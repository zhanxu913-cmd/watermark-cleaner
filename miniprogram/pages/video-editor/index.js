const app = getApp();
const image = require('../../utils/image');
const localdb = require('../../utils/localdb');
const localVideo = require('../../utils/local-video');
const videoRemote = require('../../services/video-remote');
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

    // 区域（默认右下角，水印高发区）；最多 4 个，一次处理全部
    regions: [{ x: 0.6, y: 0.8, w: 0.34, h: 0.12 }],
    selIdx: 0,
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
    cancelling: false,
    progress: 0,
    progressLabel: '',
    videoServiceEnabled: true,

    // 电脑（开发者工具）测试：电脑视频服务的连接状态 '' | 'checking' | 'ok' | 'down'
    simService: ''
  },

  onLoad() {
    const pending = app.globalData.pending || {};
    if (!pending.path || pending.type !== 'video') {
      toast('未选择视频');
      setTimeout(() => wx.navigateBack(), 600);
      return;
    }

    this._drawing = false;
    this._selGrab = '';
    this._tlGrab = '';
    this._imgW = pending.width || 0;
    this._imgH = pending.height || 0;

    const duration = Math.max(1, Math.round(pending.duration || 0));
    const simulator = localVideo.isSimulator();
    const supported = localVideo.isSupported();

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
      modeOptions: [],
      // 模拟器 / 机型不支持时提交按钮给出明确指引
      videoServiceEnabled: !simulator ? supported : true,
      simulator
    });

  },

  onReady() {
    this.prepare();
    // 电脑测试模式下自动探测一次电脑视频服务，界面上给出明确状态
    if (this.data.simulator) this.checkSimService();
  },

  /** 电脑测试：探测 video-service-lite 是否就绪（点状态条可手动重试） */
  async checkSimService() {
    if (!this.data.simulator) return;
    this.setData({ simService: 'checking' });
    const up = await videoRemote.serviceAvailable();
    this.setData({ simService: up ? 'ok' : 'down' });
  },

  onUnload() {
    this._cancelled = true; // 页面销毁：让处理循环尽快退出并释放解码器/录制器
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

    d.regions.forEach((r, idx) => {
      const sel = idx === d.selIdx;
      const x = d.offX + r.x * d.dispW;
      const y = d.offY + r.y * d.dispH;
      const w = r.w * d.dispW;
      const h = r.h * d.dispH;

      ctx.save();
      ctx.fillStyle = sel ? 'rgba(15,110,86,0.30)' : 'rgba(15,110,86,0.16)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = sel ? '#0F6E56' : 'rgba(15,110,86,0.55)';
      ctx.lineWidth = sel ? 2.5 : 1.5;
      ctx.strokeRect(x, y, w, h);
      ctx.restore();

      // 只有选中的框画角点手柄
      if (sel) {
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
      }
    });
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

  /** 多区域命中测试：选中框优先，其余按后画在上层（从数组尾向前） */
  hitRegion(cx, cy) {
    const d = this.data;
    if (!d.hasRegion) return { idx: -1, grab: '' };
    const order = [];
    for (let i = d.regions.length - 1; i >= 0; i--) if (i !== d.selIdx) order.push(i);
    if (d.selIdx >= 0 && d.selIdx < d.regions.length) order.unshift(d.selIdx);

    for (let k = 0; k < order.length; k++) {
      const idx = order[k];
      const r = d.regions[idx];
      const x = d.offX + r.x * d.dispW;
      const y = d.offY + r.y * d.dispH;
      const w = r.w * d.dispW;
      const h = r.h * d.dispH;
      const corners = [
        ['tl', x, y],
        ['tr', x + w, y],
        ['bl', x, y + h],
        ['br', x + w, y + h]
      ];
      for (let i = 0; i < corners.length; i++) {
        if (Math.abs(cx - corners[i][1]) < HANDLE_HIT && Math.abs(cy - corners[i][2]) < HANDLE_HIT) {
          return { idx, grab: corners[i][0] };
        }
      }
      if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) return { idx, grab: 'move' };
    }
    return { idx: -1, grab: '' };
  },

  onRegionStart(e) {
    if (this.data.submitting || !this.data.layoutReady) return;
    const local = this.localPoint(e);
    if (!local) return;
    const pt = this.toNorm(local);
    const hit = this.hitRegion(local.x, local.y);

    if (hit.idx >= 0) {
      // 命中已有框：选中并调整
      this._selGrab = hit.grab;
      this._regionStart = { x: pt.x, y: pt.y, rect: Object.assign({}, this.data.regions[hit.idx]) };
      if (hit.idx !== this.data.selIdx) {
        this.setData({ selIdx: hit.idx }, () => this.redraw());
      }
    } else {
      // 空白处按住拖动 = 画一个新框（最多 4 个）
      if (this.data.regions.length >= 4) {
        toast('最多支持 4 个水印框，可拖动或删框后重画');
        return;
      }
      this._selGrab = 'new';
      this._regionStart = { x: pt.x, y: pt.y, rect: { x: pt.x, y: pt.y, w: MIN_CROP, h: MIN_CROP } };
      const regions = this.data.regions.concat([{ x: pt.x, y: pt.y, w: MIN_CROP, h: MIN_CROP }]);
      this.setData({ hasRegion: true, selIdx: regions.length - 1, regions }, () => this.redraw());
    }
    this._drawing = true;
  },

  onRegionMove(e) {
    if (!this._drawing || !this._selGrab) return;
    const d = this.data;
    if (d.selIdx < 0 || d.selIdx >= d.regions.length) return;
    const local = this.localPoint(e);
    if (!local) return;
    const pt = this.toNorm(local);
    const s = this._regionStart;
    if (!s) return;

    const dx = pt.x - s.x;
    const dy = pt.y - s.y;
    const r = Object.assign({}, s.rect);

    if (this._selGrab === 'move') {
      r.x = clamp(s.rect.x + dx, 0, 1 - r.w);
      r.y = clamp(s.rect.y + dy, 0, 1 - r.h);
    } else if (this._selGrab === 'new') {
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
      if (this._selGrab.indexOf('l') > -1) x0 = clamp(s.rect.x + dx, 0, x1 - MIN_CROP);
      if (this._selGrab.indexOf('r') > -1)
        x1 = clamp(s.rect.x + s.rect.w + dx, x0 + MIN_CROP, 1);
      if (this._selGrab.indexOf('t') > -1) y0 = clamp(s.rect.y + dy, 0, y1 - MIN_CROP);
      if (this._selGrab.indexOf('b') > -1)
        y1 = clamp(s.rect.y + s.rect.h + dy, y0 + MIN_CROP, 1);
      r.x = x0;
      r.y = y0;
      r.w = x1 - x0;
      r.h = y1 - y0;
    }

    const regions = d.regions.slice();
    regions[d.selIdx] = r;
    this.setData({ regions }, () => this.redraw());
  },

  onRegionEnd() {
    // 新画框几乎没拖动（单击误触）：删掉这个新框，避免留下极小框
    if (this._selGrab === 'new') {
      const d = this.data;
      const r = d.regions[d.selIdx];
      if (r && r.w <= MIN_CROP * 1.2 && r.h <= MIN_CROP * 1.2) {
        const regions = d.regions.slice();
        regions.splice(d.selIdx, 1);
        this.setData(
          {
            regions,
            selIdx: regions.length ? Math.max(0, d.selIdx - 1) : -1,
            hasRegion: regions.length > 0
          },
          () => this.redraw()
        );
      }
    }
    this._drawing = false;
    this._selGrab = '';
  },

  /** 删除选中的水印框 */
  deleteSelected() {
    const d = this.data;
    if (!d.regions.length) return toast('还没有框选水印');
    const idx = d.selIdx >= 0 && d.selIdx < d.regions.length ? d.selIdx : d.regions.length - 1;
    const regions = d.regions.slice();
    regions.splice(idx, 1);
    this.setData(
      {
        regions,
        selIdx: regions.length ? Math.min(idx, regions.length - 1) : -1,
        hasRegion: regions.length > 0
      },
      () => this.redraw()
    );
    toast(regions.length ? '已删除，剩 ' + regions.length + ' 个框' : '已清空全部框');
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

  /* ================= 提交（全离线处理） ================= */

  async submit() {
    if (this.data.submitting) return;
    if (!localVideo.isSupported() && !this.data.simulator) {
      return toast('这台手机的微信版本较低，请升级微信后重试');
    }
    if (this.data.endSec - this.data.startSec < MIN_SPAN) {
      return toast('请选择至少 ' + MIN_SPAN + ' 秒的处理区间');
    }

    // 模拟器：提交前先探测电脑服务，未启动则不创建记录、直接给指引
    if (this.data.simulator) {
      const up = await videoRemote.serviceAvailable();
      this.setData({ simService: up ? 'ok' : 'down' });
      if (!up) {
        return wx.showModal({
          title: '电脑视频服务未启动',
          content:
            '电脑测试模式需要本机的视频服务。请双击项目根目录的 start-video-service.bat（或在该目录执行 npm start），看到 3100 端口启动后回到这里，点状态条重试即可。',
          showCancel: false,
          confirmColor: '#185FA5'
        });
      }
    }

    this.pauseVideo();
    this._cancelled = false;

    // 视频处理不消耗额度；额度在结果页「下载/保存」时校验
    this.setData({ submitting: true, cancelling: false, progress: 2, progressLabel: '准备处理' });

    // 缩略图先落地到本机：记录列表靠它显示封面
    let thumbFileID = '';
    if (this.data.thumbSrc) {
      try {
        thumbFileID = localdb.persistFile(this.data.thumbSrc, 'thumb');
      } catch (e) {
        /* 忽略 */
      }
    }

    // 产品定位「只去水印，不改音频」：固定全片处理，音轨始终保留
    const FULL_RANGE = { start: 0, end: this.data.duration };

    // 先写一条 pending 记录：处理期间退出小程序，记录页也能看到这条任务
    let rec = null;
    try {
      rec = await jobApi.create({
        type: 'video',
        status: 'pending',
        progress: 0,
        fileName: this.data.fileName,
        duration: this.data.duration,
        width: this._imgW || 0,
        height: this._imgH || 0,
        mode: this.data.mode,
        region: this.data.regions[0] || null,
        regions: this.data.regions,
        timeRange: FULL_RANGE,
        thumbFileID
      });
    } catch (e) {
      this.setData({ submitting: false, progress: 0, progressLabel: '' });
      return toast('写入记录失败，请检查本机存储空间');
    }

    try {
      // 双链路：模拟器 → 电脑 video-service-lite；真机 → 全离线处理
      const runner = this.data.simulator ? videoRemote.processVideoRemote : localVideo.processVideo;
      const result = await runner({
        src: this.data.src,
        mode: this.data.mode,
        region: this.data.regions[0] || null,
        regions: this.data.regions,
        timeRange: FULL_RANGE,
        duration: this.data.duration,
        fileName: this.data.fileName,
        shouldCancel: () => this._cancelled === true,
        onProgress: (pct, label) => {
          this.setData({ progress: Math.min(96, pct), progressLabel: label || '处理中' });
        }
      });

      // 成品落盘到持久目录（tempFilePath 重启即失效）
      this.setData({ progress: 97, progressLabel: '保存到本机' });
      const outPath = localdb.persistFile(result.tempFilePath, 'output', 'mp4');
      if (!outPath) throw new Error('保存成品失败，请检查本机存储空间');

      await jobApi.update(rec.id, {
        status: 'done',
        progress: 100,
        outFileID: outPath,
        width: result.width,
        height: result.height,
        duration: result.duration || this.data.duration,
        // 记录成品是否带声音，结果页据此提示「原视频本身无音轨」
        hasAudio: result.hasAudio !== false
      });
      app.bumpJob();

      this.setData({ progress: 100, progressLabel: '完成' });

      app.globalData.pending = { jobId: rec.id, fileName: this.data.fileName };
      setTimeout(() => {
        wx.switchTab({ url: '/pages/records/index' });
      }, 320);
    } catch (e) {
      const cancelled = e && e.code === 'CANCELLED';
      // 失败也要落状态，避免记录页永远停在「处理中」
      jobApi
        .update(rec.id, {
          status: 'failed',
          error: cancelled ? '已取消处理' : (e && e.message) || '处理失败'
        })
        .catch(() => {});
      app.bumpJob();
      this.setData({ submitting: false, cancelling: false, progress: 0, progressLabel: '' });
      if (cancelled) toast('已取消处理');
      else toast((e && e.message) || '处理失败，请重试');
    }
  },

  /** 取消正在进行的处理：置旗标，处理循环在下一帧检查后自行退出并清理 */
  cancelProcess() {
    if (!this.data.submitting || this.data.cancelling) return;
    if (this.data.simulator) {
      return toast('电脑端任务已提交，无法中途取消');
    }
    this._cancelled = true;
    this.setData({ cancelling: true, progressLabel: '正在取消…' });
  }
});
