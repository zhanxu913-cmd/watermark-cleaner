/**
 * 水印自动框选（多帧亮度网格分析）
 *
 * 原理：水印是「长时间不动 + 有结构边缘」的画面区域。
 *   1. 抽 8 帧，各缩成 96×N 的亮度网格
 *   2. 逐格算时间方差 → 几乎不变 = 疑似水印
 *   3. 在多帧均值图上算梯度 → 有边缘结构 = 排除纯色死区
 *   4. 「静态且有结构」的格子做连通域聚类，近邻框合并成整体
 *   5. 角落先验加权评分，最多返回 4 个候选框（归一化坐标 x/y/w/h）
 *
 * 说明：固定机位的整段视频画面全静止时，静态判定会覆盖全画面，
 * 大于面积上限的连通域会被丢弃 → 返回空数组，提示用户手动框选。
 */

'use strict';

const GRID_W = 96;
const GRID_H = 54;
const SAMPLE_COUNT = 8;
const MAX_BOXES = 4;
const AREA_MIN = 0.004; // 面积下限（占画面比例）：0.4%
const AREA_MAX = 0.2; // 面积上限：20%
const STATIC_STD = 5.5; // 时间标准差阈值（0—255 亮度）
const EDGE_GRAD = 14.0; // 结构梯度阈值
const MERGE_PAD = 3; // 连通域合并时的膨胀格数（把分散字符连成整体）

/** RGBA 帧数据 → 亮度网格（每格 = 块内像素均值，隔 2 像素采样提速） */
function gridFromRgba(data, fw, fh, gw, gh) {
  const grid = new Float32Array(gw * gh);
  const cnt = new Float32Array(gw * gh);
  for (let py = 0; py < fh; py += 2) {
    const gy = Math.min(gh - 1, ((py / fh) * gh) | 0);
    const row = py * fw * 4;
    for (let px = 0; px < fw; px += 2) {
      const gx = Math.min(gw - 1, ((px / fw) * gw) | 0);
      const i = row + px * 4;
      const gi = gy * gw + gx;
      grid[gi] += (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      cnt[gi] += 1;
    }
  }
  for (let i = 0; i < grid.length; i++) grid[i] = cnt[i] ? grid[i] / cnt[i] : 0;
  return grid;
}

/**
 * 多帧亮度网格 → 候选框数组
 * @param {Array<Float32Array|Uint8Array>} grids
 * @param {number} gw
 * @param {number} gh
 * @returns {Array<{x:number,y:number,w:number,h:number,score:number}>}
 */
function analyzeGrids(grids, gw, gh) {
  const n = (grids || []).length;
  const cells = gw * gh;
  if (n < 3 || !cells) return [];

  // 多帧均值（Welford 一次遍历）与时间标准差
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

  // 均值图上的结构梯度（水平差 + 垂直差）
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

  // 静态且有结构的格子 → 候选
  const mask = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    const std = Math.sqrt(Math.max(0, m2[i] / Math.max(1, n - 1)));
    if (std < STATIC_STD && grad[i] > EDGE_GRAD) mask[i] = 1;
  }

  // 连通域（栈式 4 邻域，不用递归）
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

  // 近邻合并（膨胀后相交即合并，把单字符的小块连成水印整体）
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
        if (b.minX - MERGE_PAD <= ax1 && b.maxX + MERGE_PAD >= ax0 && b.minY - MERGE_PAD <= ay1 && b.maxY + MERGE_PAD >= ay0) {
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

  // 面积/评分过滤，取前 MAX_BOXES 个
  const out = [];
  merged.forEach((c) => {
    const wCells = c.maxX - c.minX + 1;
    const hCells = c.maxY - c.minY + 1;
    const area = (wCells * hCells) / cells;
    if (area < AREA_MIN || area > AREA_MAX) return;
    if (c.cnt / (wCells * hCells) < 0.25) return; // 过散的噪声
    const cxn = (c.minX + wCells / 2) / gw;
    const cyn = (c.minY + hCells / 2) / gh;
    // 角落先验：离画面中心越远分越高（水印高发区）
    const prior = 0.6 + 1.4 * Math.max(Math.abs(cxn - 0.5), Math.abs(cyn - 0.5)) * 2;
    const score = c.gradAvg * Math.sqrt(c.cnt) * prior;
    out.push({
      x: Math.max(0, c.minX - 1) / gw,
      y: Math.max(0, c.minY - 1) / gh,
      w: Math.min(gw, c.maxX + 2) / gw - Math.max(0, c.minX - 1) / gw,
      h: Math.min(gh, c.maxY + 2) / gh - Math.max(0, c.minY - 1) / gh,
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

module.exports = {
  GRID_W,
  GRID_H,
  SAMPLE_COUNT,
  gridFromRgba,
  analyzeGrids,
  detectWatermarks
};

/* ============================================================
   抽帧入口（真机）：VideoDecoder 分散采样 8 帧
   ============================================================ */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function callP(obj, method, opts) {
  return new Promise((resolve, reject) => {
    try {
      obj[method](
        Object.assign({}, opts, {
          success: resolve,
          fail: (e) => reject(new Error((e && e.errMsg) || method + ' 失败'))
        })
      );
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 自动识别视频水印位置（真机路径）
 * @param {string} src 本地视频路径
 * @param {{start:number,end:number}} [timeRange] 在该时段内采样
 * @returns {Promise<Array<{x:number,y:number,w:number,h:number}>>}
 */
async function detectWatermarks(src, timeRange) {
  if (typeof wx === 'undefined' || typeof wx.createVideoDecoder !== 'function') {
    throw new Error('当前微信版本不支持自动识别，请手动框选');
  }
  const o = timeRange || {};
  const start = Math.max(0, Number(o.start) || 0);
  let end = Number(o.end) || 0;
  if (!(end > start + 1)) end = start + 1;

  const decoder = wx.createVideoDecoder();
  const grids = [];
  let gw = GRID_W;
  let gh = 0;

  try {
    await callP(decoder, 'start', { source: src });
    const span = end - start;
    for (let k = 0; k < SAMPLE_COUNT; k++) {
      const pos = start + (span * (k + 0.5)) / SAMPLE_COUNT;
      let frame = null;
      try {
        await callP(decoder, 'seek', { position: pos });
        await sleep(40);
        frame = await callP(decoder, 'getFrameData');
      } catch (e) {
        // seek 失败则顺序取帧兜底
        try {
          frame = await callP(decoder, 'getFrameData');
        } catch (e2) {
          /* 该点抽不到就跳过 */
        }
      }
      if (frame && frame.data && frame.width && frame.height) {
        if (!gh) gh = Math.max(20, Math.min(96, Math.round((GRID_W * frame.height) / frame.width)));
        grids.push(gridFromRgba(frame.data, frame.width, frame.height, gw, gh));
      }
    }
  } finally {
    try {
      await callP(decoder, 'stop');
    } catch (e) {
      /* 忽略 */
    }
    try {
      decoder.remove();
    } catch (e2) {
      /* 忽略 */
    }
  }

  if (grids.length < 3) throw new Error('抽帧不足，无法自动识别');
  return analyzeGrids(grids, gw, gh);
}
