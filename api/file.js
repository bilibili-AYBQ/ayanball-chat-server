// ================= AyanBall Chat · 文件下载（Vercel Blob） =================
// 返回 Blob 公开 URL（客户端可直接下载；历史 file?id 兼容）
const { readState } = require("../netlify/functions/_lib.js");

module.exports = async function (req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  const fileId = String(req.query.id || "");
  if (!fileId.startsWith("f_")) return res.status(404).json({ error: "not-found" });

  const files = (await readState("files")) || {};
  const meta = files[fileId];
  if (!meta || Date.now() > meta.expiresAt) {
    return res.status(404).json({ error: "expired" });
  }

  return res.status(200).json({
    url: meta.blobUrl,
    name: meta.name,
    size: meta.size,
    expiresAt: meta.expiresAt,
  });
};
