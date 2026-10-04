// ================= AyanBall Chat · 文件上传（Vercel Blob 客户端直传） =================
// 流程：1) 校验登录 + 文件名 + 大小(≤50MB) 2) 写入元数据 3) 用 Vercel Blob 生成 clientUpload
// 客户端拿到 pathname/token 后用 @vercel/blob/client 的 put() 直传二进制（绕过函数体积限制）
const { Blob } = require("@vercel/blob");
const {
  readState, mutate, uid, authed,
  MAX_FILE_SIZE, FILE_TTL_MS,
} = require("../netlify/functions/_lib.js");

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

module.exports = async function (req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(404).json({ error: "not-found" });

  const token = authed({ headers: req.headers || {} });
  const tokens = (await readState("tokens")) || {};
  const userId = tokens[token];
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const body = parseBody(req);
  const fileName = String(body.name || "file.bin").slice(0, 200);
  const fileSize = Number(body.size) || 0;
  if (fileSize > MAX_FILE_SIZE) {
    // 客户端提示：目前服务器原因，仅支持发送50MB以内的文件，且有效期3天！！！
    return res.status(413).json({ error: "too-large" });
  }

  const fileId = uid("f_");
  const pathname = `ayanball/${fileId}`;
  let blob = null;
  try {
    blob = await Blob.put(pathname, "", {
      access: "public",
      token: process.env.BLOB_READ_WRITE_TOKEN,
      clientUpload: true,
      addRandomSuffix: false,
    });
  } catch (e) {
    console.error("[blob-clientUpload]", e.message);
    return res.status(500).json({ error: "blob-unavailable" });
  }

  const meta = {
    id: fileId,
    name: fileName,
    size: fileSize,
    type: String(body.type || "application/octet-stream").slice(0, 120),
    ownerId: userId,
    blobUrl: blob.url,
    createdAt: Date.now(),
    expiresAt: Date.now() + FILE_TTL_MS,
  };
  await mutate("files", (files) => { files[fileId] = meta; return files; }, {});

  return res.status(200).json({
    fileId,
    uploadPathname: blob.pathname,
    uploadToken: blob.token,
    file: {
      id: meta.id,
      name: meta.name,
      size: meta.size,
      type: meta.type,
      url: blob.url, // 公开可下载地址，客户端直接使用
      expiresAt: meta.expiresAt,
      ttl: FILE_TTL_MS,
    },
  });
};
