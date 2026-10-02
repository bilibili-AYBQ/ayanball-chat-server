// ================= AyanBall Chat · 客户端自动更新 =================
// GET /.netlify/functions/update            -> 返回最新版本元信息（客户端据此判断是否需更新）
// GET /.netlify/functions/update?download=1 -> 返回更新 zip 的预签名下载地址
const {
  store, readState, json,
} = require("./_lib.js");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "GET") return json(404, { error: "not-found" });

  const meta = (await readState("update:meta")) || null;
  if (!meta) return json(404, { error: "no-update" });

  const wantDownload = String(event.queryStringParameters?.download || "") === "1";
  if (wantDownload) {
    try {
      const signed = await store().getSignedUrl("blob:update:zip", { expire: 600 });
      return json(200, {
        url: signed,
        version: meta.version,
        name: meta.name,
        size: meta.size,
      });
    } catch (e) {
      console.error("[update download]", e.message);
      return json(404, { error: "no-file" });
    }
  }

  return json(200, {
    version: meta.version,
    notes: meta.notes || "",
    uploadedAt: meta.uploadedAt || 0,
    size: meta.size || 0,
    hasZip: !!meta.hasZip,
    name: meta.name || "ayanball-update.zip",
    downloadUrl: "/.netlify/functions/update?download=1",
  });
};
