const app = getApp();
const image = require('../../utils/image');
const cloud = require('../../utils/cloud');
const jobApi = require('../../services/job');
const { MODE, MODE_DESC } = require('../../utils/constants');
const { toast, clamp, formatDuration, humanDuration } = require('../../utils/util');

const HANDLE_HIT = 34;
const MIN_CROP = 0.04;
const MIN_SPAN = 1; // 最短处理区间（秒）

Page({
  data: {
    src: '',
    thumbSrc: '',
    fileName: '',
    duration: 0,
    durationText: '',

    // 布局
    canvasW: 0,
    canvasH: 0,
    dispW: 0,
    dispH: 0,
    offX: 0,
    offY: 0,
    layoutReady: false,

    // 区域（默认右下角，水印高发区）
    region: { x: 0.6, y: 0.8, w: 0.34, h: 0.12 },
    hasRegion: true,

    // 播放（与框选同时可用）
    playing: false,
    vMuted: true,
    vError: '',
    playCursor: 0,
    playTimeText: '00:00',
    tlMidText: '',

    // 时间区间
    startSec: 0,
    endSec: 0,
    selLeft: 0,
    selWidth: 100,
    startText: '00:00',
    endText: '00:00',
    spanText: '',

    // 处理方式：固定智能去水印（delogo 按周围画面推算填充，效果最好）
    mode: MODE.FILL,
    modeDesc: MODE_DESC.fill,

    // 提交
    submitting: false,
    progress: 0,
    progressLabel: '',
    queueHint: '',
    videoServiceEnabled: false
  },

  onLoad() {
    const pending = app.globalData.pending || {};
    if (!pending.path || pending.type !== 'video') {
      toast('未选择视频');
      setTimeout(() => wx.navigateBack(), 600);
      return;
    }

    this._drawing = false;
    this._regionGrab = '';
    this._tlGrab = '';
    this._imgW = pending.width || 0;
    this._imgH = pending.height || 0;

    const duration = Math.max(1, Math.round(pending.duration || 0));
    const settings = app.globalData.settings || {};

    this.setData({
      src: pending.path,
      thumbSrc: pending.thumbPath || '',
      fileName: pending.fileName || '视频.mp4',
      duration,
      durationText: formatDuration(duration),
      endSec: duration,
      selLeft: 0,
      selWidth: 100,
      startText: formatDuration(0),
      endText: formatDuration(duration),
      spanText: humanDuration(duration),
      tlMidText: '已选 ' + humanDuration(duration) + ' · 已暂停',
      queueHint:
        '视频需上传处理后端。仅处理选中区间，约需 ' +
        Math.max(20, Math.round(duration * 0.8)) +
        '—' +
        Math.max(40, Math.round(duration * 1.6)) +
        ' 秒。',
      modeOptions: [],
      // 默认按已开启处理，随后以服务端探测结果校正（避免误拦）
      videoServiceEnabled: true
    });

    // 真实探测服务可用性，不只看后台开关
    jobApi
      .videoService()
      .then((res) => {
        if (res) this.setData({ videoServiceEnabled: !!res.available });
      })
      .catch(() => {
        // 探测失败保持开启，交给提交时的服务端校验兜底
      });
  },

  onReady() {
    this.prepare();
  },

  onUnload() {
    this.stopTimeBinder();
    this._ctx = null;
    this._vctx = null;
  },

  onHide() {
    this.pauseVideo();
  },

  /* ================= 视频播放 ================= */

  vctx() {
    if (!this._vctx) this._vctx = wx.createVideoContext('vEdit', this);
    return this._vctx;
  },

  onEditPlay() {
    this.setData({ playing: true }, () => this.refreshMid());
    this.startTimeBinder();
  },

  onEditPause() {
    this.setData({ playing: false }, () => this.refreshMid());
    this.stopTimeBinder();
    // 暂停瞬间把游标对齐真实帧位置
    try {
      const t = this._vctx && this._vctx.currentTime;
      if (typeof t === 'number') this.syncCursor(t, true);
    } catch (e) {
      /* 忽略 */
    }
  },

  onEditEnded() {
    this.setData({ playing: false }, () => this.refreshMid());
    this.stopTimeBinder();
  },

  onEditError(e) {
    this.stopTimeBinder();
    this.setData({ playing: false });
    const msg = (e && e.detail && e.detail.errMsg) || '视频播放失败';
    this.setData({ vError: msg });
  },

  // 播放中挂 200ms 定时器刷新游标（小程序 video 无 bindtimeupdate，只能轮询 currentTime）
  startTimeBinder() {
    if (this._tTimer) return;
    this._tTimer = setInterval(() => {
      const ctx = this._vctx;
      if (!ctx || typeof ctx.currentTime !== 'number') return;
      this.syncCursor(ctx.currentTime);
    }, 200);
  },

  stopTimeBinder() {
    if (this._tTimer) {
      clearInterval(this._tTimer);
      this._tTimer = null;
    }
  },

  syncCursor(sec, force) {
    const d = this.data;
    const total = d.duration || 1;
    const pct = clamp((sec / total) * 100, 0, 100);
    // 变化太小不刷数据，减少 setData 次数（force 用于暂停对齐）
    if (!force && Math.abs(pct - d.playCursor) < 0.35) return;
    this.setData({ playCursor: pct, playTimeText: formatDuration(Math.round(sec)) });
  },

  // 时间轴中段文案：已选时长 + 播放状态
  refreshMid() {
    const d = this.data;
    const txt = '已选 ' + d.spanText + (d.playing ? ' · 播放中' : ' · 已暂停');
    if (txt !== d.tlMidText) this.setData({ tlMidText: txt });
  },

  onEditTime(e) {
    // 部分基础库支持该事件，触发时同步一次（不支持则静默忽略）
    const t = e && e.detail && e.detail.currentTime;
    if (typeof t === 'number') this.syncCursor(t);
  },

  /* ---- 播放 / 暂停（框选过程中随时可用） ---- */

  togglePlay() {
    if (this.data.submitting || !this.data.src) return;
    if (this.data.playing) this.pauseVideo();
    else this.playVideo();
  },

  playVideo() {
    if (!this.data.src) return;
    try {
      this.vctx().play();
    } catch (e) {
      /* 忽略 */
    }
    // 部分基础库不触发 bindplay，这里主动补一次状态
    this.setData({ playing: true }, () => this.refreshMid());
    this.startTimeBinder();
  },

  pauseVideo() {
    try {
      this.vctx().pause();
    } catch (e) {
      /* 忽略 */
    }
    this.stopTimeBinder();
    this.setData({ playing: false }, () => this.refreshMid());
  },

  toggleMuted() {
    this.setData({ vMuted: !this.data.vMuted });
  },

  // 长按画面：临时静音并起播，松手（长按结束后再次点击或按暂停）即停
  onStageLongPress() {
    if (this.data.submitting || !this.data.src) return;
    this._mutedBak = this.data.vMuted;
    this._longPressing = true;
    this.setData({ vMuted: true }, () => this.playVideo());
  },

  // 跳到选区起点并播放
  playSelection() {
    const d = this.data;
    if (!d.src) return;
    try {
      const ctx = this.vctx();
      ctx.seek(d.startSec || 0);
      ctx.play();
      this.syncCursor(d.startSec || 0, true);
    } catch (e) {
      /* 忽略 */
    }
  },

  seekToEnd() {
    const d = this.data;
    const to = Math.max(0, (d.endSec || d.duration || 1) - 0.3);
    try {
      this.vctx().seek(to);
      this.syncCursor(to, true);
    } catch (e) {
      /* 忽略 */
    }
  },

  toggleRegion() {
    this.setData({ hasRegion: !this.data.hasRegion }, () => {
      if (this._ctx) this.redraw();
    });
  },

  /* ================= 初始化 ================= */

  prepare() {
    // 重新绑定画布（模式切换后 wx:if 会重建节点）
    this._ctx = null;
    const boot = () => this.measureAndLayout().then(() => this.redraw());

    const src = this.data.thumbSrc;
    if (!src) {
      // 无缩略图也照样挂画布（尺寸走 16:9 兜底），保证框选始终可用
      this.setData({ layoutReady: true });
      return boot();
    }

    return image
      .getImageInfo(src)
      .then((info) => {
        this._imgW = info.width;
        this._imgH = info.height;
      })
      .catch(() => {})
      .then(boot);
  },

  measureStage() {
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#vCanvas')
        .boundingClientRect((r) => resolve(r || null))
        .exec();
    });
  },

  measureAndLayout() {
    return this.measureStage().then(
      (rect) =>
        new Promise((resolve) => {
          if (!rect || !rect.width) {
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
    if (!cw || !ch) return Promise.resolve();

    // 视频尺寸未知时按 16:9 估算，保证画布仍可正常挂载与交互
    const iw = this._imgW || 16;
    const ih = this._imgH || 9;
    const scale = Math.min(cw / iw, ch / ih);
    const dispW = iw * scale;
    const dispH = ih * scale;

    let dpr = 2;
    try {
      dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2;
    } catch (e) {
      dpr = 2;
    }
    this._rect = { left: rect.left, top: rect.top };

    return new Promise((resolve) => {
      this.setData(
        {
          canvasW: cw,
          canvasH: ch,
          dispW,
          dispH,
          offX: (cw - dispW) / 2,
          offY: (ch - dispH) / 2
        },
        () => {
          image
            .getCanvasNode('#vCanvas', this)
            .then((node) => {
              node.width = Math.round(cw * dpr);
              node.height = Math.round(ch * dpr);
              this._ctx = node.getContext('2d');
              this._ctx.scale(dpr, dpr);
              this.setData({ layoutReady: true });
              resolve();
            })
            .catch(() => {
              this.setData({ layoutReady: true });
              resolve();
            });
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

    if (!d.hasRegion) return;

    const x = d.offX + d.region.x * d.dispW;
    const y = d.offY + d.region.y * d.dispH;
    const w = d.region.w * d.dispW;
    const h = d.region.h * d.dispH;

    ctx.save();
    ctx.fillStyle = 'rgba(15,110,86,0.28)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#0F6E56';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();

    const s = 11;
    const pts = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h]
    ];
    ctx.save();
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#0F6E56';
    ctx.lineWidth = 2.5;
    pts.forEach((p) => {
      ctx.beginPath();
      ctx.rect(p[0] - s / 2, p[1] - s / 2, s, s);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  },

  /* ================= 区域交互 ================= */

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

  hitHandle(cx, cy) {
    const d = this.data;
    if (!d.hasRegion) return '';
    const x = d.offX + d.region.x * d.dispW;
    const y = d.offY + d.region.y * d.dispH;
    const w = d.region.w * d.dispW;
    const h = d.region.h * d.dispH;
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

  onRegionStart(e) {
    if (this.data.submitting || !this.data.layoutReady) return;
    const local = this.localPoint(e);
    if (!local) return;
    const grab = this.hitHandle(local.x, local.y);
    const pt = this.toNorm(local);
    this._regionStart = { x: pt.x, y: pt.y, rect: Object.assign({}, this.data.region) };

    if (grab) {
      // 命中角点 / 框体：调整现有框
      this._regionGrab = grab;
    } else {
      // 与图片编辑一致：空白处按住拖动 = 画一个新框
      this._regionGrab = 'new';
      this.setData(
        { hasRegion: true, region: { x: pt.x, y: pt.y, w: MIN_CROP, h: MIN_CROP } },
        () => this.redraw()
      );
    }
    this._drawing = true;
  },

  onRegionMove(e) {
    if (!this._drawing || !this._regionGrab) return;
    const local = this.localPoint(e);
    if (!local) return;
    const pt = this.toNorm(local);
    const s = this._regionStart;
    if (!s) return;

    const dx = pt.x - s.x;
    const dy = pt.y - s.y;
    const r = Object.assign({}, s.rect);

    if (this._regionGrab === 'move') {
      r.x = clamp(s.rect.x + dx, 0, 1 - r.w);
      r.y = clamp(s.rect.y + dy, 0, 1 - r.h);
    } else if (this._regionGrab === 'new') {
      // 起点到当前点的包围盒（支持任意方向拖动）
      const x0 = Math.min(s.x, pt.x);
      const x1 = Math.max(s.x, pt.x);
      const y0 = Math.min(s.y, pt.y);
      const y1 = Math.max(s.y, pt.y);
      r.x = x0;
      r.y = y0;
      r.w = clamp(x1 - x0, MIN_CROP, 1 - x0);
      r.h = clamp(y1 - y0, MIN_CROP, 1 - y0);
    } else {
      let x0 = r.x;
      let y0 = r.y;
      let x1 = r.x + r.w;
      let y1 = r.y + r.h;
      if (this._regionGrab.indexOf('l') > -1) x0 = clamp(s.rect.x + dx, 0, x1 - MIN_CROP);
      if (this._regionGrab.indexOf('r') > -1)
        x1 = clamp(s.rect.x + s.rect.w + dx, x0 + MIN_CROP, 1);
      if (this._regionGrab.indexOf('t') > -1) y0 = clamp(s.rect.y + dy, 0, y1 - MIN_CROP);
      if (this._regionGrab.indexOf('b') > -1)
        y1 = clamp(s.rect.y + s.rect.h + dy, y0 + MIN_CROP, 1);
      r.x = x0;
      r.y = y0;
      r.w = x1 - x0;
      r.h = y1 - y0;
    }

    this.setData({ region: r }, () => this.redraw());
  },

  onRegionEnd() {
    // 新画框几乎没拖动（单击误触）：还原原框，避免留下极小框
    if (this._regionGrab === 'new' && this._regionStart) {
      const r = this.data.region;
      if (r.w <= MIN_CROP * 1.2 && r.h <= MIN_CROP * 1.2) {
        this.setData({ region: this._regionStart.rect }, () => this.redraw());
      }
    }
    this._drawing = false;
    this._regionGrab = '';
  },

  /* ================= 时间区间 ================= */

  measureTimeline() {
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#timeline')
        .boundingClientRect((r) => resolve(r || null))
        .exec();
    });
  },

  tlPoint(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!t || !this._tlRect) return -1;
    const cx = t.clientX != null ? t.clientX : t.pageX;
    return clamp((cx - this._tlRect.left) / (this._tlRect.width || 1), 0, 1);
  },

  onTlStart(e) {
    if (this.data.submitting) return;
    this.measureTimeline().then((rect) => {
      if (!rect || !rect.width) return;
      this._tlRect = rect;
      const ratio = this.tlPoint(e);
      if (ratio < 0) return;
      const sec = ratio * this.data.duration;
      const ds = Math.abs(sec - this.data.startSec);
      const de = Math.abs(sec - this.data.endSec);
      this._tlGrab = ds <= de ? 'start' : 'end';
      this.applyTime(sec);
    });
  },

  onTlMove(e) {
    if (!this._tlGrab) return;
    const ratio = this.tlPoint(e);
    if (ratio < 0) return;
    this.applyTime(ratio * this.data.duration);
  },

  onTlEnd() {
    this._tlGrab = '';
  },

  applyTime(sec) {
    const d = this.data;
    const total = d.duration || 1;
    let start = d.startSec;
    let end = d.endSec;

    if (this._tlGrab === 'start') {
      start = clamp(Math.round(sec), 0, end - MIN_SPAN);
    } else if (this._tlGrab === 'end') {
      end = clamp(Math.round(sec), start + MIN_SPAN, total);
    } else {
      return;
    }
    if (end <= start) return;

    this.setData(
      {
        startSec: start,
        endSec: end,
        selLeft: (start / total) * 100,
        selWidth: ((end - start) / total) * 100,
        startText: formatDuration(start),
        endText: formatDuration(end),
        spanText: humanDuration(end - start)
      },
      () => this.refreshMid()
    );
  },

  applyFullRange() {
    const d = this.data;
    this.setData(
      {
        startSec: 0,
        endSec: d.duration,
        selLeft: 0,
        selWidth: 100,
        startText: formatDuration(0),
        endText: formatDuration(d.duration),
        spanText: humanDuration(d.duration)
      },
      () => this.refreshMid()
    );
  },

  // 全屏播放当前视频（全屏时无框选，纯查看）
  previewVideo() {
    const src = this.data.src;
    if (!src) return;
    this.pauseVideo();
    try {
      this.vctx().requestFullScreen({ direction: 0 });
    } catch (e) {
      wx.previewMedia({
        sources: [{ url: src, type: 'video' }],
        fail: () => {}
      });
    }
  },

  /* ================= 提交 ================= */

  async submit() {
    if (this.data.submitting) return;
    if (!this.data.videoServiceEnabled) {
      return toast('视频服务暂时不可用，请稍后重试');
    }
    if (this.data.endSec - this.data.startSec < MIN_SPAN) {
      return toast('请选择至少 ' + MIN_SPAN + ' 秒的处理区间');
    }

    this.pauseVideo();
    this.setData({ submitting: true, progress: 0, progressLabel: '上传视频' });

    try {
      // 1) 上传视频到云存储（原视频处理完会随任务一起清理）
      const up = await cloud.upload(this.data.src, 'src/videos', (p) => {
        this.setData({ progress: Math.round(p * 0.6), progressLabel: '上传视频' });
      });

      // 2) 上传缩略图
      let thumbFileID = '';
      if (this.data.thumbSrc) {
        try {
          const t = await cloud.upload(this.data.thumbSrc, 'thumb/videos');
          thumbFileID = t.fileID;
        } catch (e) {
          /* 忽略 */
        }
      }

      // 3) 提交处理任务
      this.setData({ progress: 68, progressLabel: '提交处理任务' });
      const res = await jobApi.submitVideo({
        srcFileID: up.fileID,
        thumbFileID,
        fileName: this.data.fileName,
        duration: this.data.duration,
        width: this._imgW || 0,
        height: this._imgH || 0,
        region: this.data.region,
        timeRange: { start: this.data.startSec, end: this.data.endSec },
        mode: this.data.mode
      });

      this.setData({ progress: 100, progressLabel: '已进入队列' });
      app.bumpJob();

      // 提交完成后直接进入「处理记录」，用户可在列表里看到排队/处理进度
      app.globalData.pending = { jobId: res.jobId, fileName: this.data.fileName };
      setTimeout(() => {
        wx.switchTab({ url: '/pages/records/index' });
        // 配额刷新放到跳转之后，避免与列表页首次查询抢登录态
        app.refresh().catch(() => {});
      }, 280);
    } catch (e) {
      this.setData({ submitting: false, progress: 0, progressLabel: '' });
      toast(e.message || '提交失败，请重试');
    }
  }
});
