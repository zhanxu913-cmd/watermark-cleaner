#!/usr/bin/env node
/**
 * 一键检查 —— 启动前自检所有依赖是否就绪
 *
 * 用法：node tools/doctor.js
 *
 * 检查项：Node 版本 / MySQL 连通 / 数据库表 / FFmpeg / 后端端口 / 小程序配置
 */
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const CONST_FILE = path.join(ROOT, 'miniprogram', 'utils', 'constants.js');
const PROJ_CFG = path.join(ROOT, 'project.config.json');

let problems = [];

function ok(t) { console.log('  ✓ ' + t); }
function bad(t, fix) { console.log('  ✗ ' + t); if (fix) console.log('      → ' + fix); problems.push(t); }
function warn(t, fix) { console.log('  ! ' + t); if (fix) console.log('      → ' + fix); }

function readEnv() {
  const f = path.join(SERVER, '.env');
  const out = {};
  if (!fs.existsSync(f)) return out;
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l) => {
    const t = l.trim();
    if (!t || t[0] === '#') return;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  });
  return out;
}

function portOpen(port, host, cb) {
  const s = new net.Socket();
  s.setTimeout(1200);
  s.once('connect', () => { s.destroy(); cb(true); });
  s.once('timeout', () => { s.destroy(); cb(false); });
  s.once('error', () => { s.destroy(); cb(false); });
  s.connect(port, host || '127.0.0.1');
}

(async function main() {
  console.log('\n═══ 水印清理小程序 · 环境自检 ═══\n');

  // 1. Node
  console.log('[1] Node.js');
  const nodeV = process.versions.node;
  const major = Number(nodeV.split('.')[0]);
  if (major >= 16) ok('Node ' + nodeV); else bad('Node ' + nodeV + ' 版本过低', '需 Node 16+');

  // 2. .env
  console.log('\n[2] 后端配置 server/.env');
  const env = readEnv();
  if (!Object.keys(env).length) {
    bad('server/.env 不存在', '复制 server/.env.example 为 .env 并填写');
    env.DB_HOST = '127.0.0.1';
  } else {
    ok('.env 已存在');
    ['DB_HOST', 'DB_USER', 'DB_NAME'].forEach((k) => {
      if (env[k]) ok('  ' + k + ' = ' + env[k]); else bad('  缺少 ' + k);
    });
  }

  // 3. MySQL
  console.log('\n[3] MySQL (' + (env.DB_HOST || '127.0.0.1') + ':' + (env.DB_PORT || 3306) + ')');
  const dbOpen = await new Promise((r) => portOpen(Number(env.DB_PORT) || 3306, env.DB_HOST || '127.0.0.1', r));
  if (dbOpen) ok('端口可连通');
  else bad('MySQL 连不上', '确认 MySQL 服务已启动（net start mysql80）');

  // 4. 数据库表
  console.log('\n[4] 数据表');
  if (dbOpen && env.DB_NAME) {
    try {
      // 直接用项目自带的 mysql2 连接，避免依赖 mysql.exe 命令行客户端
      const mysql = require(path.join(SERVER, 'node_modules', 'mysql2', 'promise'));
      const conn = await mysql.createConnection({
        host: env.DB_HOST || '127.0.0.1',
        port: Number(env.DB_PORT) || 3306,
        user: env.DB_USER || 'root',
        password: env.DB_PASSWORD || '',
        database: env.DB_NAME
      });
      const [rows] = await conn.query('SHOW TABLES');
      await conn.end();
      const n = rows.length;
      if (n >= 5) ok(env.DB_NAME + ' 有 ' + n + ' 张表');
      else bad('仅 ' + n + ' 张表，应为 5 张', '执行 server/db/schema.sql 导入');
    } catch (e) {
      bad('数据库连接/查询失败：' + e.message, '检查 .env 中的账号密码、以及库是否已建');
    }
  } else {
    warn('跳过表检查（数据库端口不通）');
  }

  // 5. FFmpeg / FFprobe
  // 用 server/lib/binpath 的同一套逻辑解析，保证自检结果和服务实际使用的完全一致
  console.log('\n[5] FFmpeg / FFprobe（视频去水印依赖）');
  const binpath = require(path.join(SERVER, 'lib', 'binpath'));
  let bins;
  try {
    bins = binpath.describe();
  } catch (e) {
    bins = { ffmpeg: env.FFMPEG_PATH || 'ffmpeg', ffprobe: env.FFPROBE_PATH || 'ffprobe', ffmpegSource: '未知', ffprobeSource: '未知' };
  }
  const localFF = bins.ffmpeg;
  const localFP = bins.ffprobe;
  const ffExists = fs.existsSync(localFF);
  const fpExists = fs.existsSync(localFP);

  if (ffExists) {
    const sizeMB = (fs.statSync(localFF).size / 1048576).toFixed(1);
    ok('ffmpeg 可用 (' + sizeMB + ' MB · ' + bins.ffmpegSource + '): ' + localFF);
  } else if (localFF === 'ffmpeg') {
    bad('未找到 ffmpeg', '运行  node tools/get-ffmpeg.js  自动安装（图片功能不受影响）');
  } else {
    bad('ffmpeg 路径无效: ' + localFF, '清空 .env 里的 FFMPEG_PATH 走自动探测，或运行 node tools/get-ffmpeg.js');
  }

  if (fpExists) {
    ok('ffprobe 可用 (' + bins.ffprobeSource + '): ' + localFP);
  } else if (localFP === 'ffprobe') {
    bad('未找到 ffprobe', '视频功能必须要有。运行  node tools/get-ffmpeg.js  自动安装');
  } else {
    bad('ffprobe 路径无效: ' + localFP, '清空 .env 里的 FFPROBE_PATH 走自动探测');
  }

  if (!ffExists && !fpExists && localFF !== 'ffmpeg') {
    console.log('  !  说明：没有 ffmpeg/ffprobe 只影响视频线，图片线不受影响');
  }

  // 6. 后端端口
  console.log('\n[6] 后端服务');
  const apiPort = Number(env.PORT) || 3000;
  const apiOpen = await new Promise((r) => portOpen(apiPort, '127.0.0.1', r));
  if (apiOpen) ok('端口 ' + apiPort + ' 正在监听（服务已启动）');
  else warn('端口 ' + apiPort + ' 未监听', 'cd server && npm start');

  // 7. 局域网 IP
  console.log('\n[7] 真机测试地址');
  const ips = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    if (/vmware|virtualbox|vethernet|docker|wsl|hyper-v/i.test(name)) return;
    (ifaces[name] || []).forEach((it) => {
      if (it.family === 'IPv4' && !it.internal && !it.address.startsWith('169.254.')) ips.push(it.address);
    });
  });
  if (ips.length) ok('局域网 IP: ' + ips.join(', '));
  else warn('未检测到局域网 IP', '连接 WiFi 后再试');

  // 8. 小程序配置
  console.log('\n[8] 小程序配置');
  if (fs.existsSync(CONST_FILE)) {
    const src = fs.readFileSync(CONST_FILE, 'utf8');
    const m = src.match(/^\s*const API_BASE_URL = '([^']+)'/m);
    const url = m ? m[1] : '(未设置)';
    ok('API_BASE_URL = ' + url);
    if (url.indexOf('127.0.0.1') === -1 && url.indexOf('localhost') === -1) {
      ok('  → 当前为真机模式，手机可访问');
    } else {
      warn('  → 当前为模拟器模式，手机扫码连不上', 'node tools/lan-ip.js --set');
    }
  } else {
    bad('找不到 miniprogram/utils/constants.js');
  }

  if (fs.existsSync(PROJ_CFG)) {
    const cfg = JSON.parse(fs.readFileSync(PROJ_CFG, 'utf8'));
    if (cfg.appid === 'touristappid' || !cfg.appid) {
      bad('appid 为游客模式（touristappid）', '手机扫码必须换成真实 AppID，见 docs/手机扫码真机测试.md');
    } else {
      ok('appid = ' + cfg.appid);
    }
  }

  // 汇总
  console.log('\n' + '═'.repeat(46));
  if (!problems.length) {
    console.log('全部就绪，可以直接使用 ✓');
  } else {
    console.log('发现 ' + problems.length + " 个待处理项：");
    problems.forEach((p, i) => console.log('  ' + (i + 1) + '. ' + p));
  }
  console.log('═'.repeat(46) + '\n');
})();
