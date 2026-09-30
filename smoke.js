// AyanBall Chat 服务端端到端冒烟测试
const WebSocket = require("ws");
const http = require("http");

const WS = "ws://127.0.0.1:8899";
let pass = 0, fail = 0;
function ok(name) { pass++; console.log("  ✓ " + name); }
function bad(name, extra) { fail++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS);
    ws.on("open", () => resolve(ws));
  });
}
function req(ws, action, payload) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => reject(new Error("timeout " + action)), 4000);
    ws.on("message", function onMsg(raw) {
      const d = JSON.parse(raw.toString());
      if (d.id === id) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(d);
      }
    });
    ws.send(JSON.stringify({ id, action, payload }));
  });
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const a = await connect();
  const b = await connect();
  const pushesA = [], pushesB = [];
  a.on("message", (raw) => { const d = JSON.parse(raw.toString()); if (d.action) pushesA.push(d); });
  b.on("message", (raw) => { const d = JSON.parse(raw.toString()); if (d.action) pushesB.push(d); });

  // 注册（首个用户成为管理员）
  const r1 = await req(a, "auth.register", { username: "alice", password: "123456", nickname: "爱丽丝" });
  if (r1.payload?.user?.admin === true) ok("首个用户自动成为管理员");
  else bad("首个用户自动成为管理员", JSON.stringify(r1.payload));
  const tokA = r1.payload.token;

  const r2 = await req(b, "auth.register", { username: "bob", password: "123456", nickname: "鲍勃" });
  if (r2.payload?.user?.admin === false) ok("第二个用户非管理员");
  else bad("第二个用户非管理员");
  const tokB = r2.payload.token;

  const r3 = await req(a, "auth.register", { username: "alice", password: "123456" });
  if (r3.error === "taken") ok("重复用户名被拒绝");
  else bad("重复用户名被拒绝", JSON.stringify(r3.payload));

  const r4 = await req(a, "auth.login", { username: "alice", password: "wrong" });
  if (r4.error === "credential") ok("错误密码被拒绝");
  else bad("错误密码被拒绝", JSON.stringify(r4.payload));

  // 认证（同一连接重新 auth 绑定用户）
  const sA = await req(a, "auth", { token: tokA });
  const sB = await req(b, "auth", { token: tokB });
  if (sA.payload?.user?.username === "alice") ok("auth 返回用户信息");
  else bad("auth 返回用户信息");
  const idA = sA.payload.user.id, idB = sB.payload.user.id;

  // 非管理员提升被拒（bob 此时还不是管理员）
  const notAdmin = await req(b, "admin.promote", { username: "alice" });
  if (notAdmin.error === "forbidden") ok("非管理员提升被拒绝");
  else bad("非管理员提升被拒绝", JSON.stringify(notAdmin.payload));

  // 搜索用户
  const s1 = await req(a, "friend.search", { username: "bob" });
  if (s1.payload?.user?.id === idB) ok("搜索用户");
  else bad("搜索用户", JSON.stringify(s1.payload));

  // 好友申请 + 接受
  await req(a, "friend.request", { toId: idB });
  await wait(300);
  if (pushesB.some((p) => p.action === "friend.request")) ok("好友申请推送到达");
  else bad("好友申请推送到达", JSON.stringify(pushesB));
  const myReq = await req(b, "auth", { token: tokB });
  const reqObj = myReq.payload.requests.find((x) => x.status === "pending");
  if (reqObj) ok("收到好友申请");
  else bad("收到好友申请");
  await req(b, "friend.accept", { requestId: reqObj.id });
  await wait(300);
  if (pushesA.some((p) => p.action === "friend.accepted")) ok("好友接受推送到达发起方");
  else bad("好友接受推送到达发起方", JSON.stringify(pushesA));

  // 群聊创建/加入
  const g1 = await req(a, "group.create", { name: "AyanBall 开发组" });
  if (g1.payload?.group?.code) ok("创建群聊，邀请码 " + g1.payload.group.code);
  else bad("创建群聊", JSON.stringify(g1.payload));
  const join = await req(b, "group.join", { code: g1.payload.group.code });
  if (join.payload?.group?.memberCount === 2) ok("邀请码加群成功");
  else bad("邀请码加群成功", JSON.stringify(join.payload));

  // 私聊消息（双向回执）
  pushesA.length = 0; pushesB.length = 0;
  await req(a, "message.send", { roomId: idB, kind: "text", content: "你好 Bob！" });
  await wait(300);
  const gotB = pushesB.find((p) => p.action === "message.new" && p.payload.msg.content === "你好 Bob！");
  if (gotB && gotB.payload.msg.mine === false && gotB.payload.convId === `dm:${idA}`) ok("私聊消息送达 Bob (convId 正确)");
  else bad("私聊消息送达 Bob", JSON.stringify(pushesB));

  // 群消息
  pushesA.length = 0; pushesB.length = 0;
  await req(b, "message.send", { roomId: g1.payload.group.id, kind: "text", content: "大家好" });
  await wait(300);
  if (pushesB.some((p) => p.action === "message.new" && p.payload.convId === `g:${g1.payload.group.id}`)) ok("群消息推送(含发送者回执)");
  else bad("群消息推送(含发送者回执)", JSON.stringify(pushesB));

  // 拉黑后发送被拒
  await req(b, "block.add", { userId: idA });
  const blk = await req(a, "message.send", { roomId: idB, kind: "text", content: "x" });
  if (blk.error === "blocked-by-peer") ok("拉黑后消息被服务端拦截");
  else bad("拉黑后消息被服务端拦截", JSON.stringify(blk.payload));
  await req(b, "block.remove", { userId: idA });

  // 管理员提升
  const prom = await req(a, "admin.promote", { username: "bob" });
  if (!prom.error) ok("管理员可提升其他用户");
  else bad("管理员可提升其他用户", JSON.stringify(prom.payload));

  // 文件上传：正常（中文文件名）
  const upRes = await new Promise((resolve) => {
    const data = Buffer.from("hello ayanball file content");
    const hreq = http.request(
      {
        host: "127.0.0.1", port: 8899, path: "/api/upload", method: "POST",
        headers: {
          Authorization: "Bearer " + tokA,
          "x-file-name": encodeURIComponent("测试文档.txt"),
          "x-file-size": String(data.length),
          "Content-Length": data.length,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      },
    );
    hreq.end(data);
  });
  if (upRes.status === 200 && upRes.body.file?.name === "测试文档.txt") ok("文件上传成功(≤50MB, 中文名)");
  else bad("文件上传成功", JSON.stringify(upRes));

  // 文件下载
  const dlRes = await new Promise((resolve) => {
    http.get(upRes.body.file.url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
  });
  if (dlRes.status === 200 && dlRes.body === "hello ayanball file content") ok("文件下载内容正确");
  else bad("文件下载内容正确", dlRes.status + "");

  // 文件超限（>50MB 声明）
  const tooBig = await new Promise((resolve) => {
    const hreq = http.request(
      {
        host: "127.0.0.1", port: 8899, path: "/api/upload", method: "POST",
        headers: {
          Authorization: "Bearer " + tokA,
          "x-file-name": encodeURIComponent("big.bin"),
          "x-file-size": String(51 * 1024 * 1024),
          "Content-Length": 10,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    hreq.end(Buffer.from("0123456789"));
  });
  if (tooBig.status === 413) ok(">50MB 文件被服务端拒绝 (413)");
  else bad(">50MB 文件被服务端拒绝", tooBig.status + " " + tooBig.body);

  a.close(); b.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("测试异常:", e.message); process.exit(1); });
