/**
 * 极简 .env 加载器（无第三方依赖）
 * 启动时调用 loadEnv(__dirname)，将 server/.env 写入 process.env
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadEnv(baseDir) {
  const file = path.join(baseDir, '.env');
  if (!fs.existsSync(file)) return false;

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const t = line.trim();
    if (!t || t.charAt(0) === '#') return;
    const eq = t.indexOf('=');
    if (eq < 1) return;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    // 去掉成对引号
    if (
      (val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
      (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  });
  return true;
}

module.exports = { loadEnv };
