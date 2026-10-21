const app = getApp();
const jobApi = require('../../services/job');
const { toast, confirm, debounce, ensureAlbumAuth, downloadFile, defaultFileName, renameLocalFile, extLabel, guessExt } = require('../../utils/util');

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'unsaved', label: '未保存' }
];

const EMPTY_TEXT = {
  all: { title: '还没有处理记录', desc: '去首页选一张图片或视频开始' },
  image: { title: '没有图片记录', desc: '试试处理一张图片' },
  video: { title: '没有视频记录', desc: '视频去水印需要先配置视频服务' },
  unsaved: { title: '没有未保存的结果', desc: '所有处理结果都已存进相册' }
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

    selectMode: false,
    selectedIds: [],
    selectedCount: 0,

    emptyTitle: EMPTY_TEXT.all.title,
    emptyDesc: EMPTY_TEXT.all.desc,
    skeletonRows: [1, 2, 3, 4]
  },

  onLoad() {
    this._jobVersion = -1;
    this._onSearchInput = debounce(() => this.reload(), 400);
    this.reload();
  },

  onShow() {
    // 从编辑器跳转过来 / 切回本页时都刷新，保证新提交的任务立刻可见
    this.reload();
  },

  onHide() {
    this.stopPoll();
  },

  onUnload() {
    this.stopPoll();
  },

  /* ================= 处理中自动刷新 ================= */

  // 列表里还有 pending / processing 的任务时，每 4 秒静默刷新一次
  syncPoll(list) {
    const arr = list || this.data.list || [];
    const busy = arr.some((j) => j.status === 'pending' || j.status === 'processing');
    if (busy) this.startPoll();
    else this.stopPoll();
  },

  startPoll() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this.pollOnce(), 3000);
  },

  /**
   * 轮询远程视频任务，把进度 / 结果地址回填到本地记录。
   * 图片记录不走这里（本地处理，创建即完成）。
   */
  async pollOnce() {
    const busy = (this.data.list || []).filter(
      (j) => (j.status === 'pending' || j.status === 'processing') && j.remoteId
    );
    if (!busy.length) {
      this.stopPoll();
      return;
    }

    let changed = false;
    for (let i = 0; i < busy.length; i++) {
      const j = busy[i];
      try {
        const r = await jobApi.videoStatus(j.remoteId);
        const patch = {
          status: r.status || j.status,
          progress: Number(r.progress) || 0
        };
        if (r.status === 'done') {
          patch.progress = 100;
          patch.outFileID = r.url || j.outFileID || '';
          patch.thumbFileID = r.thumbUrl || j.thumbFileID || '';
        } else if (r.status === 'failed') {
          patch.error = r.error || '处理失败';
        }
        jobApi.update(j.id, patch);
        changed = true;
      } catch (e) {
        /* 单条查询失败不打断其它任务 */
      }
    }

    if (changed) {
      app.bumpJob();
      this.reload();
    }
  },

  stopPoll() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  onShareAppMessage() {
    return { title: '水印清理', path: '/pages/index/index' };
  },

  /* ================= 数据 ================= */

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
    const params = {
      page,
      pageSize: this.data.pageSize,
      filter: this.data.filter
    };
    if (this.data.keyword) params.keyword = this.data.keyword;

    return jobApi
      .list(params)
      .then((res) => {
        const raw = (res && res.list) || [];
        return this.decorate(raw).then((list) => ({
          list,
          hasMore: !!(res && res.hasMore)
        }));
      })
      .then((r) => {
        // checked 供 WXML 直接读取（WXML 不能调用 indexOf 之类的方法）
        const merged = reset ? r.list : this.data.list.concat(r.list);
        const list = merged.map((j) => Object.assign({}, j, { checked: false }));
        this.setData({
          list,
          page,
          hasMore: r.hasMore,
          loading: false,
          loadingMore: false
        });
        this._jobVersion = app.globalData.version.job;
        // 有处理中的任务就自动轮询刷新，完成后自动停止
        this.syncPoll(list);
      })
      .catch(() => {
        this.setData({ loading: false, loadingMore: false, hasMore: false });
      });
  },

  // 本地路径可直接用于 <image> 与保存相册，不需要再换取临时链接。
  // 视频结果是服务端 https 地址，下载时由 util.downloadFile 负责拉取。
  decorate(list) {
    return Promise.resolve(
      list.map((j) =>
        Object.assign({}, j, {
          thumbUrl: j.thumbFileID || j.outFileID || '',
          outUrl: j.outFileID || ''
        })
      )
    );
  },

  /* ================= 筛选 ================= */

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value });
    this._onSearchInput();
  },

  clearSearch() {
    this.setData({ keyword: '' });
    this.reload();
  },

  switchFilter(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.filter) return;
    const empty = EMPTY_TEXT[key] || EMPTY_TEXT.all;
    this.setData({
      filter: key,
      filters: this.data.filters.map((f) => Object.assign({}, f, { active: f.key === key })),
      emptyTitle: empty.title,
      emptyDesc: empty.desc,
      selectMode: false,
      selectedIds: [],
      selectedCount: 0
    });
    this.reload();
  },

  /* ================= 选择与操作 ================= */

  toggleSelectMode() {
    const on = !this.data.selectMode;
    this.setData({ selectMode: on, selectedIds: [], selectedCount: 0 });
  },

  onCardTap(e) {
    const job = e.detail.job;
    if (!job) return;

    if (this.data.selectMode) {
      this.toggleOne(job.id);
      return;
    }

    app.globalData.pending = { jobId: job.id };
    wx.navigateTo({ url: '/pages/result/index' });
  },

  onCardLongPress(e) {
    const job = e.detail.job;
    if (!job || this.data.selectMode) return;
    this.setData({ selectMode: true, selectedIds: [job.id], selectedCount: 1 });
  },

  toggleOne(id) {
    const ids = this.data.selectedIds.slice();
    const i = ids.indexOf(id);
    if (i > -1) ids.splice(i, 1);
    else ids.push(id);
    this.setData({
      selectedIds: ids,
      selectedCount: ids.length,
      list: this.data.list.map((j) =>
        Object.assign({}, j, { checked: ids.indexOf(j.id) > -1 })
      )
    });
  },

  selectAll() {
    const all = this.data.list.map((j) => j.id);
    const isAll = this.data.selectedIds.length === all.length && all.length > 0;
    const ids = isAll ? [] : all;
    this.setData({
      selectedIds: ids,
      selectedCount: ids.length,
      list: this.data.list.map((j) =>
        Object.assign({}, j, { checked: ids.indexOf(j.id) > -1 })
      )
    });
  },

  async removeSelected() {
    const ids = this.data.selectedIds;
    if (!ids.length) return toast('请先选择要删除的记录');

    const ok = await confirm('将删除 ' + ids.length + ' 条记录及本机文件，此操作不可恢复，确定吗？');
    if (!ok) return;

    jobApi
      .remove(ids)
      .then(() => {
        toast('已删除', 'success');
        this.setData({ selectMode: false, selectedIds: [], selectedCount: 0 });
        app.bumpJob();
        this.reload();
      })
      .catch(() => {});
  },

  // 批量下载选中记录（逐条落地到小程序本地文件，并存入相册）
  async downloadSelected() {
    const ids = this.data.selectedIds;
    if (!ids.length) return toast('请先选择要下载的记录');

    const picked = this.data.list.filter((j) => ids.indexOf(j.id) > -1);
    const jobs = picked.filter((j) => j.status === 'done');
    const skipped = picked.length - jobs.length;
    if (!jobs.length) return toast('选中的记录还没有可下载的结果');

    const authed = await ensureAlbumAuth();
    if (!authed) return toast('未获得相册权限，无法保存');

    wx.showLoading({ title: '下载中 0/' + jobs.length, mask: true });

    let ok = 0;
    let firstErr = '';
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      try {
        const url = j.outUrl || j.outFileID;
        if (!url) throw new Error('结果文件已过期');
        // 每条都按「时间 + 类型」生成默认文件名，并落地到本地文件系统
        const name = defaultFileName(j.type, url, j.fileName);
        const path = await downloadFile(url);
        const named = await renameLocalFile(path, name);
        if (j.type === 'video') await saveVideo(named);
        else await saveImage(named);
        ok += 1;
      } catch (e) {
        // 记住第一条失败原因，最后明确告知用户
        if (!firstErr) firstErr = (e && e.message) || '下载失败';
      }
      wx.showLoading({ title: '下载中 ' + (i + 1) + '/' + jobs.length, mask: true });
    }
    wx.hideLoading();

    if (ok === jobs.length) {
      toast(skipped ? '已下载 ' + ok + ' 个（跳过 ' + skipped + ' 个未完成）' : '已下载 ' + ok + ' 个到相册', 'success');
    } else if (ok > 0) {
      toast('成功 ' + ok + ' 个，失败 ' + (jobs.length - ok) + ' 个：' + firstErr, 'none');
    } else {
      toast(firstErr || '下载失败，请重试', 'none');
    }

    if (ok > 0) this.setData({ selectMode: false, selectedIds: [], selectedCount: 0 });
  },

  // 单条下载：点卡片右下角「下载」（视频存相册，图片存相册）
  async onCardDownload(e) {
    const job = e.detail && e.detail.job;
    if (!job) return;
    if (job.status !== 'done') return toast('该记录还没有可下载的结果');

    const authed = await ensureAlbumAuth();
    if (!authed) return toast('未获得相册权限，无法保存');

    // 下载前先算好默认文件名（时间 + 类型），并落到本地文件系统
    const name = defaultFileName(job.type, job.outUrl || job.outFileID, job.fileName);
    const fmt = extLabel(guessExt(job.outUrl || job.outFileID, job.fileName, job.type));

    wx.showLoading({ title: '下载中…', mask: true });
    try {
      const url = job.outUrl || job.outFileID;
      if (!url) throw new Error('结果文件已过期');
      const path = await downloadFile(url);
      const named = await renameLocalFile(path, name);
      if (job.type === 'video') await saveVideo(named);
      else await saveImage(named);
      wx.hideLoading();
      toast('已保存 ' + name + '（' + fmt + '）', 'success');
    } catch (err) {
      wx.hideLoading();
      toast((err && err.message) || '下载失败，请重试');
    }
  },

  async clearAll() {
    const ok = await confirm('确定清空全部处理记录吗？本机文件会一并删除，此操作不可恢复。');
    if (!ok) return;

    jobApi
      .removeAll()
      .then(() => {
        toast('已清空', 'success');
        this.setData({ selectMode: false, selectedIds: [], selectedCount: 0 });
        app.bumpJob();
        this.reload();
      })
      .catch(() => {});
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});

function saveImage(filePath) {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: resolve,
      fail: () => reject(new Error('保存图片失败'))
    });
  });
}

function saveVideo(filePath) {
  return new Promise((resolve, reject) => {
    wx.saveVideoToPhotosAlbum({
      filePath,
      success: resolve,
      fail: () => reject(new Error('保存视频失败'))
    });
  });
}
