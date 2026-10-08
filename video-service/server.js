/**
 * video-service —— 视频水印清理处理服务（微信云托管）
 *
 * 职责：
 *   POST /api/ping     健康检查（是否装好 ffmpeg、云环境是否可用）
 *   POST /api/process  接收处理任务，入队后立即返回 202，处理结果通过 callbackUrl 回传
 *   GET  /api/jobs/:id 查询本容器内的任务状态（进程重启后即失效，仅用于排障）
 *
 * 与小程序侧的约定：
 *   1) videoProc 云函数把任务下发到本服务（POST /api/process）
 *   2) 本服务处理完成后 POST callbackUrl，body 里带 serviceKey / jobId / status / outFileID…
 *   3) videoProc 的 HTTP 触发分支落库
 *
 * 环境变量：
 *   PORT                  监听端口（云托管默认 80）
 *   MAX_CONCURRENT        并发转码数，默认 2
 *   CLOUDBASE_ENV_ID      云开发环境 ID（云托管绑定环境后自动注入 CBR_ENV_ID）
 *   WORK_DIR              临时目录，默认 /tmp/wm
 *   MAX_INPUT_MB          单文件下载体积上限，默认 500
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const { buildGraph } = require('./lib/graph');
const ff = require('./lib/ffmpeg');
const cloud = require('./lib/cloud');
const { createQueue } = require('./lib/queue');

const VERSION = '1.0.0';
const STARTED_AT = Date.now();

const PORT = Number(process.env.PORT) || 80;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 2;
const WORK_DIR = process.env.WORK_DIR || path.join(os.tmpdir(), 'wm');
const MAX_INPUT_MB = Number(process.env.MAX_INPUT_MB) || 500;

const app = express();
const queue = createQueue(MAX_CONCURRENT);
const jobs = new Map(); // jobId -> { status, progress, error, startedAt, finishedAt }

app.use(express.json({ limit: '2mb' }));

cloud.ensureDir(WORK_DIR);

/* ============================================================
   启动
   ============================================================ */

let ffmpegVersion = '';

function detectFfmpeg() {
  return new Promise((resolve) => {
    execFile(ff.FFMPEG, ['-version'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, version: '' });
      const line = String(stdout || '').split('\n')[0] || '';
      ffmpegVersion = line.replace('ffmpeg version ', '').slice(0, 60);
      resolve({ ok: true, version: ffmpegVersion });
    });
  });
}

/* ============================================================
   路由
   ============================================================ */

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'video-service', version: VERSION });
});

app.post('/api/ping', async (req, res) => {
  const cloudCheck = await cloud.selfCheck();
  res.json({
    ok: true,
    service: 'video-service',
    version: VERSION,
    ffmpeg: !!ffmpegVersion,
    ffmpegVersion,
    cloud: cloudCheck.ok,
    cloudReason: cloudCheck.reason || '',
    queue: queue.stats(),
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000)
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ ok: false, error: 'not found' });
  res.json(Object.assign({ ok: true, jobId: req.params.id }, j));
});

app.post('/api/process', async (req, res) => {
  const body = req.body || {};

  if (!body.jobId) return res.status(400).json({ ok: false, error: 'missing jobId' });
  if (!body.srcFileID) return res.status(400).json({ ok: false, error: 'missing srcFileID' });
  if (!body.callbackUrl) {
    return res.status(400).json({ ok: false, error: 'missing callbackUrl（视频服务未配置回调地址）' });
  }

  const jobId = String(body.jobId);
  if (jobs.has(jobId) && jobs.get(jobId).status === 'processing') {
    return res.status(202).json({ ok: true, jobId, duplicated: true });
  }

  jobs.set(jobId, {
    status: 'queued',
    progress: 0,
    progressText: '已入队',
    error: '',
    startedAt: new Date().toISOString(),
    finishedAt: null
  });

  // 立即返回，处理放到队列里跑
  res.status(202).json({ ok: true, jobId, queued: true, queue: queue.stats() });

  queue
    .push(() => handleJob(body))
    .catch((e) => {
      console.error('[process] unhandled error', jobId, e && e.message);
    });
});

/* ============================================================
   处理主流程
   ============================================================ */

async function handleJob(body) {
  const jobId = String(body.jobId);
  const workDir = path.join(WORK_DIR, jobId);
  cloud.ensureDir(workDir);

  const srcPath = path.join(workDir, 'input' + cloud.safeExt(body.srcFileID, '.mp4'));
  const outPath = path.join(workDir, 'output.mp4');
  const thumbPath = path.join(workDir, 'thumb.jpg');

  const callbackUrl = String(body.callbackUrl);
  const serviceKey = String(body.serviceKey || '');
  const mark = (patch) => {
    const cur = jobs.get(jobId) || {};
    jobs.set(jobId, Object.assign({}, cur, patch));
  };

  let reporter = null;

  try {
    mark({ status: 'processing', progress: 1, progressText: '下载源视频' });
    await report(callbackUrl, serviceKey, jobId, { status: 'processing', progress: 1, progressText: '下载源视频' });

    // ---- 1) 下载 ----
    await cloud.downloadFileID(body.srcFileID, srcPath, (p) => {
      const percent = Math.min(14, Math.round(1 + p * 13));
      mark({ progress: percent, progressText: '下载源视频' });
    });

    const sizeMB = fs.statSync(srcPath).size / 1024 / 1024;
    if (sizeMB > MAX_INPUT_MB) {
      throw new Error('源视频体积 ' + sizeMB.toFixed(1) + 'MB 超过服务上限 ' + MAX_INPUT_MB + 'MB');
    }

    // ---- 2) 探测 ----
    mark({ progress: 16, progressText: '解析视频信息' });
    const info = await ff.probe(srcPath);
    if (!info.width || !info.height) throw new Error('无法读取视频分辨率');

    const duration = info.duration || Number(body.duration) || 0;

    // ---- 3) 构建滤镜图 ----
    const regions = normalizeRegions(body.region || body.regions);
    const built = buildGraph({
      mode: body.mode,
      regions,
      timeRange: body.timeRange,
      duration,
      width: info.width,
      height: info.height
    });

    mark({ progress: 18, progressText: '开始处理' });
    await report(callbackUrl, serviceKey, jobId, { status: 'processing', progress: 18, progressText: '开始处理' });

    // ---- 4) 转码 ----
    const encodeArgs = buildEncodeArgs(srcPath, outPath, built, info);

    // 进度区间：18% → 88%
    reporter = makeReporter(callbackUrl, serviceKey, jobId, mark, 18, 88);

    try {
      await ff.encode(encodeArgs, { totalDuration: duration, onProgress: reporter });
    } catch (e) {
      // 音轨直接复制失败（容器不支持该音频编码）时，退回重新编码音频
      if (String(e.message).indexOf('ffmpeg 退出码') === -1) throw e;
      console.warn('[process] retry with aac audio:', e.message);
      await ff.encode(replaceAudioCopy(encodeArgs), {
        totalDuration: duration,
        onProgress: reporter
      });
    }

    if (!fs.existsSync(outPath)) throw new Error('转码未产出文件');

    // ---- 5) 封面 ----
    mark({ progress: 90, progressText: '生成封面' });
    let thumbFileID = '';
    try {
      await ff.thumbnail(outPath, thumbPath, Math.min(1, duration / 2 || 0), 480);
    } catch (e) {
      console.warn('[process] thumbnail failed:', e.message);
    }

    // ---- 6) 上传 ----
    mark({ progress: 93, progressText: '上传结果' });
    const outUp = await cloud.uploadFile(outPath, resultPath('videos', jobId, '.mp4'));

    if (fs.existsSync(thumbPath)) {
      try {
        const t = await cloud.uploadFile(thumbPath, resultPath('thumbs', jobId, '.jpg'));
        thumbFileID = t.fileID;
      } catch (e) {
        console.warn('[process] upload thumbnail failed:', e.message);
      }
    }

    const outSize = fs.statSync(outPath).size;

    // ---- 7) 回调完成 ----
    mark({
      status: 'done',
      progress: 100,
      progressText: '处理完成',
      finishedAt: new Date().toISOString(),
      outFileID: outUp.fileID
    });

    await report(callbackUrl, serviceKey, jobId, {
      status: 'done',
      progress: 100,
      progressText: '处理完成',
      outFileID: outUp.fileID,
      thumbFileID: thumbFileID || body.thumbFileID || '',
      size: outSize,
      width: info.width,
      height: info.height,
      duration,
      deleteSrc: true
    });

    if (reporter && reporter.flush) reporter.flush(100);

    console.log('[process] done', jobId, Math.round(outSize / 1024) + 'KB', built.note || '');
  } catch (e) {
    const msg = (e && e.message) || '处理失败';
    console.error('[process] failed', jobId, msg);

    mark({ status: 'failed', error: msg, finishedAt: new Date().toISOString() });

    await report(callbackUrl, serviceKey, jobId, {
      status: 'failed',
      error: msg.slice(0, 200),
      progressText: ''
    });
  } finally {
    cleanupDir(workDir);
  }
}

/* ============================================================
   参数拼装
   ============================================================ */

/** 组装完整的 ffmpeg 参数（含输入与输出），失败重试时直接复用 */
function buildEncodeArgs(srcPath, outPath, built, info) {
  const args = ['-y', '-i', srcPath];

  if (built.graph) {
    args.push('-filter_complex', built.graph, '-map', '[' + built.outLabel + ']');
  } else {
    args.push('-map', '0:v:0');
  }

  if (info.hasAudio) {
    args.push('-map', '0:a:0', '-c:a', 'copy');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart'
  );

  args.push(outPath);
  return args;
}

function replaceAudioCopy(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c:a' && args[i + 1] === 'copy') {
      out.push('-c:a', 'aac', '-b:a', '128k');
      i++; // 跳过原来的 copy
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function normalizeRegions(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  return list
    .map((r) => ({
      x: clamp01(Number(r && r.x)),
      y: clamp01(Number(r && r.y)),
      w: clamp01(Number(r && r.w)),
      h: clamp01(Number(r && r.h))
    }))
    .filter((r) => r.w > 0.001 && r.h > 0.001);
}

function resultPath(kind, jobId, ext) {
  const d = new Date();
  const day = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  return 'processed/' + kind + '/' + day + '/' + jobId + ext;
}

/* ============================================================
   进度与回调
   ============================================================ */

/**
 * 按百分比区间换算并限流上报
 */
function makeReporter(callbackUrl, serviceKey, jobId, mark, from, to) {
  let last = -1;
  let lastAt = 0;

  const fn = (percent) => {
    const mapped = Math.round(from + (Math.max(0, Math.min(100, percent)) / 100) * (to - from));
    if (mapped <= last) return;
    const now = Date.now();
    if (mapped - last < 4 && now - lastAt < 4000) return;

    last = mapped;
    lastAt = now;
    mark({ progress: mapped, progressText: '处理中 ' + mapped + '%' });
    report(callbackUrl, serviceKey, jobId, {
      status: 'processing',
      progress: mapped,
      progressText: '处理中 ' + mapped + '%'
    }).catch(() => {});
  };

  fn.flush = (percent) => fn(percent);
  return fn;
}

/**
 * 回传结果到 videoProc 的 HTTP 触发地址（失败重试 3 次）
 */
async function report(callbackUrl, serviceKey, jobId, patch) {
  const url = String(callbackUrl || '').trim();
  if (!url) return { ok: false, reason: 'no callbackUrl' };

  const payload = Object.assign({ serviceKey, jobId, serviceVersion: VERSION }, patch || {});
  let lastErr = null;

  for (let i = 0; i < 3; i++) {
    try {
      const res = await postJson(url, payload, 12000);
      if (res.statusCode >= 200 && res.statusCode < 300) return { ok: true, body: res.body };
      lastErr = new Error('回调返回状态 ' + res.statusCode);
    } catch (e) {
      lastErr = e;
    }
    await sleep(500 * (i + 1));
  }

  console.warn('[callback] failed', jobId, lastErr && lastErr.message);
  return { ok: false, reason: lastErr && lastErr.message };
}

function postJson(urlStr, payload, timeout) {
  const https = require('https');
  const httpMod = require('http');
  const { URL } = require('url');

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(new Error('回调地址格式不正确'));
    }

    const lib = u.protocol === 'https:' ? https : httpMod;
    const data = JSON.stringify(payload || {});

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data)
        },
        timeout: timeout || 10000
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(raw);
          } catch (e) {
            body = { raw: raw.slice(0, 300) };
          }
          resolve({ statusCode: res.statusCode, body });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('回调超时')));
    req.on('error', (e) => reject(new Error(e.message || '回调网络错误')));
    req.write(data);
    req.end();
  });
}

/* ============================================================
   工具
   ============================================================ */

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* 忽略 */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp01(v) {
  if (!isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

/* ============================================================
   启动 / 自检
   ============================================================ */

async function bootstrap() {
  const detected = await detectFfmpeg();
  if (!detected.ok) {
    console.error('[boot] 未检测到 ffmpeg，请确认镜像内已安装 ffmpeg');
  } else {
    console.log('[boot] ffmpeg', detected.version);
  }

  const cloudCheck = await cloud.selfCheck();
  console.log('[boot] cloud', cloudCheck.ok ? 'ok (' + cloudCheck.env + ')' : 'unavailable: ' + cloudCheck.reason);

  if (process.argv.indexOf('--check') > -1) {
    console.log(
      JSON.stringify(
        { ffmpeg: detected, cloud: cloudCheck, workDir: WORK_DIR, maxConcurrent: MAX_CONCURRENT },
        null,
        2
      )
    );
    process.exit(detected.ok && cloudCheck.ok ? 0 : 1);
  }

  app.listen(PORT, () => {
    console.log('[boot] video-service ' + VERSION + ' listening on ' + PORT);
  });
}

process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', (e && e.message) || e);
});

bootstrap();
