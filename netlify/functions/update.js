// ================= AyanBall Chat · 客户端自动更新 =================
// GET /.netlify/functions/update            -> 返回最新版本元信息（客户端据此判断是否需更新）
// GET /.netlify/functions/update?download=1 -> 返回 zip 元信息（size/total/chunkSize）
// GET /.netlify/functions/update?download=1&index=i -> 返回第 i 块 zip（base64），客户端分块拼接
const {
  store, readState, json,
} = require("./_lib.js");

const UPDATE_CHUNK = 3 * 1024 * 1024; // 与 admin.js 分块大小一致

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "GET") return json(404, { error: "not-found" });

  const meta = (await readState("update:meta")) || null;
  if (!meta) return json(404, { error: "no-update" });

  const wantDownload = String(event.queryStringParameters?.download || "") === "1";
  if (wantDownload) {
    const raw = await store().get("updatezip", { type: "arrayBuffer" }).catch(() => null);
    if (!raw) return json(404, { error: "no-file" });
    const B = Buffer.from(raw);
    const total = Math.max(1, Math.ceil(B.length / UPDATE_CHUNK));
    const indexParam = event.queryStringParameters?.index;
    if (indexParam === undefined || indexParam === "" || indexParam === null) {
      return json(200, {
        version: meta.version, name: meta.name, size: meta.size,
        total, chunkSize: UPDATE_CHUNK,
      });
    }
    const i = Math.max(0, Math.min(Number(indexParam) || 0, total - 1));
    const piece = B.subarray(i * UPDATE_CHUNK, Math.min(B.length, (i + 1) * UPDATE_CHUNK));
    return json(200, { index: i, total, data: piece.toString("base64") });
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
