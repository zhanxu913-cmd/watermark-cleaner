#!/usr/bin/env node
/**
 * FFmpeg 自动获取脚本（Windows）
 *
 * 为什么需要：视频去水印依赖 FFmpeg，但 Windows 默认不带。
 * 本脚本把 ffmpeg.exe / ffprobe.exe 下载到 tools/bin/ 并写入 server/.env，
 * 不污染系统 PATH，删除文件夹即卸载。
 *
 * 用法：
 *   node tools/get-ffmpeg.js           下载并安装到 tools/bin/
 *   node tools/get-ffmpeg.js --check   只检测当前是否可用
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(__dirname, 'bin');
const ENV_FILE = path.join(ROOT, 'server', '.env');

const URLS = [
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
];

function log(m) { console.log(m); }

/* ---------- 检测 ---------- */
function findInBin() {
  const names = ['ffmpeg.exe', 'ffmpeg'];
  // 直接在 tools/bin 下找，也找一层子目录（解压后常带 ffmpeg-x.x-essentials_build/bin/）
  const stack = [BIN_DIR];
  while (stack.length) {
    const dir = stack.pop();
    if (!fs.existsSync(dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (names.includes(e.name.toLowerCase())) {
        const probe = path.join(path.dirname(full), 'ffprobe.exe');
        return { ffmpeg: full, ffprobe: fs.existsSync(probe) ? probe : null };
      }
    }
  }
  return null;
}

function checkSystem() {
  try {
    const out = execSync('ffmpeg -version', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out.split('\n')[0];
  } catch (e) { return null; }
}

function check() {
  const local = findInBin();
  const sys = checkSystem();
  log('本机 FFmpeg 检测：');
  log('  tools/bin 内 : ' + (local ? '✓ ' + local.ffmpeg : '✗ 未找到'));
  log('  系统 PATH 内 : ' + (sys ? '✓ ' + sys : '✗ 未找到'));
  if (!local && !sys) {
    log('');
    log('→ 视频功能不可用。运行  node tools/get-ffmpeg.js  自动安装。');
    return false;
  }
  return true;
}

/* ---------- 下载 ---------- */
function download(url, dest, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 6) return reject(new Error('重定向次数过多'));
    log('  下载中… ' + url.slice(0, 72));
    const req = https.get(url, { timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return download(res.headers.location, dest, (redirects || 0) + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      let lastPct = -1;
      const f = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct >= lastPct + 10) { lastPct = pct; process.stdout.write('    ' + pct + '%\r'); }
        }
      });
      res.pipe(f);
      f.on('finish', () => f.close(() => { process.stdout.write('    100%\n'); resolve(dest); }));
      f.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
    req.on('error', reject);
  });
}

/* ---------- 解压（用 PowerShell Expand-Archive，免依赖）---------- */
function unzip(zip, outDir) {
  log('  解压中…');
  const r = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${outDir}' -Force`
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('解压失败');
}

/* ---------- 写入 .env ---------- */
function writeEnv(ffmpeg, ffprobe) {
  if (!fs.existsSync(ENV_FILE)) {
    log('  ⚠ 未找到 server/.env，跳过写入（请手动配置 FFMPEG_PATH）');
    return;
  }
  // 转成相对 server/ 的路径，便于整个项目搬走
  const rel = (p) => path.relative(path.join(ROOT, 'server'), p).replace(/\\/g, '/');
  let src = fs.readFileSync(ENV_FILE, 'utf8');
  const setKey = (s, k, v) => {
    const re = new RegExp('^' + k + '=.*$', 'm');
    if (re.test(s)) return s.replace(re, k + '=' + v);
    return s.replace(/\s*$/, '\n' + k + '=' + v + '\n');
  };
  src = setKey(src, 'FFMPEG_PATH', rel(ffmpeg));
  if (ffprobe) src = setKey(src, 'FFPROBE_PATH', rel(ffprobe));
  fs.writeFileSync(ENV_FILE, src, 'utf8');
  log('  ✓ 已写入 server/.env：FFMPEG_PATH=' + rel(ffmpeg));
  if (ffprobe) log('                          FFPROBE_PATH=' + rel(ffprobe));
}

/* ---------- 主流程 ---------- */
async function main() {
  if (process.argv.includes('--check')) { check(); return; }

  // ffprobe 独立检测：ffmpeg-static 不含 ffprobe，需单独装 ffprobe-static
  const needFfprobe = !fs.existsSync(path.join(BIN_DIR, 'ffprobe.exe'));

  if (findInBin() && !needFfprobe) {
    log('✓ tools/bin 里已有 FFmpeg + FFprobe，无需重复下载。');
    const l = findInBin();
    writeEnv(l.ffmpeg, l.ffprobe || path.join(BIN_DIR, 'ffprobe.exe'));
    verify(l.ffmpeg);
    return;
  }

  if (findInBin() && needFfprobe) {
    log('✓ ffmpeg 已存在，但缺少 ffprobe —— 单独补装 ffprobe-static …');
    await installViaNpm('ffprobe-static', 'ffprobe.exe');
    const l = findInBin();
    writeEnv(l.ffmpeg, l.ffprobe);
    verify(l.ffmpeg);
    return;
  }

  if (checkSystem()) {
    log('✓ 系统 PATH 里已有 FFmpeg，直接可用，无需下载。');
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const zip = path.join(BIN_DIR, 'ffmpeg.zip');

  let ok = false;
  for (const url of URLS) {
    try {
      await download(url, zip);
      ok = true;
      break;
    } catch (e) {
      log('  ✗ 该源失败：' + e.message + '，换下一个源…');
    }
  }
  if (!ok) {
    log('');
    log('✗ 所有下载源都失败。请手动下载 FFmpeg 后放到 tools/bin/：');
    log('  https://www.gyan.dev/ffmpeg/builds/');
    process.exit(1);
  }

  unzip(zip, BIN_DIR);
  try { fs.unlinkSync(zip); } catch (e) { /* 忽略 */ }

  let found = findInBin();
  if (!found) { log('✗ 解压后仍未找到 ffmpeg.exe，请检查 tools/bin 目录'); process.exit(1); }

  log('');
  log('✓ FFmpeg 已安装：');
  log('  ' + found.ffmpeg);

  // 官方 zip 通常自带 ffprobe；没有的话补装
  if (!found.ffprobe) {
    log('  官方包未含 ffprobe，补装 ffprobe-static …');
    await installViaNpm('ffprobe-static', 'ffprobe.exe');
    found = findInBin();
  }

  writeEnv(found.ffmpeg, found.ffprobe);
  verify(found.ffmpeg);
}

/** 通过 npmmirror 安装含静态二进制的 npm 包，并把目标 exe 拷到 tools/bin */
async function installViaNpm(pkg, exeName) {
  const tmp = path.join(__dirname, '.' + pkg + '-tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const npmCli = process.env.npm_cli || 'npm';
  const { execFile } = require('child_process');
  await new Promise((resolve, reject) => {
    execFile(npmCli, ['install', pkg, '--registry=https://registry.npmmirror.com', '--no-audit', '--no-fund', '--prefix', tmp], (err, stdout, stderr) => {
      if (err) { reject(new Error('npm install 失败: ' + (stderr || err.message).slice(0, 200))); return; }
      resolve();
    });
  });
  // 在 node_modules 里找 exe
  const found = findExeRecursive(path.join(tmp, 'node_modules', pkg), exeName);
  if (!found) throw new Error('包 ' + pkg + ' 中未找到 ' + exeName);
  const dest = path.join(BIN_DIR, exeName);
  fs.copyFileSync(found, dest);
  // 清理临时目录
  fs.rmSync(tmp, { recursive: true, force: true });
  log('  ✓ ' + exeName + ' 已安装到 tools/bin/（来自 ' + pkg + '）');
}

function findExeRecursive(dir, exeName) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.name.toLowerCase() === exeName.toLowerCase()) return full;
    }
  }
  return null;
}

function verify(ffmpegPath) {
  const r = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8' });
  if (r.status === 0) {
    log('');
    log('  版本：' + String(r.stdout).split('\n')[0]);
    log('');
    log('✓ 完成。重启后端（npm start）后视频功能即可用。');
  } else {
    log('✗ 验证失败，可能是文件损坏或被杀软拦截。');
  }
}

main().catch((e) => { console.error('异常：' + e.message); process.exit(1); });
