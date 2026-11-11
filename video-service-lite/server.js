/**
 * 极简视频去水印服务
 *
 * 定位：只做一件事 —— 收一个视频、按框选区域跑 FFmpeg、回一个 mp4。
 *      没有数据库、没有登录、没有用户体系、没有管理后台。
 *
 * 状态全部放内存（重启即清空），产物按 KEEP_HOURS 自动删除。
 *
 * 接口：
 *   POST /api/video/submit   multipart：file + mode/region/timeRange/duration/fileName
 *   GET  /api/video/status   ?id=xxx
 *   GET  /api/video/service  探测 FFmpeg 是否就绪
 *   GET  /files/:name        产物下载（mp4 / jpg）
 *   GET  /healthz            健康检查（给容器平台用）
 *
 * 鉴权：可选静态令牌 CLIENT_TOKEN，与小程序端 VIDEO_CLIENT_TOKEN 一致；
 *      两边都留空则不校验（只建议本地调试时这样）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');

/* ============================================================
   配置
   ============================================================ */

/** 轻量 .env 解析（不引入 dotenv，少一个依赖） */
function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  let txt = '';
  try {
    txt = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return;
  }
  txt.split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s || s.charAt(0) === '#') return;
    const i = s.indexOf('=');
    if (i < 1) return;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if (
      (v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') ||
      (v.charAt(0) === "'" && v.charAt(v.length - 1) === "'")
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  });
}

loadEnv();

// 必须在 loadEnv 之后加载：ffmpeg.js 在模块初始化时就会解析可执行文件路径
const ff = require('./lib/ffmpeg');
const graph = require('./lib/graph');
const binpath = require('./lib/binpath');

const PORT = Number(process.env.PORT) || 3100;
const CLIENT_TOKEN = String(process.env.CLIENT_TOKEN || '').trim();
const WORK_DIR = process.env.WORK_DIR || path.join(__dirname, '.work');
const IN_DIR = path.join(WORK_DIR, 'incoming');
const OUT_DIR = path.join(WORK_DIR, 'output');
const KEEP_HOURS = Math.max(1, Number(process.env.KEEP_HOURS) || 24);
const MAX_SIZE_MB = Math.max(1, Number(process.env.MAX_SIZE_MB) || 500);
const MAX_DURATION = Math.max(0, Number(process.env.MAX_DURATION) || 60);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY) || 1);
const PUBLIC_BASE = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

[WORK_DIR, IN_DIR, OUT_DIR].forEach((d) => {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    /* 已存在 */
  }
});

/* ============================================================
   任务表
   ============================================================ */

/**
 * job = {
 *   id, status, progress, error,
 *   mode, regions, timeRange, fileName, origin,
 *   srcPath, outPath, thumbPath,
 *   duration, width, height, outSize,
 *   createdAt, finishedAt, expiresAt
 * }
 */
const jobs = new Map();

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function publicJob(job) {
  const done = job.status === 'done';
  const origin = PUBLIC_BASE || job.origin || '';
  return {
    id: job.id,
    status: job.status,
    progress: job.progress || 0,
    progressText:
      job.status === 'processing'
        ? '处理中 ' + (job.progress || 0) + '%'
        : job.status === 'pending'
          ? '排队中…'
          : '',
    error: job.error || '',
    url: done ? origin + '/files/' + job.id + '.mp4' : '',
    thumbUrl: done && job.thumbPath ? origin + '/files/' + job.id + '.jpg' : '',
    duration: job.duration || 0,
    width: job.width || 0,
    height: job.height || 0,
    size: job.outSize || 0,
    expiresAt: job.expiresAt || 0
  };
}

/* ============================================================
   队列（串行，避免一台小机器被并发转码打满）
   ============================================================ */

const queue = [];
let running = 0;

function enqueue(id) {
  queue.push(id);
  drain();
}

function drain() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift();
    running += 1;
    processJob(id)
      .catch((e) => fail(id, e))
      .then(() => {
        running -= 1;
        drain();
      });
  }
}

async function processJob(id) {
  const job = jobs.get(id);
  if (!job || job.status === 'done') return;

  job.status = 'processing';
  job.progress = 3;

  const src = job.srcPath;
  if (!src || !fs.existsSync(src)) throw new Error('源视频已丢失，请重新提交');

  /* ---- 1) 探测 ---- */
  const info = await ff.probe(src);
  if (MAX_DURATION > 0 && info.duration > MAX_DURATION + 1) {
    throw new Error('视频时长 ' + Math.round(info.duration) + 's 超过上限 ' + MAX_DURATION + 's');
  }

  job.duration = info.duration;
  job.width = info.width;
  job.height = info.height;

  /* ---- 2) 滤镜图 ---- */
  const built = graph.buildGraph({
    mode: job.mode,
    regions: job.regions,
    timeRange: job.timeRange,
    duration: info.duration,
    width: info.width,
    height: info.height
  });

  job.progress = 8;

  /* ---- 3) 转码 ---- */
  const outPath = path.join(OUT_DIR, id + '.mp4');
  const args = ['-y', '-i', src];

  if (built.graph) {
    args.push('-filter_complex', built.graph, '-map', '[' + built.outLabel + ']');
  } else {
    args.push('-map', '0:v:0');
  }
  if (info.hasAudio) {
    args.push('-map', '0:a:0?', '-c:a', 'copy');
  }
  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath
  );

  const onProgress = (p) => {
    job.progress = Math.min(95, 10 + Math.round(p * 0.85));
  };

  try {
    await ff.encode(args, { totalDuration: info.duration, onProgress });
  } catch (e) {
    // 音轨直拷在个别编码上会失败，退回 aac 重编码再来一次
    if (String(e.message).indexOf('ffmpeg') === -1) throw e;
    console.warn('[video] 音频 copy 失败，改用 aac 重试:', e.message);
    await ff.encode(replaceAudio(args), { totalDuration: info.duration, onProgress });
  }

  if (!fs.existsSync(outPath)) throw new Error('转码未生成文件，请检查 FFmpeg 日志');

  /* ---- 4) 封面 ---- */
  try {
    const thumbPath = path.join(OUT_DIR, id + '.jpg');
    await ff.thumbnail(outPath, thumbPath, Math.min(2, info.duration / 2), 480);
    job.thumbPath = thumbPath;
  } catch (e) {
    /* 封面失败不影响结果 */
  }

  /* ---- 5) 完成 ---- */
  job.outPath = outPath;
  try {
    job.outSize = fs.statSync(outPath).size;
  } catch (e) {
    job.outSize = 0;
  }

  // 裁剪后尺寸会变，以产物为准（拿不到就沿用源尺寸）
  try {
    const outInfo = await ff.probe(outPath);
    if (outInfo && outInfo.width) {
      job.width = outInfo.width;
      job.height = outInfo.height;
    }
  } catch (e) {
    /* 忽略 */
  }

  job.status = 'done';
  job.progress = 100;
  job.finishedAt = Date.now();
  job.expiresAt = Date.now() + KEEP_HOURS * 3600 * 1000;

  // 源文件用完即删，避免占盘
  removeQuiet(job.srcPath);
  job.srcPath = '';

  console.log(
    '[video] 完成 ' + id + '  ' + (job.outSize / 1024 / 1024).toFixed(2) + 'MB' + (built.note ? '  ' + built.note : '')
  );
}

function fail(id, e) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'failed';
  job.progress = 0;
  job.error = String((e && e.message) || '处理失败').slice(0, 300);
  job.finishedAt = Date.now();
  job.expiresAt = Date.now() + KEEP_HOURS * 3600 * 1000;
  removeQuiet(job.srcPath);
  job.srcPath = '';
  console.error('[video] 失败 ' + id + ':', job.error);
}

/* ============================================================
   工具
   ============================================================ */

function removeQuiet(p) {
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch (e) {
    /* 已删除 */
  }
}

function replaceAudio(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c:a' && args[i + 1] === 'copy') {
      out.push('-c:a', 'aac', '-b:a', '128k');
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function normalizeRegions(b) {
  let v = b;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch (e) {
      v = null;
    }
  }
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (Array.isArray(v.regions)) return v.regions;
  if (v.x !== undefined) return [v];
  return [];
}

function safeParse(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

/* ============================================================
   清理
   ============================================================ */

function cleanup() {
  const now = Date.now();

  jobs.forEach((job, id) => {
    if (job.status === 'done' || job.status === 'failed') {
      if (job.expiresAt && job.expiresAt < now) {
        removeQuiet(job.outPath);
        removeQuiet(job.thumbPath);
        removeQuiet(job.srcPath);
        jobs.delete(id);
      }
    } else if (now - (job.createdAt || now) > KEEP_HOURS * 3600 * 1000) {
      // 卡住的任务：超时判失败并清源
      job.status = 'failed';
      job.error = '处理超时，请重新提交';
      job.expiresAt = now + 3600 * 1000;
      removeQuiet(job.srcPath);
      job.srcPath = '';
    }
  });

  // 清掉重启后残留的孤儿上传文件（内存表里查不到的）
  let names = [];
  try {
    names = fs.readdirSync(IN_DIR);
  } catch (e) {
    names = [];
  }
  names.forEach((n) => {
    const p = path.join(IN_DIR, n);
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs > KEEP_HOURS * 3600 * 1000) removeQuiet(p);
    } catch (e) {
      /* 忽略 */
    }
  });
}

/* ============================================================
   Express
   ============================================================ */

const app = express();
app.disable('x-powered-by');

const upload = multer({
  dest: IN_DIR,
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 }
});

/** 可选静态令牌校验 */
function auth(req, res, next) {
  if (!CLIENT_TOKEN) return next();
  const token = String(req.get('X-Client-Token') || req.query.token || '');
  if (token === CLIENT_TOKEN) return next();
  res.status(401).json({ code: 401, msg: '令牌校验失败' });
}

app.get('/healthz', (req, res) => {
  res.json({ ok: true, jobs: jobs.size, queue: queue.length, running });
});

/* ---------- 服务能力 ---------- */
app.get('/api/video/service', auth, (req, res) => {
  const bins = binpath.describe();
  execFile(bins.ffmpeg, ['-version'], { timeout: 4000 }, (err, stdout) => {
    const ok = !err;
    res.json({
      code: 0,
      data: {
        available: ok,
        message: ok
          ? '视频处理就绪（' + bins.ffmpegSource + '）'
          : '未找到可用的 FFmpeg，请安装后重启服务',
        ffmpegPath: bins.ffmpeg,
        ffmpegFrom: bins.ffmpegSource,
        version: ok ? String(stdout || '').split('\n')[0].slice(0, 80) : '',
        maxDuration: MAX_DURATION,
        maxSizeMB: MAX_SIZE_MB
      }
    });
  });
});

/* ---------- 提交 ---------- */
app.post('/api/video/submit', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ code: 400, msg: '缺少视频文件' });

  const id = newId();
  const body = req.body || {};
  const job = {
    id,
    status: 'pending',
    progress: 0,
    error: '',
    mode: String(body.mode || 'blur').slice(0, 16),
    regions: normalizeRegions(body.region),
    timeRange: safeParse(body.timeRange),
    fileName: String(body.fileName || '').slice(0, 200),
    origin: (req.protocol || 'http') + '://' + (req.get('host') || ''),
    srcPath: req.file.path,
    outPath: '',
    thumbPath: '',
    duration: Number(body.duration) || 0,
    width: 0,
    height: 0,
    outSize: 0,
    createdAt: Date.now(),
    finishedAt: 0,
    expiresAt: 0
  };

  jobs.set(id, job);
  enqueue(id);

  console.log('[video] 入队 ' + id + '  ' + (req.file.size / 1024 / 1024).toFixed(1) + 'MB  mode=' + job.mode);
  res.json({ code: 0, data: { id, status: 'pending' } });
});

/* ---------- 状态 ---------- */
app.get('/api/video/status', auth, (req, res) => {
  const id = String(req.query.id || '');
  const job = jobs.get(id);

  if (!job) {
    // 服务重启会丢内存表：明确告诉客户端「这个任务没了」，让它落一个失败态，
    // 而不是一直停在排队中。
    return res.json({
      code: 0,
      data: { id, status: 'failed', progress: 0, error: '任务已失效（服务可能重启过），请重新提交', url: '', thumbUrl: '' }
    });
  }

  res.json({ code: 0, data: publicJob(job) });
});

/* ---------- 产物下载 ---------- */
app.get('/files/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!/^[a-f0-9]{16}\.(mp4|jpg)$/.test(name)) {
    return res.status(400).json({ code: 400, msg: '非法文件名' });
  }
  const p = path.join(OUT_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).json({ code: 404, msg: '文件已过期或被清理' });

  res.setHeader('Content-Type', name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  fs.createReadStream(p).pipe(res);
});

/* ---------- 错误处理 ---------- */
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ code: 413, msg: '视频超过 ' + MAX_SIZE_MB + 'MB 上限' });
  }
  console.error('[server] 未捕获异常:', err && err.message);
  res.status(500).json({ code: 500, msg: (err && err.message) || '服务异常' });
});

/* ============================================================
   启动
   ============================================================ */

app.listen(PORT, () => {
  const bins = binpath.describe();
  console.log('');
  console.log('  极简视频去水印服务已启动');
  console.log('  监听      http://0.0.0.0:' + PORT);
  console.log('  FFmpeg    ' + bins.ffmpeg + '  (' + bins.ffmpegSource + ')');
  console.log('  工作目录  ' + WORK_DIR);
  console.log('  保留时长  ' + KEEP_HOURS + ' 小时');
  console.log('  大小/时长 ' + MAX_SIZE_MB + 'MB / ' + MAX_DURATION + 's');
  console.log('  令牌      ' + (CLIENT_TOKEN ? '已启用' : '未设置（任何人拿到地址都能调用）'));
  console.log('');
  cleanup();
  setInterval(cleanup, 10 * 60 * 1000);
});

process.on('uncaughtException', (e) => console.error('[server] uncaughtException:', e && e.message));
process.on('unhandledRejection', (e) => console.error('[server] unhandledRejection:', e && e.message));
