// AyanBall Chat 群管理 API 全流程测试
// 用法: node test-group.js  （需要 ws 依赖，服务端已启动）
const WebSocket = require("ws");

const URL = "ws://127.0.0.1:8899";
const PREFIX = "t" + Date.now().toString(36).slice(-4);

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (detail !== undefined ? "  → 实际: " + JSON.stringify(detail) : "")); }
}

function client() {
  const ws = new WebSocket(URL);
  let seq = 1;
  const pending = new Map();
  const events = [];
  ws.on("message", (raw) => {
    const d = JSON.parse(raw.toString());
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id); pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error)); else p.resolve(d.payload);
    } else if (d.action) events.push(d);
  });
  const req = (action, payload = {}) => new Promise((res, rej) => {
    const id = seq++;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, action, payload }));
  });
  return {
    ws,
    events,
    req,
    async auth(token) { await req("auth", { token }); },
    close() { ws.close(); },
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const owner = client(); const m1 = client(); const m2 = client();
  await new Promise((r) => { let n = 0; const go = () => { n++; if (n === 3) r(); }; owner.ws.on("open", go); m1.ws.on("open", go); m2.ws.on("open", go); });

  const a = await owner.req("auth.register", { username: PREFIX + "_owner", password: "123456", nickname: "群主" });
  const b = await m1.req("auth.register", { username: PREFIX + "_m1", password: "123456", nickname: "成员一" });
  const c = await m2.req("auth.register", { username: PREFIX + "_m2", password: "123456", nickname: "成员二" });
  await owner.auth(a.token); await m1.auth(b.token); await m2.auth(c.token);
  await sleep(100);
  console.log(`\n== 用户: ${PREFIX}_owner(admin=${a.user.admin}) / m1 / m2 ==`);

  console.log("\n[1] 建群 + 邀请码加入");
  const g1 = await owner.req("group.create", { name: "测试群" });
  ok("建群成功，成员=1", g1.group.memberCount === 1 && g1.group.ownerId === a.user.id);
  ok("adminIds 含群主", (g1.group.adminIds || []).includes(a.user.id));
  const g2 = await m1.req("group.join", { code: g1.group.code });
  ok("m1 加入成功，成员=2", g2.group.memberCount === 2);
  const g3 = await m2.req("group.join", { code: g1.group.code });
  ok("m2 加入成功，成员=3", g3.group.memberCount === 3);

  console.log("\n[2] 权限校验");
  let err = null;
  try { await m2.req("group.setAdmin", { groupId: g1.group.id, userId: b.user.id, admin: true }); } catch (e) { err = e.message; }
  ok("普通成员不能设管理员 → forbidden", err === "forbidden", err);
  err = null;
  try { await m2.req("group.kick", { groupId: g1.group.id, userId: b.user.id }); } catch (e) { err = e.message; }
  ok("普通成员不能踢人 → forbidden", err === "forbidden", err);
  err = null;
  try { await owner.req("group.kick", { groupId: g1.group.id, userId: a.user.id }); } catch (e) { err = e.message; }
  ok("不能踢自己 → cannot-kick-self", err === "cannot-kick-self", err);

  console.log("\n[3] 设管理员 + 管理员踢人");
  const g4 = await owner.req("group.setAdmin", { groupId: g1.group.id, userId: b.user.id, admin: true });
  ok("m1 被设为管理员", (g4.group.adminIds || []).includes(b.user.id));
  const g5 = await m1.req("group.kick", { groupId: g1.group.id, userId: c.user.id });
  ok("管理员 m1 踢普通成员 m2 成功", g5.group.memberCount === 2 && !g5.group.members.some((m) => m.id === c.user.id));
  await sleep(150);
  ok("m2 收到 group.kicked 事件", m2.events.some((e) => e.action === "group.kicked" && e.payload.groupId === g1.group.id));
  err = null;
  try { await m1.req("group.kick", { groupId: g1.group.id, userId: a.user.id }); } catch (e) { err = e.message; }
  ok("管理员不能踢群主 → cannot-kick-owner", err === "cannot-kick-owner", err);
  err = null;
  try { await m1.req("group.setAdmin", { groupId: g1.group.id, userId: b.user.id, admin: false }); } catch (e) { err = e.message; }
  ok("管理员不能撤销自己管理员 → forbidden", err === "forbidden", err);

  console.log("\n[4] 群主撤管理员 + 邀请");
  const g6 = await owner.req("group.setAdmin", { groupId: g1.group.id, userId: b.user.id, admin: false });
  ok("群主撤销管理员成功", !(g6.group.adminIds || []).includes(b.user.id));
  const g7 = await owner.req("group.invite", { groupId: g1.group.id, username: PREFIX + "_m2" });
  ok("群主邀请 m2 回群成功", g7.group.memberCount === 3);
  err = null;
  try { await m1.req("group.invite", { groupId: g1.group.id, username: PREFIX + "_owner" }); } catch (e) { err = e.message; }
  ok("普通成员不能邀请 → forbidden", err === "forbidden", err);
  err = null;
  try { await owner.req("group.invite", { groupId: g1.group.id, username: "不存在的用户" }); } catch (e) { err = e.message; }
  ok("邀请不存在用户 → not-found", err === "not-found", err);

  console.log("\n[5] 转让群主");
  const g8 = await owner.req("group.transfer", { groupId: g1.group.id, userId: b.user.id });
  ok("群主转让给 m1 成功", g8.group.ownerId === b.user.id);
  ok("新群主自动进 adminIds", (g8.group.adminIds || []).includes(b.user.id));
  err = null;
  try { await m2.req("group.dissolve", { groupId: g1.group.id }); } catch (e) { err = e.message; }
  ok("非群主不能解散 → owner-only", err === "owner-only", err);

  console.log("\n[6] 群主退出限制 + 解散");
  err = null;
  try { await m1.req("group.leave", { groupId: g1.group.id }); } catch (e) { err = e.message; }
  ok("群主不能直接退群 → owner-cannot-leave", err === "owner-cannot-leave", err);
  const r1 = await m1.req("group.dissolve", { groupId: g1.group.id });
  ok("新群主解散群成功", !r1.error);
  await sleep(150);
  ok("owner 收到 group.removed 事件", owner.events.some((e) => e.action === "group.removed" && e.payload.groupId === g1.group.id));

  console.log("\n[7] 群上限 100 人");
  const g9 = await owner.req("group.create", { name: "满员测试群" });
  const mids = [];
  for (let i = 0; i < 99; i++) {
    const cc = client();
    await new Promise((r) => cc.ws.on("open", r));
    const reg = await cc.req("auth.register", { username: `${PREFIX}_bulk${i}`, password: "123456" });
    await cc.auth(reg.token);
    await cc.req("group.join", { code: g9.group.code });
    mids.push(cc);
  }
  await sleep(80);
  const gFull = await m1.req("group.join", { code: g9.group.code }).catch((e) => e.message);
  ok("第 101 人加入 → group-full", gFull === "group-full");

  console.log(`\n==================== 结果: ${passed} 通过 / ${failed} 失败 ====================\n`);
  owner.close(); m1.close(); m2.close();
  mids.forEach((c) => c.close());
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试异常:", e); process.exit(1); });
