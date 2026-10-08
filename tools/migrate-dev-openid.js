/**
 * 一次性迁移：开发态 openid 稳定化后，把历史上按 code 哈希生成的 dev_* 用户任务
 * 全部归属到固定的 dev_user 名下，恢复「记录不存在」的历史数据可见性。
 * 只改 wc_jobs.openid，不删除任何用户行（非破坏性）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
// 脚本位于 tools/，mysql2 装在 server/node_modules，需显式指路
const mysql = require(path.join(__dirname, '..', 'server', 'node_modules', 'mysql2', 'promise'));

// 手动解析 server/.env（避免依赖 dotenv 的加载时机）
const envPath = path.join(__dirname, '..', 'server', '.env');
const env = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1][0] !== '#') env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
}

(async () => {
  const conn = await mysql.createConnection({
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'wc_watermark'
  });

  const [before] = await conn.query(
    "SELECT openid, COUNT(*) AS n FROM wc_jobs WHERE LEFT(openid, 4) = 'dev_' GROUP BY openid"
  );
  console.log('迁移前 dev_* 任务分布:', JSON.stringify(before));

  const [r] = await conn.query(
    "UPDATE wc_jobs SET openid = 'dev_user' WHERE LEFT(openid, 4) = 'dev_' AND openid <> 'dev_user'"
  );
  console.log('已归并任务数:', r.affectedRows);

  // dev_user 用户行不存在时补建（下次登录也会自动建，这里提前建好保证配额列有默认值）
  await conn.query(
    "INSERT IGNORE INTO wc_users (openid, last_active_at) VALUES ('dev_user', NOW())"
  );

  const [after] = await conn.query(
    "SELECT COUNT(*) AS n FROM wc_jobs WHERE openid = 'dev_user'"
  );
  console.log('迁移后 dev_user 名下任务数:', after[0].n);

  await conn.end();
  console.log('迁移完成 ✓');
})().catch((e) => {
  console.error('迁移失败:', e.message);
  process.exit(1);
});
