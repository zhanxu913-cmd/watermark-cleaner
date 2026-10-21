const app = getApp();
const jobApi = require('../../services/job');
const localdb = require('../../utils/localdb');
const { VIDEO_LIMITS } = require('../../utils/constants');
const { toast } = require('../../utils/util');

const IMAGE_MAX_SIZE = 20 * 1024 * 1024;

Page({
  data: {
    copyrightTip: '请仅处理你拥有版权的素材。去除他人作品水印可能构成侵权。',
    recent: [],
    recentLoading: true,
    videoServiceEnabled: true,
    videoHint: '框选区域 + 时间区间',
    storageText: ''
  },

  onLoad() {
    this._jobVersion = -1;
    this.bootstrap();
  },

  onShow() {
    if (this._jobVersion !== app.globalData.version.job) this.loadRecent();
    this.consumeAutoPick();
    this.checkVideoService();
  },

  /**
   * 探测视频服务可用性。
   * 地址没配时不再判死整个页面 —— 图片线完全不依赖服务，照常可用。
   */
  checkVideoService() {
    jobApi
      .videoService()
      .then((res) => {
        if (!res) return;
        const available = !!res.available;
        this.setData({
          videoServiceEnabled: available,
          videoHint: available ? '框选区域 + 时间区间' : res.message || '服务暂不可用'
        });
      })
      .catch(() => {
        this.setData({ videoServiceEnabled: false, videoHint: '视频服务暂不可用' });
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
    this.loadRecent().then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    return {
      title: '水印清理 · 图片本地处理，不上传',
      path: '/pages/index/index'
    };
  },

  bootstrap() {
    // 清掉记录里已不存在的孤儿文件，避免占用本地空间
    try {
      localdb.gc();
    } catch (e) {
      /* 清理失败不影响使用 */
    }
    this.loadRecent();
  },

  /* ---------------- 最近处理 ---------------- */

  loadRecent() {
    this.setData({ recentLoading: true });
    return jobApi
      .list({ page: 1, pageSize: 6 })
      .then((res) => {
        const list = (res && res.list) || [];
        this.setData({ recent: this.decorate(list), recentLoading: false });
        this._jobVersion = app.globalData.version.job;
        this.refreshStorage();
      })
      .catch(() => {
        this.setData({ recentLoading: false });
      });
  },

  /** 本地路径可直接给 <image> 用，无需换取临时链接 */
  decorate(list) {
    return list.map((j) =>
      Object.assign({}, j, { thumbUrl: j.thumbFileID || j.outFileID || '' })
    );
  },

  refreshStorage() {
    try {
      const s = localdb.stats();
      this.setData({ storageText: '记录保存在本机 · 已占 ' + s.bytesText });
    } catch (e) {
      /* 统计失败不影响主流程 */
    }
  },

  /* ---------------- 入口 ---------------- */

  goImage() {
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
    if (!this.data.videoServiceEnabled) {
      wx.showModal({
        title: '视频服务未配置',
        content:
          '图片去水印完全在本机处理，不受影响；视频去水印需要一台跑 FFmpeg 的机器。请在 utils/constants.js 填写 VIDEO_API_BASE_URL 后重试。',
        showCancel: false,
        confirmColor: '#185FA5'
      });
      return;
    }

    const maxDur = VIDEO_LIMITS.maxDuration;
    const maxMB = VIDEO_LIMITS.maxSizeMB;

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
  }
});

/** 从临时路径里取一个像样的文件名 */
function pickName(p) {
  const s = String(p || '');
  const seg = s.split('/').pop() || s.split('\\').pop() || '素材';
  const clean = seg.split('?')[0];
  if (/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(clean)) return clean;
  const ext = /\.([a-zA-Z0-9]{2,5})$/.exec(clean);
  return '素材_' + Date.now().toString().slice(-6) + '.' + (ext ? ext[1] : 'jpg');
}
