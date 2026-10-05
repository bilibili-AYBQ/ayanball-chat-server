// ================= AyanBall Chat · Zeabur 常驻 HTTP 服务 =================
// 挂载原 Netlify/Vercel 的 handler（api/admin/pusher/update）+ 本地文件上传/下载 + 静态页
// 存储：KV(REDIS_URL) -> Redis -> Netlify Blobs -> 内存（见 _lib.js）；文件/更新zip：本地磁盘
// 启动：node zeabur.js   环境变量：PORT / ADMIN_KEY / PUSHER_* / REDIS_URL / ZEABUR(持久卷)
const http = require("http");
const fs = require("fs");
const path = require("path");

const {
  readState, writeState, mutate, uid, authed,
  MAX_FILE_SIZE, FILE_TTL_MS,
} = require("./netlify/functions/_lib.js");

const PORT = Number(process.env.PORT || 3000);
const UPLOAD_DIR = process.env.ZEABUR ? "/data/uploads" : path.join(__dirname, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");

const apiHandler = require("./netlify/functions/api.js").handler;
const adminHandler = require("./netlify/functions/admin.js").handler;
const pusherHandler = require("./netlify/functions/pusher.js").handler;
const updateHandler = require("./netlify/functions/update.js").handler;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

/** 读取请求体（保留原始 Buffer）并组装 Netlify 风格 event */
function toEvent(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { chunks.push(c); size += c.length; });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      const u = new URL(req.url, "http://x");
      resolve({
        buf,
        size,
        event: {
          httpMethod: req.method,
          queryStringParameters: Object.fromEntries(u.searchParams.entries()),
          headers: req.headers,
          body: buf.toString("utf8"),
        },
      });
    });
    req.on("error", reject);
  });
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON_HEADERS, JSON.stringify(obj));
}

/** 调用 Netlify 风格 handler */
function runHandler(handler) {
  return async (req, res) => {
    try {
      const { event } = await toEvent(req);
      const out = await handler(event);
      send(res, out.statusCode || 200, out.headers || JSON_HEADERS, out.body || "");
    } catch (e) {
      console.error("[handler]", e);
      sendJson(res, 500, { error: "internal" });
    }
  };
}

/** POST /upload —— body 为文件二进制，query: name/type，Authorization: Bearer token */
async function handleUpload(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, JSON_HEADERS, "");
  if (req.method !== "POST") return sendJson(res, 404, { error: "not-found" });

  const { buf, size, event } = await toEvent(req);
  const token = authed(event);
  const tokens = (await readState("tokens")) || {};
  const userId = tokens[token];
  if (!userId) return sendJson(res, 401, { error: "unauthorized" });

  const fileName = String(event.queryStringParameters.name || "file.bin").slice(0, 200);
  const fileType = String(event.queryStringParameters.type || "application/octet-stream").slice(0, 120);
  if (size > MAX_FILE_SIZE) {
    // 客户端提示：目前服务器原因，仅支持发送50MB以内的文件，且有效期3天！！！
    return sendJson(res, 413, { error: "too-large" });
  }
  if (size === 0) return sendJson(res, 400, { error: "empty" });

  const fileId = uid("f_");
  const filePath = path.join(UPLOAD_DIR, fileId);
  fs.writeFileSync(filePath, buf);
  const meta = {
    id: fileId,
    name: fileName,
    size,
    type: fileType,
    ownerId: userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + FILE_TTL_MS,
    path: filePath,
  };
  await mutate("files", (files) => { files[fileId] = meta; return files; }, {});
  return sendJson(res, 200, {
    fileId,
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
}

/** GET /file?id=xxx —— 返回本地文件二进制流 */
async function handleFile(req, res) {
  const u = new URL(req.url, "http://x");
  const fileId = String(u.searchParams.get("id") || "");
  if (!fileId.startsWith("f_")) return sendJson(res, 404, { error: "not-found" });
  const files = (await readState("files")) || {};
  const meta = files[fileId];
  if (!meta || Date.now() > meta.expiresAt) return sendJson(res, 404, { error: "expired" });
  const p = meta.path && fs.existsSync(meta.path) ? meta.path : path.join(UPLOAD_DIR, fileId);
  if (!fs.existsSync(p)) return sendJson(res, 404, { error: "no-file" });
  res.writeHead(200, {
    "Content-Type": meta.type || "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(meta.name || "file")}`,
    "Access-Control-Allow-Origin": "*",
  });
  fs.createReadStream(p).pipe(res);
}

/** GET 静态页 */
function serveStatic(fileName) {
  return (req, res) => {
    const p = path.join(PUBLIC_DIR, fileName);
    if (!fs.existsSync(p)) return sendJson(res, 404, { error: "not-found" });
    const ext = path.extname(fileName).toLowerCase();
    const mime = ext === ".html" ? "text/html; charset=utf-8" : "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    fs.createReadStream(p).pipe(res);
  };
}

const routes = {
  "/api": runHandler(apiHandler),
  "/admin": runHandler(adminHandler),
  "/pusher": runHandler(pusherHandler),
  "/update": runHandler(updateHandler),
  "/upload": handleUpload,
  "/file": handleFile,
  // 兼容旧 .netlify/functions 前缀路径
  "/.netlify/functions/api": runHandler(apiHandler),
  "/.netlify/functions/admin": runHandler(adminHandler),
  "/.netlify/functions/pusher": runHandler(pusherHandler),
  "/.netlify/functions/update": runHandler(updateHandler),
  "/.netlify/functions/upload": handleUpload,
  "/.netlify/functions/file": handleFile,
  "/admin.html": serveStatic("admin.html"),
  "/forgot-password.html": serveStatic("forgot-password.html"),
  "/index.html": serveStatic("index.html"),
  "/": serveStatic("index.html"),
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const route = routes[u.pathname];
  if (route) return route(req, res);
  // 找不到 admin.html 时回退到 public 下任意 .html
  if (u.pathname.endsWith(".html")) {
    const f = u.pathname.slice(1);
    if (fs.existsSync(path.join(PUBLIC_DIR, f))) return serveStatic(f)(req, res);
  }
  return sendJson(res, 404, { error: "not-found" });
});

server.listen(PORT, () => {
  console.log(`[zeabur] AyanBall Chat server listening on :${PORT}`);
  console.log(`[zeabur] storage=${process.env.REDIS_URL ? "redis" : (process.env.ZEABUR ? "local" : "memory")}`);
});
