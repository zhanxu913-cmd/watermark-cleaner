const app = getApp();
const jobApi = require('../../services/job');
const cloud = require('../../utils/cloud');
const { MODE_LABEL, JOB_STATUS_LABEL } = require('../../utils/constants');
const { toast, formatSize, formatTime, ensureAlbumAuth, confirm, downloadFile, defaultFileName, renameLocalFile, extLabel, guessExt } = require('../../utils/util');

const POLL_INTERVAL = 3000;

Page({
  data: {
    loading: true,
    error: '',
    isVideo: false,
    srcUrl: '',
    outUrl: '',
    fileName: '',
    modeLabel: '',
    sizeText: '—',
    dimText: '—',
    timeText: '',
    status: 'done',
    statusLabel: '已完成',
    job: null,
    saving: false,
    canSave: false,
    downloading: false,
    progressText: '',
    progressPctDisp: 0,
    savedPath: '',
    savedName: '',
    formatLabel: '',
    saveName: '',

    /* 状态横幅 */
    bannerType: '',
    bannerTitle: '',
    bannerDesc: '',
    processing: false,
    progressText: '',
    progressPct: 0,
    pageTitle: '处理完成',

    /* ---- 视频播放相关 ---- */
    vMode: 'single',      // single | compare
    hasSource: false,     // 是否有可用的原视频
    vError: '',
    srcError: '',
    loop: false,
    muted: false,
    syncing: false,
    curTimeText: '00:00',
    durTimeText: '00:00'
  },

  onLoad() {
    this._timer = null;
    this._syncTimer = null;
    this._lastProgress = -1;
    this.load();
  },

  onUnload() {
    this.stopPoll();
    this.stopEase();
    this.stopSync();
    this._outCtx = null;
    this._out2Ctx = null;
    this._srcCtx = null;
  },

  onHide() {
    this.stopPoll();
    this.stopSync();
    this.pauseAll();
  },

  onShow() {
    // 从后台切回来时，若任务仍在处理，恢复轮询
    if (this.data.processing && this.data.job) this.startPoll();
  },

  onShareAppMessage() {
    return {
      title: '水印清理 · 本地处理，原图不上传',
      path: '/pages/index/index'
    };
  },

  /* ================= 加载 ================= */

  load() {
    const pending = app.globalData.pending || {};

    // 场景一：刚从图片编辑页处理完，用本地结果直接展示
    if (pending.localResult) {
      this.setData({
        loading: false,
        isVideo: false,
        srcUrl: pending.localSource || '',
        outUrl: pending.localResult,
        fileName: pending.fileName || '处理结果',
        modeLabel: MODE_LABEL[pending.mode] || '',
        dimText:
          pending.width && pending.height ? pending.width + ' × ' + pending.height : '—',
        timeText: formatTime(Date.now()),
        status: 'done',
        statusLabel: '已完成',
        canSave: true,
        pageTitle: '处理完成'
      });
      return;
    }

    // 场景二：从记录页进入，或视频任务提交后进入
    if (pending.jobId) {
      this.jobId = pending.jobId;
      // 视频：本地原视频路径（用于前后对比）
      this._localSource = pending.localSource || '';
      this.loadJob();
      return;
    }

    this.setData({ loading: false, error: '没有可展示的结果' });
  },

  loadJob() {
    jobApi
      .detail(this.jobId)
      .then((job) => this.decorate(job))
      .then((job) => {
        const isVideo = job.type === 'video';
        const status = job.status || 'done';
        const isProcessing = status === 'pending' || status === 'processing';

        // 原视频来源：优先本地临时路径（无需网络），退回云端地址
        const localSource = this._localSource || '';
        const remoteSource = job.srcUrl || '';
        const videoSource = localSource || remoteSource;

        const next = {
          loading: false,
          job,
          isVideo,
          fileName: job.fileName || '处理结果',
          modeLabel: MODE_LABEL[job.mode] || '',
          sizeText: job.outSize ? formatSize(job.outSize) : job.size ? formatSize(job.size) : '—',
          dimText: job.width && job.height ? job.width + ' × ' + job.height : '—',
          timeText: formatTime(job.createdAt),
          status,
          statusLabel: JOB_STATUS_LABEL[status] || '',
          outUrl: job.outUrl || '',
          error: status === 'failed' ? job.error || '处理失败' : '',
          canSave: status === 'done' && !!job.outUrl,
          processing: isProcessing,
          progressText: job.progressText || '',
          progressPct: Math.max(0, Math.min(100, Number(job.progress) || 0)),
          // 进度条显示值同步初始化，避免进页面后 3s 内停在 0%
          progressPctDisp: Math.max(0, Math.min(100, Number(job.progress) || 0)),
          pageTitle: isProcessing ? '处理中' : status === 'failed' ? '处理失败' : '处理完成'
        };

        // 下载时自动生成的默认文件名（时间 + 类型）与格式，提前展示给用户
        next.formatLabel = extLabel(guessExt(job.outUrl || job.outFileID, job.fileName, isVideo ? 'video' : 'image'));
        next.saveName = defaultFileName(isVideo ? 'video' : 'image', job.outUrl || job.outFileID, job.fileName);

        if (isVideo) {
          const hasSource = !!videoSource;
          next.srcUrl = videoSource;
          next.hasSource = hasSource;
          // 有原视频 + 有结果 → 默认进对比模式
          next.vMode = hasSource && job.outUrl ? 'compare' : 'single';
        } else {
          // 图片：沿用缩略图作为「处理前」
          next.srcUrl = job.thumbUrl || '';
          next.hasSource = !!job.thumbUrl;
        }

        // ---- 状态横幅 ----
        const b = this.buildBanner(status, job);
        next.bannerType = b.type;
        next.bannerTitle = b.title;
        next.bannerDesc = b.desc;

        this.setData(next);
        this._curJobId = job.id || this.jobId;

        if (isVideo && isProcessing) this.startPoll();
        else this.stopPoll();
      })
      .catch((e) => {
        this.setData({ loading: false, error: e.message || '加载失败' });
      });
  },

  /** 状态横幅文案：处理中 / 成功 / 失败 */
  buildBanner(status, job) {
    if (status === 'pending') {
      return { type: 'wait', title: '排队处理中', desc: '任务已提交，正在等待处理资源' };
    }
    if (status === 'processing') {
      return { type: 'wait', title: '正在处理视频', desc: '处理完成后可下载或保存到相册' };
    }
    if (status === 'failed') {
      return {
        type: 'fail',
        title: '处理失败',
        desc: job.error || '未能生成结果，可点下方「重新处理」再试一次'
      };
    }
    // done
    const saved = !!job.saved;
    return {
      type: 'ok',
      title: '处理完成',
      desc: saved ? '已保存过到相册，可再次下载' : '可下载文件，或直接保存到相册'
    };
  },

  /** 把 cloud fileID 换成可访问的临时链接 */
  decorate(job) {
    const ids = [job.outFileID, job.thumbFileID, job.srcFileID].filter(Boolean);
    if (!ids.length) return Promise.resolve(job);
    return cloud.tempUrls(ids).then((map) =>
      Object.assign({}, job, {
        outUrl: map[job.outFileID] || '',
        thumbUrl: map[job.thumbFileID] || '',
        srcUrl: map[job.srcFileID] || ''
      })
    );
  },

  /* ================= 视频任务轮询 ================= */

  startPoll() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      jobApi
        .videoStatus(this.jobId)
        .then((res) => {
          if (!res) return;
          const status = res.status;
          const done = status === 'done' || status === 'failed';
          const pct = Math.max(0, Math.min(100, Number(res.progress) || 0));
          const isProcessing = !done && (status === 'pending' || status === 'processing');
          this.setData({
            status,
            statusLabel: JOB_STATUS_LABEL[status] || '',
            progressText: res.progressText || '',
            progressPct: pct,
            processing: isProcessing,
            pageTitle: done ? (status === 'failed' ? '处理失败' : '处理完成') : '处理中'
          });
          // 进度条平滑推进（产物就绪后直接推到 100）
          this.easeProgress(done && status === 'done' ? 100 : pct);
          if (done) {
            this.stopPoll();
            // 明确的成败提示：先把进度条推到终点，再提示结果
            this.easeProgress(status === 'failed' ? pct : 100, () => {
              if (status === 'done') toast('处理完成，可以下载了', 'success');
              else toast(res.error || '处理失败，请重试');
            });
            // 结果就绪后再刷新一次详情
            setTimeout(() => this.loadJob(), 260);
          }
        })
        .catch(() => {
          /* 单次轮询失败忽略，下一轮继续 */
        });
    }, POLL_INTERVAL);
  },

  stopPoll() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  /**
   * 进度条平滑推进。
   * 后端每 3s 才回一次进度，直接 setData 会让进度条一格一格地跳；
   * 这里在两次轮询之间按固定步长补齐，done 时推到 100 再回调。
   */
  easeProgress(target, doneCb) {
    const from = Number(this.data.progressPctDisp) || 0;
    const to = Math.max(0, Math.min(100, Number(target) || 0));
    if (to <= from) {
      if (typeof doneCb === 'function') doneCb();
      return;
    }
    const step = Math.max(1, Math.ceil((to - from) / 12));
    clearInterval(this._easeTimer);
    this._easeTimer = setInterval(() => {
      const cur = Number(this.data.progressPctDisp) || 0;
      const next = Math.min(to, cur + step);
      this.setData({ progressPctDisp: next });
      if (next >= to) {
        clearInterval(this._easeTimer);
        this._easeTimer = null;
        if (typeof doneCb === 'function') doneCb();
      }
    }, 60);
  },

  stopEase() {
    if (this._easeTimer) {
      clearInterval(this._easeTimer);
      this._easeTimer = null;
    }
  },

  /* ================= 视频播放控制 ================= */

  /** 懒加载 video 上下文 */
  ctx(id) {
    if (id === 'vOut') {
      if (!this._outCtx) this._outCtx = wx.createVideoContext('vOut', this);
      return this._outCtx;
    }
    if (id === 'vOut2') {
      if (!this._out2Ctx) this._out2Ctx = wx.createVideoContext('vOut2', this);
      return this._out2Ctx;
    }
    if (id === 'vSrc') {
      if (!this._srcCtx) this._srcCtx = wx.createVideoContext('vSrc', this);
      return this._srcCtx;
    }
    return null;
  },

  switchVMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.vMode) return;
    this.pauseAll();
    this.stopSync();
    this.setData({ vMode: mode, vError: '', srcError: '' });
  },

  onVPlay() {
    this.setData({ vError: '' });
  },

  onVPause() {},

  onVEnded() {
    if (this.data.syncing) this.stopSync();
  },

  onVTime(e) {
    const t = (e.detail && e.detail.currentTime) || 0;
    const d = (e.detail && e.detail.duration) || 0;
    // 节流：变化超过 0.5 秒才更新 UI
    if (Math.abs(t - this._lastProgress) < 0.5) return;
    this._lastProgress = t;
    this.setData({ curTimeText: fmtClock(t), durTimeText: fmtClock(d) });
  },

  onVError(e) {
    const msg = (e.detail && e.detail.errMsg) || '';
    const tip = /timeout|network|fail/i.test(msg)
      ? '视频加载失败，请检查网络'
      : '视频无法播放（格式可能不受支持）';
    this.setData({ vError: tip });
  },

  onSrcError() {
    this.setData({ srcError: true, hasSource: false, vMode: 'single' });
  },

  onSrcPlay() {},

  retryVideo() {
    this.setData({ vError: '' });
    const c = this.ctx(this.data.vMode === 'compare' ? 'vOut2' : 'vOut');
    if (c) {
      c.stop();
      c.play();
    }
  },

  toggleLoop() {
    this.setData({ loop: !this.data.loop });
  },

  toggleMute() {
    const muted = !this.data.muted;
    this.setData({ muted });
    ['vOut', 'vOut2'].forEach((id) => {
      const c = this.ctx(id);
      if (!c) return;
      try {
        if (muted && c.mute) c.mute();
        else if (!muted && c.unmute) c.unmute();
      } catch (e) { /* 忽略 */ }
    });
  },

  /** 同步播放：两个播放器同时从头播放并保持进度对齐 */
  toggleSync() {
    if (this.data.syncing) {
      this.stopSync();
      this.pauseAll();
      return;
    }
    const a = this.ctx('vSrc');
    const b = this.ctx('vOut2');
    if (!a || !b) return;

    try {
      a.seek(0);
      b.seek(0);
      a.play();
      b.play();
    } catch (e) {
      return;
    }
    this.setData({ syncing: true });

    // 每 500ms 校正一次进度，防止两个播放器漂移
    this._syncTimer = setInterval(() => {
      if (!this.data.syncing) return;
      let ta = 0;
      let tb = 0;
      try {
        ta = typeof a.currentTime === 'function' ? a.currentTime() || 0 : 0;
        tb = typeof b.currentTime === 'function' ? b.currentTime() || 0 : 0;
      } catch (e) {
        return;
      }
      if (Math.abs(ta - tb) > 0.3) {
        try { b.seek(ta); } catch (e) { /* 忽略 */ }
      }
    }, 500);
  },

  stopSync() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    if (this.data.syncing) this.setData({ syncing: false });
  },

  replayBoth() {
    const a = this.ctx('vSrc');
    const b = this.ctx('vOut2');
    try {
      if (a) { a.seek(0); a.play(); }
      if (b) { b.seek(0); b.play(); }
    } catch (e) { /* 忽略 */ }
    if (!this.data.syncing) this.setData({ syncing: true });
  },

  pauseAll() {
    ['vOut', 'vOut2', 'vSrc'].forEach((id) => {
      const c = this.ctx(id);
      if (c && c.pause) {
        try { c.pause(); } catch (e) { /* 忽略 */ }
      }
    });
  },

  /* ================= 保存 ================= */

  async save() {
    if (this.data.saving) return;
    if (!this.data.canSave) {
      return toast(this.data.outUrl ? '结果还没准备好，请稍候' : '暂无可保存的结果文件');
    }

    const authed = await ensureAlbumAuth();
    if (!authed) return toast('未获得相册权限，无法保存');

    this.pauseAll();
    this.setData({ saving: true, progressText: '' });
    try {
      const filePath = await this.grabFile();
      const type = this.data.isVideo ? 'video' : 'image';
      const name = defaultFileName(type, this.data.outUrl, this.data.fileName);
      const named = await renameLocalFile(filePath, name);
      this.setData({ savedName: name });
      if (this.data.isVideo) {
        await saveVideo(named);
      } else {
        await saveImage(named);
      }
      toast('已保存 ' + name, 'success');
      if (this.jobId) {
        jobApi.markSaved(this.jobId).catch(() => {});
      }
    } catch (e) {
      toast(e.message || '保存失败，请重试');
    } finally {
      this.setData({ saving: false, progressText: '' });
    }
  },

  /* ================= 下载 ================= */

  // 下载到本地，带进度；返回临时文件路径
  grabFile() {
    return downloadFile(this.data.outUrl, (p) => {
      if (p > 0 && p < 100) this.setData({ progressText: '下载中 ' + p + '%' });
    });
  },

  // 下载并打开系统预览（可另存/分享）
  async download() {
    if (this.data.downloading) return;
    if (!this.data.canSave) {
      return toast(this.data.outUrl ? '结果还没准备好，请稍候' : '暂无可下载的结果文件');
    }
    this.pauseAll();
    // 视频最终要写相册，先拿权限再开始下载，避免白下一场
    if (this.data.isVideo) {
      const authed = await ensureAlbumAuth();
      if (!authed) return toast('未获得相册权限，无法保存视频');
    }
    this.setData({ downloading: true, progressText: '准备下载…' });
    try {
      const filePath = await downloadFile(this.data.outUrl, (p) => {
        this.setData({ progressText: '下载中 ' + p + '%' });
      });
      this.setData({ progressText: '下载完成' });

      const type = this.data.isVideo ? 'video' : 'image';
      // 下载时自动生成默认文件名（时间 + 类型）并落地到本地文件系统
      const name = defaultFileName(type, this.data.outUrl, this.data.fileName);
      const fmt = extLabel(guessExt(this.data.outUrl, this.data.fileName, type));
      const named = await renameLocalFile(filePath, name);
      this.setData({ savedName: name });

      if (type === 'video') {
        // 视频：openDocument 不支持 mp4，直接保存到系统相册（用户可真正拿到文件）
        await saveVideo(named);
        this.setData({ savedPath: named });
        if (this.jobId) jobApi.markSaved(this.jobId).catch(() => {});
        toast('已保存 ' + name + '（' + fmt + '）', 'success');
      } else {
        wx.previewImage({
          urls: [named],
          fail: () => this.openSaved(named, type)
        });
      }
    } catch (e) {
      toast(e.message || '下载失败，请重试');
    } finally {
      this.setData({ downloading: false, progressText: '' });
    }
  },

  openSaved(filePath, type) {
    wx.saveFile({
      tempFilePath: filePath,
      success: (r) => {
        if (this.data.isVideo) saveVideo(r.savedFilePath).catch(() => {});
        else saveImage(r.savedFilePath).catch(() => {});
        this.setData({ savedPath: r.savedFilePath });
        toast('已下载到小程序文件', 'success');
      },
      fail: () => toast('下载完成，可在相册或文件中查看')
    });
  },

  preview() {
    if (!this.data.outUrl) return;
    if (this.data.isVideo) {
      wx.previewMedia({
        sources: [{ url: this.data.outUrl, type: 'video' }],
        fail: () => {}
      });
    } else {
      wx.previewImage({
        urls: [this.data.outUrl],
        fail: () => {}
      });
    }
  },

  /* ================= 其它操作 ================= */

  retry() {
    const id = this._curJobId || this.jobId;
    if (!id) return;
    jobApi
      .retry(id)
      .then(() => {
        toast('已重新提交');
        this.setData({ error: '', processing: true, pageTitle: '处理中' });
        setTimeout(() => this.loadJob(), 1200);
      })
      .catch(() => {});
  },

  async removeJob() {
    const id = this._curJobId || this.jobId;
    if (!id) return;
    const ok = await confirm('删除后无法恢复，确定删除这条记录吗？');
    if (!ok) return;
    jobApi
      .remove([id])
      .then(() => {
        app.bumpJob();
        toast('已删除');
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch(() => {});
  },

  again() {
    const isVideo = this.data.isVideo;
    app.globalData.pending = { autoPick: isVideo ? 'video' : 'image' };
    wx.switchTab({ url: '/pages/index/index' });
  },

  goRecords() {
    app.globalData.pending = {};
    wx.switchTab({ url: '/pages/records/index' });
  }
});

/* ================= 辅助 ================= */

/** 秒 → mm:ss */
function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
}

function saveImage(filePath) {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: resolve,
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        reject(new Error(msg.indexOf('auth') > -1 ? '未获得相册权限' : '保存失败'));
      }
    });
  });
}

function saveVideo(filePath) {
  return new Promise((resolve, reject) => {
    wx.saveVideoToPhotosAlbum({
      filePath,
      success: resolve,
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        reject(new Error(msg.indexOf('auth') > -1 ? '未获得相册权限' : '保存失败'));
      }
    });
  });
}
