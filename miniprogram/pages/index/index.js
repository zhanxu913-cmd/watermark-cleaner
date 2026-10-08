const app = getApp();
const jobApi = require('../../services/job');
const cloud = require('../../utils/cloud');
const { toast } = require('../../utils/util');

const IMAGE_MAX_SIZE = 20 * 1024 * 1024;

Page({
  data: {
    ready: false,
    bootError: '',
    user: null,
    isAdmin: false,
    settings: {},
    copyrightTip: '',
    recent: [],
    recentLoading: true,
    videoServiceEnabled: true,
    videoHint: '',
    videoServiceMsg: '',
    quotaText: ''
  },

  onLoad() {
    this._unsub = app.subscribe(() => this.syncGlobal());
    this._jobVersion = -1;
    this.syncGlobal();
    this.bootstrap();
  },

  onUnload() {
    if (this._unsub) this._unsub();
  },

  onShow() {
    this.syncGlobal();
    if (this.data.ready && this._jobVersion !== app.globalData.version.job) {
      this.loadRecent();
    }
    this.consumeAutoPick();
    this.checkVideoService();
  },

  /**
   * 探测视频服务真实可用性。
   * 只看后台开关不够：开关开了但服务器没装 FFmpeg 一样用不了；
   * 反之接口偶发失败也不该把功能判死。以服务端 available 为准，失败时保持开启。
   */
  checkVideoService() {
    jobApi
      .videoService()
      .then((res) => {
        if (!res) return;
        const available = !!res.available;
        this.setData({
          videoServiceEnabled: available,
          videoHint: available ? '框选区域 + 时间区间' : res.message || '服务暂不可用',
          videoServiceMsg: res.message || ''
        });
      })
      .catch(() => {
        // 探测失败不降级：配置已永久开启，避免误判为未启用
        this.setData({ videoServiceEnabled: true });
      });
  },

  /** 从结果页「再处理一个」回来时，自动唤起选择器 */
  consumeAutoPick() {
    const pending = app.globalData.pending || {};
    const auto = pending.autoPick;
    if (!auto) return;
    app.globalData.pending = {};
    setTimeout(() => {
      if (auto === 'video') this.goVideo();
      else this.goImage();
    }, 320);
  },

  onPullDownRefresh() {
    Promise.all([
      app.refresh().catch(() => {}),
      this.loadRecent().catch(() => {})
    ]).then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    return {
      title: '水印清理 · 本地处理，不上传原图',
      path: '/pages/index/index'
    };
  },

  /* ---------------- 全局状态同步 ---------------- */

  syncGlobal() {
    const s = app.globalData.settings || {};
    const u = app.globalData.user;

    let quotaText = '';
    if (u) {
      const img = typeof u.remainImage === 'number' ? u.remainImage : '-';
      const vid = typeof u.remainVideo === 'number' ? u.remainVideo : '-';
      quotaText = '今日剩余 图片 ' + img + ' 次 · 视频 ' + vid + ' 次';
    }

    // 视频入口不再单看后台开关（由 checkVideoService 以服务端探测结果为准）
    this.setData({
      user: u,
      isAdmin: !!app.globalData.isAdmin,
      bootError: app.globalData.bootError || '',
      settings: s,
      copyrightTip:
        s.copyrightTip || '请仅处理你拥有版权的素材。去除他人作品水印可能构成侵权。',
      videoServiceEnabled: true,
      videoHint: '框选区域 + 时间区间',
      quotaText
    });
  },

  bootstrap() {
    app
      .ready()
      .then(() => {
        this.setData({ ready: true });
        return this.loadRecent();
      })
      .catch(() => {
        this.setData({ ready: true, recentLoading: false });
      });
  },

  /* ---------------- 最近处理 ---------------- */

  loadRecent() {
    this.setData({ recentLoading: true });
    return jobApi
      .list({ page: 1, pageSize: 6 })
      .then((res) => {
        const list = (res && res.list) || [];
        return this.decorate(list);
      })
      .then((list) => {
        this.setData({ recent: list, recentLoading: false });
        this._jobVersion = app.globalData.version.job;
      })
      .catch(() => {
        this.setData({ recentLoading: false });
      });
  },

  /** 批量换取缩略图临时链接 */
  decorate(list) {
    const ids = list.map((j) => j.thumbFileID).filter(Boolean);
    if (!ids.length) return Promise.resolve(list);
    return cloud.tempUrls(ids).then((map) =>
      list.map((j) =>
        Object.assign({}, j, { thumbUrl: map[j.thumbFileID] || '' })
      )
    );
  },

  /* ---------------- 入口 ---------------- */

  guard() {
    if (!cloud.isConfigured()) {
      toast(app.globalData.bootError || '后端地址未配置，请检查 constants.js');
      return false;
    }
    if (app.globalData.user && app.globalData.user.status === 'banned') {
      wx.showModal({
        title: '账号已被限制',
        content:
          (app.globalData.user.banReason || '你的账号当前无法使用本功能') +
          '，如有疑问请联系管理员。',
        showCancel: false,
        confirmColor: '#185FA5'
      });
      return false;
    }
    return true;
  },

  goImage() {
    if (!this.guard()) return;

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        if (f.size && f.size > IMAGE_MAX_SIZE) {
          return toast('图片超过 20MB，请压缩后再试');
        }
        app.globalData.pending = {
          type: 'image',
          path: f.tempFilePath,
          size: f.size || 0,
          width: f.width || 0,
          height: f.height || 0,
          fileName: pickName(f.tempFilePath)
        };
        wx.navigateTo({ url: '/pages/image-editor/index' });
      },
      fail: () => {}
    });
  },

  goVideo() {
    if (!this.guard()) return;

    if (!this.data.videoServiceEnabled) {
      wx.showModal({
        title: '视频服务未启用',
        content:
          '视频去水印需要云端 FFmpeg 服务。请先部署 video-service 并在管理后台开启开关，或先使用图片去水印。',
        showCancel: false,
        confirmColor: '#185FA5'
      });
      return;
    }

    const maxDur = this.data.settings.maxVideoDuration || 60;
    const maxMB = this.data.settings.maxVideoSizeMB || 100;

    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      maxDuration: maxDur,
      camera: 'back',
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        if (f.size && f.size > maxMB * 1024 * 1024) {
          return toast('视频超过 ' + maxMB + 'MB，请压缩后再试');
        }
        if (f.duration && f.duration > maxDur) {
          return toast('视频超过 ' + maxDur + ' 秒，请先裁剪');
        }
        app.globalData.pending = {
          type: 'video',
          path: f.tempFilePath,
          size: f.size || 0,
          width: f.width || 0,
          height: f.height || 0,
          duration: Math.round(f.duration || 0),
          thumbPath: f.thumbTempFilePath || '',
          fileName: pickName(f.tempFilePath)
        };
        wx.navigateTo({ url: '/pages/video-editor/index' });
      },
      fail: () => {}
    });
  },

  /* ---------------- 交互 ---------------- */

  openRecent(e) {
    const index = e.currentTarget.dataset.index;
    const job = this.data.recent[index];
    if (!job) return;
    app.globalData.pending = { jobId: job.id };
    wx.navigateTo({ url: '/pages/result/index' });
  },

  goRecords() {
    wx.switchTab({ url: '/pages/records/index' });
  },

  goAbout() {
    wx.navigateTo({ url: '/packageCommon/pages/about/index' });
  },

  goAdmin() {
    wx.navigateTo({ url: '/packageAdmin/pages/dashboard/index' });
  },

  retryBoot() {
    app.globalData.bootError = '';
    app.checkApi();
    if (cloud.isConfigured()) {
      app.refresh().then(() => {
        this.setData({ ready: true });
        this.loadRecent();
      });
    } else {
      this.syncGlobal();
    }
  }
});

/** 从临时路径里取一个像样的文件名 */
function pickName(p) {
  const s = String(p || '');
  const seg = s.split('/').pop() || s.split('\\').pop() || '素材';
  const clean = seg.split('?')[0];
  if (/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(clean)) return clean;
  return '素材_' + Date.now().toString().slice(-6) + '.jpg';
}
