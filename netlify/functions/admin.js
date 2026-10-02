// ================= AyanBall Chat · 管理面板 API =================
// 图形化管理面板（admin.html）的后端：登录 / 统计 / 用户 / 群 / 消息 / 文件 / 广播 / 清理
// 管理会话存 Netlify Blobs（12h TTL）
// 实时推送：Pusher Channels（private-user_*）
const Pusher = require("pusher");
const {
  store, readState, writeState, mutate, uid, avatarOf, json, readBody, hashPwd,
  ADMIN_PASSWORD,
} = require("./_lib.js");

const ADMIN_TOKEN_TTL = 12 * 3600 * 1000; // 管理面板会话 12 小时
const ONLINE_WINDOW_MS = 60000; // HTTP 心跳在线窗口
const UPDATE_CHUNK = 3 * 1024 * 1024; // 更新包分块上传/下载的块大小（原始字节，base64 后约 4MB，落在函数请求限制内）

let _pusher = null;
function pusherClient() {
  const appId = process.env.PUSHER_APP_ID;
  const key = process.env.PUSHER_KEY;
  const secret = process.env.PUSHER_SECRET;
  if (!appId || !key || !secret) return null;
  if (!_pusher) {
    _pusher = new Pusher({
      appId, key, secret,
      cluster: process.env.PUSHER_CLUSTER || "mt1",
      useTLS: true,
    });
  }
  return _pusher;
}

async function isAdminSession(event) {
  const t = String((event.headers.authorization || "").replace("Bearer ", ""));
  const sessions = (await readState("adminSessions")) || {};
  const exp = sessions[t];
  if (!exp) return false;
  if (Date.now() > exp) {
    delete sessions[t];
    await writeState("adminSessions", sessions);
    return false;
  }
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  const pathPart = (event.path || "").split("/").pop(); // stats / users / groups / messages / files ...
  const method = event.httpMethod;

  // ---- 登录 ----
  if (method === "POST" && pathPart === "login") {
    const pass = String(readBody(event).password || "");
    if (pass !== ADMIN_PASSWORD) return json(403, { error: "bad-password" });
    const t = uid("a_");
    await mutate("adminSessions", (s) => { s[t] = Date.now() + ADMIN_TOKEN_TTL; return s; }, {});
    return json(200, { token: t });
  }

  if (!(await isAdminSession(event))) return json(401, { error: "unauthorized" });

  const users = (await readState("users")) || {};
  const groups = (await readState("groups")) || {};
  const files = (await readState("files")) || {};
  const body = readBody(event);

  // ---- 统计 ----
  if (method === "GET" && pathPart === "stats") {
    let msgTotal = 0, fileTotal = 0;
    const list = await store().list({ prefix: "room:" });
    for (const item of (list?.blobs || [])) {
      const room = (await readState(item.key)) || [];
      msgTotal += room.length;
      for (const m of room) if (m.kind === "file") fileTotal++;
    }
    const online = await onlineUserIds();
    return json(200, {
      users: Object.keys(users).length,
      online: online.length,
      groups: Object.keys(groups).length,
      messages: msgTotal,
      files: Object.keys(files).length,
      filesBytes: fileTotal,
      adminPanelUrl: "/admin.html",
      realtime: "Netlify Functions + Pusher",
    });
  }

  // ---- 用户 ----
  if (method === "GET" && pathPart === "users") {
    const online = new Set(await onlineUserIds());
    const friendCounts = {};
    for (const u of Object.values(users)) {
      friendCounts[u.id] = ((await readState(`friends:${u.id}`)) || []).length;
    }
    const list = Object.values(users).map((u) => ({
      id: u.id,
      username: u.username,
      nickname: u.nickname,
      admin: !!u.admin,
      banned: u.banned || null,
      muted: u.muted || null,
      createdAt: u.createdAt,
      online: online.has(u.id),
      friendCount: friendCounts[u.id] || 0,
      groupCount: Object.values(groups).filter((g) => g.memberIds.includes(u.id)).length,
    }));
    return json(200, { users: list });
  }

  if (method === "POST" && pathPart === "promote") {
    const u = Object.values(users).find((x) => x.username === String(body.username || "").trim());
    if (!u) return json(404, { error: "not-found" });
    u.admin = true;
    await writeState("users", users);
    await pushUser(u.id, "promoted", { userId: u.id, by: "admin" });
    return json(200, {});
  }

  if (method === "POST" && pathPart === "demote") {
    const u = Object.values(users).find((x) => x.username === String(body.username || "").trim());
    if (!u) return json(404, { error: "not-found" });
    u.admin = false;
    await writeState("users", users);
    return json(200, {});
  }

  if (method === "POST" && pathPart === "delete") {
    const u = Object.values(users).find((x) => x.username === String(body.username || "").trim());
    if (!u) return json(404, { error: "not-found" });
    await deleteUserCompletely(u.id);
    return json(200, {});
  }

  // ---- 服主辅助注册（用户注册不了时） ----
  if (method === "POST" && pathPart === "create") {
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (username.length < 2 || password.length < 6) return json(400, { error: "invalid" });
    if (Object.values(users).some((x) => x.username === username)) return json(409, { error: "taken" });
    const salt = uid("s_");
    const user = {
      id: uid("u_"),
      username,
      nickname: String(body.nickname || "").trim() || username,
      avatar: "p1",
      passwordHash: hashPwd(password, salt),
      salt,
      admin: Object.keys(users).length === 0,
      createdAt: Date.now(),
      createdBy: "admin",
    };
    users[user.id] = user;
    await writeState("users", users);
    console.log(`[管理面板] 辅助注册 ${username}`);
    return json(200, { user: { id: user.id, username: user.username, nickname: user.nickname } });
  }

  // ---- 修改他人密码（忘记密码找回） ----
  if (method === "POST" && pathPart === "setpassword") {
    const u = Object.values(users).find((x) => x.username === String(body.username || "").trim());
    if (!u) return json(404, { error: "not-found" });
    const password = String(body.password || "");
    if (password.length < 6) return json(400, { error: "invalid" });
    u.salt = uid("s_");
    u.passwordHash = hashPwd(password, u.salt);
    await writeState("users", users);
    await pushUser(u.id, "password-changed", {});
    console.log(`[管理面板] 重置密码 ${u.username}`);
    return json(200, {});
  }

  // ---- 封号 / 禁言 ----
  if (method === "POST" && (pathPart === "ban" || pathPart === "mute")) {
    const u = Object.values(users).find((x) => x.username === String(body.username || "").trim());
    if (!u) return json(404, { error: "not-found" });
    const reason = String(body.reason || "").trim().slice(0, 300) || "管理员操作";
    if (pathPart === "ban") {
      u.banned = { at: Date.now(), reason, by: "admin" };
      u.muted = null;
    } else {
      u.muted = { at: Date.now(), reason, by: "admin" };
      u.banned = null;
    }
    await writeState("users", users);
    await pushUser(u.id, pathPart === "ban" ? "banned" : "muted", { reason });
    console.log(`[封禁] ${pathPart === "ban" ? "封号" : "禁言"} ${u.username}: ${reason}`);
    return json(200, {});
  }

  if (method === "POST" && (pathPart === "unban" || pathPart === "unmute")) {
    const u = Object.values(users).find((x) => x.username === String(body.username || "").trim());
    if (!u) return json(404, { error: "not-found" });
    if (pathPart === "unban") u.banned = null;
    else u.muted = null;
    await writeState("users", users);
    await pushUser(u.id, pathPart === "unban" ? "unbanned" : "unmuted", {});
    console.log(`[封禁] 解除${pathPart === "unban" ? "封号" : "禁言"} ${u.username}`);
    return json(200, {});
  }

  // ---- 举报处理 ----
  if (method === "POST" && pathPart === "report-resolve") {
    const reports = (await readState("reports")) || {};
    const rp = reports[String(body.id || "")];
    if (!rp) return json(404, { error: "not-found" });
    const action = String(body.action || "");
    if (action !== "ban" && action !== "mute") return json(400, { error: "bad-action" });
    const reason = String(body.reason || "").trim().slice(0, 300) || "经举报审核";
    const target = users[rp.targetId];
    if (target) {
      if (action === "ban") {
        target.banned = { at: Date.now(), reason, by: "admin" };
        target.muted = null;
      } else {
        target.muted = { at: Date.now(), reason, by: "admin" };
        target.banned = null;
      }
      await writeState("users", users);
      await pushUser(target.id, action === "ban" ? "banned" : "muted", { reason });
    }
    rp.status = "resolved";
    rp.action = action;
    rp.reason = reason;
    rp.handledAt = Date.now();
    await writeState("reports", reports);
    return json(200, {});
  }

  // ---- 反馈 / 举报列表 ----
  if (method === "GET" && pathPart === "feedback") {
    const list = Object.values((await readState("feedback")) || {}).sort((a, b) => b.ts - a.ts);
    return json(200, { feedback: list });
  }

  if (method === "GET" && pathPart === "reports") {
    const list = Object.values((await readState("reports")) || {}).sort((a, b) => b.ts - a.ts);
    return json(200, { reports: list });
  }

  // ---- 群聊 ----
  if (method === "GET" && pathPart === "groups") {
    const list = Object.values(groups).map((g) => ({
      id: g.id,
      name: g.name,
      code: g.code,
      ownerId: g.ownerId,
      ownerName: users[g.ownerId] ? users[g.ownerId].username : "未知",
      adminIds: g.adminIds || [],
      memberCount: g.memberIds.length,
      members: g.memberIds.map((id) => {
        const u = users[id];
        return u ? { id: u.id, username: u.username, nickname: u.nickname, avatar: avatarOf(u) } : null;
      }).filter(Boolean),
      createdAt: g.createdAt,
    }));
    return json(200, { groups: list });
  }

  if (method === "POST" && pathPart === "dissolve") {
    const g = groups[String(body.id || "")];
    if (!g) return json(404, { error: "not-found" });
    for (const mid of g.memberIds) await pushUser(mid, "group.removed", { groupId: g.id });
    delete groups[g.id];
    await writeState("groups", groups);
    await writeState(`room:g:${g.id}`, []);
    return json(200, {});
  }

  if (method === "POST" && pathPart === "kick") {
    const g = groups[String(body.id || "")];
    if (!g) return json(404, { error: "not-found" });
    const targetId = String(body.userId || "");
    if (targetId === g.ownerId) return json(400, { error: "cannot-kick-owner" });
    if (!g.memberIds.includes(targetId)) return json(400, { error: "not-member" });
    g.memberIds = g.memberIds.filter((x) => x !== targetId);
    g.adminIds = (g.adminIds || []).filter((x) => x !== targetId);
    await writeState("groups", groups);
    await pushUser(targetId, "group.kicked", { groupId: g.id });
    if (g.memberIds.length === 0) {
      delete groups[g.id];
      await writeState("groups", groups);
      await writeState(`room:g:${g.id}`, []);
    } else {
      await pushGroupUpdate(g);
    }
    return json(200, {});
  }

  if (method === "POST" && pathPart === "transfer") {
    const g = groups[String(body.id || "")];
    if (!g) return json(404, { error: "not-found" });
    const targetId = String(body.userId || "");
    if (!g.memberIds.includes(targetId)) return json(400, { error: "not-member" });
    g.ownerId = targetId;
    if (!(g.adminIds || []).includes(targetId)) g.adminIds.push(targetId);
    await writeState("groups", groups);
    await pushGroupUpdate(g);
    return json(200, {});
  }

  // ---- 消息 ----
  if (method === "GET" && pathPart === "messages") {
    const limit = Number(event.queryStringParameters?.limit) || 200;
    const arr = [];
    const list = await store().list({ prefix: "room:" });
    for (const item of (list?.blobs || [])) {
      const key = item.key.replace("room:", "");
      const isGroup = key.startsWith("g:");
      const group = groups[key];
      const room = (await readState(item.key)) || [];
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
    return json(200, { messages: arr.slice(0, Math.min(limit, 500)) });
  }

  // ---- 文件 ----
  if (method === "GET" && pathPart === "files") {
    const list = Object.values(files).map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size,
      createdAt: f.createdAt,
      expiresAt: f.expiresAt,
      ownerName: users[f.ownerId] ? users[f.ownerId].username : "未知",
    }));
    return json(200, { files: list });
  }

  if (method === "POST" && (pathPart === "delete-file" || (event.path || "").endsWith("/files/delete"))) {
    const meta = files[String(body.id || "")];
    if (!meta) return json(404, { error: "not-found" });
    delete files[meta.id];
    await writeState("files", files);
    try { await store().delete(`blob:${meta.id}`); } catch { /* ignore */ }
    return json(200, {});
  }

  // ---- 维护 ----
  if (method === "POST" && pathPart === "cleanup") {
    let removed = 0;
    const now = Date.now();
    for (const [fid, meta] of Object.entries(files)) {
      if (now > meta.expiresAt) {
        delete files[fid];
        try { await store().delete(`blob:${fid}`); } catch { /* ignore */ }
        removed++;
      }
    }
    await writeState("files", files);
    return json(200, { removed });
  }

  if (method === "POST" && pathPart === "cleanup-tokens") {
    const tokens = (await readState("tokens")) || {};
    let removed = 0;
    for (const [t, uidv] of Object.entries(tokens)) {
      if (!users[uidv]) { delete tokens[t]; removed++; }
    }
    await writeState("tokens", tokens);
    const sessions = (await readState("adminSessions")) || {};
    for (const [t, exp] of Object.entries(sessions)) {
      if (Date.now() > exp) { delete sessions[t]; removed++; }
    }
    await writeState("adminSessions", sessions);
    return json(200, { removed });
  }

  // ---- 广播 ----
  if (method === "POST" && pathPart === "broadcast") {
    const text = String(body.text || "").trim().slice(0, 500);
    if (!text) return json(400, { error: "empty" });
    const online = await onlineUserIds();
    for (const uidv of online) await pushUser(uidv, "system.broadcast", { text, by: "admin" });
    return json(200, { sent: online.length });
  }

  // ---- 更新发布（分块上传 zip 到 Blobs，供客户端自动更新） ----
  // 因 Netlify Blobs 无预签名 URL，采用分块上传：POST update 建会话 → POST chunk 传块 → POST finalize 合并
  if (method === "POST" && pathPart === "update") {
    const version = String(body.version || "").trim();
    if (!/^[\w.\-]+$/.test(version)) return json(400, { error: "bad-version" });
    const size = Number(body.size) || 0;
    if (size > 50 * 1024 * 1024) return json(413, { error: "too-large" });
    const hasZip = size > 0;
    if (!hasZip) {
      // 仅设置当前版本号（不上传 zip）
      await writeState("update:meta", {
        version,
        notes: String(body.notes || "").slice(0, 1000),
        name: "ayanball-update.zip",
        size: 0, hasZip: false,
        uploadedAt: Date.now(),
        downloadUrl: "/.netlify/functions/update?download=1",
      });
      console.log(`[更新发布] v${version}（仅设版本） by admin`);
      return json(200, { ok: true, hasZip: false });
    }
    // 有 zip：开启分块上传会话
    const uploadId = uid("u_");
    const totalChunks = Math.max(1, Math.ceil(size / UPDATE_CHUNK));
    await writeState(`update:draft:${uploadId}`, {
      uploadId, version,
      notes: String(body.notes || "").slice(0, 1000),
      name: String(body.name || "ayanball-update.zip"),
      size, totalChunks, uploaded: 0,
    });
    console.log(`[更新发布] v${version} 分块会话 ${uploadId}（${totalChunks} 块） by admin`);
    return json(200, { ok: true, hasZip: true, uploadId, chunkSize: UPDATE_CHUNK, totalChunks });
  }

  // ---- 上传单个分块（base64，每块原始 ≤3MB） ----
  if (method === "POST" && pathPart === "chunk") {
    const { uploadId, index, data } = body;
    const draft = await readState(`update:draft:${uploadId}`);
    if (!draft) return json(404, { error: "no-draft" });
    if (typeof data !== "string" || !data) return json(400, { error: "no-data" });
    const idx = Number(index);
    if (Number.isNaN(idx) || idx < 0 || idx >= draft.totalChunks) return json(400, { error: "bad-index" });
    await store().set(`updatec:${uploadId}:${idx}`, Buffer.from(data, "base64"));
    draft.uploaded = (draft.uploaded || 0) + 1;
    await writeState(`update:draft:${uploadId}`, draft);
    return json(200, { ok: true, index: idx, uploaded: draft.uploaded, total: draft.totalChunks });
  }

  // ---- 合并分块，写入 updatezip blob 并发布 ----
  if (method === "POST" && pathPart === "finalize") {
    const uploadId = String(body.uploadId || "");
    const draft = await readState(`update:draft:${uploadId}`);
    if (!draft) return json(404, { error: "no-draft" });
    const parts = [];
    for (let i = 0; i < draft.totalChunks; i++) {
      const raw = await store().get(`updatec:${uploadId}:${i}`, { type: "arrayBuffer" });
      if (raw == null) return json(400, { error: "missing-chunk-" + i });
      parts.push(Buffer.from(raw));
    }
    const buf = Buffer.concat(parts);
    await store().set("updatezip", buf);
    for (let i = 0; i < draft.totalChunks; i++) { try { await store().delete(`updatec:${uploadId}:${i}`); } catch { /* ignore */ } }
    await writeState(`update:draft:${uploadId}`, null);
    await writeState("update:meta", {
      version: draft.version, notes: draft.notes, name: draft.name,
      size: draft.size, hasZip: true, uploadedAt: Date.now(),
      downloadUrl: "/.netlify/functions/update?download=1",
    });
    console.log(`[更新发布] v${draft.version}（含安装包 ${draft.size} 字节） by admin`);
    return json(200, { ok: true, version: draft.version, size: draft.size });
  }

  // ---- 清除已发布更新（撤销发布） ----
  if (method === "DELETE" && pathPart === "update") {
    await writeState("update:meta", null);
    try { await store().delete("updatezip"); } catch { /* ignore */ }
    console.log("[更新清除] by admin");
    return json(200, { ok: true });
  }

  return json(404, { error: "not-found" });
};

// ---------------- 内部工具 ----------------
/** 在线用户：HTTP 心跳 lastSeen（客户端每 30s ping），60 秒内视为在线 */
async function onlineUserIds() {
  const users = (await readState("users")) || {};
  const now = Date.now();
  const ids = [];
  for (const id of Object.keys(users)) {
    const last = await readState(`lastSeen:${id}`);
    if (last && now - last <= ONLINE_WINDOW_MS) ids.push(id);
  }
  return ids;
}

async function pushUser(userId, action, payload) {
  const p = pusherClient();
  if (!p) return;
  try {
    await p.trigger(`private-user_${userId}`, action, payload);
  } catch { /* ignore */ }
}

async function pushGroupUpdate(g) {
  const users = (await readState("users")) || {};
  const p = pusherClient();
  if (!p) return;
  const payload = {
    id: g.id,
    name: g.name,
    code: g.code,
    ownerId: g.ownerId,
    adminIds: g.adminIds || [],
    memberCount: g.memberIds.length,
    members: g.memberIds.map((id) => {
      const u = users[id];
      return u ? { id: u.id, username: u.username, nickname: u.nickname, avatar: avatarOf(u) } : null;
    }).filter(Boolean),
    createdAt: g.createdAt,
  };
  for (const mid of g.memberIds) {
    try {
      await p.trigger(`private-user_${mid}`, "group.updated", { group: payload });
    } catch { /* ignore */ }
  }
}

async function deleteUserCompletely(targetId) {
  const users = (await readState("users")) || {};
  const tokens = (await readState("tokens")) || {};
  const groups = (await readState("groups")) || {};
  const requests = (await readState("requests")) || {};
  if (!users[targetId]) return false;
  for (const [t, uidv] of Object.entries(tokens)) if (uidv === targetId) delete tokens[t];
  await writeState("tokens", tokens);
  for (const uidv of Object.keys(users)) {
    await mutate(`friends:${uidv}`, (l) => l.filter((x) => x !== targetId), []);
    await mutate(`blocked:${uidv}`, (l) => l.filter((x) => x !== targetId), []);
  }
  await writeState(`friends:${targetId}`, []);
  await writeState(`blocked:${targetId}`, []);
  for (const [rid, r] of Object.entries(requests)) {
    if (r.fromId === targetId || r.toId === targetId) delete requests[rid];
  }
  await writeState("requests", requests);
  for (const g of Object.values(groups)) {
    g.memberIds = g.memberIds.filter((x) => x !== targetId);
  }
  await writeState("groups", groups);
  delete users[targetId];
  await writeState("users", users);
  return true;
}
