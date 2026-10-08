/**
 * 水印清理小程序 · 后端服务
 * Express + MySQL + JWT，内置 FFmpeg 视频处理队列
 *
 * 启动：npm install && cp .env.example .env（改配置）&& node server.js
 */

'use strict';

const path = require('path');
const os = require('os');
const express = require('express');
const fs = require('fs');

/** 取本机所有可用的局域网 IPv4（排除回环 / 虚拟网卡） */
function getLanIPv4() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    // 跳过虚拟机 / Docker / WSL 的虚拟网卡
    if (/vmware|virtualbox|vethernet|docker|wsl|loopback|hyper-v/i.test(name)) return;
    (ifaces[name] || []).forEach((it) => {
      if (it.family !== 'IPv4' || it.internal) return;
      const ip = it.address;
      // 排除 169.254.x.x（未获取到 DHCP）
      if (ip.startsWith('169.254.')) return;
      out.push(ip);
    });
  });
  // 常见家用网段优先：192.168 > 10. > 172.16-31
  return out.sort((a, b) => {
    const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
    return score(a) - score(b);
  });
}

const { loadEnv } = require('./lib/env');
loadEnv(__dirname);

// ---------------- 配置校验 ----------------
const PORT = Number(process.env.PORT) || 3000;
const REQUIRED = ['DB_HOST', 'DB_USER', 'DB_NAME'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('✗ 缺少环境变量：' + missing.join(', '));
  console.error('  请复制 .env.example 为 .env 并填写后重试');
  process.exit(1);
}
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'please-change-me-to-a-random-long-string') {
  console.warn('⚠ JWT_SECRET 未配置或仍为默认值，生产环境务必改为随机长字符串');
}
if (!process.env.WX_APPID || !process.env.WX_SECRET) {
  console.warn('⚠ WX_APPID / WX_SECRET 未配置 → 开发模式：openid 用 code 哈希模拟（仅限本地调试）');
}

// ---------------- 初始化 ----------------
const db = require('./db');
const files = require('./lib/files');
const settings = require('./lib/settings');
const account = require('./lib/account');
const videoQueue = require('./services/videoQueue');
const scheduler = require('./services/scheduler');
const storage = require('./lib/storage');

const uploadDir = files.init(process.env.UPLOAD_DIR || 'uploads');
db.init({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// CORS（Web 管理后台本地调试用；生产建议同域或关闭）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 上传文件静态访问
// 存储根目录可在后台「配置 → 存储路径」中修改并即时生效，
// 因此这里按需重建 static 中间件（仅在根目录变化时重建，无额外开销）。
let staticMW = null;
let staticRootCached = '';
app.use('/files', (req, res, next) => {
  const root = files.getRoot();
  if (!staticMW || root !== staticRootCached) {
    staticMW = express.static(root, { maxAge: '1h' });
    staticRootCached = root;
  }
  staticMW(req, res, next);
});

// Web 管理后台静态托管（同源，免跨域）
// 页面来源优先级：<项目根>/admin-web/  →  <server>/admin-web/
const adminDirs = [
  path.join(__dirname, '..', 'admin-web'),
  path.join(__dirname, 'admin-web')
];
adminDirs.forEach((dir) => {
  if (fs.existsSync(path.join(dir, 'index.html'))) {
    app.use('/admin', express.static(dir, { index: 'index.html', maxAge: '0' }));
  }
});

// 健康检查
app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// 根路径直接跳到后台
app.get('/', (req, res) => res.redirect('/admin/'));

// ---------------- 业务路由 ----------------
const ctx = { videoQueue };
require('./routes/auth').register(app, ctx);
require('./routes/jobs').register(app, ctx);
require('./routes/videoProc').register(app, ctx);
require('./routes/admin').register(app, ctx);
require('./routes/upload').register(app, ctx);

// 统一错误处理（BizError → 业务码；其余 → 500）
const { fail } = require('./lib/resp');
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const code = err && err.code ? err.code : 500;
  const isBiz = err && err.name === 'BizError';
  if (!isBiz) console.error('[error]', req.method, req.originalUrl, '\n', err);
  if (!res.headersSent) fail(res, code, err.message || '服务异常');
});

// ---------------- 启动 ----------------
async function start() {
  // 存储路径配置（后台可自定义；为空则沿用 .env 的 UPLOAD_DIR）
  let storageInfo = null;
  try {
    storageInfo = await storage.load();
  } catch (e) {
    console.warn('⚠ 存储路径配置加载失败，继续使用 .env 的 UPLOAD_DIR：' + e.message);
  }

  // 确保配置单行 + 后台密钥存在
  const initKey = await settings.ensureRow(process.env.INIT_ADMIN_KEY || '');
  if (initKey) {
    console.log('★ 已生成后台访问密钥（请立即保存）：' + initKey);
  }

  // 确保存在可登录的后台账号
  let freshAccount = null;
  try {
    freshAccount = await account.ensureDefaultAccount();
  } catch (e) {
    console.warn('⚠ 后台账号初始化失败（请先执行 db/migrate_admin_account.sql）：' + e.message);
  }

  // 恢复遗留的视频任务
  await videoQueue.recover();

  // 定时清理：兜底 jobs 卡死/日志（每 30 分钟）；具体清理策略由后台「定时任务」配置
  setInterval(() => cleanup().catch((e) => console.error('[cleanup]', e.message)), 30 * 60 * 1000);

  // 后台可配置的定时任务调度器（每分钟检查到期任务）
  await scheduler.start();

  app.listen(PORT, () => {
    const lanIPs = getLanIPv4();
    console.log('✓ 服务已启动: http://localhost:' + PORT);
    console.log('  管理后台  : http://localhost:' + PORT + '/admin/');
    console.log('  健康检查  : http://localhost:' + PORT + '/healthz');
    console.log('  文件目录  : ' + (storageInfo ? storageInfo.root : uploadDir) +
      (storageInfo ? (storageInfo.source === 'custom' ? '（后台自定义）' : '（.env 默认）') : ''));
    console.log('  微信模式  : ' + (process.env.WX_APPID ? '正式（code2session）' : '开发（模拟 openid）'));
    if (lanIPs.length) {
      console.log('');
      console.log('  ┌───────────── 手机真机测试（局域网）─────────────┐');
      lanIPs.forEach((ip) => {
        console.log('  │  后端地址：http://' + ip + ':' + PORT);
        console.log('  │  后台地址：http://' + ip + ':' + PORT + '/admin/');
      });
      console.log('  │  ↑ 把这些地址填到 miniprogram/utils/constants.js');
      console.log('  │  手机和电脑必须连同一个 WiFi');
      console.log('  └────────────────────────────────────────────────┘');
    }
    if (freshAccount) {
      console.log('');
      console.log('  ┌──────────────── 后台登录账号 ────────────────┐');
      console.log('  │  账号：' + freshAccount.account);
      console.log('  │  密码：' + freshAccount.password);
      console.log('  │  登录地址：http://localhost:' + PORT + '/admin/');
      console.log('  └──────────────────────────────────────────────┘');
      console.log('  ⚠ 请登录后立即修改密码');
    }
  });
}

/** 清理过期产物 / 回收卡死任务 / 清旧日志 */
async function cleanup() {
  // 1) 过期 done 任务
  const expired = await db.query(
    'SELECT * FROM wc_jobs WHERE status = "done" AND expires_at IS NOT NULL AND expires_at < NOW() LIMIT 500'
  );
  if (expired.length) {
    expired.forEach((j) => files.remove([j.out_file, j.thumb_file, j.src_file].filter(Boolean)));
    await db.exec('DELETE FROM wc_jobs WHERE id IN (' + expired.map(() => '?').join(',') + ')',
      expired.map((j) => j.id));
    console.log('[cleanup] 清理过期任务', expired.length, '个');
  }

  // 2) 超过 2 小时仍 processing 的任务 → failed
  await db.exec(
    'UPDATE wc_jobs SET status = "failed", error = "处理超时，请重试", finished_at = NOW() ' +
    'WHERE status = "processing" AND created_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)'
  );

  // 3) 90 天前日志
  await db.exec('DELETE FROM wc_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)');
}

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n正在退出…');
  try {
    if (db.getPool()) db.getPool().end();
  } catch (e) { /* 忽略 */ }
  process.exit(0);
});

start().catch((e) => {
  console.error('✗ 启动失败:', e.message);
  process.exit(1);
});
