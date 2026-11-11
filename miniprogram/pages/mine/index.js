const app = getApp();
const jobApi = require('../../services/job');
const rewardAd = require('../../services/reward-ad');
const quota = require('../../utils/quota');
const { toast, confirm } = require('../../utils/util');

const VERSION = '2.0.0';

Page({
  data: {
    metrics: [],
    recordText: '—',
    version: VERSION,
    cacheText: '—',
    quotaCount: 0
  },

  onShow() {
    this.loadStats();
    this.setData({ quotaCount: quota.get() });
  },

  /** 点额度行：有额度 → 说明规则；没额度 → 直接走看广告解锁 */
  async onQuotaTap() {
    if (this.data.quotaCount > 0) {
      return toast('图片免费；每下载 1 段视频扣 1 条');
    }
    const ok = await rewardAd.ensureQuota();
    if (ok) this.setData({ quotaCount: quota.get() });
  },

  onShareAppMessage() {
    return { title: '全能AI去水印', path: '/pages/index/index' };
  },

  /* ================= 统计 ================= */

  loadStats() {
    jobApi
      .stats()
      .then((s) => {
        const st = s || {};
        this.setData({
          recordText: (st.total || 0) + ' 条',
          cacheText: st.bytesText || '0 MB',
          metrics: [
            { k: '累计处理', v: String(st.total || 0) },
            { k: '图片 / 视频', v: (st.image || 0) + ' / ' + (st.video || 0) },
            { k: '占用空间', v: st.bytesText || '0 MB' }
          ]
        });
      })
      .catch(() => {
        this.setData({
          metrics: [
            { k: '累计处理', v: '—' },
            { k: '图片 / 视频', v: '—' },
            { k: '占用空间', v: '—' }
          ]
        });
      });
  },

  /* ================= 导航 ================= */

  goRecords() {
    wx.switchTab({ url: '/pages/records/index' });
  },

  goAbout() {
    wx.navigateTo({ url: '/packageCommon/pages/about/index' });
  },

  goPrivacy() {
    wx.navigateTo({ url: '/packageCommon/pages/privacy/index' });
  },

  goNotice() {
    wx.navigateTo({ url: '/packageCommon/pages/notice/index' });
  },

  /* ================= 维护 ================= */

  async clearCache() {
    const ok = await confirm(
      '将清空本机全部处理记录与结果文件（已保存到相册的不受影响），此操作不可恢复，确定吗？'
    );
    if (!ok) return;

    jobApi
      .removeAll()
      .then(() => {
        app.bumpJob();
        this.loadStats();
        toast('已清空', 'success');
      })
      .catch(() => toast('清空失败，请重试'));
  }
});
