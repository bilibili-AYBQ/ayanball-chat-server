// 清理自动化测试产生的数据（测试前缀用户及其群/会话），保留真实用户
// 用法: node clean-test-data.js  （需先停止服务端）
const fs = require("fs");
const path = require("path");
const DATA_FILE = path.join(__dirname, "data.json");

const raw = fs.readFileSync(DATA_FILE, "utf-8");
const d = JSON.parse(raw);
fs.writeFileSync(DATA_FILE + ".bak-" + Date.now(), raw); // 备份

const isTestUser = (u) =>
  /^(t[a-z0-9]{3,}_|ui[a-z0-9]{4,}|probe[a-z0-9]{3,})/.test(u.username);

const testIds = new Set(
  Object.values(d.users || {}).filter(isTestUser).map((u) => u.id),
);
console.log("待清理测试用户:", testIds.size);

for (const id of testIds) {
  delete d.users[id];
  for (const [t, uid] of Object.entries(d.tokens || {})) if (uid === id) delete d.tokens[t];
  delete d.friends[id];
  delete d.blocked[id];
  for (const [k, v] of Object.entries(d.friends || {})) {
    d.friends[k] = v.filter((x) => !testIds.has(x));
  }
  for (const [k, v] of Object.entries(d.blocked || {})) {
    d.blocked[k] = v.filter((x) => !testIds.has(x));
  }
}
for (const [rid, r] of Object.entries(d.requests || {})) {
  if (testIds.has(r.fromId) || testIds.has(r.toId)) delete d.requests[rid];
}
// 删除含测试用户的群
for (const [gid, g] of Object.entries(d.groups || {})) {
  if (g.memberIds.some((x) => testIds.has(x))) {
    delete d.groups[gid];
    delete d.rooms[gid];
  }
}
// 清理测试会话消息
for (const [key, msgs] of Object.entries(d.rooms || {})) {
  if (key.startsWith("dm:")) {
    const [a, b] = key.replace("dm:", "").split(":");
    if (testIds.has(a) || testIds.has(b)) delete d.rooms[key];
  }
}
fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
console.log("清理完成，剩余用户:", Object.keys(d.users || {}).length, "群:", Object.keys(d.groups || {}).length);
