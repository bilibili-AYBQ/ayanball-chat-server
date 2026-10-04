// Vercel 入口：包装 Netlify 版 api handler，逻辑复用原文件
const { vercelize } = require("../netlify/functions/_lib.js");
module.exports = vercelize(require("../netlify/functions/api.js").handler);
