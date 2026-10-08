const app = getApp();
const userApi = require('../../services/user');
const jobApi = require('../../services/job');
const cloud = require('../../utils/cloud');
const adminApi = require('../../services/admin');
const { ROLE_LABEL, CACHE } = require('../../utils/constants');
const { toast, confirm, prompt } = require('../../utils/util');

const VERSION = '1.0.0';

Page({
  data: {
    ready: false,
    user: null,
    isAdmin: false,
    adminRole: '',
    adminRoleLabel: '',
    isSuper: false,
    metrics: [],
    quotaText: '',
    recordText: '—',
    version: VERSION,
    cacheText: '—',
    uploading: false
  },

  onLoad() {
    this._unsub = app.subscribe(() => this.sync());
    this._userVersion = -1;
    this.sync();
    this.loadStats();
    this.loadCache();
  },

  onUnload() {
    if (this._unsub) this._unsub();
  },

  onShow() {
    this.sync();
    if (this._userVersion !== app.globalData.version.user) {
      this.loadStats();
      this.loadCache();
    }
  },

  onShareAppMessage() {
    return { title: '水印清理 · 本地处理不上传原图', path: '/pages/index/index' };
  },

  /* ================= 状态 ================= */

  sync() {
    const u = app.globalData.user;
    const role = app.globalData.adminRole || '';

    let quotaText = '正在加载…';
    if (u) {
      if (u.status === 'banned') {
        quotaText = '账号已被限制';
      } else {
        const img = typeof u.remainImage === 'number' ? u.remainImage : '-';
        const vid = typeof u.remainVideo === 'number' ? u.remainVideo : '-';
        quotaText = '今日剩余 图片 ' + img + ' 次 · 视频 ' + vid + ' 次';
      }
    }

    this.setData({
      user: u,
      isAdmin: !!app.globalData.isAdmin,
      adminRole: role,
      adminRoleLabel: ROLE_LABEL[role] || '',
      isSuper: role === 'super',
      quotaText,
      ready: true
    });
  },

  loadStats() {
    jobApi
      .stats()
      .then((s) => {
        const st = s || {};
        this.setData({
          recordText: (st.total || 0) + ' 条',
          metrics: [
            { k: '累计处理', v: String(st.total || 0) },
            { k: '本月', v: String(st.month || 0) },
            { k: '本地数据', v: this.data.cacheText }
          ]
        });
        this._userVersion = app.globalData.version.user;
      })
      .catch(() => {
        this.setData({
          metrics: [
            { k: '累计处理', v: '—' },
            { k: '本月', v: '—' },
            { k: '本地数据', v: this.data.cacheText }
          ]
        });
      });
  },

  loadCache() {
    try {
      const info = wx.getStorageInfoSync();
      const kb = info.currentSize || 0;
      this.setData({
        cacheText: kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'
      });
    } catch (e) {
      this.setData({ cacheText: '0 KB' });
    }
  },

  /* ================= 资料 ================= */

  onChooseAvatar(e) {
    const path = e.detail && e.detail.avatarUrl;
    if (!path) return;
    this.setData({ uploading: true });
    cloud
      .upload(path, 'avatar')
      .then((up) => userApi.updateProfile({ avatarUrl: up.fileID }))
      .then(() => {
        toast('头像已更新', 'success');
        return app.refresh();
      })
      .catch(() => {})
      .then(() => this.setData({ uploading: false }));
  },

  onNickBlur(e) {
    const name = String((e.detail && e.detail.value) || '').trim();
    const current = (this.data.user && this.data.user.nickName) || '';
    if (!name || name === current) return;
    if (name.length > 20) return toast('昵称最多 20 个字');

    userApi
      .updateProfile({ nickName: name })
      .then(() => {
        toast('已保存', 'success');
        return app.refresh();
      })
      .catch(() => {});
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
    const notice = (app.globalData.settings || {}).globalNotice || '';
    wx.navigateTo({
      url: '/packageCommon/pages/notice/index?has=' + (notice ? 1 : 0)
    });
  },

  goAdmin() {
    wx.navigateTo({ url: '/packageAdmin/pages/dashboard/index' });
  },

  /* ================= 维护 ================= */

  async clearCache() {
    const ok = await confirm('将清除本机缓存的数据（不影响云端记录），确定吗？');
    if (!ok) return;

    const key = wx.getStorageSync(CACHE.ADMIN_KEY);
    try {
      wx.clearStorageSync();
      if (key) wx.setStorageSync(CACHE.ADMIN_KEY, key);
    } catch (e) {
      /* 忽略 */
    }
    this.loadCache();
    if (this.data.metrics.length) {
      const m = this.data.metrics.slice();
      m[2] = { k: '本地数据', v: this.data.cacheText };
      this.setData({ metrics: m });
    }
    toast('已清理', 'success');
  },

  async adminQuickLogin() {
    if (this.data.isAdmin) return this.goAdmin();
    const key = await prompt('请输入管理后台访问密钥');
    if (!key) return;

    adminApi
      .login(key)
      .then(() => {
        toast('已进入管理后台', 'success');
        // 刷新全局身份，让「我的」页立刻显示管理员态
        app.refresh().catch(() => {});
        setTimeout(() => this.goAdmin(), 500);
      })
      .catch(() => {});
  },

  feedback() {
    wx.setClipboardData({
      data: 'openid: ' + ((this.data.user && this.data.user.openid) || '未知'),
      success: () => toast('已复制你的标识，可发给管理员排查问题')
    });
  }
});
