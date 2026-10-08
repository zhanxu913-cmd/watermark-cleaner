/**
 * FFmpeg / ffprobe 进程封装
 *
 * - probe(file)  取分辨率、时长、旋转角、是否含音轨
 * - encode(args) 执行转码，并通过 -progress pipe:1 实时回报进度
 * - thumbnail()  抽一帧做封面
 */

'use strict';

const { spawn } = require('child_process');
const binpath = require('./binpath');

// 路径由 binpath 统一解析：配置可用则用配置，失效则退回项目内置 tools/bin，再退回系统 PATH
const FFMPEG = binpath.ffmpeg();
const FFPROBE = binpath.ffprobe();

/* ============================================================
   ffprobe
   ============================================================ */

function probe(file) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      file
    ];

    const ps = spawn(FFPROBE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';

    ps.stdout.on('data', (c) => (out += c));
    ps.stderr.on('data', (c) => (err += c));
    ps.on('error', (e) => reject(new Error('无法启动 ffprobe：' + e.message)));
    ps.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe 解析失败：' + tail(err)));
      let json;
      try {
        json = JSON.parse(out);
      } catch (e) {
        return reject(new Error('ffprobe 输出无法解析'));
      }
      resolve(normalize(json));
    });
  });
}

function normalize(json) {
  const streams = json.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');

  if (!v) throw new Error('文件里没有视频轨道');

  const rotation = detectRotation(v);
  const rawW = Number(v.width) || 0;
  const rawH = Number(v.height) || 0;
  const swapped = rotation === 90 || rotation === 270;

  const duration =
    Number(json.format && json.format.duration) ||
    Number(v.duration) ||
    Number(a && a.duration) ||
    0;

  return {
    // 显示尺寸：滤镜图作用在自动旋转之后的画面上
    width: swapped ? rawH : rawW,
    height: swapped ? rawW : rawH,
    rawWidth: rawW,
    rawHeight: rawH,
    rotation,
    duration: isFinite(duration) ? duration : 0,
    hasAudio: !!a,
    audioCodec: a ? a.codec_name || '' : '',
    videoCodec: v.codec_name || '',
    fps: parseFps(v.avg_frame_rate || v.r_frame_rate)
  };
}

function detectRotation(stream) {
  const list = stream.side_data_list || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].rotation !== undefined) {
      const r = Number(list[i].rotation);
      if (isFinite(r)) return ((Math.round(r) % 360) + 360) % 360;
    }
  }
  const tag = stream.tags && stream.tags.rotate;
  if (tag !== undefined) {
    const r = Number(tag);
    if (isFinite(r)) return ((Math.round(r) % 360) + 360) % 360;
  }
  return 0;
}

function parseFps(rate) {
  if (!rate) return 0;
  const parts = String(rate).split('/');
  if (parts.length === 2) {
    const n = Number(parts[0]);
    const d = Number(parts[1]);
    if (d) return Math.round((n / d) * 100) / 100;
  }
  return Number(rate) || 0;
}

/* ============================================================
   ffmpeg
   ============================================================ */

/**
 * 执行一次转码
 * @param {string[]} args
 * @param {object} [opts]
 * @param {number} [opts.totalDuration] 用于换算进度百分比
 * @param {function} [opts.onProgress]  (percent 0-100) => void
 * @returns {Promise<{ code:number, stderr:string }>}
 */
function encode(args, opts) {
  const options = opts || {};
  const total = Number(options.totalDuration) || 0;

  return new Promise((resolve, reject) => {
    const full = ['-hide_banner', '-nostats', '-progress', 'pipe:1'].concat(args);
    const ps = spawn(FFMPEG, full, { stdio: ['ignore', 'pipe', 'pipe'] });

    let errTail = [];
    let stdoutBuf = '';
    let lastReported = -1;
    let lastTick = 0;

    ps.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';

      lines.forEach((line) => {
        const eq = line.indexOf('=');
        if (eq < 0) return;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();

        if (key !== 'out_time_us' && key !== 'out_time_ms') return;

        // out_time_ms 在多数版本里实际是微秒，两个字段统一按微秒处理
        const us = Number(val);
        if (!isFinite(us) || us <= 0 || !total) return;

        const percent = Math.max(0, Math.min(99, Math.round((us / 1e6 / total) * 100)));
        const now = Date.now();
        if (percent > lastReported && (now - lastTick > 1500 || percent - lastReported >= 5)) {
          lastReported = percent;
          lastTick = now;
          if (typeof options.onProgress === 'function') options.onProgress(percent);
        }
      });
    });

    ps.stderr.on('data', (chunk) => {
      errTail.push(chunk.toString());
      if (errTail.length > 60) errTail.shift();
    });

    ps.on('error', (e) => reject(new Error('无法启动 ffmpeg：' + e.message)));
    ps.on('close', (code) => {
      const stderr = errTail.join('');
      if (code === 0) {
        if (typeof options.onProgress === 'function') options.onProgress(100);
        return resolve({ code, stderr });
      }
      reject(new Error('ffmpeg 退出码 ' + code + '：' + tail(stderr)));
    });
  });
}

/**
 * 抽帧生成封面
 * @param {string} input
 * @param {string} output
 * @param {number} [second]
 * @param {number} [maxEdge]
 */
async function thumbnail(input, output, second, maxEdge) {
  const at = Math.max(0, Number(second) || 0);
  const edge = Math.max(120, Number(maxEdge) || 480);

  await encode([
    '-y',
    '-ss', at.toFixed(3),
    '-i', input,
    '-frames:v', '1',
    '-vf', 'scale=' + edge + ':-2:flags=bicubic',
    '-q:v', '4',
    output
  ]);

  return output;
}

/* ============================================================
   工具
   ============================================================ */

function tail(s, n) {
  const str = String(s || '').trim();
  const limit = n || 400;
  if (str.length <= limit) return str;
  return '…' + str.slice(-limit);
}

module.exports = {
  probe,
  encode,
  thumbnail,
  FFMPEG,
  FFPROBE
};
