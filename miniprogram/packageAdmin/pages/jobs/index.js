const app = getApp();
const adminApi = require('../../../services/admin');
const adminGuard = require('../../utils/guard');
const { JOB_STATUS_LABEL, MODE_LABEL } = require('../../../utils/constants');
const {
  debounce,
  relativeTime,
  formatSize,
  toast,
  confirm
} = require('../../../utils/util');

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'failed', label: '失败' },
  { key: 'processing', label: '处理中' }
];

const BADGE = {
  done: 'badge-ok',
  failed: 'badge-danger',
  processing: 'badge-info',
  pending: 'badge-warn'
};

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
    total: 0,

    adminRole: '',
    isSuper: false,
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
      .jobs(params)
      .then((res) => {
        const list = ((res && res.list) || []).map((j) =>
          Object.assign({}, j, {
            statusLabel: JOB_STATUS_LABEL[j.status] || j.status,
            badgeClass: BADGE[j.status] || 'badge-gray',
            modeLabel: MODE_LABEL[j.mode] || j.mode,
            typeLabel: j.type === 'video' ? '视频' : '图片',
            timeText: relativeTime(j.createdAt),
            sizeText: j.size ? formatSize(j.size) : '—',
            ownerText: (j.ownerName || '未知') + ' · ' + (j.openid || '').slice(-6),
            canRetry: j.status === 'failed' || j.status === 'pending'
          })
        );
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

  openJob(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    app.globalData.pending = { jobId: id };
    wx.navigateTo({ url: '/pages/result/index' });
  },

  async retryJob(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const ok = await confirm('重新提交这个任务？视频任务会重新走一遍云端处理。');
    if (!ok) return;
    adminApi
      .jobUpdate({ id, action: 'retry' })
      .then(() => {
        toast('已重新提交', 'success');
        this.reload();
      })
      .catch(() => {});
  },

  async removeJob(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const ok = await confirm('删除该任务及其云端文件，确定吗？');
    if (!ok) return;
    adminApi
      .jobUpdate({ id, action: 'delete' })
      .then(() => {
        toast('已删除', 'success');
        this.reload();
      })
      .catch(() => {});
  }
});
