#!/usr/bin/env node
/**
 * 环境自检
 *
 * 用法：node tools/doctor.js
 *
 * 检查项（只读，不启动任何服务）：
 *   1. Node 版本
 *   2. FFmpeg / ffprobe 可执行文件是否找得到
 *   3. 视频服务依赖是否已安装
 *   4. 视频服务是否正在运行
 *   5. 小程序是否已填写 VIDEO_API_BASE_URL
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SERVICE = path.join(ROOT, 'video-service-lite');
const MP = path.join(ROOT, 'miniprogram');
const PROBE = process.env.PROBE_URL || 'http://127.0.0.1:3100/api/video/service';

const rows = [];

function check(name, ok, detail) {
  rows.push({ name, ok, detail });
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (detail ? '   ' + detail : ''));
}

/* ---------------- 1. Node ---------------- */

const major = Number((process.versions.node || '0').split('.')[0]);
check('Node 版本', major >= 18, process.versions.node + (major >= 18 ? '' : '（需要 >= 18）'));

/* ---------------- 2. FFmpeg ---------------- */

function findInPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (let i = 0; i < dirs.length; i++) {
    for (let j = 0; j < exts.length; j++) {
      const p = path.join(dirs[i], name + exts[j]);
      try {
        if (fs.existsSync(p)) return p;
      } catch (e) {
        /* 忽略无权限目录 */
      }
    }
  }
  return '';
}

function resolveBin(name, envKey) {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const fromEnv = process.env[envKey];
  if (fromEnv && fs.existsSync(fromEnv)) return { path: fromEnv, from: '.env 配置' };

  const local = path.join(ROOT, 'tools', 'bin', name + exe);
  if (fs.existsSync(local)) return { path: local, from: 'tools/bin' };

  const sys = findInPath(name);
  if (sys) return { path: sys, from: '系统 PATH' };

  return { path: '', from: '' };
}

const ff = resolveBin('ffmpeg', 'FFMPEG_PATH');
const fp = resolveBin('ffprobe', 'FFPROBE_PATH');

check('ffmpeg', !!ff.path, ff.path ? ff.from + '  ' + ff.path : '未找到（视频功能不可用）');
check('ffprobe', !!fp.path, fp.path ? fp.from + '  ' + fp.path : '未找到（视频功能不可用）');

/* ---------------- 3. 服务依赖 ---------------- */

const deps = path.join(SERVICE, 'node_modules', 'express');
check(
  '视频服务依赖',
  fs.existsSync(deps),
  fs.existsSync(deps) ? '已安装' : '未安装，执行：cd video-service-lite && npm install'
);

/* ---------------- 4. 服务是否在跑 ---------------- */

function probe() {
  return new Promise((resolve) => {
    const req = http.get(PROBE, { timeout: 4000 }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          resolve({ up: true, data: j.data || {} });
        } catch (e) {
          resolve({ up: true, data: {} });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ up: false });
    });
    req.on('error', () => resolve({ up: false }));
  });
}

/* ---------------- 5. 小程序配置 ---------------- */

const constants = path.join(MP, 'utils', 'constants.js');
let apiBase = '';
try {
  const src = fs.readFileSync(constants, 'utf8');
  const m = /^[ \t]*const\s+VIDEO_API_BASE_URL\s*=\s*['"]([^'"]*)['"]/m.exec(src);
  apiBase = m ? m[1].trim() : '';
} catch (e) {
  apiBase = '';
}

check(
  '小程序视频地址',
  !!apiBase,
  apiBase || "未填写（图片功能不受影响）—— 改 miniprogram/utils/constants.js 的 VIDEO_API_BASE_URL"
);

/* ---------------- 汇总 ---------------- */

probe().then((r) => {
  check(
    '视频服务运行中',
    r.up,
    r.up
      ? (r.data.available ? '就绪 ' + (r.data.ffmpegFrom || '') : '已启动但 FFmpeg 未就绪')
      : '未启动 —— cd video-service-lite && npm start'
  );

  const bad = rows.filter((x) => !x.ok);
  console.log('');
  console.log('─'.repeat(52));
  if (!bad.length) {
    console.log('全部通过 ✓  图片功能随时可用，视频功能已就绪');
  } else {
    console.log('有 ' + bad.length + ' 项需要处理：');
    bad.forEach((b) => console.log('  · ' + b.name + '  ' + b.detail));
    console.log('');
    console.log('提示：图片去水印完全不依赖以上任何一项，只有视频功能受影响。');
  }
  console.log('─'.repeat(52));
});
