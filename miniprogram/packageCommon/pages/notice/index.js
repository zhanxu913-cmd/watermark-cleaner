const app = getApp();
const userApi = require('../../services/user');

Page({
  data: {
    loading: true,
    notice: '',
    hasNotice: false,
    maintenance: ''
  },

  onLoad() {
    this.load();
  },

  load() {
    const settings = app.globalData.settings;
    if (settings) {
      this.apply(settings);
      return;
    }
    // 冷启动时设置可能还没到达，主动拉一次
    userApi
      .signIn()
      .then((d) => this.apply((d && d.settings) || {}))
      .catch(() => {
        this.setData({ loading: false });
      });
  },

  apply(settings) {
    const notice = settings.globalNotice || '';
    const maintenance = settings.maintenanceNotice || '';
    this.setData({
      loading: false,
      notice,
      maintenance,
      hasNotice: !!(notice || maintenance)
    });
  },

  copy() {
    if (!this.data.notice) return;
    wx.setClipboardData({
      data: this.data.notice,
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    });
  }
});
