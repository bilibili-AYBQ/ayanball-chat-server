// Vercel 入口：包装 Netlify 版 update handler
const { vercelize } = require("../netlify/functions/_lib.js");
module.exports = vercelize(require("../netlify/functions/update.js").handler);
