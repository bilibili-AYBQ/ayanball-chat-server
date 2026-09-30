// ================= AyanBall Chat · Pusher Channels 鉴权 =================
// 客户端订阅 private-* 频道前调用此接口：校验登录态与频道归属后，
// 用服务端 SECRET 对 socket_id:channel_name 做 HMAC-SHA256 签名。
// 服务端密钥（PUSHER_SECRET）绝不进入客户端。
const crypto = require("crypto");
const { json, authed } = require("./_lib.js");
const { readState } = require("./_lib.js");

/** 解析 pusher-js 的 auth 请求体（application/x-www-form-urlencoded） */
function formBody(event) {
  const raw = String(event.body || "");
  if (!raw) return {};
  if (raw.includes("=")) {
    const out = {};
    for (const pair of raw.split("&")) {
      const [k, v] = pair.split("=");
      if (k) out[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
    return out;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(404, { error: "not-found" });

  const key = process.env.PUSHER_KEY;
  const secret = process.env.PUSHER_SECRET;
  if (!key || !secret) return json(500, { error: "missing-pusher-key" });

  // 鉴权：Authorization: Bearer <app token>
  const token = authed(event);
  const tokens = (await readState("tokens")) || {};
  const users = (await readState("users")) || {};
  const me = users[tokens[token]];
  if (!me) return json(401, { error: "unauthorized" });

  const body = formBody(event);
  const socketId = String(body.socket_id || "");
  const channel = String(body.channel_name || "");
  if (!socketId || !channel) return json(400, { error: "bad-request" });
  if (!channel.startsWith("private-")) return json(403, { error: "channel-forbidden" });

  // 只允许订阅自己的频道：user_/call_/conv_dm_ 必须含自己的 id；conv_g_ 必须是群成员
  const name = channel.replace("private-", "");
  if (name.startsWith("user_") || name.startsWith("call_") || name.startsWith("conv_dm_")) {
    const id = name.split("_").pop();
    if (id !== me.id) return json(403, { error: "channel-forbidden" });
  } else if (name.startsWith("conv_g_")) {
    const gid = name.slice("conv_g_".length);
    const groups = (await readState("groups")) || {};
    const g = groups[gid];
    if (!g || !g.memberIds.includes(me.id)) return json(403, { error: "channel-forbidden" });
  } else {
    return json(403, { error: "channel-forbidden" });
  }

  const sig = crypto.createHmac("sha256", secret).update(`${socketId}:${channel}`).digest("hex");
  return json(200, { auth: `${key}:${sig}` });
};
