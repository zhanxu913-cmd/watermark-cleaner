const adminApi = require('../../../services/admin');
const adminGuard = require('../../utils/guard');
const { LOG_ACTION_LABEL } = require('../../../utils/constants');
const { formatTime, relativeTime } = require('../../../utils/util');

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'user', label: '用户操作' },
  { key: 'job', label: '任务操作' },
  { key: 'config', label: '配置变更' },
  { key: 'admin', label: '管理员' }
];

Page({
  data: {
    filter: 'all',
    filters: FILTERS.map((f) => Object.assign({}, f, { active: f.key === 'all' })),

    list: [],
    page: 1,
    pageSize: 30,
    hasMore: true,
    loading: true,
    loadingMore: false,

    adminRole: '',
    isSuper: false,
    skeletonRows: [1, 2, 3, 4, 5, 6]
  },

  onLoad() {
    adminGuard
      .guard(this)
      .then(() => this.reload())
      .catch(() => this.setData({ loading: false }));
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  reload() {
    this.setData({ loading: true, page: 1, hasMore: true });
    return this.fetch(1, true);
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
    this.setData({ loadingMore: true });
    this.fetch(this.data.page + 1, false);
  },

  fetch(page, reset) {
    return adminApi
      .logs({ page, pageSize: this.data.pageSize, filter: this.data.filter })
      .then((res) => {
        const list = ((res && res.list) || []).map((l) =>
          Object.assign({}, l, {
            actionLabel: LOG_ACTION_LABEL[l.action] || l.action,
            timeText: formatTime(l.createdAt),
            relText: relativeTime(l.createdAt),
            operatorShort: (l.operatorName || '未知').slice(0, 10)
          })
        );
        const merged = reset ? list : this.data.list.concat(list);
        this.setData({
          list: merged,
          page,
          hasMore: !!(res && res.hasMore),
          loading: false,
          loadingMore: false
        });
      })
      .catch(() => {
        this.setData({ loading: false, loadingMore: false, hasMore: false });
      });
  },

  switchFilter(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.filter) return;
    this.setData({
      filter: key,
      filters: this.data.filters.map((f) => Object.assign({}, f, { active: f.key === key }))
    });
    this.reload();
  },

  copyLog(e) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.list[index];
    if (!item) return;
    const text =
      item.timeText +
      ' | ' +
      (LOG_ACTION_LABEL[item.action] || item.action) +
      ' | ' +
      (item.operatorName || '未知') +
      ' | ' +
      (item.target || '') +
      (item.detail ? ' | ' + item.detail : '');
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    });
  }
});
