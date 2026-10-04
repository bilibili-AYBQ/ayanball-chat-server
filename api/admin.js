// Vercel 入口：包装 Netlify 版 admin handler
const { vercelize } = require("../netlify/functions/_lib.js");
module.exports = vercelize(require("../netlify/functions/admin.js").handler);
