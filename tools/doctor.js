#!/usr/bin/env node
/**
 * 环境自检
 *
 * 用法：node tools/doctor.js
 *
 * 小程序视频已改为全离线（VideoDecoder + WebGL + MediaRecorder），
 * 不再需要任何服务。本脚本检查：
 *   1. Node 版本（开发工具链）
 *   2. 小程序静态完整性（页面四件套、require 可解析）
 *   3. 确认无远程视频地址残留
 *   4. video-service-lite 后备服务依赖（可选，仅历史方案回退时使用）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVICE = path.join(ROOT, 'video-service-lite');
const MP = path.join(ROOT, 'miniprogram');
const NODE = process.execPath;

const rows = [];

function check(name, ok, detail) {
  rows.push({ name, ok, detail });
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (detail ? '   ' + detail : ''));
}

/* ---------------- 1. Node ---------------- */

const major = Number((process.versions.node || '0').split('.')[0]);
check('Node 版本', major >= 18, process.versions.node + (major >= 18 ? '' : '（需要 >= 18）'));

/* ---------------- 2. 小程序静态完整性 ---------------- */

let staticOk = false;
let staticDetail = '运行失败';
try {
  const out = execFileSync(NODE, [path.join(ROOT, 'tools', 'check-miniprogram.js'), MP], {
    encoding: 'utf8',
    timeout: 30000
  });
  staticOk = /全部通过/.test(out);
  staticDetail = (out.match(/检查文件：[^\n]*/) || [''])[0] || '已运行';
} catch (e) {
  staticDetail = (e.stdout || '').match(/检查文件：[^\n]*/)?.[0] || '运行失败';
}
check('小程序静态完整性', staticOk, staticDetail);

/* ---------------- 3. 远程地址残留 ---------------- */

let leftover = '';
try {
  const constants = fs.readFileSync(path.join(MP, 'utils', 'constants.js'), 'utf8');
  if (/VIDEO_API_BASE_URL|VIDEO_CLIENT_TOKEN/.test(constants)) leftover = 'constants.js 仍含远程地址常量';
  if (/192\.168\.\d+\.\d+|https?:\/\/(?!developers)/.test(constants)) leftover = 'constants.js 含硬编码地址';
} catch (e) {
  leftover = 'constants.js 读取失败';
}
check('零后端配置确认', !leftover, leftover || '无远程地址，图片/视频全离线');

/* ---------------- 4. 后备服务（可选） ---------------- */

const deps = path.join(SERVICE, 'node_modules', 'express');
const hasDeps = fs.existsSync(deps);
console.log(
  '  ⓘ video-service-lite 后备服务依赖 ' +
    (hasDeps ? '已安装' : '未安装') +
    '（可选；仅当需要回退到「电脑处理」方案时使用）'
);

/* ---------------- 汇总 ---------------- */

const bad = rows.filter((x) => !x.ok);
console.log('');
console.log('─'.repeat(52));
if (!bad.length) {
  console.log('全部通过 ✓  图片 / 视频全离线，随时可用');
} else {
  console.log('有 ' + bad.length + ' 项需要处理：');
  bad.forEach((b) => console.log('  · ' + b.name + '  ' + b.detail));
}
console.log('─'.repeat(52));
