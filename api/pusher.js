// Vercel 入口：包装 Netlify 版 pusher 鉴权 handler
const { vercelize } = require("../netlify/functions/_lib.js");
module.exports = vercelize(require("../netlify/functions/pusher.js").handler);
