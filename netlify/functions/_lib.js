// ================= AyanBall Chat · Netlify 共享库 =================
// 数据持久化：Netlify Blobs（分 key 存储，减少并发竞争）
// 实时推送：Pusher（消息频道 conv_* / 个人频道 user_* / 通话频道 call_*，均 private- 前缀）
const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const FILE_TTL_MS = 3 * 24 * 3600 * 1000; // 3 天
const HISTORY_LIMIT = 50;
const MAX_GROUP_MEMBERS = 100; // 普通群上限 100 人
const ADMIN_PASSWORD = process.env.ADMIN_KEY || "ayanball-admin";

let _store = null;
function store() {
  if (!_store) {
    const ks = Object.keys(process.env).filter((k) => /NETLIFY|BLOBS|SITE|TOKEN|DEPLOY/i.test(k));
    console.log("[blobs-env-keys]", ks.join(","));
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE;
    const tok = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN || process.env.BLOBS_TOKEN;
    console.log("[blobs-creds]", "siteID=" + (siteID ? "set" : "MISSING"), "token=" + (tok ? "set" : "MISSING"));
    try {
      _store = getStore({ name: "ayanball", ...(siteID ? { siteID } : {}), ...(tok ? { token: tok } : {}) });
    } catch (e) {
      console.log("[blobs-getstore-error]", e.message);
      throw e;
    }
  }
  return _store;
}

/** 读取 JSON 状态（分 key） */
async function readState(key) {
  try {
    const v = await store().get(key, { type: "json" });
    return v == null ? null : v;
  } catch {
    return null;
  }
}

/** 写入 JSON 状态（整个 key 原子覆盖） */
async function writeState(key, val) {
  try {
    await store().set(key, JSON.stringify(val));
  } catch (e) {
    console.error("[writeState]", key, e.message);
  }
}

/** 乐观读-改-写（低频数据用） */
async function mutate(key, fn, def) {
  const cur = (await readState(key)) ?? def;
  const next = fn(cur) ?? cur;
  await writeState(key, next);
  return next;
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
function safeName(name) {
  return String(name || "file").replace(/[^\w.\u4e00-\u9fa5-]/g, "_").slice(0, 120);
}
/** 生成唯一 ABC 号：6 位大写字母+数字（去掉易混的 0/O/1/I） */
function genAbcId(existing = []) {
  const pool = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const set = new Set(existing.map((v) => String(v).toUpperCase()));
  for (let attempt = 0; attempt < 200; attempt++) {
    let s = "";
    for (let i = 0; i < 6; i++) s += pool[Math.floor(Math.random() * pool.length)];
    if (!set.has(s)) return s;
  }
  return "A" + Date.now().toString(36).toUpperCase().slice(-5);
}
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, nickname: u.nickname, avatar: u.avatar || "p1",
    admin: !!u.admin, createdAt: u.createdAt,
    abcId: u.abcId || "", // 唯一 ABC 号
    banned: u.banned || null, // { at, reason, by }
    muted: u.muted || null,   // { at, reason, by }
  };
}
function avatarOf(u) {
  return u ? u.avatar || "p1" : "p1";
}
function roomKeyFor(a, b) {
  return `dm:${[a, b].sort().join(":")}`;
}
function preview(m) {
  return m.kind === "file" ? `[${m.file?.name || "file"}]` : m.content;
}

/** 群信息（带成员/管理员） */
function groupPayload(g, users) {
  return {
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
}

/** 群成员操作权限 */
function groupRole(g, userId) {
  if (g.ownerId === userId) return "owner";
  if ((g.adminIds || []).includes(userId)) return "admin";
  if (g.memberIds.includes(userId)) return "member";
  return "none";
}

/** 某用户全部会话 + 历史消息（auth 时一次性下发） */
async function resolveRoomsFor(userId, users, groups, roomsMap) {
  const result = [];
  const seen = new Set();
  const me = users[userId];
  if (!me) return [];
  const blocked = (await readState(`blocked:${userId}`)) || [];

  for (const [key, msgs] of Object.entries(roomsMap)) {
    if (key.startsWith("g:")) continue;
    const [a, b] = key.replace("dm:", "").split(":");
    // 双方向可见：会话双方都能在自己的会话列表看到该会话
    if (a !== userId && b !== userId) continue;
    const peerId = a === userId ? b : a;
    const peer = users[peerId];
    if (!peer) continue;
    const convId = `dm:${peerId}`;
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
        avatar: avatarOf(peer),
        lastMsg: last ? preview(last) : "",
        lastTs: last ? last.ts : 0,
        unread: 0,
        blocked: blocked.includes(peerId),
      },
      msgs: msgs.slice(-HISTORY_LIMIT).map((m) => ({ ...m, convId, mine: m.senderId === userId })),
    });
  }

  for (const g of Object.values(groups)) {
    if (!g.memberIds.includes(userId)) continue;
    const convId = `g:${g.id}`;
    const msgs = roomsMap[g.id] || [];
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

// ---------------- HTTP 工具 ----------------
function json(status, obj) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    },
    body: JSON.stringify(obj),
  };
}
function readBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return {};
  }
}
function authed(event) {
  const auth = String((event.headers.authorization || "").replace("Bearer ", ""));
  return auth || null;
}

module.exports = {
  store, readState, writeState, mutate, uid, hashPwd, safeName, genAbcId,
  publicUser, avatarOf, roomKeyFor, preview, groupPayload, groupRole,
  resolveRoomsFor, json, readBody, authed,
  MAX_FILE_SIZE, FILE_TTL_MS, HISTORY_LIMIT, MAX_GROUP_MEMBERS, ADMIN_PASSWORD,
};
