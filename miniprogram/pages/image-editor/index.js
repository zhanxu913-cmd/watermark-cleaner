const app = getApp();
const image = require('../../utils/image');
const cloud = require('../../utils/cloud');
const jobApi = require('../../services/job');
const { MODE, MODE_LABEL, MODE_DESC, TOOL } = require('../../utils/constants');
const { toast, clamp } = require('../../utils/util');

// 各模式的默认强度（以 800px 宽为基准，引擎会按实际宽度等比换算）
const STRENGTH = { blur: 12, mosaic: 16, fill: 0 };

const MIN_CROP = 0.08;
const HANDLE_HIT = 30;

Page({
  data: {
    src: '',
    fileName: '',

    // 布局
    canvasW: 0,
    canvasH: 0,
    dispW: 0,
    dispH: 0,
    offX: 0,
    offY: 0,
    layoutReady: false,

    // 编辑状态
    tool: TOOL.BRUSH,
    strokes: [],
    current: null,
    cropRect: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
    brushLevel: 3,
    brushPx: 32,
    mode: MODE.FILL,
    showOriginal: false,

    // 派生展示
    hasSelection: false,
    modeLabel: MODE_LABEL.fill,
    modeDesc: MODE_DESC.fill,
    modeOptions: [],
    canUndo: false,
    canRedo: false,

    // 处理中
    processing: false,
    progress: 0,
    progressLabel: ''
  },

  onLoad() {
    const pending = app.globalData.pending || {};
    if (!pending.path || pending.type !== 'image') {
      toast('未选择图片');
      setTimeout(() => wx.navigateBack(), 600);
      return;
    }

    this._history = [];
    this._redo = [];
    this._drawing = false;
    this._imgW = pending.width || 0;
    this._imgH = pending.height || 0;

    this.setData({
      src: pending.path,
      fileName: pending.fileName || '素材.jpg',
      // 处理方式固定为智能去水印，不再提供模式选择
      modeOptions: []
    });
  },

  onReady() {
    this.prepare();
  },

  onUnload() {
    this._ctx = null;
    this._canvas = null;
  },

  /* ================= 初始化 ================= */

  prepare() {
    const src = this.data.src;
    if (!src) return;

    image
      .getImageInfo(src)
      .then((info) => {
        this._imgW = info.width;
        this._imgH = info.height;
        return this.measureAndLayout();
      })
      .then(() => this.redraw())
      .catch((e) => {
        toast(e.message || '图片加载失败');
      });
  },

  measureStage() {
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#stageCanvas')
        .boundingClientRect((rect) => resolve(rect || null))
        .exec();
    });
  },

  measureAndLayout() {
    return this.measureStage().then(
      (rect) =>
        new Promise((resolve) => {
          if (!rect || !rect.width) {
            // canvas 尚未渲染完成，稍后重试一次
            return setTimeout(() => {
              this.measureStage().then((r2) => {
                if (r2 && r2.width) this.applyLayout(r2).then(resolve);
                else resolve();
              });
            }, 120);
          }
          this.applyLayout(rect).then(resolve);
        })
    );
  },

  applyLayout(rect) {
    const cw = rect.width;
    const ch = rect.height;
    if (!cw || !ch || !this._imgW || !this._imgH) return Promise.resolve();

    const scale = Math.min(cw / this._imgW, ch / this._imgH);
    const dispW = this._imgW * scale;
    const dispH = this._imgH * scale;

    let dpr = 2;
    try {
      dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2;
    } catch (e) {
      dpr = 2;
    }

    // 触摸坐标基准（用于把 clientX/Y 换算成 canvas 内坐标）
    this._rect = { left: rect.left, top: rect.top };

    return new Promise((resolve) => {
      this.setData(
        {
          canvasW: cw,
          canvasH: ch,
          dispW,
          dispH,
          offX: (cw - dispW) / 2,
          offY: (ch - dispH) / 2,
          brushPx: Math.round(this.data.brushLevel / 100 * this._imgW)
        },
        () => {
          image
            .getCanvasNode('#stageCanvas', this)
            .then((node) => {
              this._canvas = node;
              node.width = Math.round(cw * dpr);
              node.height = Math.round(ch * dpr);
              this._ctx = node.getContext('2d');
              this._ctx.scale(dpr, dpr);
              this._dpr = dpr;
              this.setData({ layoutReady: true });
              resolve();
            })
            .catch(() => resolve());
        }
      );
    });
  },

  /* ================= 绘制 ================= */

  redraw() {
    const ctx = this._ctx;
    if (!ctx) return;

    const d = this.data;
    ctx.clearRect(0, 0, d.canvasW, d.canvasH);

    if (d.showOriginal) {
      this.drawCompareBadge(ctx);
      return;
    }

    if (d.tool === TOOL.CROP) {
      this.drawCrop(ctx);
      return;
    }

    const list = d.current ? d.strokes.concat([d.current]) : d.strokes;
    ctx.fillStyle = 'rgba(55,138,221,0.38)';
    ctx.strokeStyle = '#185FA5';
    ctx.lineWidth = 2;

    list.forEach((s) => {
      if (s.type === 'brush') {
        (s.points || []).forEach((p) => {
          ctx.beginPath();
          ctx.arc(
            d.offX + p.x * d.dispW,
            d.offY + p.y * d.dispH,
            Math.max(2, p.r * d.dispW),
            0,
            Math.PI * 2
          );
          ctx.fill();
        });
      } else if (s.type === 'rect') {
        const x = d.offX + s.x * d.dispW;
        const y = d.offY + s.y * d.dispH;
        const w = s.w * d.dispW;
        const h = s.h * d.dispH;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        this.drawHandles(ctx, x, y, w, h, '#185FA5');
      }
    });
  },

  drawHandles(ctx, x, y, w, h, color) {
    const s = 9;
    const pts = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h]
    ];
    ctx.save();
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    pts.forEach((p) => {
      ctx.beginPath();
      ctx.rect(p[0] - s / 2, p[1] - s / 2, s, s);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  },

  drawCrop(ctx) {
    const d = this.data;
    const x = d.offX + d.cropRect.x * d.dispW;
    const y = d.offY + d.cropRect.y * d.dispH;
    const w = d.cropRect.w * d.dispW;
    const h = d.cropRect.h * d.dispH;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fillRect(d.offX, d.offY, d.dispW, y - d.offY);
    ctx.fillRect(d.offX, y + h, d.dispW, d.offY + d.dispH - (y + h));
    ctx.fillRect(d.offX, y, x - d.offX, h);
    ctx.fillRect(x + w, y, d.offX + d.dispW - (x + w), h);

    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    // 三分参考线
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(x + (w * i) / 3, y);
      ctx.lineTo(x + (w * i) / 3, y + h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y + (h * i) / 3);
      ctx.lineTo(x + w, y + (h * i) / 3);
      ctx.stroke();
    }
    ctx.restore();

    this.drawHandles(ctx, x, y, w, h, '#185FA5');
  },

  drawCompareBadge(ctx) {
    const d = this.data;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(d.offX + 12, d.offY + (d.dispH - 48) - 12, 210, 48);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '26rpx sans-serif';
    ctx.fillText('原图', d.offX + 32, d.offY + d.dispH - 42);
    ctx.restore();
  },

  /* ================= 触摸 ================= */

  localPoint(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!t || !this._rect) return null;
    const cx = t.clientX != null ? t.clientX : t.pageX;
    const cy = t.clientY != null ? t.clientY : t.pageY;
    return { x: cx - this._rect.left, y: cy - this._rect.top };
  },

  toNorm(local) {
    const d = this.data;
    return {
      x: clamp((local.x - d.offX) / (d.dispW || 1), 0, 1),
      y: clamp((local.y - d.offY) / (d.dispH || 1), 0, 1)
    };
  },

  onTouchStart(e) {
    if (this.data.processing || !this.data.layoutReady) return;
    const local = this.localPoint(e);
    if (!local) return;
    const pt = this.toNorm(local);
    const tool = this.data.tool;

    if (tool === TOOL.BRUSH) {
      this._drawing = true;
      this.pushHistory();
      this.setData({
        current: {
          type: 'brush',
          points: [{ x: pt.x, y: pt.y, r: this.data.brushLevel / 100 }]
        }
      });
      this.redraw();
    } else if (tool === TOOL.RECT) {
      this._drawing = true;
      this._start = pt;
      this.pushHistory();
      this.setData({ current: { type: 'rect', x: pt.x, y: pt.y, w: 0, h: 0 } });
    } else {
      this._cropMode = this.hitCropHandle(local.x, local.y);
      this._cropStart = { x: pt.x, y: pt.y, rect: Object.assign({}, this.data.cropRect) };
      this._drawing = !!this._cropMode;
    }
  },

  onTouchMove(e) {
    if (!this._drawing) return;
    const local = this.localPoint(e);
    if (!local) return;
    const pt = this.toNorm(local);
    const tool = this.data.tool;

    if (tool === TOOL.BRUSH) {
      const cur = this.data.current;
      if (!cur || !cur.points.length) return;
      const last = cur.points[cur.points.length - 1];
      const minDist = 0.005;
      if (Math.abs(pt.x - last.x) < minDist && Math.abs(pt.y - last.y) < minDist) return;
      cur.points.push({ x: pt.x, y: pt.y, r: this.data.brushLevel / 100 });
      this.setData({ current: cur });
      this.redraw();
    } else if (tool === TOOL.RECT) {
      const s = this._start;
      if (!s) return;
      this.setData({
        current: {
          type: 'rect',
          x: Math.min(s.x, pt.x),
          y: Math.min(s.y, pt.y),
          w: Math.abs(pt.x - s.x),
          h: Math.abs(pt.y - s.y)
        }
      });
      this.redraw();
    } else {
      this.updateCrop(pt);
    }
  },

  onTouchEnd() {
    if (!this._drawing) return;
    this._drawing = false;
    const tool = this.data.tool;
    const cur = this.data.current;

    if (tool === TOOL.BRUSH && cur && cur.points && cur.points.length) {
      const strokes = this.data.strokes.concat([cur]);
      this.setData({ strokes, current: null }, () => this.afterChange());
    } else if (tool === TOOL.RECT && cur && cur.w > 0.008 && cur.h > 0.008) {
      const strokes = this.data.strokes.concat([cur]);
      this.setData({ strokes, current: null }, () => this.afterChange());
    } else if (tool === TOOL.CROP) {
      this._cropMode = '';
      this.afterChange();
    } else {
      this.setData({ current: null });
      this.redraw();
    }
  },

  hitCropHandle(cx, cy) {
    const d = this.data;
    const x = d.offX + d.cropRect.x * d.dispW;
    const y = d.offY + d.cropRect.y * d.dispH;
    const w = d.cropRect.w * d.dispW;
    const h = d.cropRect.h * d.dispH;

    const corners = [
      ['tl', x, y],
      ['tr', x + w, y],
      ['bl', x, y + h],
      ['br', x + w, y + h]
    ];
    for (let i = 0; i < corners.length; i++) {
      const c = corners[i];
      if (Math.abs(cx - c[1]) < HANDLE_HIT && Math.abs(cy - c[2]) < HANDLE_HIT) return c[0];
    }
    if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) return 'move';
    return '';
  },

  updateCrop(pt) {
    const s = this._cropStart;
    if (!s || !this._cropMode) return;

    const dx = pt.x - s.x;
    const dy = pt.y - s.y;
    const r = Object.assign({}, s.rect);

    if (this._cropMode === 'move') {
      r.x = clamp(s.rect.x + dx, 0, 1 - r.w);
      r.y = clamp(s.rect.y + dy, 0, 1 - r.h);
    } else {
      let x0 = r.x;
      let y0 = r.y;
      let x1 = r.x + r.w;
      let y1 = r.y + r.h;
      if (this._cropMode.indexOf('l') > -1) x0 = clamp(s.rect.x + dx, 0, x1 - MIN_CROP);
      if (this._cropMode.indexOf('r') > -1)
        x1 = clamp(s.rect.x + s.rect.w + dx, x0 + MIN_CROP, 1);
      if (this._cropMode.indexOf('t') > -1) y0 = clamp(s.rect.y + dy, 0, y1 - MIN_CROP);
      if (this._cropMode.indexOf('b') > -1)
        y1 = clamp(s.rect.y + s.rect.h + dy, y0 + MIN_CROP, 1);
      r.x = x0;
      r.y = y0;
      r.w = x1 - x0;
      r.h = y1 - y0;
    }

    this.setData({ cropRect: r }, () => this.redraw());
  },

  /* ================= 工具栏 ================= */

  afterChange() {
    const d = this.data;
    const has =
      d.tool === TOOL.CROP
        ? d.cropRect.w < 0.995 || d.cropRect.h < 0.995
        : d.strokes.length > 0;

    this.setData({
      hasSelection: has,
      canUndo: (this._history || []).length > 0,
      canRedo: (this._redo || []).length > 0
    });
    this.redraw();
  },

  pushHistory() {
    if (!this._history) this._history = [];
    this._history.push(JSON.parse(JSON.stringify(this.data.strokes)));
    if (this._history.length > 30) this._history.shift();
    this._redo = [];
  },

  undo() {
    if (!this._history || !this._history.length) return toast('没有可撤销的操作');
    if (!this._redo) this._redo = [];
    this._redo.push(JSON.parse(JSON.stringify(this.data.strokes)));
    const prev = this._history.pop();
    this.setData({ strokes: prev, current: null }, () => this.afterChange());
  },

  redo() {
    if (!this._redo || !this._redo.length) return toast('没有可重做的操作');
    if (!this._history) this._history = [];
    this._history.push(JSON.parse(JSON.stringify(this.data.strokes)));
    const next = this._redo.pop();
    this.setData({ strokes: next, current: null }, () => this.afterChange());
  },

  clearAll() {
    if (!this.data.hasSelection && !this._history.length) return;
    this.pushHistory();
    this.setData(
      {
        strokes: [],
        current: null,
        cropRect: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 }
      },
      () => this.afterChange()
    );
  },

  showOrigin() {
    if (!this.data.hasSelection) return;
    this.setData({ showOriginal: true }, () => this.redraw());
  },

  hideOrigin() {
    if (!this.data.showOriginal) return;
    this.setData({ showOriginal: false }, () => this.redraw());
  },

  switchTool(e) {
    const tool = e.currentTarget.dataset.tool;
    if (tool === this.data.tool) return;
    this.setData({ tool, current: null }, () => this.afterChange());
  },

  onBrushChange(e) {
    const level = Number(e.detail.value) || 3;
    this.setData({
      brushLevel: level,
      brushPx: Math.round((level / 100) * (this._imgW || 1000))
    });
  },

  /* ================= 处理 ================= */

  async startProcess() {
    if (this.data.processing) return;
    if (!this.data.hasSelection) {
      return toast(
        this.data.tool === TOOL.CROP ? '请先调整裁剪范围' : '请先涂抹或框选要清理的水印区域'
      );
    }

    const isCrop = this.data.tool === TOOL.CROP;
    this.setData({ processing: true, progress: 2, progressLabel: '准备中' });

    try {
      const canvas = this._workCanvas || (await image.getCanvasNode('#workCanvas', this));
      this._workCanvas = canvas;

      const result = await image.processImage({
        canvas,
        src: this.data.src,
        mode: isCrop ? MODE.CROP : this.data.mode,
        strokes: isCrop ? [] : this.data.strokes,
        crop: isCrop ? this.data.cropRect : null,
        strength: STRENGTH[this.data.mode] || 12,
        onProgress: (p, label) => this.setData({ progress: p, progressLabel: label })
      });

      // 上传结果（原图不上传，只传处理后的成品与缩略图）
      this.setData({ progress: 92, progressLabel: '上传结果' });
      const up = await cloud.upload(result.path, 'output/images');

      let thumbFileID = '';
      try {
        const thumbPath = await image.makeThumbnail(canvas, result.path, 400);
        const t = await cloud.upload(thumbPath, 'thumb/images');
        thumbFileID = t.fileID;
      } catch (e) {
        /* 缩略图失败不影响主流程 */
      }

      this.setData({ progress: 97, progressLabel: '写入记录' });
      await jobApi.create({
        type: 'image',
        fileName: this.data.fileName,
        mode: isCrop ? MODE.CROP : this.data.mode,
        outFileID: up.fileID,
        thumbFileID,
        width: result.width,
        height: result.height,
        regionCount: isCrop ? 1 : this.data.strokes.length
      });

      app.bumpJob();
      app.refresh().catch(() => {});

      this.setData({ progress: 100, progressLabel: '完成' });

      // 已写入记录，直接进入「处理记录」查看与下载
      setTimeout(() => {
        wx.switchTab({ url: '/pages/records/index' });
      }, 260);
    } catch (e) {
      this.setData({ processing: false, progress: 0, progressLabel: '' });
      toast(e.message || '处理失败，请重试');
    }
  },

  onCancel() {
    wx.navigateBack();
  }
});
