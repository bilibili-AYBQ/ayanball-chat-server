// ================= AyanBall Chat · 文件下载（3 天有效期） =================
// 返回 Blobs 预签名 GET 地址，客户端据此直接下载（支持 50MB 大文件）
const {
  store, readState, mutate, safeName, json,
} = require("./_lib.js");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});

  const fileId = String(event.queryStringParameters?.id || "");
  if (!fileId.startsWith("f_")) return json(404, { error: "not-found" });

  const files = (await readState("files")) || {};
  const meta = files[fileId];
  const now = Date.now();
  if (!meta || now > meta.expiresAt) {
    if (meta) {
      delete files[fileId];
      await mutate("files", () => files, {});
      try { await store().delete(`blob:${fileId}`); } catch { /* ignore */ }
    }
    return json(404, { error: "expired" });
  }

  try {
    const signed = await store().getSignedUrl(`blob:${fileId}`, { expire: 600 });
    return json(200, {
      url: signed,
      name: meta.name,
      size: meta.size,
      expiresAt: meta.expiresAt,
    });
  } catch (e) {
    console.error("[getSignedUrl]", e.message);
    return json(404, { error: "expired" });
  }
};
