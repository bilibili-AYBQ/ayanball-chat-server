// ================= AyanBall Chat · Netlify 函数本地回归测试 =================
// 通过 mock @netlify/blobs 为本地文件存储，验证全部业务逻辑
// （Ably 实时推送无 key 时自动跳过；需真实密钥的在线判断/推送不在本测试范围）
const fs = require("fs");
const path = require("path");
const Module = require("module");

const DIR = path.join(__dirname, ".test-blobs");
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

function blobStore() {
  const fileOf = (key) => path.join(DIR, encodeURIComponent(key));
  return {
    async get(key, opts) {
      const p = fileOf(key);
      if (!fs.existsSync(p)) return null;
      const raw = fs.readFileSync(p, "utf-8");
      return opts?.type === "json" ? JSON.parse(raw) : raw;
    },
    async set(key, val) { fs.writeFileSync(fileOf(key), val); },
    async delete(key) { try { fs.unlinkSync(fileOf(key)); } catch { /* ignore */ } },
    async list({ prefix }) {
      const blobs = [];
      for (const f of fs.readdirSync(DIR)) {
        const key = decodeURIComponent(f);
        if (key.startsWith(prefix)) blobs.push({ key });
      }
      return { blobs };
    },
    async createUploadUrl(key) { return `http://mock/upload/${encodeURIComponent(key)}`; },
    async getSignedUrl(key) { return `http://mock/signed/${encodeURIComponent(key)}`; },
  };
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@netlify/blobs") return { getStore: () => blobStore() };
  return origLoad.apply(this, arguments);
};

const api = require("./netlify/functions/api.js");
const admin = require("./netlify/functions/admin.js");
const upload = require("./netlify/functions/upload.js");
const file = require("./netlify/functions/file.js");

async function call(fn, { method = "POST", path = "/", query = {}, headers = {}, body = null } = {}) {
  const event = {
    httpMethod: method,
    path,
    queryStringParameters: query,
    headers,
    body: body ? JSON.stringify(body) : null,
  };
  const res = await fn.handler(event);
  return { status: res.statusCode, data: JSON.parse(res.body || "{}") };
}

let pass = 0, failCount = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failCount++; console.log(`  ❌ ${name} ${extra}`); }
}

async function main() {
  console.log("== AyanBall Chat Netlify 函数回归测试 ==");

  // 1) 注册（首个用户自动管理员）
  let r = await call(api, { body: { action: "auth.register", payload: { username: "alice", password: "pass123", nickname: "爱丽丝", avatar: "p3" } } });
  check("注册 alice（首个→管理员）", r.status === 200 && r.data.user?.admin === true && r.data.user?.avatar === "p3", JSON.stringify(r.data));
  const t1 = r.data.token;

  r = await call(api, { body: { action: "auth.register", payload: { username: "bob", password: "pass456", nickname: "鲍勃" } } });
  check("注册 bob", r.status === 200 && !r.data.user?.admin);
  const t2 = r.data.token;

  r = await call(api, { body: { action: "auth.register", payload: { username: "carol", password: "pass789" } } });
  check("注册 carol", r.status === 200);
  const t3 = r.data.token;

  r = await call(api, { body: { action: "auth.register", payload: { username: "alice", password: "xxxxxx" } } });
  check("重复注册被拒(taken)", r.status === 400 && r.data.error === "taken");

  r = await call(api, { body: { action: "auth.login", payload: { username: "alice", password: "wrong" } } });
  check("错误密码(credential)", r.status === 400 && r.data.error === "credential");

  r = await call(api, { body: { action: "auth.login", payload: { username: "bob", password: "pass456" } } });
  check("bob 登录", r.status === 200 && r.data.token);
  const t2b = r.data.token;

  // 2) auth hydrate
  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "auth", payload: {} } });
  check("auth hydrate（用户/好友/群/会话）", r.status === 200 && r.data.user?.username === "alice" && Array.isArray(r.data.friends));

  // 3) 好友
  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "friend.search", payload: { username: "bob" } } });
  check("搜索 bob", r.status === 200 && r.data.user?.username === "bob");

  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "friend.request", payload: { toId: r.data.user.id } } });
  const bobId = r.data.request?.toId;
  check("alice 发送好友申请", r.status === 200 && r.data.request?.status === "pending");

  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "friend.request", payload: { toId: bobId } } });
  check("重复申请被拒(duplicate)", r.status === 400 && r.data.error === "duplicate");

  r = await call(api, { headers: { authorization: `Bearer ${t2b}` }, body: { action: "auth", payload: {} } });
  const reqId = r.data.requests?.find((x) => x.fromId && x.toId === r.data.user.id)?.id;
  r = await call(api, { headers: { authorization: `Bearer ${t2b}` }, body: { action: "friend.accept", payload: { requestId: reqId } } });
  check("bob 接受好友申请", r.status === 200 && r.data.friend?.username === "alice");

  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "auth", payload: {} } });
  check("alice 好友列表含 bob", r.data.friends?.some((f) => f.username === "bob"));

  // 4) 拉黑
  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "block.add", payload: { userId: bobId } } });
  check("alice 拉黑 bob", r.status === 200);
  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "auth", payload: {} } });
  check("拉黑后 bob 从好友移除+进入黑名单", !r.data.friends?.some((f) => f.id === bobId) && r.data.blocked?.includes(bobId));
  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "block.remove", payload: { userId: bobId } } });
  check("解除拉黑", r.status === 200);

  // 5) 头像
  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "profile.setAvatar", payload: { avatar: "p7" } } });
  check("alice 换头像 p7", r.status === 200 && r.data.user?.avatar === "p7");

  // 6) 群聊
  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "group.create", payload: { name: "AyanBall 开发群" } } });
  check("创建群聊", r.status === 200 && r.data.group?.code && r.data.group?.memberCount === 1);
  const gid = r.data.group.id;
  const gcode = r.data.group.code;

  r = await call(api, { headers: { authorization: `Bearer ${t2b}` }, body: { action: "group.join", payload: { code: gcode } } });
  check("bob 用群号加群", r.status === 200 && r.data.group?.memberCount === 2);

  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "group.setAdmin", payload: { groupId: gid, userId: bobId, admin: true } } });
  check("群主设 bob 为管理员", r.status === 200 && r.data.group?.adminIds?.includes(bobId));

  r = await call(api, { headers: { authorization: `Bearer ${t3}` }, body: { action: "group.join", payload: { code: gcode } } });
  check("carol 用群号加群", r.status === 200 && r.data.group?.memberCount === 3);

  r = await call(api, { body: { action: "auth.register", payload: { username: "fill0", password: "pass123456" } } });
  check("注册 fill0", r.status === 200);

  r = await call(api, { headers: { authorization: `Bearer ${t3}` }, body: { action: "group.invite", payload: { groupId: gid, username: "fill0" } } });
  check("非管理员邀请被拒(forbidden)", r.status === 400 && r.data.error === "forbidden");

  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "group.invite", payload: { groupId: gid, username: "carol" } } });
  check("重复邀请被拒(already-in-group)", r.status === 400 && r.data.error === "already-in-group");

  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "group.invite", payload: { groupId: gid, username: "fill0" } } });
  check("群主邀请 fill0", r.status === 200 && r.data.group?.memberCount === 4);

  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "group.setAdmin", payload: { groupId: gid, userId: bobId, admin: false } } });
  check("撤销 bob 管理员", r.status === 200 && !r.data.group?.adminIds?.includes(bobId));

  r = await call(api, { headers: { authorization: `Bearer ${t3}` }, body: { action: "group.leave", payload: { groupId: gid } } });
  check("carol 退群", r.status === 200);

  // 群主不能退群
  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "group.leave", payload: { groupId: gid } } });
  check("群主不能退群(owner-cannot-leave)", r.status === 400 && r.data.error === "owner-cannot-leave");

  // 转让
  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "group.transfer", payload: { groupId: gid, userId: bobId } } });
  check("转让群主给 bob", r.status === 200 && r.data.group?.ownerId === bobId);

  // 100 人上限（fill0 已在群，从 fill1 开始填充）
  let full = false;
  for (let i = 1; i < 106; i++) {
    await call(api, { body: { action: "auth.register", payload: { username: `fill${i}`, password: "pass123456" } } });
  }
  for (let i = 1; i < 106; i++) {
    const rr = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "group.invite", payload: { groupId: gid, username: `fill${i}` } } });
    if (rr.status === 400 && rr.data.error === "group-full") { full = true; break; }
  }
  check("群成员上限 100（group-full）", full);

  // 解散
  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "group.dissolve", payload: { groupId: gid } } });
  check("非群主解散被拒(owner-only)", r.status === 400 && r.data.error === "owner-only");
  r = await call(api, { headers: { authorization: `Bearer ${t2b}` }, body: { action: "group.dissolve", payload: { groupId: gid } } });
  check("群主解散群", r.status === 200);

  // 7) 消息
  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "message.send", payload: { roomId: bobId, kind: "text", content: "你好 bob！" } } });
  check("私聊发消息", r.status === 200 && r.data.msg?.kind === "text" && r.data.msg?.mine === true);

  r = await call(api, { headers: { authorization: `Bearer ${t2b}` }, body: { action: "auth", payload: {} } });
  const dm = r.data.rooms?.find((x) => x.convId === "dm:alice" || x.convId.startsWith("dm:"));
  check("bob 收到私聊历史", dm && dm.msgs?.some((m) => m.content === "你好 bob！"));

  // 8) 文件（50MB 限制 + 3 天有效期）
  r = await call(upload, { headers: { authorization: `Bearer ${t1}` }, body: { name: "big.bin", size: 51 * 1024 * 1024 } });
  check(">50MB 文件被拒(too-large)", r.status === 413 && r.data.error === "too-large");

  r = await call(upload, { headers: { authorization: `Bearer ${t1}` }, body: { name: "报告.pdf", size: 1024, type: "application/pdf" } });
  check("50MB 内文件获得预签名地址", r.status === 200 && r.data.uploadUrl?.startsWith("http://mock/upload/") && r.data.file?.ttl === 259200000);

  const fid = r.data.fileId;
  r = await call(file, { method: "GET", query: { id: fid } });
  check("文件下载返回签名地址", r.status === 200 && r.data.url?.startsWith("http://mock/signed/"));

  r = await call(file, { method: "GET", query: { id: "f_nonexist" } });
  check("不存在文件 404", r.status === 404);

  // 9) 管理面板
  r = await call(admin, { path: "/.netlify/functions/admin/login", body: { password: "ayanball-admin" } });
  check("admin 登录", r.status === 200 && r.data.token);
  const at = r.data.token;
  const ah = { authorization: `Bearer ${at}` };

  r = await call(admin, { method: "GET", path: "/.netlify/functions/admin/stats", headers: ah });
  check("admin 统计（用户数>100）", r.status === 200 && r.data.users > 100 && r.data.groups === 0);

  r = await call(admin, { method: "GET", path: "/.netlify/functions/admin/users", headers: ah });
  check("admin 用户列表", r.status === 200 && Array.isArray(r.data.users));

  r = await call(admin, { method: "GET", path: "/.netlify/functions/admin/groups", headers: ah });
  check("admin 群列表", r.status === 200 && Array.isArray(r.data.groups));

  r = await call(admin, { method: "GET", path: "/.netlify/functions/admin/messages", headers: ah });
  check("admin 消息记录", r.status === 200 && r.data.messages?.length >= 1);

  r = await call(admin, { method: "GET", path: "/.netlify/functions/admin/files", headers: ah });
  check("admin 文件列表", r.status === 200 && r.data.files?.length === 1);

  r = await call(admin, { method: "GET", path: "/.netlify/functions/admin/stats" });
  check("未登录访问 admin 401", r.status === 401);

  r = await call(admin, { path: "/.netlify/functions/admin/broadcast", headers: ah, body: { text: "系统维护通知" } });
  check("admin 广播", r.status === 200);

  // 10) 未登录业务 401
  r = await call(api, { body: { action: "message.send", payload: { roomId: "x", kind: "text", content: "hi" } } });
  check("未登录发消息 401", r.status === 401);

  // 11) 管理员提权
  r = await call(api, { headers: { authorization: `Bearer ${t1}` }, body: { action: "admin.promote", payload: { username: "bob" } } });
  check("管理员提升 bob", r.status === 200);
  r = await call(api, { headers: { authorization: `Bearer ${t3}` }, body: { action: "admin.promote", payload: { username: "alice" } } });
  check("非管理员提权被拒(forbidden)", r.status === 400 && r.data.error === "forbidden");

  console.log(`\n==== 结果: ${pass} 通过 / ${failCount} 失败 ====`);
  process.exit(failCount ? 1 : 0);
}

main().catch((e) => { console.error("测试崩溃:", e); process.exit(1); });
