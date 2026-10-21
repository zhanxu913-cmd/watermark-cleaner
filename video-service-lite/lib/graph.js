/**
 * FFmpeg 滤镜图构建
 *
 * 输入：归一化坐标（0—1，相对视频显示尺寸）的遮盖区域 + 处理方式 + 时间区间
 * 输出：可直接喂给 `ffmpeg -filter_complex` 的字符串
 *
 * 三种空间处理方式统一走「带内边距裁剪 → 局部处理 → 原位叠加」的结构：
 *   - 保证局部算法（boxblur / delogo）有足够的周边像素参与运算
 *   - 叠加只用 overlay 的 enable 做时间区间控制 —— overlay 对时间轴编辑的支持最稳，
 *     delogo / boxblur 对 enable 的支持则随版本而异，统一避开这个坑
 *
 * 坐标换算注意：ffmpeg 默认开启自动旋转（-autorotate），滤镜图作用在
 * 「显示方向」的画面上，因此这里必须使用旋转后的显示尺寸。
 */

'use strict';

const DELOGO_PAD = 12; // 局部处理的周边余量（像素）
const BLUR_MAX_RADIUS = 20;
const MOSAIC_BLOCKS = 16; // 马赛克块边长 = 区域边长 / 16

/* ============================================================
   对外入口
   ============================================================ */

/**
 * @param {object} opts
 * @param {string} opts.mode       fill | blur | mosaic | crop | delogo | none
 * @param {Array}  opts.regions    [{x,y,w,h}] 归一化
 * @param {object} opts.timeRange  { start, end }（秒，可空）
 * @param {number} opts.duration   视频总时长（秒）
 * @param {number} opts.width      显示宽度（像素）
 * @param {number} opts.height     显示高度（像素）
 * @returns {{ graph: string|null, outLabel: string, note: string }}
 */
function buildGraph(opts) {
  const o = opts || {};
  const mode = String(o.mode || 'fill');
  const vw = Math.max(2, Math.round(o.width || 0));
  const vh = Math.max(2, Math.round(o.height || 0));
  const duration = Number(o.duration) || 0;

  if (!vw || !vh) return { graph: null, outLabel: '0:v', note: '缺少视频尺寸，跳过滤镜' };

  const px = (o.regions || [])
    .map((r) => toPixelRegion(r, vw, vh))
    .filter((r) => r && r.w >= 2 && r.h >= 2);

  // ---- 裁剪：只做画幅裁剪，不叠加局部滤镜 ----
  if (mode === 'crop') {
    const c = pickCropRect(px, vw, vh);
    if (!c) return { graph: null, outLabel: '0:v', note: '没有可裁剪的空间' };
    const w = even(c.w);
    const h = even(c.h);
    const x = even(Math.min(c.x, vw - w));
    const y = even(Math.min(c.y, vh - h));
    return {
      graph: '[0:v]crop=' + w + ':' + h + ':' + x + ':' + y + '[vout]',
      outLabel: 'vout',
      note: '裁剪为 ' + w + 'x' + h
    };
  }

  if (mode === 'none' || !px.length) {
    return { graph: null, outLabel: '0:v', note: '无需处理' };
  }

  const enable = buildEnable(o.timeRange, duration);
  const parts = [];

  // ---- 关键：所有局部处理链都从 [0:v] 派生，overlay 再逐个串行叠加 ----
  //
  // 为什么不能把「上一步的 overlay 输出」当作下一步的局部处理输入：
  // FFmpeg 滤镜图里一个标签只能被消费一次。
  //   [0:v]…[f1]; [0:v][f1]overlay[v1]; [v1]crop…[f2]; [v1][f2]overlay[v2]
  //                                              ^^^ 此处 v1 已被上一条 overlay 消费
  // 会报 "Stream specifier 'v1' in filtergraph description ... not found"。
  //
  // 正确做法：局部处理全部从 [0:v] 分叉，overlay 之间只串接主链：
  //   [0:v]…[f1]; [0:v]…[f2]; [0:v][f1]overlay[v1]; [v1][f2]overlay[v2]
  // 这样每个中间标签都只被消费一次。

  const layers = [];

  px.forEach((r) => {
    const p = paddedCrop(r, vw, vh, DELOGO_PAD);
    if (!p) return;

    const out = 'v' + (layers.length + 1);
    const cropHead = 'crop=' + p.cw + ':' + p.ch + ':' + p.cx + ':' + p.cy;

    let chain = '';
    let overlayX = p.cx;
    let overlayY = p.cy;

    if (mode === 'mosaic') {
      // 马赛克原理：裁剪图 → 缩到「区域边长 / MOSAIC_BLOCKS」→ 裁出内层区域 → 放回原尺寸。
      // 缩小再放大后，每 MOSAIC_BLOCKS 个像素合并成一个色块 = 马赛克。
      //
      // 硬约束（实测得出）：小画布下缩放倍数 < 1，Math.round 会把内层矩形缩成 0 像素，
      // 例如 crop 54x42 的内层 26x14 缩到 2x1 —— 高只剩 0px，
      // crop 随即报 "Invalid too big or non positive size for width '2' or height '0'"。
      //
      // 所以块边长（scale 倍数分母）必须钳到「内层矩形在该轴的最小像素数」：
      //   块边长 <= rw  →  rw / 块边长 >= 1，内层宽度至少 1px
      //   块边长 <= rh  →  rh / 块边长 >= 1，内层高度至少 1px
      // 大区域（如 200x80）块边长仍是 16，马赛克外观不变；
      // 只有小到 26x14 这种水印框才会自动退化成更细的块 —— 此时本来也糊不成块。
      const blockW = clamp(Math.round(p.cw / MOSAIC_BLOCKS), 1, p.rw);
      const blockH = clamp(Math.round(p.ch / MOSAIC_BLOCKS), 1, p.rh);

      // 小图尺寸 = 裁剪图 / 块边长（向上取整，保证内层矩形缩后 >= 1px）
      const sw = Math.max(1, Math.ceil(p.cw / blockW));
      const sh = Math.max(1, Math.ceil(p.ch / blockH));

      // 内层矩形在小图上的位置，按实际缩放倍率换算，并保证完全落在小图内
      const bx = clamp(Math.floor(p.ix / (p.cw / sw)), 0, Math.max(0, sw - 1));
      const by = clamp(Math.floor(p.iy / (p.ch / sh)), 0, Math.max(0, sh - 1));
      const bw = clamp(Math.floor(p.rw / (p.cw / sw)), 1, Math.max(1, sw - bx));
      const bh = clamp(Math.floor(p.rh / (p.ch / sh)), 1, Math.max(1, sh - by));

      chain =
        cropHead +
        ',scale=' + sw + ':' + sh + ':flags=neighbor' +
        ',crop=' + bw + ':' + bh + ':' + bx + ':' + by +
        ',scale=' + p.rw + ':' + p.rh + ':flags=neighbor';
      overlayX = p.ax;
      overlayY = p.ay;
    } else if (mode === 'fill' || mode === 'delogo') {
      chain =
        cropHead +
        ',delogo=x=' + p.ix + ':y=' + p.iy + ':w=' + p.rw + ':h=' + p.rh + ':show=0';
      overlayX = p.cx;
      overlayY = p.cy;
    } else {
      // blur（默认）
      const radius = clamp(Math.floor(Math.min(p.cw, p.ch) / 6), 2, BLUR_MAX_RADIUS);
      chain =
        cropHead +
        ',boxblur=' + radius + ':2' +
        ',crop=' + p.rw + ':' + p.rh + ':' + p.ix + ':' + p.iy;
      overlayX = p.ax;
      overlayY = p.ay;
    }

    const fLabel = 'f' + (layers.length + 1);
    // 1) 局部处理：一律从原始 [0:v] 分叉
    parts.push('[0:v]' + chain + '[' + fLabel + ']');
    layers.push({ fLabel, out, overlayX, overlayY });
  });

  if (!layers.length) return { graph: null, outLabel: '0:v', note: '区域过小，跳过滤镜' };

  // 2) overlay 串行叠加：主链依次消费「上一步输出」与「本步的局部图层」
  let cur = '0:v';
  layers.forEach((L) => {
    parts.push(
      '[' + cur + '][' + L.fLabel + ']overlay=' + L.overlayX + ':' + L.overlayY +
        (enable ? ':enable=' + enable : '') +
        '[' + L.out + ']'
    );
    cur = L.out;
  });

  // 3) 最后一级输出重命名为 vout，方便 -map
  if (cur !== 'vout') {
    parts.push('[' + cur + ']null[vout]');
    cur = 'vout';
  }

  return { graph: parts.join(';'), outLabel: cur, note: '区域 ' + layers.length + ' 处' };
}

/* ============================================================
   内部：坐标与几何
   ============================================================ */

function toPixelRegion(r, vw, vh) {
  const src = r || {};
  let x = Math.round(clamp(Number(src.x) || 0, 0, 1) * vw);
  let y = Math.round(clamp(Number(src.y) || 0, 0, 1) * vh);
  let w = Math.round(clamp(Number(src.w) || 0, 0, 1) * vw);
  let h = Math.round(clamp(Number(src.h) || 0, 0, 1) * vh);

  x = clamp(x, 0, Math.max(0, vw - 2));
  y = clamp(y, 0, Math.max(0, vh - 2));
  w = clamp(w, 0, vw - x);
  h = clamp(h, 0, vh - y);

  return { x, y, w, h };
}

/**
 * 计算「带内边距的裁剪框」与「内部真实待处理矩形」
 *
 * delogo 的硬性约束（实测得出，文档未写明）：
 *   logo 矩形必须是裁剪画面的「真内部矩形」，四周各留 ≥2px 余量。
 *   余量 0 或 1 时 ffmpeg 会报：
 *     [delogo] Logo area is outside of the frame.
 *     Failed to inject frame into filter network: Invalid argument
 *   水印通常贴在画面角落，裁剪框会被画幅截断导致余量归零，
 *   因此这里必须「反算」：先确定裁剪框，再收缩内层矩形保证余量。
 *
 * 同时裁剪宽高取偶数，规避 delogo / boxblur 的奇偶对齐隐患。
 */
function paddedCrop(r, vw, vh, pad) {
  const EDGE = 2; // delogo 要求的最小内侧余量（实测 1 仍会失败）

  const cx = clamp(r.x - pad, 0, Math.max(0, vw - 2 * EDGE - 4));
  const cy = clamp(r.y - pad, 0, Math.max(0, vh - 2 * EDGE - 4));

  // 裁剪框尽量容下「区域 + 两侧 pad + 内侧余量」
  const cwMax = vw - cx;
  const chMax = vh - cy;
  const cw = clamp(evenFloor(r.w + 2 * pad + 2 * EDGE), 2, evenFloor(cwMax));
  const ch = clamp(evenFloor(r.h + 2 * pad + 2 * EDGE), 2, evenFloor(chMax));

  // 内层矩形：相对裁剪图定位，四边各保证 ≥EDGE 余量
  const ix = clamp(r.x - cx, EDGE, Math.max(EDGE, cw - EDGE - 4));
  const iy = clamp(r.y - cy, EDGE, Math.max(EDGE, ch - EDGE - 4));

  // 内层尺寸向「安全上限」收敛，而不是简单截到 cw-ix
  const rw = clamp(r.w, 4, Math.max(4, cw - ix - EDGE));
  const rh = clamp(r.h, 4, Math.max(4, ch - iy - EDGE));

  if (rw < 4 || rh < 4) return null;

  // 终极守卫：四边余量必须 ≥EDGE，且不得越界（越界即 delogo 必然失败）
  if (ix < EDGE || iy < EDGE) return null;
  if (ix + rw + EDGE > cw || iy + rh + EDGE > ch) return null;
  if (cx + cw > vw || cy + ch > vh) return null;

  return {
    cx, cy, cw, ch,
    ix, iy, rw, rh,
    ax: cx + ix,
    ay: cy + iy
  };
}

/** 向下取偶（delogo / boxblur 对奇数尺寸敏感） */
function evenFloor(n) {
  return Math.max(2, Math.floor(Number(n) / 2) * 2);
}

/** 裁剪模式下：取出不含水印的最大子矩形 */
function pickCropRect(regions, vw, vh) {
  const MIN_SIDE = 32;
  let best = null;

  regions.forEach((r) => {
    const cands = [
      { x: 0, y: 0, w: r.x, h: vh },
      { x: r.x + r.w, y: 0, w: vw - (r.x + r.w), h: vh },
      { x: 0, y: 0, w: vw, h: r.y },
      { x: 0, y: r.y + r.h, w: vw, h: vh - (r.y + r.h) }
    ];
    cands.forEach((c) => {
      if (c.w < MIN_SIDE || c.h < MIN_SIDE) return;
      const area = c.w * c.h;
      if (!best || area > best.area) best = Object.assign({}, c, { area });
    });
  });

  return best;
}

/** 时间区间 → overlay 的 enable 表达式；覆盖全片时返回空串 */
function buildEnable(timeRange, duration) {
  if (!timeRange) return '';
  const s = Number(timeRange.start);
  const e = Number(timeRange.end);
  if (!isFinite(s) || !isFinite(e)) return '';

  const startClamped = Math.max(0, s);
  const endClamped = duration > 0 ? Math.min(duration, e) : e;

  const coversAll = startClamped <= 0.2 && (duration <= 0 || endClamped >= duration - 0.2);
  if (coversAll) return '';

  return "'between(t," + startClamped.toFixed(3) + "," + endClamped.toFixed(3) + ")'";
}

function even(n) {
  return Math.max(2, Math.floor(Number(n) / 2) * 2);
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

module.exports = {
  buildGraph,
  toPixelRegion,
  pickCropRect,
  DELOGO_PAD,
  MOSAIC_BLOCKS
};
