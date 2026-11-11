const app = getApp();
const jobApi = require('../../services/job');
const rewardAd = require('../../services/reward-ad');
const quota = require('../../utils/quota');
const { toast, confirm, debounce, ensureAlbumAuth, downloadFile, defaultFileName, renameLocalFile, extLabel, guessExt, isDevtools, saveToDisk } = require('../../utils/util');
const { QUOTA_ENABLED, DEBUG_UI } = require('../../utils/constants');
const trace = require('../../utils/trace');

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
    dbg: '',
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
    this.failStalePending();
    this.reload();
    // 本页也有下载入口：提前拉取激励视频，避免首次点下载时现等 3 秒
    if (!this._adPreloaded) {
      this._adPreloaded = true;
      rewardAd.preload();
    }
  },

  /**
   * 自愈：pending 超过 6 分钟的记录直接判失败。
   * 正常链路里记录创建后几分钟内必有终态（本机处理即时完成 / 模拟器
   * 通道提交后页面内轮询回填）；卡在 pending 说明处理中断（退出小程序、
   * 电脑服务断开等），留着只会永远「排队中」。
   */
  async failStalePending() {
    try {
      const res = await jobApi.list({ page: 1, pageSize: 50, filter: 'all' });
      const list = (res && res.list) || [];
      let changed = false;
      for (let i = 0; i < list.length; i++) {
        const j = list[i];
        if (j.status !== 'pending' && j.status !== 'processing') continue;
        // createdAt 为 'YYYY-MM-DD HH:mm:ss' 本地时间字符串
        const t = j.createdAt ? new Date(String(j.createdAt).replace(/-/g, '/')).getTime() : 0;
        if (!t || t >= Date.now() - 6 * 60 * 1000) continue;
        await jobApi.update(j.id, { status: 'failed', error: '处理中断，请重新提交' });
        changed = true;
      }
      if (changed) app.bumpJob();
    } catch (e) {
      /* 自愈失败不影响列表展示 */
    }
  },

  onHide() {
    this.stopPoll();
  },

  onUnload() {
    this.stopPoll();
  },

  /* ================= 处理中自动刷新 ================= */

  // 全离线处理后，记录创建时即已完成或失败，无需轮询远程任务。
  // 保留空实现以兼容页面里的既有调用点。
  syncPoll() {},

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
    return { title: '全能AI去水印', path: '/pages/index/index' };
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

  // 本地路径可直接用于 <image> 与保存相册，图片视频均不再经过服务端。
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

  // 单条下载：点卡片右下角「下载」（视频存相册，图片存相册）
  /**
   * 排查打点：始终写入本机日志（关于 → 点击追踪），
   * 只有 DEBUG_UI 为 true 时才同步显示在屏幕黑条上（线上默认关闭）。
   */
  mark(msg) {
    trace.trace('save', msg);
    if (DEBUG_UI) this.setData({ dbg: msg });
  },

  async onCardDownload(e) {
    this.mark('① 点击已收到');
    try {
      await this._doCardDownload(e);
    } catch (err) {
      // 兜底：任何异常都要给用户可见提示，绝不静默
      this.mark('✗ 异常: ' + ((err && err.message) || err));
      console.error('[下载] 异常:', err);
      toast((err && err.message) || '下载失败，请重试');
    }
  },

  async _doCardDownload(e) {
    const job = e.detail && e.detail.job;
    if (!job) return toast('记录数据异常，请返回重新进入');
    if (job.status !== 'done') return toast('该记录还没有可下载的结果');
    this.mark('② 记录: ' + job.type + ' / ' + job.status);

    // 视频下载走额度闸门：图片免费直接放行
    if (job.type === 'video') {
      const unlocked = await rewardAd.ensureQuota();
      this.mark('③ 额度闸门: ' + (unlocked ? '通过' : '未通过 · ' + (rewardAd.lastGateError() || '未知原因')));
      if (!unlocked) return;
    }

    // 电脑（开发者工具）自测：相册是模拟的，改为另存到电脑，方便直接播放验证
    const devtools = isDevtools();
    if (!devtools) {
      const authed = await ensureAlbumAuth();
      this.mark('④ 相册权限: ' + (authed ? '已授权' : '被拒绝'));
      if (!authed) return toast('未获得相册权限，无法保存');
    } else {
      this.mark('④ 电脑模式，跳过相册权限');
    }

    // 下载前先算好默认文件名（时间 + 类型），并落到本地文件系统
    const name = defaultFileName(job.type, job.outUrl || job.outFileID, job.fileName);
    const fmt = extLabel(guessExt(job.outUrl || job.outFileID, job.fileName, job.type));

    wx.showLoading({ title: '下载中…', mask: true });
    try {
      const url = job.outUrl || job.outFileID;
      if (!url) throw new Error('结果文件已过期');
      const path = await downloadFile(url);
      this.mark('⑤ 下载完成: ' + String(path || '').slice(-40));
      const named = await renameLocalFile(path, name);
      let where = '相册';
      if (devtools) {
        // 开发者工具内相册是模拟的，saveVideo/saveImage 必失败，
        // 因此工具内只走「另存到电脑」，失败时给出真实原因，不退回相册
        try {
          await saveToDisk(named);
          where = '电脑';
        } catch (e) {
          const msg = (e && e.message) || '';
          if (msg.indexOf('cancel') > -1 || msg.indexOf('取消') > -1) {
            // 用户在另存对话框点了取消：视为主动放弃，不算失败
            this.mark('已取消另存（文件保留在小程序本地）');
            wx.hideLoading();
            toast('已取消保存，文件保留在小程序内', 'none');
            return;
          }
          this.mark('✗ 另存失败: ' + msg);
          wx.hideLoading();
          wx.showModal({
            title: '保存到电脑失败',
            content: '原因：' + msg + '\n\n文件已生成在小程序本地目录，可重试另存。',
            showCancel: false,
            confirmColor: '#185FA5'
          });
          return;
        }
      } else if (job.type === 'video') {
        await saveVideo(named);
      } else {
        await saveImage(named);
      }
      if (job.type === 'video' && QUOTA_ENABLED) quota.consume(1); // 额度闸门开启时，保存成功才扣 1 条
      this.mark('⑥ 写入完成: ' + where);
      wx.hideLoading();
      toast('已保存到' + where + '：' + name + '（' + fmt + '）', 'success');
    } catch (err) {
      this.mark('✗ 失败: ' + ((err && err.message) || err));
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
