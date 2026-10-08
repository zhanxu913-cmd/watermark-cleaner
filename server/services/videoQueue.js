/**
 * 视频处理队列（进程内 FIFO，并发 1）
 *
 * 流程：pending → processing（probe → 滤镜图 → ffmpeg 转码，进度回写）
 *      → done（记录产物、设过期时间、删源文件）/ failed（记录错误）
 *
 * 说明：队列在内存里，进程重启会丢队列状态；
 *      server.js 启动时会把卡在 pending/processing 的任务重新入队。
 */

'use strict';

const path = require('path');
const db = require('../db');
const files = require('../lib/files');
const ff = require('../lib/ffmpeg');
const graph = require('../lib/graph');
const settingsLib = require('../lib/settings');
const storage = require('../lib/storage');

const queue = [];
let running = false;

/** 入队（去重） */
function push(jobId) {
  if (!jobId) return;
  if (queue.indexOf(jobId) > -1) return;
  queue.push(jobId);
  drain();
}

/** 启动时恢复：把遗留的 pending / processing 任务重新入队 */
async function recover() {
  try {
    const rows = await db.query(
      'SELECT id FROM wc_jobs WHERE type = "video" AND status IN ("pending", "processing")'
    );
    rows.forEach((row) => push(row.id));
    if (rows.length) console.log('[videoQueue] 恢复遗留任务', rows.length, '个');
  } catch (e) {
    console.error('[videoQueue] 恢复失败:', e.message);
  }
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const jobId = queue.shift();
      try {
        await processJob(jobId);
      } catch (e) {
        console.error('[videoQueue] 任务失败', jobId, e);
        await markFailed(jobId, e.message || '处理失败');
      }
    }
  } finally {
    running = false;
  }
}

async function processJob(jobId) {
  const row = await db.get('SELECT * FROM wc_jobs WHERE id = ?', [jobId]);
  if (!row || row.type !== 'video' || !row.src_file) return;
  if (row.status === 'done') return;

  const s = await settingsLib.getSettings();
  const keepHours = Math.max(1, Number(s.cloudKeepHours) || 1);

  await setStatus(jobId, 'processing', 3);

  const srcAbs = files.absOf(row.src_file).abs;
  // 产物目录由后台「配置 → 存储路径」决定（默认 output/videos）
  const outFileID = storage.outVideoDir() + '/' + jobId + '.mp4';
  const outAbs = path.join.apply(path, [files.getRoot()].concat(outFileID.split('/')));
  require('fs').mkdirSync(path.dirname(outAbs), { recursive: true });

  // ---- 1) 探测视频 ----
  const info = await ff.probe(srcAbs);

  if (s.maxVideoDuration > 0 && info.duration > s.maxVideoDuration + 1) {
    throw new Error('视频时长 ' + Math.round(info.duration) + 's 超过上限 ' + s.maxVideoDuration + 's');
  }

  // ---- 2) 滤镜图 ----
  const regions = normalizeRegions(row.region);
  const timeRange = safeParse(row.time_range);
  const built = graph.buildGraph({
    mode: row.mode,
    regions,
    timeRange,
    duration: info.duration,
    width: info.width,
    height: info.height
  });

  await setStatus(jobId, 'processing', 8);

  // ---- 3) 组装 ffmpeg 参数并转码 ----
  const reporter = makeReporter(jobId, info.duration, 10, 95);

  const baseArgs = ['-y', '-i', srcAbs];
  if (built.graph) {
    baseArgs.push('-filter_complex', built.graph, '-map', '[' + built.outLabel + ']');
  } else {
    baseArgs.push('-map', '0:v:0');
  }
  if (info.hasAudio) {
    baseArgs.push('-map', '0:a:0?', '-c:a', 'copy');
  }
  baseArgs.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outAbs
  );

  try {
    await ff.encode(baseArgs, { totalDuration: info.duration, onProgress: reporter });
  } catch (e) {
    // 音轨直拷失败（编码不兼容等）→ 退回 aac 重编码
    if (String(e.message).indexOf('ffmpeg') === -1) throw e;
    console.warn('[videoQueue] 音频 copy 失败，改用 aac 重试:', e.message);
    const retryArgs = replaceAudio(baseArgs);
    await ff.encode(retryArgs, { totalDuration: info.duration, onProgress: reporter });
  }

  // ---- 4) 完成：写库 + 清源 ----
  let outSize = 0;
  try {
    outSize = require('fs').statSync(outAbs).size;
  } catch (e) { /* 忽略 */ }

  files.remove(row.src_file);

  await db.exec(
    'UPDATE wc_jobs SET status = "done", progress = 100, out_file = ?, out_size = ?, error = "", ' +
    'width = ?, height = ?, src_file = "", finished_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL ? HOUR) WHERE id = ?',
    [outFileID, outSize, info.width || 0, info.height || 0, keepHours, jobId]
  );

  // 缩略图缺省时补一张
  if (!row.thumb_file) {
    try {
      const thumbID = storage.thumbVideoDir() + '/' + jobId + '.jpg';
      const thumbAbs = path.join.apply(path, [files.getRoot()].concat(thumbID.split('/')));
      require('fs').mkdirSync(path.dirname(thumbAbs), { recursive: true });
      await ff.thumbnail(outAbs, thumbAbs, Math.min(2, info.duration / 2), 480);
      await db.exec('UPDATE wc_jobs SET thumb_file = ? WHERE id = ?', [thumbID, jobId]);
    } catch (e) { /* 封面失败不阻断 */ }
  }

  console.log('[videoQueue] 完成', jobId, (outSize / 1024 / 1024).toFixed(2) + 'MB', built.note || '');
}

/* ---------------- 辅助 ---------------- */

function normalizeRegions(raw) {
  let obj = raw;
  if (typeof raw === 'string') obj = safeParse(raw);
  if (!obj) return [];
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.regions)) return obj.regions;
  if (obj.x !== undefined) return [obj];
  return [];
}

function safeParse(str) {
  try {
    return str ? JSON.parse(str) : null;
  } catch (e) {
    return null;
  }
}

async function setStatus(jobId, status, progress) {
  await db.exec('UPDATE wc_jobs SET status = ?, progress = ? WHERE id = ?', [status, progress || 0, jobId]);
}

async function markFailed(jobId, msg) {
  try {
    await db.exec(
      'UPDATE wc_jobs SET status = "failed", progress = 0, error = ?, finished_at = NOW() WHERE id = ?',
      [String(msg || '处理失败').slice(0, 480), jobId]
    );
  } catch (e) {
    console.error('[videoQueue] 标记失败异常:', e.message);
  }
}

/** 进度上报：把 ffmpeg 百分比映射到 [from, to] 区间并节流写库 */
function makeReporter(jobId, duration, from, to) {
  let last = -1;
  let lastAt = 0;
  return function (p) {
    const now = Date.now();
    const mapped = from + Math.round(((to - from) * p) / 100);
    if (mapped <= last || now - lastAt < 2000) return;
    last = mapped;
    lastAt = now;
    db.exec('UPDATE wc_jobs SET progress = ? WHERE id = ?', [Math.min(99, mapped), jobId])
      .catch(() => {});
  };
}

function replaceAudio(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c:a' && args[i + 1] === 'copy') {
      out.push('-c:a', 'aac', '-b:a', '128k');
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

module.exports = { push, recover, drain };
