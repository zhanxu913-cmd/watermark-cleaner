const app = getApp();
const adminApi = require('../../../services/admin');
const adminGuard = require('../../utils/guard');
const { ROLE_LABEL, LOG_ACTION_LABEL } = require('../../../utils/constants');
const { relativeTime, formatSize, confirm } = require('../../../utils/util');

Page({
  data: {
    loading: true,
    ready: false,

    adminRole: '',
    adminName: '',
    isSuper: false,
    roleLabel: '',

    userMetrics: [],
    jobMetrics: [],
    healthItems: [],
    recentLogs: [],
    settings: {}
  },

  onLoad() {
    this.init();
  },

  onShow() {
    if (this.data.ready && this._needRefresh) {
      this._needRefresh = false;
      this.loadAll();
    }
  },

  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh());
  },

  init() {
    adminGuard
      .guard(this)
      .then(() => {
        this.setData({
          ready: true,
          roleLabel: ROLE_LABEL[this.data.adminRole] || '运营'
        });
        return this.loadAll();
      })
      .catch(() => {
        this.setData({ loading: false });
      });
  },

  loadAll() {
    return Promise.all([
      adminApi.overview().then((o) => this.applyOverview(o)),
      adminApi.logs({ page: 1, pageSize: 6 }).then((r) => this.applyLogs(r)),
      adminApi.settings().then((s) => this.applySettings(s))
    ]).catch(() => {
      this.setData({ loading: false });
    });
  },

  applyOverview(o) {
    const d = o || {};
    this.setData({
      loading: false,
      userMetrics: [
        { k: '用户总数', v: num(d.userCount) },
        { k: '今日新增', v: num(d.todayNewUsers) },
        { k: '已封禁', v: num(d.bannedUsers) }
      ],
      jobMetrics: [
        { k: '任务总数', v: num(d.jobCount) },
        { k: '今日任务', v: num(d.todayJobs) },
        { k: '失败任务', v: num(d.failedJobs) }
      ],
      healthItems: [
        { k: '图片任务', v: num(d.imageJobs), sub: '本地处理' },
        { k: '视频任务', v: num(d.videoJobs), sub: '云端处理' },
        { k: '存储占用', v: formatSize(d.totalSize || 0), sub: '云存储文件' }
      ]
    });
  },

  applyLogs(r) {
    const list = ((r && r.list) || []).map((l) =>
      Object.assign({}, l, {
        actionLabel: LOG_ACTION_LABEL[l.action] || l.action,
        timeText: relativeTime(l.createdAt)
      })
    );
    this.setData({ recentLogs: list });
  },

  applySettings(s) {
    this.setData({ settings: s || {} });
  },

  /* ================= 导航 ================= */

  markRefresh() {
    this._needRefresh = true;
  },

  goUsers() {
    this.markRefresh();
    wx.navigateTo({ url: '/packageAdmin/pages/users/index' });
  },

  goJobs() {
    this.markRefresh();
    wx.navigateTo({ url: '/packageAdmin/pages/jobs/index' });
  },

  goConfig() {
    if (!this.data.isSuper) {
      return wx.showModal({
        title: '权限不足',
        content: '只有超级管理员可以修改系统配置。',
        showCancel: false,
        confirmColor: '#185FA5'
      });
    }
    this.markRefresh();
    wx.navigateTo({ url: '/packageAdmin/pages/config/index' });
  },

  goLogs() {
    wx.navigateTo({ url: '/packageAdmin/pages/logs/index' });
  },

  goAdmins() {
    if (!this.data.isSuper) {
      return wx.showModal({
        title: '权限不足',
        content: '只有超级管理员可以管理其他管理员。',
        showCancel: false,
        confirmColor: '#185FA5'
      });
    }
    wx.navigateTo({ url: '/packageAdmin/pages/config/index?tab=admins' });
  },

  /* ================= 维护 ================= */

  async cleanData() {
    const ok = await confirm('将清理 30 天前的已完成任务记录及其云端文件，确定吗？', '数据清理');
    if (!ok) return;
    this.setData({ loading: true });
    adminApi
      .cleanData({ days: 30 })
      .then((res) => {
        wx.showModal({
          title: '清理完成',
          content: '共清理 ' + ((res && res.removed) || 0) + ' 条记录。',
          showCancel: false,
          confirmColor: '#185FA5'
        });
        return this.loadAll();
      })
      .catch(() => this.setData({ loading: false }));
  },

  copyKey() {
    const { CACHE } = require('../../../utils/constants');
    const key = wx.getStorageSync(CACHE.ADMIN_KEY) || '';
    if (!key) {
      return wx.showToast({ title: '当前会话没有密钥', icon: 'none' });
    }
    wx.setClipboardData({
      data: key,
      success: () => wx.showToast({ title: '已复制，可用于 Web 后台', icon: 'none' })
    });
  },

  logout() {
    adminGuard.logout();
  }
});

function num(v) {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  return n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n);
}
