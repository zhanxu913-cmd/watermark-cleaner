const adminApi = require('../../../services/admin');
const adminGuard = require('../../utils/guard');
const { ROLE_LABEL } = require('../../../utils/constants');
const { debounce, relativeTime, formatTime, toast } = require('../../../utils/util');

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'normal', label: '正常' },
  { key: 'banned', label: '已封禁' },
  { key: 'vip', label: '会员' }
];

Page({
  data: {
    keyword: '',
    filter: 'all',
    filters: FILTERS.map((f) => Object.assign({}, f, { active: f.key === 'all' })),

    list: [],
    page: 1,
    pageSize: 20,
    hasMore: true,
    loading: true,
    loadingMore: false,

    adminRole: '',
    isSuper: false,
    total: 0,
    skeletonRows: [1, 2, 3, 4, 5]
  },

  onLoad() {
    this._onSearch = debounce(() => this.reload(), 400);
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
    const params = { page, pageSize: this.data.pageSize, filter: this.data.filter };
    if (this.data.keyword) params.keyword = this.data.keyword;

    return adminApi
      .users(params)
      .then((res) => {
        const list = ((res && res.list) || []).map(decorateUser);
        const merged = reset ? list : this.data.list.concat(list);
        this.setData({
          list: merged,
          total: (res && res.total) || merged.length,
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

  /* ================= 交互 ================= */

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value });
    this._onSearch();
  },

  clearSearch() {
    this.setData({ keyword: '' });
    this.reload();
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

  openUser(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: '/packageAdmin/pages/user-detail/index?id=' + id,
      complete: () => {}
    });
  },

  copyOpenid(e) {
    const id = e.currentTarget.dataset.openid;
    if (!id) return;
    wx.setClipboardData({
      data: id,
      success: () => toast('已复制 openid')
    });
  }
});

function decorateUser(u) {
  const role = u.role || 'user';
  const banned = u.status === 'banned';
  const usedImg = u.usedImageToday || 0;
  const usedVid = u.usedVideoToday || 0;

  return Object.assign({}, u, {
    roleLabel: ROLE_LABEL[role] || '普通用户',
    isBanned: banned,
    statusLabel: banned ? '已封禁' : '正常',
    badgeClass: banned ? 'badge-danger' : 'badge-ok',
    openidShort: (u.openid || '').slice(-8) || '未知',
    usageText: '今日 图 ' + usedImg + ' · 视频 ' + usedVid,
    timeText: relativeTime(u.createdAt),
    createdText: formatTime(u.createdAt),
    quotaOverrideText:
      u.quotaImage != null || u.quotaVideo != null
        ? '自定义 图' + (u.quotaImage == null ? '默认' : u.quotaImage) +
          ' / 视频' + (u.quotaVideo == null ? '默认' : u.quotaVideo)
        : '跟随全局'
  });
}
