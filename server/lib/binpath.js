/**
 * FFmpeg / ffprobe 可执行文件定位
 *
 * 为什么要有这个模块：
 *   .env 里的 FFMPEG_PATH 一旦写成绝对路径，就绑死在这台机器的这个目录上。
 *   项目拷到别的电脑、或换个盘放，视频功能会直接报「无法启动 ffmpeg」，而且错误信息
 *   看不出是路径失效。所以这里统一做一次探测，按下面的优先级找，找不到才报错。
 *
 * 优先级：
 *   1) .env 里配置的 FFMPEG_PATH / FFPROBE_PATH，且文件确实存在
 *   2) 项目内置的 tools/bin/ffmpeg(.exe) —— 相对项目根目录解析，所以拷到哪都有效
 *   3) 交回裸命令名，由系统 PATH 解析（用户自行全局安装 FFmpeg 的情形）
 *
 * 配置了但失效时会打印一条 warn，说明实际用了哪个，方便排查。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** 项目根目录（server/lib → server → 项目根） */
const ROOT = path.join(__dirname, '..', '..');
const BIN_DIR = path.join(ROOT, 'tools', 'bin');
const EXE = process.platform === 'win32' ? '.exe' : '';

let warned = {};

function warnOnce(key, msg) {
  if (warned[key]) return;
  warned[key] = true;
  console.warn('[binpath] ' + msg);
}

/**
 * 找一个可执行文件
 * @param {string} envValue .env 里配置的值
 * @param {string} name 命令名（ffmpeg / ffprobe）
 * @returns {string} 可直接 spawn 的路径或命令名
 */
function resolve(envValue, name) {
  const raw = String(envValue || '').trim();

  if (raw) {
    // 相对路径按项目根解析，绝对路径原样用
    const abs = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
    if (fs.existsSync(abs)) return abs;
    warnOnce(name, '配置的 ' + name.toUpperCase() + '_PATH 不存在（' + raw + '），已自动改用其它来源');
  }

  const local = path.join(BIN_DIR, name + EXE);
  if (fs.existsSync(local)) {
    if (raw) warnOnce(name + '-local', '已改用项目内置：' + local);
    return local;
  }

  if (raw) warnOnce(name + '-path', '项目内置也没有，改用系统 PATH 里的 ' + name);
  return name;
}

/** ffmpeg 路径（惰性求值：确保 .env 已加载） */
function ffmpeg() {
  return resolve(process.env.FFMPEG_PATH, 'ffmpeg');
}

/** ffprobe 路径 */
function ffprobe() {
  return resolve(process.env.FFPROBE_PATH, 'ffprobe');
}

/** 供后台 / 自检展示 */
function describe() {
  const ff = ffmpeg();
  const fp = ffprobe();
  const source = (p) => {
    if (p === 'ffmpeg' || p === 'ffprobe') return '系统 PATH';
    if (p.indexOf(BIN_DIR) === 0) return '项目内置 tools/bin';
    return '.env 配置';
  };
  return {
    root: ROOT.split(path.sep).join('/'),
    binDir: BIN_DIR.split(path.sep).join('/'),
    ffmpeg: ff.split(path.sep).join('/'),
    ffprobe: fp.split(path.sep).join('/'),
    ffmpegSource: source(ff),
    ffprobeSource: source(fp)
  };
}

module.exports = { ffmpeg, ffprobe, describe, ROOT, BIN_DIR };
