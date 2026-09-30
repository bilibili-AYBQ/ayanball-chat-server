// ================= AyanBall Chat · Node.js 测试服务端 =================
// 依赖: ws  (npm install ws)
// 启动: node server.js   (可选环境变量 PORT / ADMIN_KEY)
// 首个注册用户自动成为管理员；或通过 ADMIN_KEY 提升任意用户
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 8899);
const ADMIN_KEY = process.env.ADMIN_KEY || null;
// 管理面板登录密码：优先取 ADMIN_KEY，未设置时使用默认密码
const ADMIN_PASSWORD = ADMIN_KEY || "ayanball-admin";
const DATA_FILE = path.join(__dirname, "data.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const FILE_TTL_MS = 3 * 24 * 3600 * 1000; // 3 天
const HISTORY_LIMIT = 50;
const ADMIN_TOKEN_TTL = 12 * 3600 * 1000; // 管理面板会话 12 小时
const MAX_GROUP_MEMBERS = 100; // 普通群上限 100 人（后续可升级）
const bootTs = Date.now();

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------- 状态 ----------------
const state = {
  users: {}, // id -> {id, username, passwordHash, salt, nickname, admin, createdAt}
  tokens: {}, // token -> userId
  friends: {}, // userId -> [friendId]
  requests: {}, // id -> {id, fromId, toId, status, ts}
  blocked: {}, // userId -> [blockedUserId]
  groups: {}, // id -> {id, name, code, ownerId, memberIds, adminIds, createdAt}
  rooms: {}, // roomKey -> Message[]
  files: {}, // fileId -> {id, name, size, type, ownerId, createdAt, expiresAt}
  activeCalls: {}, // userId -> peerId
};

// 管理面板会话：adminToken -> 过期时间
const adminSessions = new Map();

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const d = JSON.parse(raw);
    for (const k of Object.keys(state)) {
      if (d[k]) state[k] = d[k];
    }
  } catch {
    /* 首次启动 */
  }
}
loadState();

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error("[persist]", e.message);
    }
  }, 400);
}

// ---------------- 工具 ----------------
function uid(prefix = "") {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8) +
    crypto.randomBytes(2).toString("hex")
  );
}
function hashPwd(password, salt) {
  return crypto.createHash("sha256").update(password + "::" + salt).digest("hex");
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, nickname: u.nickname, avatar: u.avatar || "p1", admin: !!u.admin, createdAt: u.createdAt };
}
function avatarOf(u) {
  return u ? u.avatar || "p1" : "p1";
}
function safeName(name) {
  return String(name || "file").replace(/[^\w.\u4e00-\u9fa5-]/g, "_").slice(0, 120);
}

const clients = new Map(); // userId -> ws

function bindWs(ws, userId) {
  ws.userId = userId;
  clients.set(userId, ws);
}

function pushTo(userId, action, payload) {
  const ws = clients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action, payload }));
  }
}

function roomKeyFor(a, b) {
  return `dm:${[a, b].sort().join(":")}`;
}

function resolveRoomsFor(userId) {
  // 该用户所有会话: 单向 DM(按自己视角)+群聊
  const result = [];
  const seen = new Set();
  const me = state.users[userId];
  if (!me) return [];

  for (const [key, msgs] of Object.entries(state.rooms)) {
    if (key.startsWith("g:")) continue;
    const [a, b] = key.replace("dm:", "").split(":");
    if (a === userId) {
      const peer = state.users[b];
      if (!peer) continue;
      const convId = `dm:${b}`;
      if (seen.has(convId)) continue;
      seen.add(convId);
      const last = msgs[msgs.length - 1];
      result.push({
        convId,
        conv: {
          id: convId,
          type: "dm",
          name: peer.nickname || peer.username,
          avatarText: (peer.nickname || peer.username).slice(0, 1),
          lastMsg: last ? preview(last) : "",
          lastTs: last ? last.ts : 0,
          unread: 0,
          blocked: (state.blocked[userId] || []).includes(b),
        },
        msgs: msgs.slice(-HISTORY_LIMIT).map((m) => ({ ...m, convId, mine: m.senderId === userId })),
      });
    }
  }

  for (const g of Object.values(state.groups)) {
    if (!g.memberIds.includes(userId)) continue;
    const convId = `g:${g.id}`;
    const msgs = state.rooms[g.id] || [];
    const last = msgs[msgs.length - 1];
    result.push({
      convId,
      conv: {
        id: convId,
        type: "group",
        name: g.name,
        avatarText: "群",
        lastMsg: last ? preview(last) : "",
        lastTs: last ? last.ts : 0,
        unread: 0,
      },
      msgs: msgs.slice(-HISTORY_LIMIT).map((m) => ({ ...m, convId, mine: m.senderId === userId })),
    });
  }
  return result;
}

function preview(m) {
  return m.kind === "file" ? `[${m.file?.name || "file"}]` : m.content;
}

function groupPayload(g) {
  return {
    id: g.id,
    name: g.name,
    code: g.code,
    ownerId: g.ownerId,
    adminIds: g.adminIds || [],
    memberCount: g.memberIds.length,
    members: g.memberIds.map((id) => {
      const u = state.users[id];
      return u ? { id: u.id, username: u.username, nickname: u.nickname, avatar: avatarOf(u) } : null;
    }).filter(Boolean),
    createdAt: g.createdAt,
  };
}

/** 群信息变更后推送给所有成员（群主/管理员/成员数变化） */
function pushGroupUpdate(g) {
  const payload = groupPayload(g);
  for (const mid of g.memberIds) pushTo(mid, "group.updated", { group: payload });
}

/** 群成员操作权限：owner=群主 admin=群管理员 member=普通成员 */
function groupRole(g, userId) {
  if (g.ownerId === userId) return "owner";
  if ((g.adminIds || []).includes(userId)) return "admin";
  if (g.memberIds.includes(userId)) return "member";
  return "none";
}

// ---------------- 管理面板（图形化操作） ----------------
function isAdminSession(req) {
  const t = String((req.headers.authorization || "").replace("Bearer ", ""));
  const exp = adminSessions.get(t);
  if (!exp) return false;
  if (Date.now() > exp) {
    adminSessions.delete(t);
    return false;
  }
  return true;
}

function adminStats() {
  let msgTotal = 0;
  let fileTotal = 0;
  for (const room of Object.values(state.rooms)) {
    msgTotal += room.length;
    for (const m of room) if (m.kind === "file") fileTotal++;
  }
  const onlineUsers = [...clients.keys()].filter((id) => state.users[id]);
  return {
    uptimeSec: Math.floor((Date.now() - bootTs) / 1000),
    port: PORT,
    users: Object.keys(state.users).length,
    online: onlineUsers.length,
    groups: Object.keys(state.groups).length,
    messages: msgTotal,
    files: Object.keys(state.files).length,
    filesBytes: fileTotal,
    calls: Math.floor(Object.keys(state.activeCalls).length / 2),
    memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    adminPanelUrl: `http://127.0.0.1:${PORT}/admin`,
    wsUrl: `ws://127.0.0.1:${PORT}`,
  };
}

function adminUsersList() {
  return Object.values(state.users).map((u) => ({
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    admin: !!u.admin,
    createdAt: u.createdAt,
    online: clients.has(u.id),
    friendCount: (state.friends[u.id] || []).length,
    groupCount: Object.values(state.groups).filter((g) => g.memberIds.includes(u.id)).length,
  }));
}

function adminRecentMessages(limit) {
  const arr = [];
  for (const [key, room] of Object.entries(state.rooms)) {
    const isGroup = key.startsWith("g:");
    const group = state.groups[key];
    for (const m of room) {
      arr.push({
        id: m.id,
        kind: m.kind,
        content: m.content,
        file: m.file ? { name: m.file.name, size: m.file.size, url: m.file.url, expiresAt: m.file.expiresAt } : undefined,
        senderId: m.senderId,
        senderName: m.senderName,
        ts: m.ts,
        roomType: isGroup ? "group" : "dm",
        roomName: isGroup ? (group ? group.name : key) : "私聊",
      });
    }
  }
  arr.sort((a, b) => b.ts - a.ts);
  return arr.slice(0, Math.min(Number(limit) || 200, 500));
}

function adminFilesList() {
  return Object.values(state.files).map((f) => ({
    id: f.id,
    name: f.name,
    size: f.size,
    createdAt: f.createdAt,
    expiresAt: f.expiresAt,
    ownerName: state.users[f.ownerId] ? state.users[f.ownerId].username : "未知",
  }));
}

function deleteUserCompletely(targetId) {
  const target = state.users[targetId];
  if (!target) return false;
  // 移除登录态与在线连接
  for (const [t, uid] of Object.entries(state.tokens)) {
    if (uid === targetId) delete state.tokens[t];
  }
  const ws = clients.get(targetId);
  if (ws) {
    clients.delete(targetId);
    try { ws.close(); } catch { /* ignore */ }
  }
  // 好友关系
  for (const uid of Object.keys(state.users)) {
    state.friends[uid] = (state.friends[uid] || []).filter((x) => x !== targetId);
    state.blocked[uid] = (state.blocked[uid] || []).filter((x) => x !== targetId);
  }
  delete state.friends[targetId];
  delete state.blocked[targetId];
  // 好友申请
  for (const [rid, r] of Object.entries(state.requests)) {
    if (r.fromId === targetId || r.toId === targetId) delete state.requests[rid];
  }
  // 群聊成员
  for (const g of Object.values(state.groups)) {
    g.memberIds = g.memberIds.filter((x) => x !== targetId);
  }
  // 活动通话
  const peer = state.activeCalls[targetId];
  if (peer) {
    delete state.activeCalls[targetId];
    delete state.activeCalls[peer];
  }
  delete state.users[targetId];
  persist();
  return true;
}

// ---------------- HTTP 服务 ----------------
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-file-name, x-file-size");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 上传文件
  if (req.method === "POST" && req.url.startsWith("/api/upload")) {
    const auth = (req.headers.authorization || "").replace("Bearer ", "");
    const userId = state.tokens[auth];
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const fileName = decodeURIComponent(req.headers["x-file-name"] || "file.bin");
    const fileSize = Number(req.headers["x-file-size"] || 0);
    if (fileSize > MAX_FILE_SIZE) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "too-large" }));
      return;
    }
    const fileId = uid("f_");
    const safe = safeName(fileName);
    const filePath = path.join(UPLOAD_DIR, `${fileId}_${safe}`);
    let received = 0;
    let tooBig = false;
    const wsFile = fs.createWriteStream(filePath);
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_FILE_SIZE) {
        tooBig = true;
        req.destroy();
        wsFile.destroy();
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        return;
      }
      wsFile.write(chunk);
    });
    req.on("end", () => {
      wsFile.end(() => {
        if (tooBig) return;
        const meta = {
          id: fileId,
          name: fileName,
          size: received,
          type: "application/octet-stream",
          ownerId: userId,
          createdAt: Date.now(),
          expiresAt: Date.now() + FILE_TTL_MS,
        };
        state.files[fileId] = meta;
        persist();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            file: {
              name: meta.name,
              size: meta.size,
              type: meta.type,
              url: `http://127.0.0.1:${PORT}/api/files/${fileId}`,
              expiresAt: meta.expiresAt,
              ttl: FILE_TTL_MS,
            },
          }),
        );
      });
    });
    req.on("error", () => {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    });
    return;
  }

  // 下载文件（3 天有效期）
  const m = req.url.match(/^\/api\/files\/(f_[A-Za-z0-9]+)$/);
  if (req.method === "GET" && m) {
    const fileId = m[1];
    const meta = state.files[fileId];
    if (!meta || Date.now() > meta.expiresAt) {
      if (meta) {
        delete state.files[fileId];
        try { fs.unlinkSync(path.join(UPLOAD_DIR, `${fileId}_${safeName(meta.name)}`)); } catch { /* ignore */ }
        persist();
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "expired" }));
      return;
    }
    const filePath = path.join(UPLOAD_DIR, `${fileId}_${safeName(meta.name)}`);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      "Content-Length": meta.size,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // 管理面板页面（图形化操作界面）
  if (req.method === "GET" && (req.url === "/" || req.url === "/admin" || req.url === "/admin.html")) {
    const html = fs.readFileSync(path.join(__dirname, "admin.html"), "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // 管理面板登录
  if (req.method === "POST" && req.url === "/api/admin/login") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let pass = "";
      try { pass = String(JSON.parse(body).password || ""); } catch { /* ignore */ }
      if (pass !== ADMIN_PASSWORD) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad-password" }));
        return;
      }
      const t = uid("a_");
      adminSessions.set(t, Date.now() + ADMIN_TOKEN_TTL);
      console.log(`[管理面板] 管理员已登录`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: t }));
    });
    return;
  }

  // 管理面板 API（需登录会话）
  if (req.url.startsWith("/api/admin/") && req.method !== "OPTIONS") {
    if (!isAdminSession(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const finish = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const readBody = (cb) => {
      let b = "";
      req.on("data", (c) => { b += c; });
      req.on("end", () => {
        let o = {};
        try { o = JSON.parse(b); } catch { /* ignore */ }
        cb(o);
      });
    };

    // ---- 统计 ----
    if (req.method === "GET" && req.url === "/api/admin/stats") {
      finish(200, adminStats());
      return;
    }
    // ---- 用户 ----
    if (req.method === "GET" && req.url === "/api/admin/users") {
      finish(200, { users: adminUsersList() });
      return;
    }
    if (req.method === "POST" && req.url === "/api/admin/users/promote") {
      readBody((o) => {
        const u = Object.values(state.users).find((x) => x.username === String(o.username || "").trim());
        if (!u) return finish(404, { error: "not-found" });
        u.admin = true;
        persist();
        pushTo(u.id, "promoted", { userId: u.id, by: "admin" });
        finish(200, {});
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/admin/users/demote") {
      readBody((o) => {
        const u = Object.values(state.users).find((x) => x.username === String(o.username || "").trim());
        if (!u) return finish(404, { error: "not-found" });
        u.admin = false;
        persist();
        finish(200, {});
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/admin/users/delete") {
      readBody((o) => {
        const u = Object.values(state.users).find((x) => x.username === String(o.username || "").trim());
        if (!u) return finish(404, { error: "not-found" });
        deleteUserCompletely(u.id);
        console.log(`[管理面板] 删除用户 ${u.username}`);
        finish(200, {});
      });
      return;
    }
    // ---- 群聊 ----
    if (req.method === "GET" && req.url === "/api/admin/groups") {
      const list = Object.values(state.groups).map((g) => ({
        id: g.id,
        name: g.name,
        code: g.code,
        ownerId: g.ownerId,
        ownerName: state.users[g.ownerId] ? state.users[g.ownerId].username : "未知",
        adminIds: g.adminIds || [],
        memberCount: g.memberIds.length,
        members: g.memberIds.map((id) => {
          const u = state.users[id];
          return u ? { id: u.id, username: u.username, nickname: u.nickname, avatar: avatarOf(u) } : null;
        }).filter(Boolean),
        createdAt: g.createdAt,
      }));
      finish(200, { groups: list });
      return;
    }
    if (req.method === "POST" && req.url === "/api/admin/groups/dissolve") {
      readBody((o) => {
        const g = state.groups[String(o.id || "")];
        if (!g) return finish(404, { error: "not-found" });
        for (const mid of g.memberIds) pushTo(mid, "group.removed", { groupId: g.id });
        delete state.groups[g.id];
        delete state.rooms[g.id];
        persist();
        console.log(`[管理面板] 解散群聊 ${g.name}`);
        finish(200, {});
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/admin/groups/kick") {
      readBody((o) => {
        const g = state.groups[String(o.id || "")];
        if (!g) return finish(404, { error: "not-found" });
        const targetId = String(o.userId || "");
        if (targetId === g.ownerId) return finish(400, { error: "cannot-kick-owner" });
        if (!g.memberIds.includes(targetId)) return finish(400, { error: "not-member" });
        g.memberIds = g.memberIds.filter((x) => x !== targetId);
        g.adminIds = (g.adminIds || []).filter((x) => x !== targetId);
        persist();
        pushTo(targetId, "group.kicked", { groupId: g.id });
        if (g.memberIds.length === 0) {
          delete state.groups[g.id];
          delete state.rooms[g.id];
        } else {
          pushGroupUpdate(g);
        }
        console.log(`[管理面板] 踢出群成员 @ ${g.name}`);
        finish(200, {});
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/admin/groups/transfer") {
      readBody((o) => {
        const g = state.groups[String(o.id || "")];
        if (!g) return finish(404, { error: "not-found" });
        const targetId = String(o.userId || "");
        if (!g.memberIds.includes(targetId)) return finish(400, { error: "not-member" });
        g.ownerId = targetId;
        if (!(g.adminIds || []).includes(targetId)) g.adminIds.push(targetId);
        persist();
        pushGroupUpdate(g);
        console.log(`[管理面板] 转让群主 @ ${g.name}`);
        finish(200, {});
      });
      return;
    }
    // ---- 消息 ----
    if (req.method === "GET" && req.url.startsWith("/api/admin/messages")) {
      const limit = new URL(req.url, "http://x").searchParams.get("limit");
      finish(200, { messages: adminRecentMessages(limit) });
      return;
    }
    // ---- 文件 ----
    if (req.method === "GET" && req.url === "/api/admin/files") {
      finish(200, { files: adminFilesList() });
      return;
    }
    if (req.method === "POST" && req.url === "/api/admin/files/delete") {
      readBody((o) => {
        const meta = state.files[String(o.id || "")];
        if (!meta) return finish(404, { error: "not-found" });
        delete state.files[meta.id];
        try { fs.unlinkSync(path.join(UPLOAD_DIR, `${meta.id}_${safeName(meta.name)}`)); } catch { /* ignore */ }
        persist();
        finish(200, {});
      });
      return;
    }
    // ---- 维护 ----
    if (req.method === "POST" && req.url === "/api/admin/cleanup") {
      let removed = 0;
      const now = Date.now();
      for (const [fid, meta] of Object.entries(state.files)) {
        if (now > meta.expiresAt) {
          delete state.files[fid];
          try { fs.unlinkSync(path.join(UPLOAD_DIR, `${fid}_${safeName(meta.name)}`)); } catch { /* ignore */ }
          removed++;
        }
      }
      persist();
      finish(200, { removed });
      return;
    }
    if (req.method === "POST" && req.url === "/api/admin/cleanup-tokens") {
      let removed = 0;
      for (const [t, uid] of Object.entries(state.tokens)) {
        if (!state.users[uid]) {
          delete state.tokens[t];
          removed++;
        }
      }
      for (const [t, exp] of adminSessions) {
        if (Date.now() > exp) { adminSessions.delete(t); removed++; }
      }
      persist();
      finish(200, { removed });
      return;
    }
    // ---- 广播 ----
    if (req.method === "POST" && req.url === "/api/admin/broadcast") {
      readBody((o) => {
        const text = String(o.text || "").trim().slice(0, 500);
        if (!text) return finish(400, { error: "empty" });
        for (const uid of clients.keys()) {
          pushTo(uid, "system.broadcast", { text, by: "admin" });
        }
        console.log(`[管理面板] 广播: ${text.slice(0, 40)}`);
        finish(200, { sent: clients.size });
      });
      return;
    }

    finish(404, { error: "not-found" });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not-found" }));
});

// ---------------- WebSocket 服务 ----------------
const wss = new WebSocketServer({ server });

function handleRequest(ws, userId, action, payload, reply, reqId) {
  // 错误统一放顶层 { id, error }，客户端按顶层 error reject
  const fail = (code) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: reqId, error: code }));
  };

  switch (action) {
    // ============ 认证 ============
    case "auth.register": {
      const username = String(payload.username || "").trim();
      const password = String(payload.password || "");
      if (username.length < 2 || password.length < 6) return fail("invalid");
      if (Object.values(state.users).some((u) => u.username === username)) return fail("taken");
      const salt = crypto.randomBytes(8).toString("hex");
      const isFirst = Object.keys(state.users).length === 0; // 首个用户自动成为管理员
      const user = {
        id: uid("u_"),
        username,
        nickname: String(payload.nickname || "").trim() || username,
        avatar: String(payload.avatar || "p1").slice(0, 400),
        passwordHash: hashPwd(password, salt),
        salt,
        admin: isFirst,
        createdAt: Date.now(),
      };
      state.users[user.id] = user;
      const token = uid("t_");
      state.tokens[token] = user.id;
      bindWs(ws, user.id);
      persist();
      console.log(`[注册] ${username}${isFirst ? " (首个用户 -> 管理员)" : ""}`);
      reply({ token, user: publicUser(user) });
      break;
    }
    case "auth.login": {
      const username = String(payload.username || "").trim();
      const password = String(payload.password || "");
      const user = Object.values(state.users).find((u) => u.username === username);
      if (!user || user.passwordHash !== hashPwd(password, user.salt)) return fail("credential");
      const token = uid("t_");
      state.tokens[token] = user.id;
      bindWs(ws, user.id);
      persist();
      console.log(`[登录] ${username}`);
      reply({ token, user: publicUser(user) });
      break;
    }
    case "auth": {
      const userId2 = state.tokens[String(payload.token || "")];
      if (!userId2) return fail("unauthorized");
      const me = state.users[userId2];
      const friends = (state.friends[userId2] || [])
        .map((fid) => {
          const f = state.users[fid];
          return f ? { id: f.id, username: f.username, nickname: f.nickname, avatar: avatarOf(f), addedAt: 0, blocked: (state.blocked[userId2] || []).includes(fid) } : null;
        })
        .filter(Boolean);
      const requests = Object.values(state.requests).filter(
        (r) => r.toId === userId2 || r.fromId === userId2,
      );
      reply({
        user: publicUser(me),
        friends,
        groups: (state.groups && Object.values(state.groups).filter((g) => g.memberIds.includes(userId2)).map(groupPayload)) || [],
        requests,
        blocked: state.blocked[userId2] || [],
        rooms: resolveRoomsFor(userId2),
      });
      break;
    }

    // ============ 好友 ============
    case "friend.search": {
      const q = String(payload.username || "").trim();
      const target = Object.values(state.users).find((u) => u.username === q && u.id !== userId);
      if (!target) return fail("not-found");
      reply({ user: publicUser(target) });
      break;
    }
    case "friend.request": {
      const toId = String(payload.toId || "");
      const to = state.users[toId];
      if (!to) return fail("not-found");
      if ((state.friends[userId] || []).includes(toId)) return fail("already-friend");
      const dup = Object.values(state.requests).some(
        (r) => r.fromId === userId && r.toId === toId && r.status === "pending",
      );
      if (dup) return fail("duplicate");
      const req = { id: uid("r_"), fromId: userId, toId, status: "pending", ts: Date.now() };
      state.requests[req.id] = req;
      persist();
      const from = state.users[userId];
      const payload2 = { id: req.id, fromId: userId, fromUsername: from.username, fromNickname: from.nickname, fromAvatar: avatarOf(from), toId, status: "pending", ts: req.ts };
      pushTo(toId, "friend.request", payload2);
      reply({ request: payload2 });
      break;
    }
    case "friend.accept": {
      const req = state.requests[String(payload.requestId || "")];
      if (!req || req.toId !== userId || req.status !== "pending") return fail("bad-request");
      req.status = "accepted";
      state.friends[userId] = state.friends[userId] || [];
      state.friends[req.fromId] = state.friends[req.fromId] || [];
      if (!state.friends[userId].includes(req.fromId)) state.friends[userId].push(req.fromId);
      if (!state.friends[req.fromId].includes(userId)) state.friends[req.fromId].push(userId);
      persist();
      const from = state.users[req.fromId];
      const to = state.users[req.toId];
      pushTo(req.fromId, "friend.accepted", { id: to.id, username: to.username, nickname: to.nickname, avatar: avatarOf(to), addedAt: Date.now(), blocked: false });
      reply({ friend: { id: from.id, username: from.username, nickname: from.nickname, avatar: avatarOf(from), addedAt: Date.now(), blocked: false } });
      break;
    }
    case "friend.reject": {
      const req = state.requests[String(payload.requestId || "")];
      if (!req || req.toId !== userId || req.status !== "pending") return fail("bad-request");
      req.status = "rejected";
      persist();
      pushTo(req.fromId, "friend.rejected", {});
      reply({});
      break;
    }
    // ============ 个人资料 ============
    case "profile.setAvatar": {
      const raw = String(payload.avatar || "").slice(0, 400);
      if (!raw) return fail("invalid");
      const me2 = state.users[userId];
      me2.avatar = raw;
      persist();
      reply({ user: publicUser(me2) });
      // 通知所有好友刷新资料
      const myId = userId;
      for (const [otherId, friends] of Object.entries(state.friends || {})) {
        if (friends.includes(myId)) {
          pushTo(otherId, "profile.updated", { user: publicUser(me2) });
        }
      }
      break;
    }
    case "friend.remove": {
      const fid = String(payload.friendId || "");
      state.friends[userId] = (state.friends[userId] || []).filter((x) => x !== fid);
      state.friends[fid] = (state.friends[fid] || []).filter((x) => x !== userId);
      persist();
      pushTo(fid, "friend.removed", { friendId: userId });
      reply({});
      break;
    }

    // ============ 拉黑 ============
    case "block.add": {
      const targetId = String(payload.userId || "");
      const list = state.blocked[userId] || (state.blocked[userId] = []);
      if (!list.includes(targetId)) list.push(targetId);
      // 拉黑即解除好友
      state.friends[userId] = (state.friends[userId] || []).filter((x) => x !== targetId);
      state.friends[targetId] = (state.friends[targetId] || []).filter((x) => x !== userId);
      persist();
      pushTo(targetId, "blocked", { userId });
      reply({});
      break;
    }
    case "block.remove": {
      const targetId = String(payload.userId || "");
      state.blocked[userId] = (state.blocked[userId] || []).filter((x) => x !== targetId);
      persist();
      reply({});
      break;
    }

    // ============ 群聊 ============
    case "group.create": {
      const name = String(payload.name || "").trim();
      if (!name) return fail("invalid");
      const g = {
        id: uid("g_"),
        name,
        code: crypto.randomBytes(3).toString("hex").toUpperCase(),
        ownerId: userId,
        memberIds: [userId],
        adminIds: [userId],
        createdAt: Date.now(),
      };
      state.groups[g.id] = g;
      state.rooms[g.id] = [];
      persist();
      pushTo(userId, "group.new", groupPayload(g));
      console.log(`[建群] ${name} (${g.code}) by ${state.users[userId].username}`);
      reply({ group: groupPayload(g) });
      break;
    }
    case "group.join": {
      const code = String(payload.code || "").trim().toUpperCase();
      const g = Object.values(state.groups).find((x) => x.code === code);
      if (!g) return fail("bad-code");
      if (g.memberIds.includes(userId)) return fail("already-in-group");
      if (g.memberIds.length >= MAX_GROUP_MEMBERS) return fail("group-full");
      if ((state.blocked[userId] || []).includes(g.ownerId)) return fail("blocked-by-you");
      if ((state.blocked[g.ownerId] || []).includes(userId)) return fail("blocked-by-owner");
      g.memberIds.push(userId);
      persist();
      for (const mid of g.memberIds) pushTo(mid, "group.new", groupPayload(g));
      console.log(`[加群] ${state.users[userId].username} -> ${g.name} (${g.code})`);
      reply({ group: groupPayload(g) });
      break;
    }
    case "group.leave": {
      const g = state.groups[String(payload.groupId || "")];
      if (!g) return fail("bad-group");
      if (g.ownerId === userId) return fail("owner-cannot-leave");
      g.memberIds = g.memberIds.filter((x) => x !== userId);
      g.adminIds = (g.adminIds || []).filter((x) => x !== userId);
      persist();
      pushTo(userId, "group.removed", { groupId: g.id });
      if (g.memberIds.length === 0) {
        // 群主已转让+全员退出 → 空群自动解散
        delete state.groups[g.id];
        delete state.rooms[g.id];
      } else {
        pushGroupUpdate(g);
      }
      reply({});
      break;
    }

    // ---- 群管理：设/撤管理员（群主可设可撤；群管理员只能把普通成员设为管理员） ----
    case "group.setAdmin": {
      const g = state.groups[String(payload.groupId || "")];
      if (!g) return fail("bad-group");
      const role = groupRole(g, userId);
      if (role === "none") return fail("not-in-group");
      if (role === "member") return fail("forbidden");
      const targetId = String(payload.userId || "");
      const wantAdmin = !!payload.admin;
      if (targetId === g.ownerId) return fail("cannot-modify-owner");
      if (!g.memberIds.includes(targetId)) return fail("not-member");
      if (role !== "owner" && (wantAdmin === false || (g.adminIds || []).includes(targetId))) {
        return fail("forbidden");
      }
      if (wantAdmin) {
        if (!(g.adminIds || []).includes(targetId)) g.adminIds.push(targetId);
      } else {
        g.adminIds = (g.adminIds || []).filter((x) => x !== targetId);
      }
      persist();
      pushGroupUpdate(g);
      const target = state.users[targetId];
      console.log(`[群管理] ${state.users[userId].username} ${wantAdmin ? "设为管理员" : "撤销管理员"}: ${target ? target.username : targetId} @ ${g.name}`);
      reply({ group: groupPayload(g) });
      break;
    }

    // ---- 群管理：踢人（群主可踢任何人；管理员可踢普通成员） ----
    case "group.kick": {
      const g = state.groups[String(payload.groupId || "")];
      if (!g) return fail("bad-group");
      const role = groupRole(g, userId);
      if (role === "none") return fail("not-in-group");
      if (role === "member") return fail("forbidden");
      const targetId = String(payload.userId || "");
      if (targetId === userId) return fail("cannot-kick-self");
      if (targetId === g.ownerId) return fail("cannot-kick-owner");
      if (!g.memberIds.includes(targetId)) return fail("not-member");
      if (role !== "owner" && (g.adminIds || []).includes(targetId)) return fail("cannot-kick-admin");
      g.memberIds = g.memberIds.filter((x) => x !== targetId);
      g.adminIds = (g.adminIds || []).filter((x) => x !== targetId);
      persist();
      pushTo(targetId, "group.kicked", { groupId: g.id });
      if (g.memberIds.length === 0) {
        delete state.groups[g.id];
        delete state.rooms[g.id];
      } else {
        pushGroupUpdate(g);
      }
      const target = state.users[targetId];
      console.log(`[群管理] ${state.users[userId].username} 踢出: ${target ? target.username : targetId} @ ${g.name}`);
      reply({ group: groupPayload(g) });
      break;
    }

    // ---- 群管理：邀请成员（群主/管理员，按用户名邀请；人数上限 100） ----
    case "group.invite": {
      const g = state.groups[String(payload.groupId || "")];
      if (!g) return fail("bad-group");
      const role = groupRole(g, userId);
      if (role === "none") return fail("not-in-group");
      if (role === "member") return fail("forbidden");
      const target = Object.values(state.users).find((u) => u.username === String(payload.username || "").trim());
      if (!target) return fail("not-found");
      if (g.memberIds.includes(target.id)) return fail("already-in-group");
      if (g.memberIds.length >= MAX_GROUP_MEMBERS) return fail("group-full");
      if ((state.blocked[userId] || []).includes(target.id)) return fail("blocked-by-you");
      if ((state.blocked[target.id] || []).includes(userId)) return fail("blocked-by-target");
      g.memberIds.push(target.id);
      persist();
      pushTo(target.id, "group.new", groupPayload(g));
      pushGroupUpdate(g);
      console.log(`[群管理] ${state.users[userId].username} 邀请 ${target.username} -> ${g.name}`);
      reply({ group: groupPayload(g) });
      break;
    }

    // ---- 群管理：解散群聊（仅群主） ----
    case "group.dissolve": {
      const g = state.groups[String(payload.groupId || "")];
      if (!g) return fail("bad-group");
      if (g.ownerId !== userId) return fail("owner-only");
      for (const mid of g.memberIds) pushTo(mid, "group.removed", { groupId: g.id });
      delete state.groups[g.id];
      delete state.rooms[g.id];
      persist();
      console.log(`[群管理] ${state.users[userId].username} 解散群: ${g.name}`);
      reply({});
      break;
    }

    // ---- 群管理：转让群主（仅群主） ----
    case "group.transfer": {
      const g = state.groups[String(payload.groupId || "")];
      if (!g) return fail("bad-group");
      if (g.ownerId !== userId) return fail("owner-only");
      const targetId = String(payload.userId || "");
      if (targetId === userId) return fail("cannot-transfer-self");
      if (!g.memberIds.includes(targetId)) return fail("not-member");
      g.ownerId = targetId;
      if (!(g.adminIds || []).includes(targetId)) g.adminIds.push(targetId);
      persist();
      pushGroupUpdate(g);
      const target = state.users[targetId];
      console.log(`[群管理] ${state.users[userId].username} 转让群主给 ${target ? target.username : targetId} @ ${g.name}`);
      reply({ group: groupPayload(g) });
      break;
    }

    // ============ 消息 ============
    case "message.send": {
      const roomId = String(payload.roomId || "");
      const me = state.users[userId];
      if (!me) return fail("unauthorized");
      const kind = payload.kind === "file" ? "file" : "text";
      const content = String(payload.content || "").slice(0, 5000);
      const file = payload.file ? {
        name: String(payload.file.name || "file").slice(0, 200),
        size: Number(payload.file.size) || 0,
        type: String(payload.file.type || "application/octet-stream"),
        url: String(payload.file.url || ""),
        expiresAt: Number(payload.file.expiresAt) || Date.now() + FILE_TTL_MS,
      } : undefined;

      const msg = {
        id: uid("m_"),
        senderId: userId,
        senderName: me.nickname || me.username,
        senderAvatar: avatarOf(me),
        kind,
        content,
        file,
        ts: Date.now(),
      };

      // 群聊（roomId = 群 id，如 g_xxx）
      const group = state.groups[roomId];
      if (group) {
        if (!group.memberIds.includes(userId)) return fail("not-in-group");
        const room = state.rooms[roomId] || (state.rooms[roomId] = []);
        msg.roomId = roomId;
        room.push(msg);
        if (room.length > 500) room.splice(0, room.length - 500);
        persist();
        for (const mid of group.memberIds) {
          pushTo(mid, "message.new", { convId: `g:${group.id}`, roomId: group.id, msg: { ...msg, mine: mid === userId } });
        }
        reply({ msg: { ...msg, mine: true } });
        break;
      }

      // 私聊（roomId = 对方用户 id）
      const peerId = roomId;
      const peer = state.users[peerId];
      if (!peer) return fail("no-peer");
      if ((state.blocked[userId] || []).includes(peerId)) return fail("blocked-by-you");
      if ((state.blocked[peerId] || []).includes(userId)) return fail("blocked-by-peer");
      const key = roomKeyFor(userId, peerId);
      const room = state.rooms[key] || (state.rooms[key] = []);
      msg.roomId = peerId;
      room.push(msg);
      if (room.length > 500) room.splice(0, room.length - 500);
      persist();
      // 回执给发送者
      pushTo(userId, "message.new", { convId: `dm:${peerId}`, roomId: peerId, msg: { ...msg, mine: true } });
      // 推送给接收者
      pushTo(peerId, "message.new", { convId: `dm:${userId}`, roomId: userId, msg: { ...msg, mine: false } });
      reply({ msg: { ...msg, mine: true } });
      break;
    }

    // ============ 通话信令 ============
    case "call.offer": {
      const toId = String(payload.to || "");
      const to = state.users[toId];
      if (!to) return fail("no-peer");
      if (!clients.has(toId)) return fail("peer-offline");
      if (state.activeCalls[toId]) return fail("busy");
      state.activeCalls[userId] = toId;
      state.activeCalls[toId] = userId;
      const me = state.users[userId];
      pushTo(toId, "call.invite", {
        from: userId,
        fromName: me.nickname || me.username,
        kind: payload.kind || "voice",
        sdp: payload.sdp || null,
      });
      reply({});
      break;
    }
    case "call.answer": {
      const toId = state.activeCalls[userId];
      if (toId) pushTo(toId, "call.answer", { from: userId, sdp: payload.sdp || null });
      reply({});
      break;
    }
    case "call.ice": {
      const toId = String(payload.to || "");
      pushTo(toId, "call.ice", { from: userId, candidate: payload.candidate || null });
      reply({});
      break;
    }
    case "call.hangup": {
      const toId = String(payload.to || "");
      const reason = String(payload.reason || "ended");
      if (toId) pushTo(toId, "call.hangup", { from: userId, reason });
      // 清理活动通话
      if (state.activeCalls[userId] === toId) delete state.activeCalls[userId];
      if (state.activeCalls[toId] === userId) delete state.activeCalls[toId];
      reply({});
      break;
    }

    // ============ 管理员 ============
    case "admin.promote": {
      const me = state.users[userId];
      const isAdmin = me && (me.admin || (ADMIN_KEY && payload.key === ADMIN_KEY));
      if (!isAdmin) return fail("forbidden");
      const target = Object.values(state.users).find((u) => u.username === String(payload.username || "").trim());
      if (!target) return fail("not-found");
      target.admin = true;
      persist();
      console.log(`[管理员] ${target.username} 由 ${me.username} 提升`);
      pushTo(target.id, "promoted", { userId: target.id, by: me.username });
      reply({});
      break;
    }

    default:
      fail("unknown-action");
  }
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const reply = (payload) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: data.id, payload }));
    };

    // 认证请求：绑定连接与用户
    if (data.action === "auth" && data.payload?.token) {
      const uid2 = state.tokens[String(data.payload.token)];
      if (uid2) {
        bindWs(ws, uid2);
        handleRequest(ws, uid2, "auth", { token: data.payload.token }, reply, data.id);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: data.id, error: "unauthorized" }));
      return;
    }

    // 未登录连接只允许注册/登录
    const authedId = ws.userId || null;
    if (!authedId) {
      if (data.action === "auth.register" || data.action === "auth.login") {
        handleRequest(ws, "", data.action, data.payload, reply, data.id);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: data.id, error: "unauthorized" }));
      return;
    }

    handleRequest(ws, authedId, data.action, data.payload, reply, data.id);
  });

  ws.on("close", () => {
    for (const [uid2, w] of clients) {
      if (w === ws) {
        clients.delete(uid2);
        // 清理该用户相关的活动通话
        const peer = state.activeCalls[uid2];
        if (peer) {
          delete state.activeCalls[uid2];
          delete state.activeCalls[peer];
        }
      }
    }
  });
});

// ---------------- 过期文件清理 ----------------
setInterval(() => {
  const now = Date.now();
  for (const [fid, meta] of Object.entries(state.files)) {
    if (now > meta.expiresAt) {
      delete state.files[fid];
      try { fs.unlinkSync(path.join(UPLOAD_DIR, `${fid}_${safeName(meta.name)}`)); } catch { /* ignore */ }
    }
  }
  if (Object.keys(state.files).length < 999999) persist();
}, 60 * 60 * 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("==========================================");
  console.log("  AyanBall Chat 测试服务端已启动");
  console.log(`  WebSocket:    ws://127.0.0.1:${PORT}`);
  console.log(`  管理面板:     http://127.0.0.1:${PORT}/admin  (图形化操作)`);
  console.log("  首个注册用户自动成为管理员(无敌存在)");
  if (ADMIN_KEY) console.log(`  ADMIN_KEY:    ${ADMIN_KEY} (管理面板密码 + 提权密钥)`);
  else console.log(`  管理面板密码: ${ADMIN_PASSWORD} (可用环境变量 ADMIN_KEY 修改)`);
  console.log("==========================================");
});
