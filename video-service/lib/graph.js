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
  const mode = String(o.mode || 'blur');
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
  let base = '0:v';
  let n = 0;

  px.forEach((r) => {
    const p = paddedCrop(r, vw, vh, DELOGO_PAD);
    if (!p) return;

    const out = 'v' + ++n;
    const cropHead = 'crop=' + p.cw + ':' + p.ch + ':' + p.cx + ':' + p.cy;

    let chain = '';
    let overlayX = p.cx;
    let overlayY = p.cy;

    if (mode === 'mosaic') {
      const sw = Math.max(1, Math.round(p.cw / MOSAIC_BLOCKS));
      const sh = Math.max(1, Math.round(p.ch / MOSAIC_BLOCKS));
      const ix = Math.max(0, Math.round(p.ix / MOSAIC_BLOCKS));
      const iy = Math.max(0, Math.round(p.iy / MOSAIC_BLOCKS));
      const rw = Math.max(1, Math.round(p.rw / MOSAIC_BLOCKS));
      const rh = Math.max(1, Math.round(p.rh / MOSAIC_BLOCKS));
      chain =
        cropHead +
        ',scale=' + sw + ':' + sh + ':flags=neighbor' +
        ',crop=' + Math.min(rw, sw - ix) + ':' + Math.min(rh, sh - iy) + ':' + ix + ':' + iy +
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

    parts.push('[' + base + ']' + chain + '[f' + n + ']');
    parts.push(
      '[' + base + '][f' + n + ']overlay=' + overlayX + ':' + overlayY +
        (enable ? ':enable=' + enable : '') +
        '[' + out + ']'
    );
    base = out;
  });

  if (!parts.length) return { graph: null, outLabel: '0:v', note: '区域过小，跳过滤镜' };

  // 最后一级输出重命名为 vout，方便 -map
  if (base !== 'vout') {
    parts.push('[' + base + ']null[vout]');
    base = 'vout';
  }

  return { graph: parts.join(';'), outLabel: base, note: '区域 ' + px.length + ' 处' };
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
 * 内层矩形四周保证至少 1px 余量 —— delogo 与 boxblur 都要求这样
 */
function paddedCrop(r, vw, vh, pad) {
  const cx = clamp(r.x - pad, 0, vw - 2);
  const cy = clamp(r.y - pad, 0, vh - 2);
  const cw = clamp(r.w + 2 * pad, 2, vw - cx);
  const ch = clamp(r.h + 2 * pad, 2, vh - cy);

  const ix = clamp(r.x - cx, 1, Math.max(1, cw - 2));
  const iy = clamp(r.y - cy, 1, Math.max(1, ch - 2));
  const rw = clamp(r.w, 1, Math.max(1, cw - ix - 1));
  const rh = clamp(r.h, 1, Math.max(1, ch - iy - 1));

  if (rw < 4 || rh < 4) return null;

  return {
    cx, cy, cw, ch,
    ix, iy, rw, rh,
    ax: cx + ix,
    ay: cy + iy
  };
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
