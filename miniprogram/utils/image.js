/**
 * 图片去水印处理引擎（纯本地，零云端成本）
 *
 * 设计要点
 * ---------------------------------------------------------------
 * 1. 所有选区（涂抹轨迹 / 矩形框选）统一归约为「蒙版」，处理时按蒙版
 *    alpha 把修补结果混合回原图 —— 于是笔刷与框选共用同一套算法。
 * 2. 只处理选区包围盒（bbox）内的像素，1080p 全图不会整体过一遍。
 * 3. 蒙版做 2px 羽化，避免修补区域出现硬边。
 *
 * 三种修补算法
 * ---------------------------------------------------------------
 *   blur   分离式 box blur ×3 次，近似高斯。滑动窗口实现，复杂度 O(w·h)
 *   mosaic 像素块取平均。最省性能
 *   fill   行列最近有效像素插值，是一种轻量 inpainting，
 *          对「纯色/渐变背景上的文字水印」效果最好
 *
 * 坐标约定
 * ---------------------------------------------------------------
 *   strokes / crop 均为归一化坐标（0—1），相对图片原始尺寸。
 *   笔刷半径 r 以「图片宽度」为基准，保证正圆。
 *   crop 与 strokes 互斥：裁剪模式不使用蒙版。
 */

const MAX_EDGE = 4096;

/* ============================================================
   对外入口
   ============================================================ */

/**
 * 执行图片处理
 * @param {object} opts
 * @param {object} opts.canvas       canvas 组件节点（type="2d"）
 * @param {string} opts.src          本地图片路径
 * @param {string} opts.mode         'blur' | 'mosaic' | 'fill' | 'crop'
 * @param {Array}  [opts.strokes]    选区，归一化坐标
 * @param {number} [opts.strength]   模糊半径 / 马赛克块大小（基准 800px 宽下的像素值）
 * @param {object} [opts.crop]       裁剪区 {x,y,w,h} 归一化，仅 mode='crop' 时生效
 * @param {number} [opts.quality]    导出质量，默认 0.92
 * @param {function} [opts.onProgress] (percent, label) => void
 * @returns {Promise<{path:string,width:number,height:number}>}
 */
async function processImage(opts) {
  const { canvas, src, mode, strokes, strength, crop, quality } = opts;
  const report = makeReporter(opts.onProgress);

  if (!canvas) throw new Error('画布未就绪，请稍后重试');

  report(5, '读取图片信息');
  const info = await getImageInfo(src);

  // ---- 输出尺寸 ----
  let outW;
  let outH;
  let srcX = 0;
  let srcY = 0;
  let srcW = info.width;
  let srcH = info.height;

  if (mode === 'crop' && crop) {
    srcX = Math.round(crop.x * info.width);
    srcY = Math.round(crop.y * info.height);
    srcW = Math.max(1, Math.round(crop.w * info.width));
    srcH = Math.max(1, Math.round(crop.h * info.height));
  }

  const shrink = Math.min(1, MAX_EDGE / Math.max(srcW, srcH));
  outW = Math.max(1, Math.round(srcW * shrink));
  outH = Math.max(1, Math.round(srcH * shrink));

  report(15, '准备画布');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');

  report(25, '绘制原图');
  const img = canvas.createImage();
  await loadImage(img, src);
  ctx.clearRect(0, 0, outW, outH);
  ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, outW, outH);

  const hasMask = mode !== 'crop' && Array.isArray(strokes) && strokes.length > 0;

  if (hasMask) {
    report(35, '计算选区范围');
    const pad = padFor(mode, strength);
    const bbox = computeBBox(strokes, outW, outH, pad);

    if (bbox) {
      report(45, '生成蒙版');
      const maskAlpha = renderMask(outW, outH, strokes, bbox);

      report(58, '读取像素');
      const imgData = ctx.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);

      report(68, '计算修补像素');
      patch(imgData, maskAlpha, bbox.w, bbox.h, mode, strength, outW);

      report(88, '混合回画面');
      ctx.putImageData(imgData, bbox.x, bbox.y);
    }
  }

  report(94, '导出结果');
  const path = await canvasToTempFilePath(canvas, quality || 0.92);
  report(100, '完成');

  return { path, width: outW, height: outH };
}

/**
 * 取 canvas 组件节点
 * @param {string} selector 如 '#workCanvas'
 * @param {object} pageInstance 页面 this（可选）
 */
function getCanvasNode(selector, pageInstance) {
  return new Promise((resolve, reject) => {
    const query = pageInstance
      ? wx.createSelectorQuery().in(pageInstance)
      : wx.createSelectorQuery();
    query
      .select(selector)
      .fields({ node: true, size: true })
      .exec((res) => {
        const node = res && res[0] && res[0].node;
        if (!node) return reject(new Error('未找到画布，请确认 canvas 已渲染'));
        resolve(node);
      });
  });
}

/* ============================================================
   蒙版
   ============================================================ */

/** 选区包围盒（像素坐标，已外扩 pad 并裁剪到画布内） */
function computeBBox(strokes, w, h, pad) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;

  strokes.forEach((s) => {
    if (s.type === 'brush') {
      (s.points || []).forEach((p) => {
        const r = (p.r || 0.01) * w;
        x0 = Math.min(x0, p.x * w - r);
        y0 = Math.min(y0, p.y * h - r);
        x1 = Math.max(x1, p.x * w + r);
        y1 = Math.max(y1, p.y * h + r);
      });
    } else if (s.type === 'rect') {
      x0 = Math.min(x0, s.x * w);
      y0 = Math.min(y0, s.y * h);
      x1 = Math.max(x1, (s.x + s.w) * w);
      y1 = Math.max(y1, (s.y + s.h) * h);
    }
  });

  if (!isFinite(x0) || !isFinite(y0)) return null;

  const bx = Math.max(0, Math.floor(x0 - pad));
  const by = Math.max(0, Math.floor(y0 - pad));
  const bw = Math.min(w, Math.ceil(x1 + pad)) - bx;
  const bh = Math.min(h, Math.ceil(y1 + pad)) - by;

  if (bw <= 0 || bh <= 0) return null;
  return { x: bx, y: by, w: bw, h: bh };
}

/** 渲染蒙版并返回 bbox 区域的 alpha 数组（0—255） */
function renderMask(w, h, strokes, bbox) {
  const canvas = wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';

  strokes.forEach((s) => {
    if (s.type === 'brush') {
      const pts = s.points || [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, Math.max(2, (p.r || 0.01) * w), 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (s.type === 'rect') {
      const rx = s.x * w;
      const ry = s.y * h;
      ctx.fillRect(rx, ry, Math.max(1, s.w * w), Math.max(1, s.h * h));
    }
  });

  const data = ctx.getImageData(bbox.x, bbox.y, bbox.w, bbox.h).data;
  const alpha = new Uint8ClampedArray(bbox.w * bbox.h);
  for (let i = 0, n = alpha.length; i < n; i++) alpha[i] = data[i * 4]; // 取红通道作蒙版
  return alpha;
}

/** 蒙版羽化：两次一维滑动窗口模糊，避免硬边 */
function feather(mask, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  const win = 2 * r + 1;
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += mask[row + clampIdx(k, w)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      sum += mask[row + clampIdx(x + r + 1, w)] - mask[row + clampIdx(x - r, w)];
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[clampIdx(k, h) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      sum += tmp[clampIdx(y + r + 1, h) * w + x] - tmp[clampIdx(y - r, h) * w + x];
    }
  }
  return out;
}

/* ============================================================
   修补 + 混合
   ============================================================ */

function patch(imgData, maskAlpha, w, h, mode, strength, fullWidth) {
  const original = new Uint8ClampedArray(imgData.data);
  let patched;

  if (mode === 'mosaic') {
    patched = mosaicPatch(original, w, h, blockSize(strength, fullWidth));
  } else if (mode === 'fill') {
    patched = fillPatch(original, maskAlpha, w, h);
  } else {
    patched = blurPatch(original, w, h, blurRadius(strength, fullWidth));
  }

  const soft = feather(maskAlpha, w, h, 2);
  const out = imgData.data;

  for (let i = 0, n = w * h; i < n; i++) {
    const a = soft[i] / 255;
    if (a <= 0.002) continue;
    const o = i * 4;
    const ia = 1 - a;
    out[o] = out[o] * ia + patched[o] * a;
    out[o + 1] = out[o + 1] * ia + patched[o + 1] * a;
    out[o + 2] = out[o + 2] * ia + patched[o + 2] * a;
  }
}

/** strength 以 800px 宽为基准，按实际宽度等比换算 */
function blurRadius(strength, fullWidth) {
  const base = strength || 12;
  return Math.max(1, Math.round((base * fullWidth) / 800));
}

function blockSize(strength, fullWidth) {
  const base = strength || 16;
  return Math.max(3, Math.round((base * fullWidth) / 800));
}

/** 包围盒外扩量：模糊/马赛克需要周边像素参与运算，填充需要边界像素 */
function padFor(mode, strength) {
  if (mode === 'fill') return 3;
  if (mode === 'mosaic') return Math.max(3, blockSize(strength, 800));
  return Math.max(4, blurRadius(strength, 800) * 2);
}

/* ---------------- 模糊：分离式 box blur ---------------- */

function blurPatch(src, w, h, radius) {
  const r = Math.max(1, radius);
  const PASSES = 3;
  let buf = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) buf[i] = src[i];

  const tmp = new Float32Array(src.length);

  for (let p = 0; p < PASSES; p++) {
    blurAxisH(buf, tmp, w, h, r);
    blurAxisV(tmp, buf, w, h, r);
  }

  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i++) out[i] = buf[i];
  // alpha 保持原样
  for (let i = 3; i < src.length; i += 4) out[i] = src[i];
  return out;
}

function blurAxisH(src, dst, w, h, r) {
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let k = -r; k <= r; k++) {
      const i = row + clampIdx(k, w) * 4;
      sr += src[i];
      sg += src[i + 1];
      sb += src[i + 2];
    }
    for (let x = 0; x < w; x++) {
      const o = row + x * 4;
      dst[o] = sr / win;
      dst[o + 1] = sg / win;
      dst[o + 2] = sb / win;
      dst[o + 3] = src[o + 3];

      const oi = row + clampIdx(x - r, w) * 4;
      const ii = row + clampIdx(x + r + 1, w) * 4;
      sr += src[ii] - src[oi];
      sg += src[ii + 1] - src[oi + 1];
      sb += src[ii + 2] - src[oi + 2];
    }
  }
}

function blurAxisV(src, dst, w, h, r) {
  const win = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let k = -r; k <= r; k++) {
      const i = (clampIdx(k, h) * w + x) * 4;
      sr += src[i];
      sg += src[i + 1];
      sb += src[i + 2];
    }
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 4;
      dst[o] = sr / win;
      dst[o + 1] = sg / win;
      dst[o + 2] = sb / win;
      dst[o + 3] = src[o + 3];

      const oi = (clampIdx(y - r, h) * w + x) * 4;
      const ii = (clampIdx(y + r + 1, h) * w + x) * 4;
      sr += src[ii] - src[oi];
      sg += src[ii + 1] - src[oi + 1];
      sb += src[ii + 2] - src[oi + 2];
    }
  }
}

/* ---------------- 马赛克 ---------------- */

function mosaicPatch(src, w, h, block) {
  const out = new Uint8ClampedArray(src);
  const b = Math.max(2, block);

  for (let by = 0; by < h; by += b) {
    const yEnd = Math.min(by + b, h);
    for (let bx = 0; bx < w; bx += b) {
      const xEnd = Math.min(bx + b, w);
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;

      for (let y = by; y < yEnd; y++) {
        const row = y * w;
        for (let x = bx; x < xEnd; x++) {
          const i = (row + x) * 4;
          sr += src[i];
          sg += src[i + 1];
          sb += src[i + 2];
          n++;
        }
      }
      if (!n) continue;

      const ar = sr / n;
      const ag = sg / n;
      const ab = sb / n;

      for (let y = by; y < yEnd; y++) {
        const row = y * w;
        for (let x = bx; x < xEnd; x++) {
          const i = (row + x) * 4;
          out[i] = ar;
          out[i + 1] = ag;
          out[i + 2] = ab;
        }
      }
    }
  }
  return out;
}

/* ---------------- 智能填充：行列最近有效像素插值 ---------------- */

function fillPatch(src, maskAlpha, w, h) {
  const out = new Uint8ClampedArray(src);
  const total = w * h;
  if (!total) return out;

  // 有效 = 蒙版未覆盖
  const solid = new Uint8Array(total);
  for (let i = 0; i < total; i++) solid[i] = maskAlpha[i] < 128 ? 1 : 0;

  const lIdx = new Int32Array(total).fill(-1);
  const rIdx = new Int32Array(total).fill(-1);
  const uIdx = new Int32Array(total).fill(-1);
  const dIdx = new Int32Array(total).fill(-1);

  // 水平方向最近有效像素
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -1;
    for (let x = 0; x < w; x++) {
      if (solid[row + x]) last = x;
      lIdx[row + x] = last;
    }
    last = -1;
    for (let x = w - 1; x >= 0; x--) {
      if (solid[row + x]) last = x;
      rIdx[row + x] = last;
    }
  }

  // 垂直方向最近有效像素
  for (let x = 0; x < w; x++) {
    let last = -1;
    for (let y = 0; y < h; y++) {
      if (solid[y * w + x]) last = y;
      uIdx[y * w + x] = last;
    }
    last = -1;
    for (let y = h - 1; y >= 0; y--) {
      if (solid[y * w + x]) last = y;
      dIdx[y * w + x] = last;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (solid[i]) continue;

      const l = lIdx[i];
      const r = rIdx[i];
      const u = uIdx[i];
      const d = dIdx[i];

      let wsum = 0;
      let rr = 0;
      let gg = 0;
      let bb = 0;

      // 水平插值：两侧都有有效像素才可用
      if (l > -1 && r > -1) {
        const dl = x - l;
        const dr = r - x;
        const t = dl / (dl + dr || 1);
        const li = (y * w + l) * 4;
        const ri = (y * w + r) * 4;
        const wl = 1 / (dl + dr + 1);
        rr += (src[li] * (1 - t) + src[ri] * t) * wl;
        gg += (src[li + 1] * (1 - t) + src[ri + 1] * t) * wl;
        bb += (src[li + 2] * (1 - t) + src[ri + 2] * t) * wl;
        wsum += wl;
      }

      // 垂直插值
      if (u > -1 && d > -1) {
        const du = y - u;
        const dd = d - y;
        const t = du / (du + dd || 1);
        const ui = (u * w + x) * 4;
        const di = (d * w + x) * 4;
        const wl = 1 / (du + dd + 1);
        rr += (src[ui] * (1 - t) + src[di] * t) * wl;
        gg += (src[ui + 1] * (1 - t) + src[di + 1] * t) * wl;
        bb += (src[ui + 2] * (1 - t) + src[di + 2] * t) * wl;
        wsum += wl;
      }

      if (wsum > 0) {
        const o = i * 4;
        out[o] = rr / wsum;
        out[o + 1] = gg / wsum;
        out[o + 2] = bb / wsum;
      }
      // wsum === 0（整个 bbox 全是选区）时保留原值，交由外层羽化过渡
    }
  }

  return out;
}

/* ============================================================
   基础能力
   ============================================================ */

function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: (res) =>
        resolve({
          width: res.width,
          height: res.height,
          path: res.path,
          type: res.type,
          orientation: res.orientation
        }),
      fail: (err) => reject(new Error((err && err.errMsg) || '无法读取图片信息'))
    });
  });
}

function loadImage(imgNode, src) {
  return new Promise((resolve, reject) => {
    imgNode.onload = () => resolve();
    imgNode.onerror = () => reject(new Error('图片加载失败，请重新选择'));
    imgNode.src = src;
  });
}

function canvasToTempFilePath(canvas, quality) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      fileType: 'jpg',
      quality: quality || 0.92,
      success: (res) => resolve(res.tempFilePath),
      fail: (err) => reject(new Error((err && err.errMsg) || '导出图片失败'))
    });
  });
}

function clampIdx(i, n) {
  return i < 0 ? 0 : i > n - 1 ? n - 1 : i;
}

function makeReporter(onProgress) {
  if (typeof onProgress !== 'function') return function () {};
  return function (percent, label) {
    try {
      onProgress(percent, label);
    } catch (e) {
      /* 进度回调异常不影响主流程 */
    }
  };
}

/* ============================================================
   辅助：生成缩略图（上传前压缩，省流量）
   ============================================================ */

/**
 * 压缩图片到指定最长边
 * @param {object} canvas canvas 节点
 * @param {string} src 本地路径
 * @param {number} maxEdge 最长边像素
 */
async function makeThumbnail(canvas, src, maxEdge) {
  const limit = maxEdge || 400;
  const info = await getImageInfo(src);
  const scale = Math.min(1, limit / Math.max(info.width, info.height));
  const w = Math.max(1, Math.round(info.width * scale));
  const h = Math.max(1, Math.round(info.height * scale));

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = canvas.createImage();
  await loadImage(img, src);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, info.width, info.height, 0, 0, w, h);

  return canvasToTempFilePath(canvas, 0.7);
}

module.exports = {
  processImage,
  getCanvasNode,
  getImageInfo,
  makeThumbnail,
  canvasToTempFilePath,
  computeBBox,
  MAX_EDGE
};
