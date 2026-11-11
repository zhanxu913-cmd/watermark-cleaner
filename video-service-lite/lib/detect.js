/**
 * 水印自动框选（服务端 / 模拟器测试通道）
 *
 * 与小程序端 utils/wm-detect.js 同一套分析算法，抽帧来源不同：
 *   服务端用 ffmpeg 输出 rawvideo gray 网格（-vf scale=96:54），
 *   96×54 帧坐标是线性缩放的，网格坐标 / 96、/54 即归一化坐标。
 */

'use strict';

const { spawn } = require('child_process');
const { FFMPEG } = require('./ffmpeg');

const GRID_W = 96;
const GRID_H = 54;
const SAMPLE_COUNT = 8;
const MAX_BOXES = 4;
const AREA_MIN = 0.004;
const AREA_MAX = 0.2;
const STATIC_STD = 5.5;
const EDGE_GRAD = 14.0;
const MERGE_PAD = 3;

/** 抽一帧灰度网格（rawvideo 输出 = GRID_W*GRID_H 字节） */
function sampleGrayGrid(file, atSec) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-ss', Math.max(0, atSec).toFixed(3),
      '-i', file,
      '-frames:v', '1',
      '-vf', 'scale=' + GRID_W + ':' + GRID_H,
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',
      '-'
    ];
    const ps = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    ps.stdout.on('data', (c) => chunks.push(c));
    ps.stderr.on('data', (c) => (err += c));
    ps.on('error', (e) => reject(new Error('无法启动 ffmpeg：' + e.message)));
    ps.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length < GRID_W * GRID_H) {
        return reject(new Error('抽帧失败：' + tail(err)));
      }
      resolve(new Float32Array(buf.subarray(0, GRID_W * GRID_H)));
    });
  });
}

/** 在时段内均匀抽 SAMPLE_COUNT 帧 */
async function sampleGrids(file, timeRange, duration) {
  const total = Number(duration) || 0;
  const start = Math.max(0, Number(timeRange && timeRange.start) || 0);
  let end = Number(timeRange && timeRange.end) || 0;
  if (!(end > start + 1)) end = total > start + 1 ? total : start + 1;
  if (total > 0) end = Math.min(end, total);

  const span = Math.max(1, end - start);
  const grids = [];
  for (let k = 0; k < SAMPLE_COUNT; k++) {
    const at = start + (span * (k + 0.5)) / SAMPLE_COUNT;
    try {
      grids.push(await sampleGrayGrid(file, at));
    } catch (e) {
      /* 个别时间点抽帧失败就跳过 */
    }
  }
  return grids;
}

/** 与小程序端一致的连通域分析（同款阈值） */
function analyzeGrids(grids, gw, gh) {
  const n = (grids || []).length;
  const cells = gw * gh;
  if (n < 3 || !cells) return [];

  const mean = new Float32Array(cells);
  const m2 = new Float32Array(cells);
  for (let k = 0; k < n; k++) {
    const g = grids[k];
    for (let i = 0; i < cells; i++) {
      const d = g[i] - mean[i];
      mean[i] += d / (k + 1);
      m2[i] += d * (g[i] - mean[i]);
    }
  }

  const grad = new Float32Array(cells);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const lx = x > 0 ? mean[i - 1] : mean[i];
      const rx = x < gw - 1 ? mean[i + 1] : mean[i];
      const ty = y > 0 ? mean[i - gw] : mean[i];
      const by = y < gh - 1 ? mean[i + gw] : mean[i];
      grad[i] = Math.abs(rx - lx) + Math.abs(by - ty);
    }
  }

  const mask = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    const std = Math.sqrt(Math.max(0, m2[i] / Math.max(1, n - 1)));
    if (std < STATIC_STD && grad[i] > EDGE_GRAD) mask[i] = 1;
  }

  const seen = new Uint8Array(cells);
  const comps = [];
  for (let s = 0; s < cells; s++) {
    if (!mask[s] || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let minX = gw;
    let maxX = -1;
    let minY = gh;
    let maxY = -1;
    let cnt = 0;
    let gradSum = 0;
    while (stack.length) {
      const i = stack.pop();
      const x = i % gw;
      const y = (i / gw) | 0;
      cnt += 1;
      gradSum += grad[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) {
        seen[i - 1] = 1;
        stack.push(i - 1);
      }
      if (x < gw - 1 && mask[i + 1] && !seen[i + 1]) {
        seen[i + 1] = 1;
        stack.push(i + 1);
      }
      if (y > 0 && mask[i - gw] && !seen[i - gw]) {
        seen[i - gw] = 1;
        stack.push(i - gw);
      }
      if (y < gh - 1 && mask[i + gw] && !seen[i + gw]) {
        seen[i + gw] = 1;
        stack.push(i + gw);
      }
    }
    comps.push({ minX, maxX, minY, maxY, cnt, gradAvg: gradSum / Math.max(1, cnt) });
  }

  let merged = comps.slice();
  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    while (merged.length) {
      const a = merged.shift();
      const ax0 = a.minX - MERGE_PAD;
      const ay0 = a.minY - MERGE_PAD;
      const ax1 = a.maxX + MERGE_PAD;
      const ay1 = a.maxY + MERGE_PAD;
      let hit = -1;
      for (let j = 0; j < merged.length; j++) {
        const b = merged[j];
        if (
          b.minX - MERGE_PAD <= ax1 &&
          b.maxX + MERGE_PAD >= ax0 &&
          b.minY - MERGE_PAD <= ay1 &&
          b.maxY + MERGE_PAD >= ay0
        ) {
          hit = j;
          break;
        }
      }
      if (hit >= 0) {
        const b = merged.splice(hit, 1)[0];
        next.push({
          minX: Math.min(a.minX, b.minX),
          maxX: Math.max(a.maxX, b.maxX),
          minY: Math.min(a.minY, b.minY),
          maxY: Math.max(a.maxY, b.maxY),
          cnt: a.cnt + b.cnt,
          gradAvg: Math.max(a.gradAvg, b.gradAvg)
        });
        changed = true;
      } else {
        next.push(a);
      }
    }
    merged = next;
  }

  const out = [];
  merged.forEach((c) => {
    const wCells = c.maxX - c.minX + 1;
    const hCells = c.maxY - c.minY + 1;
    const area = (wCells * hCells) / cells;
    if (area < AREA_MIN || area > AREA_MAX) return;
    if (c.cnt / (wCells * hCells) < 0.25) return;
    const cxn = (c.minX + wCells / 2) / gw;
    const cyn = (c.minY + hCells / 2) / gh;
    const prior = 0.6 + 1.4 * Math.max(Math.abs(cxn - 0.5), Math.abs(cyn - 0.5)) * 2;
    const score = c.gradAvg * Math.sqrt(c.cnt) * prior;
    const x0 = Math.max(0, c.minX - 1) / gw;
    const y0 = Math.max(0, c.minY - 1) / gh;
    out.push({
      x: x0,
      y: y0,
      w: Math.min(gw, c.maxX + 2) / gw - x0,
      h: Math.min(gh, c.maxY + 2) / gh - y0,
      score
    });
  });

  out.sort((a, b) => b.score - a.score);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return out.slice(0, MAX_BOXES).map((b) => ({
    x: r3(Math.min(b.x, 1 - b.w)),
    y: r3(Math.min(b.y, 1 - b.h)),
    w: r3(Math.min(b.w, 1)),
    h: r3(Math.min(b.h, 1))
  }));
}

/**
 * 自动识别入口
 * @param {string} file 上传的视频路径
 * @param {{timeRange:{start,end}, duration:number}} opts
 * @returns {Promise<Array<{x,y,w,h}>>}
 */
async function detect(file, opts) {
  const o = opts || {};
  const grids = await sampleGrids(file, o.timeRange, o.duration);
  if (grids.length < 3) throw new Error('抽帧不足，无法自动识别');
  return analyzeGrids(grids, GRID_W, GRID_H);
}

function tail(s, n) {
  const str = String(s || '').trim();
  const limit = n || 300;
  if (str.length <= limit) return str;
  return '…' + str.slice(-limit);
}

module.exports = { detect };
