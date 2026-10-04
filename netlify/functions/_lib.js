// ================= AyanBall Chat · Netlify 共享库 =================
// 数据持久化：Netlify Blobs（分 key 存储，减少并发竞争）
// 实时推送：Pusher（消息频道 conv_* / 个人频道 user_* / 通话频道 call_*，均 private- 前缀）
const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const FILE_TTL_MS = 3 * 24 * 3600 * 1000; // 3 天
const HISTORY_LIMIT = 50;
const MAX_GROUP_MEMBERS = 100; // 普通群上限 100 人
// 管理密码：仅从环境变量 ADMIN_KEY 读取（高强度，不硬编码、不外显）；未设置则禁止登录
const ADMIN_PASSWORD = process.env.ADMIN_KEY || "";

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

// ---------------- Vercel KV 存储后端 ----------------
let _kv = null;
function hasKv() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}
function kv() {
  if (!_kv) {
    const { createClient } = require("@vercel/kv");
    _kv = createClient({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  }
  return _kv;
}

/** 本地开发兜底：无 KV/Netlify env 时用内存 Map，便于函数逻辑自测 */
const _mem = new Map();
function hasNetlify() {
  return !!(process.env.NETLIFY_SITE_ID || process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID);
}
function memReadState(key) {
  const v = _mem.get(key);
  return v === undefined ? null : v;
}
function memWriteState(key, val) {
  _mem.set(key, val);
}

/** 读取 JSON 状态（分 key） */
async function readState(key) {
  if (hasKv()) {
    try { return await kv().get(key); } catch { return null; }
  }
  if (!hasNetlify()) return memReadState(key);
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
    if (hasKv()) await kv().set(key, val);
    else if (!hasNetlify()) await memWriteState(key, val);
    else await store().set(key, JSON.stringify(val));
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

// ---------------- Vercel Blob 文件存储（更新包 zip / 大文件） ----------------
const { Blob } = require("@vercel/blob");
async function putBlob(key, buf) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) { console.error("[putBlob] missing BLOB_READ_WRITE_TOKEN"); throw new Error("no-blob-token"); }
  const b = await Blob.put(key, Buffer.from(buf), { access: "public", token: process.env.BLOB_READ_WRITE_TOKEN, addRandomSuffix: false });
  return b.url;
}
async function delBlob(url) {
  if (!url || !process.env.BLOB_READ_WRITE_TOKEN) return;
  try { await Blob.del(url, { token: process.env.BLOB_READ_WRITE_TOKEN }); } catch { /* ignore */ }
}
async function getBlobBytes(url) {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

/** 按前缀列出所有 key（跨后端：Vercel KV scan / Netlify list / 本地内存） */
async function listKeys(prefix) {
  if (hasKv()) {
    const keys = [];
    let cursor = "0";
    try {
      do {
        const r = await kv().scan(cursor, { match: prefix + "*", count: 100 });
        keys.push(...(r.keys || []));
        cursor = r.cursor;
      } while (cursor && cursor !== "0");
    } catch (e) {
      console.error("[listKeys-scan]", e.message);
    }
    return keys;
  }
  if (!hasNetlify()) return Array.from(_mem.keys()).filter((k) => k.startsWith(prefix));
  try {
    const list = await store().list({ prefix });
    return (list?.blobs || []).map((b) => b.key);
  } catch {
    return [];
  }
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

// ---------------- Vercel Functions 适配层 ----------------
// Vercel Node 函数是 (req,res)，Netlify 是 exports.handler(event)->{statusCode,headers,body}。
// vercelize 把 Vercel 的 req/res 转成 Netlify 风格 event，调用原 handler，再把返回值写回 res。
function vercelize(fn) {
  return async function (req, res) {
    try {
      let body = "";
      if (req.body != null) {
        body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      }
      const event = {
        httpMethod: req.method || "GET",
        queryStringParameters: req.query || {},
        headers: req.headers || {},
        body,
      };
      const out = await fn(event);
      res.status(out.statusCode || 200);
      for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
      res.send(out.body);
    } catch (e) {
      console.error("[vercelize]", e);
      res.status(500).json({ error: "internal" });
    }
  };
}

module.exports = {
  store, readState, writeState, mutate, listKeys, putBlob, delBlob, getBlobBytes,
  uid, hashPwd, safeName, genAbcId,
  publicUser, avatarOf, roomKeyFor, preview, groupPayload, groupRole,
  resolveRoomsFor, json, readBody, authed, vercelize,
  MAX_FILE_SIZE, FILE_TTL_MS, HISTORY_LIMIT, MAX_GROUP_MEMBERS, ADMIN_PASSWORD,
};
