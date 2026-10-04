// ================= AyanBall Chat · Netlify 动态业务 API =================
// 统一入口：POST /.netlify/functions/api  body: { action, payload }
// 认证：Authorization: Bearer <token>
// 实时推送：Pusher Channels（private-user_* 个人事件 / private-conv_* 消息 / private-call_* 通话信令）
const Pusher = require("pusher");
const {
  readState, writeState, mutate, listKeys, uid, hashPwd, publicUser, avatarOf, genAbcId,
  roomKeyFor, preview, groupPayload, groupRole, resolveRoomsFor,
  json, readBody, authed,
  MAX_FILE_SIZE, FILE_TTL_MS, HISTORY_LIMIT, MAX_GROUP_MEMBERS,
} = require("./_lib.js");

// ---------------- Pusher 推送 ----------------
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

/** Ably 风格频道名 → Pusher 频道名：冒号换下划线，加 private- 前缀（Pusher 频道名不允许冒号） */
function pusherChannel(name) {
  return "private-" + name.replace(/:/g, "_");
}

/** Pusher 事件体上限 10KB：递归截断长字符串，防止超大消息/群信息推送失败 */
function sanitize(obj, depth = 0) {
  if (obj == null) return obj;
  if (typeof obj === "string") return obj.slice(0, 2800);
  if (Array.isArray(obj)) return obj.map((x) => sanitize(x, depth + 1));
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = sanitize(v, depth + 1);
    return out;
  }
  return obj;
}

async function publish(channel, event, data) {
  const p = pusherClient();
  if (!p) return;
  try {
    await p.trigger(pusherChannel(channel), event, sanitize(data));
  } catch (e) {
    console.error("[pusher.publish]", channel, e.message);
  }
}
async function pushTo(userId, action, payload) {
  await publish(`user:${userId}`, action, payload);
}
async function pushConv(convChannel, action, payload) {
  await publish(`conv:${convChannel}`, action, payload);
}

/** 在线判断：HTTP 心跳（ping 写 lastSeen），60 秒内视为在线（Pusher REST 无 presence 成员查询） */
const ONLINE_WINDOW_MS = 60000;
async function isOnline(userId) {
  const last = await readState(`lastSeen:${userId}`);
  return !!last && Date.now() - last <= ONLINE_WINDOW_MS;
}

// ---------------- 会话数据读取 ----------------
async function loadUsers() { return (await readState("users")) || {}; }
async function loadTokens() { return (await readState("tokens")) || {}; }
async function loadGroups() { return (await readState("groups")) || {}; }
async function loadRequests() { return (await readState("requests")) || {}; }

/** 读取某用户全部会话（分 key 存储的 room） */
async function loadRoomsMap() {
  const map = {};
  const keys = await listKeys("room:");
  for (const key of keys) {
    const v = await readState(key);
    if (v) map[key.replace("room:", "")] = v;
  }
  return map;
}
async function loadRoom(key) { return (await readState(`room:${key}`)) || []; }
async function saveRoom(key, room) { await writeState(`room:${key}`, room.slice(-500)); }

async function loadFriends(userId) { return (await readState(`friends:${userId}`)) || []; }
async function loadBlocked(userId) { return (await readState(`blocked:${userId}`)) || []; }

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(404, { error: "not-found" });

  const { action, payload = {} } = readBody(event);
  const token = authed(event);
  const tokens = await loadTokens();
  const userId = tokens[token] || null;
  const users = await loadUsers();
  const me = userId ? users[userId] : null;

  // 需要登录的 action 统一校验
  const authedActions = new Set([
    "auth", "friend.search", "friend.request", "friend.accept", "friend.reject",
    "friend.remove", "profile.setAvatar", "profile.setNickname", "block.add", "block.remove",
    "group.create", "group.join", "group.leave", "group.setAdmin", "group.kick",
    "group.invite", "group.dissolve", "group.transfer", "message.send",
    "call.offer", "call.answer", "call.ice", "call.hangup", "admin.promote", "ping",
    "feedback.submit", "report.submit",
  ]);
  const fail = (code) => json(400, { error: code });

  try {
    // ============ 认证 ============
    // 客户端实时配置（Pusher key/cluster 公开可读，仅密钥保密）
    if (action === "config") {
      return json(200, {
        pusher: {
          key: process.env.PUSHER_KEY || "",
          cluster: process.env.PUSHER_CLUSTER || "mt1",
        },
      });
    }

    if (action === "auth.register") {
      const username = String(payload.username || "").trim();
      const password = String(payload.password || "");
      if (username.length < 2 || password.length < 6) return fail("invalid");
      if (Object.values(users).some((u) => u.username === username)) return fail("taken");
      const salt = cryptoRandomBytes();
      const isFirst = Object.keys(users).length === 0; // 首个用户自动成为管理员
      const user = {
        id: uid("u_"),
        username,
        abcId: genAbcId(Object.values(users).map((u) => u.abcId).filter(Boolean)), // 唯一 ABC 号，冲突自动重生成
        nickname: String(payload.nickname || "").trim() || username,
        avatar: String(payload.avatar || "p1").slice(0, 20000),
        passwordHash: hashPwd(password, salt),
        salt,
        admin: isFirst,
        createdAt: Date.now(),
      };
      users[user.id] = user;
      await writeState("users", users);
      const t = uid("t_");
      tokens[t] = user.id;
      await writeState("tokens", tokens);
      console.log(`[注册] ${username}${isFirst ? " (首个用户 -> 管理员)" : ""}`);
      return json(200, { token: t, user: publicUser(user) });
    }

    if (action === "auth.login") {
      const username = String(payload.username || "").trim();
      const password = String(payload.password || "");
      const user = Object.values(users).find((u) => u.username === username);
      if (!user || user.passwordHash !== hashPwd(password, user.salt)) return fail("credential");
      // 封号检查：被管理员封禁的账号拒绝登录，并返回封禁原因
      if (user.banned) {
        return json(403, { error: "banned", reason: user.banned.reason || "", bannedAt: user.banned.at || 0, by: user.banned.by || "" });
      }
      // 老账号若没有 ABC 号则补发唯一号（注册更早的用户）
      if (!user.abcId) {
        user.abcId = genAbcId(Object.values(users).map((u) => u.abcId).filter(Boolean));
        await writeState("users", users);
      }
      const t = uid("t_");
      tokens[t] = user.id;
      await writeState("tokens", tokens);
      console.log(`[登录] ${username}`);
      return json(200, { token: t, user: publicUser(user) });
    }

    if (!me || !authedActions.has(action)) {
      return json(401, { error: "unauthorized" });
    }

    if (action === "auth") {
      const blockedIds = await loadBlocked(userId);
      const friends = (await loadFriends(userId))
        .map((fid) => {
          const f = users[fid];
          return f ? { id: f.id, username: f.username, nickname: f.nickname, avatar: avatarOf(f), addedAt: 0, blocked: blockedIds.includes(fid) } : null;
        })
        .filter(Boolean);
      const requests = Object.values(await loadRequests()).filter(
        (r) => r.toId === userId || r.fromId === userId,
      );
      const groups = Object.values(await loadGroups()).filter((g) => g.memberIds.includes(userId)).map((g) => groupPayload(g, users));
      const rooms = await resolveRoomsFor(userId, users, await loadGroups(), await loadRoomsMap());
      return json(200, { user: publicUser(me), friends, groups, requests, blocked: await loadBlocked(userId), rooms });
    }

    if (action === "ping") {
      await writeState(`lastSeen:${userId}`, Date.now());
      return json(200, { ok: true });
    }

    // ============ 好友 ============
    if (action === "friend.search") {
      const q = String(payload.username || "").trim();
      if (!q) return fail("invalid");
      const ql = q.toLowerCase();
      // 支持：用户名 / 昵称 / ABC 号 匹配
      const target = Object.values(users).find(
        (u) => u.id !== userId && (
          u.username.toLowerCase() === ql ||
          u.nickname.toLowerCase() === ql ||
          (u.abcId && u.abcId.toUpperCase() === q.toUpperCase())
        ),
      );
      if (!target) return fail("not-found");
      return json(200, { user: publicUser(target) });
    }

    if (action === "friend.request") {
      const toId = String(payload.toId || "");
      const to = users[toId];
      if (!to) return fail("not-found");
      if ((await loadFriends(userId)).includes(toId)) return fail("already-friend");
      const requests = await loadRequests();
      const dup = Object.values(requests).some((r) => r.fromId === userId && r.toId === toId && r.status === "pending");
      if (dup) return fail("duplicate");
      const req = { id: uid("r_"), fromId: userId, toId, status: "pending", ts: Date.now() };
      requests[req.id] = req;
      await writeState("requests", requests);
      const from = users[userId];
      await pushTo(toId, "friend.request", { id: req.id, fromId: userId, fromUsername: from.username, fromNickname: from.nickname, fromAvatar: avatarOf(from), toId, status: "pending", ts: req.ts });
      return json(200, { request: { id: req.id, fromId: userId, fromUsername: from.username, fromNickname: from.nickname, fromAvatar: avatarOf(from), toId, status: "pending", ts: req.ts } });
    }

    if (action === "friend.accept") {
      const requests = await loadRequests();
      const req = requests[String(payload.requestId || "")];
      if (!req || req.toId !== userId || req.status !== "pending") return fail("bad-request");
      req.status = "accepted";
      await writeState("requests", requests);
      await mutate(`friends:${userId}`, (l) => { if (!l.includes(req.fromId)) l.push(req.fromId); return l; }, []);
      await mutate(`friends:${req.fromId}`, (l) => { if (!l.includes(userId)) l.push(userId); return l; }, []);
      const from = users[req.fromId];
      const to = users[req.toId];
      await pushTo(req.fromId, "friend.accepted", { id: to.id, username: to.username, nickname: to.nickname, avatar: avatarOf(to), addedAt: Date.now(), blocked: false });
      return json(200, { friend: { id: from.id, username: from.username, nickname: from.nickname, avatar: avatarOf(from), addedAt: Date.now(), blocked: false } });
    }

    if (action === "friend.reject") {
      const requests = await loadRequests();
      const req = requests[String(payload.requestId || "")];
      if (!req || req.toId !== userId || req.status !== "pending") return fail("bad-request");
      req.status = "rejected";
      await writeState("requests", requests);
      await pushTo(req.fromId, "friend.rejected", {});
      return json(200, {});
    }

    if (action === "friend.remove") {
      const fid = String(payload.friendId || "");
      await mutate(`friends:${userId}`, (l) => l.filter((x) => x !== fid), []);
      await mutate(`friends:${fid}`, (l) => l.filter((x) => x !== userId), []);
      await pushTo(fid, "friend.removed", { friendId: userId });
      return json(200, {});
    }

    // ============ 个人资料 ============
    if (action === "profile.setNickname") {
      const raw = String(payload.nickname || "").trim().slice(0, 32);
      if (!raw) return fail("invalid");
      me.nickname = raw;
      await writeState("users", users);
      const myId = userId;
      for (const otherId of Object.keys(users)) {
        const fs = await loadFriends(otherId);
        if (fs.includes(myId)) await pushTo(otherId, "profile.updated", { user: publicUser(me) });
      }
      return json(200, { user: publicUser(me) });
    }

    if (action === "profile.setAvatar") {
      const raw = String(payload.avatar || "").slice(0, 20000);
      if (!raw) return fail("invalid");
      me.avatar = raw;
      await writeState("users", users);
      // 通知所有好友刷新资料
      const myId = userId;
      for (const otherId of Object.keys(users)) {
        const fs = await loadFriends(otherId);
        if (fs.includes(myId)) await pushTo(otherId, "profile.updated", { user: publicUser(me) });
      }
      return json(200, { user: publicUser(me) });
    }

    // ============ 拉黑 ============
    if (action === "block.add") {
      const targetId = String(payload.userId || "");
      await mutate(`blocked:${userId}`, (l) => { if (!l.includes(targetId)) l.push(targetId); return l; }, []);
      await mutate(`friends:${userId}`, (l) => l.filter((x) => x !== targetId), []);
      await mutate(`friends:${targetId}`, (l) => l.filter((x) => x !== userId), []);
      await pushTo(targetId, "blocked", { userId });
      return json(200, {});
    }

    if (action === "block.remove") {
      const targetId = String(payload.userId || "");
      await mutate(`blocked:${userId}`, (l) => l.filter((x) => x !== targetId), []);
      return json(200, {});
    }

    // ============ 群聊 ============
    if (action === "group.create") {
      const name = String(payload.name || "").trim();
      if (!name) return fail("invalid");
      const groups = await loadGroups();
      const g = {
        id: uid("g_"),
        name,
        code: cryptoRandomHex(),
        ownerId: userId,
        memberIds: [userId],
        adminIds: [userId],
        createdAt: Date.now(),
      };
      groups[g.id] = g;
      await writeState("groups", groups);
      await writeState(`room:g:${g.id}`, []);
      await pushTo(userId, "group.new", groupPayload(g, users));
      console.log(`[建群] ${name} (${g.code}) by ${me.username}`);
      return json(200, { group: groupPayload(g, users) });
    }

    if (action === "group.join") {
      const code = String(payload.code || "").trim().toUpperCase();
      const groups = await loadGroups();
      const g = Object.values(groups).find((x) => x.code === code);
      if (!g) return fail("bad-code");
      if (g.memberIds.includes(userId)) return fail("already-in-group");
      if (g.memberIds.length >= MAX_GROUP_MEMBERS) return fail("group-full");
      if ((await loadBlocked(userId)).includes(g.ownerId)) return fail("blocked-by-you");
      if ((await loadBlocked(g.ownerId)).includes(userId)) return fail("blocked-by-owner");
      g.memberIds.push(userId);
      await writeState("groups", groups);
      for (const mid of g.memberIds) await pushTo(mid, "group.new", groupPayload(g, users));
      console.log(`[加群] ${me.username} -> ${g.name} (${g.code})`);
      return json(200, { group: groupPayload(g, users) });
    }

    if (action === "group.leave") {
      const groups = await loadGroups();
      const g = groups[String(payload.groupId || "")];
      if (!g) return fail("bad-group");
      if (g.ownerId === userId) return fail("owner-cannot-leave");
      g.memberIds = g.memberIds.filter((x) => x !== userId);
      g.adminIds = (g.adminIds || []).filter((x) => x !== userId);
      await writeState("groups", groups);
      await pushTo(userId, "group.removed", { groupId: g.id });
      if (g.memberIds.length === 0) {
        delete groups[g.id];
        await writeState("groups", groups);
        await writeState(`room:g:${g.id}`, []);
      } else {
        await pushGroupUpdate(g, users);
      }
      return json(200, {});
    }

    // ---- 群管理 ----
    if (action === "group.setAdmin") {
      const groups = await loadGroups();
      const g = groups[String(payload.groupId || "")];
      if (!g) return fail("bad-group");
      const role = groupRole(g, userId);
      if (role === "none") return fail("not-in-group");
      if (role === "member") return fail("forbidden");
      const targetId = String(payload.userId || "");
      const wantAdmin = !!payload.admin;
      if (targetId === g.ownerId) return fail("cannot-modify-owner");
      if (!g.memberIds.includes(targetId)) return fail("not-member");
      if (role !== "owner" && (wantAdmin === false || (g.adminIds || []).includes(targetId))) return fail("forbidden");
      if (wantAdmin) {
        if (!(g.adminIds || []).includes(targetId)) g.adminIds.push(targetId);
      } else {
        g.adminIds = (g.adminIds || []).filter((x) => x !== targetId);
      }
      await writeState("groups", groups);
      await pushGroupUpdate(g, users);
      console.log(`[群管理] ${me.username} ${wantAdmin ? "设为管理员" : "撤销管理员"} @ ${g.name}`);
      return json(200, { group: groupPayload(g, users) });
    }

    if (action === "group.kick") {
      const groups = await loadGroups();
      const g = groups[String(payload.groupId || "")];
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
      await writeState("groups", groups);
      await pushTo(targetId, "group.kicked", { groupId: g.id });
      if (g.memberIds.length === 0) {
        delete groups[g.id];
        await writeState("groups", groups);
        await writeState(`room:g:${g.id}`, []);
      } else {
        await pushGroupUpdate(g, users);
      }
      console.log(`[群管理] ${me.username} 踢出 @ ${g.name}`);
      return json(200, { group: groupPayload(g, users) });
    }

    if (action === "group.invite") {
      const groups = await loadGroups();
      const g = groups[String(payload.groupId || "")];
      if (!g) return fail("bad-group");
      const role = groupRole(g, userId);
      if (role === "none") return fail("not-in-group");
      if (role === "member") return fail("forbidden");
      const target = Object.values(users).find((u) => u.username === String(payload.username || "").trim());
      if (!target) return fail("not-found");
      if (g.memberIds.includes(target.id)) return fail("already-in-group");
      if (g.memberIds.length >= MAX_GROUP_MEMBERS) return fail("group-full");
      if ((await loadBlocked(userId)).includes(target.id)) return fail("blocked-by-you");
      if ((await loadBlocked(target.id)).includes(userId)) return fail("blocked-by-target");
      g.memberIds.push(target.id);
      await writeState("groups", groups);
      await pushTo(target.id, "group.new", groupPayload(g, users));
      await pushGroupUpdate(g, users);
      console.log(`[群管理] ${me.username} 邀请 ${target.username} -> ${g.name}`);
      return json(200, { group: groupPayload(g, users) });
    }

    if (action === "group.dissolve") {
      const groups = await loadGroups();
      const g = groups[String(payload.groupId || "")];
      if (!g) return fail("bad-group");
      if (g.ownerId !== userId) return fail("owner-only");
      for (const mid of g.memberIds) await pushTo(mid, "group.removed", { groupId: g.id });
      delete groups[g.id];
      await writeState("groups", groups);
      await writeState(`room:g:${g.id}`, []);
      console.log(`[群管理] ${me.username} 解散群: ${g.name}`);
      return json(200, {});
    }

    if (action === "group.transfer") {
      const groups = await loadGroups();
      const g = groups[String(payload.groupId || "")];
      if (!g) return fail("bad-group");
      if (g.ownerId !== userId) return fail("owner-only");
      const targetId = String(payload.userId || "");
      if (targetId === userId) return fail("cannot-transfer-self");
      if (!g.memberIds.includes(targetId)) return fail("not-member");
      g.ownerId = targetId;
      if (!(g.adminIds || []).includes(targetId)) g.adminIds.push(targetId);
      await writeState("groups", groups);
      await pushGroupUpdate(g, users);
      console.log(`[群管理] ${me.username} 转让群主给 @ ${g.name}`);
      return json(200, { group: groupPayload(g, users) });
    }

    // ============ 消息 ============
    if (action === "message.send") {
      // 禁言检查：被禁言的账号可登录、可接收消息，但不能发送
      if (me.muted) {
        return json(403, { error: "muted", reason: me.muted.reason || "", mutedAt: me.muted.at || 0 });
      }
      const roomId = String(payload.roomId || "");
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
        kind, content, file,
        ts: Date.now(),
      };

      // 群聊
      const groups = await loadGroups();
      const group = groups[roomId];
      if (group) {
        if (!group.memberIds.includes(userId)) return fail("not-in-group");
        const room = await loadRoom(`g:${group.id}`);
        msg.roomId = roomId;
        room.push(msg);
        await saveRoom(`g:${group.id}`, room);
        const convId = `g:${group.id}`;
        await pushConv(`g:${group.id}`, "message.new", { convId, roomId: group.id, msg });
        return json(200, { msg: { ...msg, convId, roomId: group.id, mine: true } });
      }

      // 私聊
      const peerId = roomId;
      const peer = users[peerId];
      if (!peer) return fail("no-peer");
      if ((await loadBlocked(userId)).includes(peerId)) return fail("blocked-by-you");
      if ((await loadBlocked(peerId)).includes(userId)) return fail("blocked-by-peer");
      const key = roomKeyFor(userId, peerId);
      const room = await loadRoom(key);
      msg.roomId = peerId;
      room.push(msg);
      await saveRoom(key, room);
      // 发送者视角频道
      await pushConv(`dm:${userId}`, "message.new", { convId: `dm:${peerId}`, roomId: peerId, msg: { ...msg, mine: true } });
      // 接收者视角频道
      await pushConv(`dm:${peerId}`, "message.new", { convId: `dm:${userId}`, roomId: userId, msg: { ...msg, mine: false } });
      return json(200, { msg: { ...msg, convId: `dm:${peerId}`, roomId: peerId, mine: true } });
    }

    // ============ 通话信令 ============
    if (action === "call.offer") {
      const toId = String(payload.to || "");
      const to = users[toId];
      if (!to) return fail("no-peer");
      if (!(await isOnline(toId))) return fail("peer-offline");
      const activeCalls = (await readState("activeCalls")) || {};
      if (activeCalls[toId]) return fail("busy");
      activeCalls[userId] = toId;
      activeCalls[toId] = userId;
      await writeState("activeCalls", activeCalls);
      await publish(`call:${toId}`, "call.invite", {
        from: userId,
        fromName: me.nickname || me.username,
        kind: payload.kind || "voice",
        sdp: payload.sdp || null,
      });
      return json(200, {});
    }

    if (action === "call.answer") {
      const activeCalls = (await readState("activeCalls")) || {};
      const toId = activeCalls[userId];
      if (toId) await publish(`call:${toId}`, "call.answer", { from: userId, sdp: payload.sdp || null });
      return json(200, {});
    }

    if (action === "call.ice") {
      const toId = String(payload.to || "");
      await publish(`call:${toId}`, "call.ice", { from: userId, candidate: payload.candidate || null });
      return json(200, {});
    }

    if (action === "call.hangup") {
      const toId = String(payload.to || "");
      const reason = String(payload.reason || "ended");
      if (toId) await publish(`call:${toId}`, "call.hangup", { from: userId, reason });
      const activeCalls = (await readState("activeCalls")) || {};
      if (activeCalls[userId] === toId) delete activeCalls[userId];
      if (activeCalls[toId] === userId) delete activeCalls[toId];
      await writeState("activeCalls", activeCalls);
      return json(200, {});
    }

    // ============ 管理员 ============
    if (action === "admin.promote") {
      const isAdmin = me.admin || (process.env.ADMIN_KEY && payload.key === process.env.ADMIN_KEY);
      if (!isAdmin) return fail("forbidden");
      const target = Object.values(users).find((u) => u.username === String(payload.username || "").trim());
      if (!target) return fail("not-found");
      target.admin = true;
      await writeState("users", users);
      console.log(`[管理员] ${target.username} 由 ${me.username} 提升`);
      await pushTo(target.id, "promoted", { userId: target.id, by: me.username });
      return json(200, {});
    }

    // ============ 反馈 ============
    if (action === "feedback.submit") {
      const content = String(payload.content || "").trim().slice(0, 2000);
      if (!content) return fail("invalid");
      const feedback = (await readState("feedback")) || {};
      const id = uid("f_");
      feedback[id] = { id, userId, username: me.username, nickname: me.nickname || me.username, content, ts: Date.now() };
      await writeState("feedback", feedback);
      console.log(`[反馈] ${me.username}: ${content.slice(0, 60)}`);
      return json(200, { id });
    }

    // ============ 举报 ============
    if (action === "report.submit") {
      const targetId = String(payload.targetId || "");
      const target = users[targetId];
      if (!target) return fail("not-found");
      if (targetId === userId) return fail("cannot-report-self");
      const reason = String(payload.reason || "").trim().slice(0, 500);
      const evidence = Array.isArray(payload.evidence)
        ? payload.evidence.slice(0, 20).map((s) => String(s || "").slice(0, 300)).filter(Boolean)
        : [];
      if (!reason) return fail("invalid");
      const reports = (await readState("reports")) || {};
      const id = uid("rp_");
      reports[id] = {
        id,
        reporterId: userId,
        reporterName: me.nickname || me.username,
        targetId,
        targetName: target.nickname || target.username,
        reason,
        evidence,
        status: "pending",
        ts: Date.now(),
      };
      await writeState("reports", reports);
      console.log(`[举报] ${me.username} 举报 ${target.username}: ${reason.slice(0, 60)}`);
      return json(200, { id });
    }

    return json(404, { error: "unknown-action" });
  } catch (e) {
    console.error("[api]", action, e);
    return json(500, { error: "server-error" });
  }
};

/** 群信息变更后推送给所有成员 */
async function pushGroupUpdate(g, users) {
  const payload = groupPayload(g, users);
  for (const mid of g.memberIds) await pushTo(mid, "group.updated", { group: payload });
}

// crypto helpers（模块顶部已 require crypto 的场景下独立使用）
const crypto = require("crypto");
function cryptoRandomBytes() { return crypto.randomBytes(8).toString("hex"); }
function cryptoRandomHex() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
