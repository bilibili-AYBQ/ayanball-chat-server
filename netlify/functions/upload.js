// ================= AyanBall Chat · 文件上传（Netlify Blobs 预签名直传） =================
// 流程：1) 校验登录 + 文件名 + 大小(≤50MB) 2) 写入元数据 3) 返回 Blobs 预签名 PUT 地址
// 客户端直接 PUT 二进制到该地址（绕过 Netlify 函数请求体积限制，支持 50MB）
const {
  store, readState, writeState, mutate, uid, safeName, json, readBody, authed,
  MAX_FILE_SIZE, FILE_TTL_MS,
} = require("./_lib.js");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(404, { error: "not-found" });

  const token = authed(event);
  const tokens = (await readState("tokens")) || {};
  const userId = tokens[token];
  if (!userId) return json(401, { error: "unauthorized" });

  const body = readBody(event);
  const fileName = String(body.name || "file.bin").slice(0, 200);
  const fileSize = Number(body.size) || 0;
  if (fileSize > MAX_FILE_SIZE) {
    return json(413, { error: "too-large" }); // 客户端提示：目前服务器原因，仅支持发送50MB以内的文件，且有效期3天！！！
  }

  const fileId = uid("f_");
  const meta = {
    id: fileId,
    name: fileName,
    size: fileSize,
    type: String(body.type || "application/octet-stream").slice(0, 120),
    ownerId: userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + FILE_TTL_MS,
  };
  await mutate("files", (files) => { files[fileId] = meta; return files; }, {});

  // 预签名上传地址（有效期 30 分钟）
  let uploadUrl = null;
  try {
    uploadUrl = await store().createUploadUrl(`blob:${fileId}`, { expire: 1800 });
  } catch (e) {
    console.error("[createUploadUrl]", e.message);
    return json(500, { error: "upload-unavailable" });
  }

  return json(200, {
    fileId,
    uploadUrl,
    file: {
      id: meta.id,
      name: meta.name,
      size: meta.size,
      type: meta.type,
      url: `/.netlify/functions/file?id=${fileId}`,
      expiresAt: meta.expiresAt,
      ttl: FILE_TTL_MS,
    },
  });
};
