const app = getApp();
const jobApi = require('../../services/job');
const { toast, confirm } = require('../../utils/util');

const VERSION = '2.0.0';

Page({
  data: {
    metrics: [],
    recordText: '—',
    version: VERSION,
    cacheText: '—'
  },

  onShow() {
    this.loadStats();
  },

  onShareAppMessage() {
    return { title: '水印清理 · 图片本地处理不上传', path: '/pages/index/index' };
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
