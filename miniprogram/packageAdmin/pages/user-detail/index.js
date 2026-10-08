const app = getApp();
const adminApi = require('../../../services/admin');
const adminGuard = require('../../utils/guard');
const { ROLE_LABEL, JOB_STATUS_LABEL, MODE_LABEL } = require('../../../utils/constants');
const { toast, confirm, formatTime, relativeTime, formatSize } = require('../../../utils/util');

Page({
  data: {
    id: '',
    loading: true,
    notFound: false,

    user: null,
    jobs: [],

    adminRole: '',
    isSuper: false,

    roleLabel: '',
    statusLabel: '',
    badgeClass: '',
    openidShort: '',
    createdText: '',
    lastActiveText: '',
    usageText: '',
    quotaEdit: { image: '', video: '' },

    saving: false,
    showQuota: false
  },

  onLoad(options) {
    this.id = (options && options.id) || '';
    if (!this.id) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    adminGuard
      .guard(this)
      .then(() => this.load())
      .catch(() => this.setData({ loading: false }));
  },

  onShow() {
    if (this._needReload) {
      this._needReload = false;
      this.load();
    }
  },

  load() {
    this.setData({ loading: true });
    return adminApi
      .userDetail(this.id)
      .then((res) => {
        const u = (res && res.user) || null;
        if (!u) {
          this.setData({ loading: false, notFound: true });
          return;
        }
        const banned = u.status === 'banned';
        const jobs = ((res && res.jobs) || []).map((j) =>
          Object.assign({}, j, {
            statusLabel: JOB_STATUS_LABEL[j.status] || j.status,
            modeLabel: MODE_LABEL[j.mode] || j.mode,
            timeText: relativeTime(j.createdAt),
            sizeText: j.size ? formatSize(j.size) : '—'
          })
        );

        this.setData({
          loading: false,
          notFound: false,
          user: u,
          jobs,
          roleLabel: ROLE_LABEL[u.role || 'user'] || '普通用户',
          statusLabel: banned ? '已封禁' : '正常',
          badgeClass: banned ? 'badge-danger' : 'badge-ok',
          openidShort: (u.openid || '').slice(-8) || '未知',
          createdText: formatTime(u.createdAt),
          lastActiveText: u.lastActiveAt ? relativeTime(u.lastActiveAt) : '未知',
          usageText:
            '今日 图 ' + (u.usedImageToday || 0) + ' 次 · 视频 ' + (u.usedVideoToday || 0) + ' 次',
          quotaEdit: {
            image: u.quotaImage == null ? '' : String(u.quotaImage),
            video: u.quotaVideo == null ? '' : String(u.quotaVideo)
          }
        });
      })
      .catch(() => {
        this.setData({ loading: false, notFound: true });
      });
  },

  /* ================= 操作 ================= */

  async toggleBan() {
    const u = this.data.user;
    if (!u) return;

    const banning = u.status !== 'banned';
    if (banning) {
      const reason = await promptText('请输入封禁原因（会展示给用户）');
      if (reason === null) return;
      this.act(
        () => adminApi.userUpdate({ id: u.id, action: 'ban', reason: reason || '' }),
        '已封禁该用户'
      );
    } else {
      const ok = await confirm('确定解除对该用户的限制吗？');
      if (!ok) return;
      this.act(
        () => adminApi.userUpdate({ id: u.id, action: 'unban' }),
        '已解除限制'
      );
    }
  },

  async changeRole() {
    const u = this.data.user;
    if (!u) return;
    if (!this.data.isSuper) return toast('只有超级管理员可以变更角色');

    const roles = ['user', 'operator', 'super'];
    const labels = roles.map((r) => ROLE_LABEL[r]);
    wx.showActionSheet({
      itemList: labels,
      success: (res) => {
        const role = roles[res.tapIndex];
        if (!role || role === u.role) return;
        this.act(
          () => adminApi.userUpdate({ id: u.id, action: 'role', role }),
          '角色已更新为 ' + ROLE_LABEL[role]
        );
      },
      fail: () => {}
    });
  },

  toggleQuota() {
    this.setData({ showQuota: !this.data.showQuota });
  },

  onQuotaInput(e) {
    const key = e.currentTarget.dataset.key;
    const quotaEdit = Object.assign({}, this.data.quotaEdit);
    quotaEdit[key] = e.detail.value;
    this.setData({ quotaEdit });
  },

  saveQuota() {
    if (!this.data.isSuper) return toast('只有超级管理员可以调整配额');
    const q = this.data.quotaEdit;
    const toNum = (v) => {
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(v);
      return isFinite(n) && n >= 0 ? Math.floor(n) : null;
    };
    this.act(
      () =>
        adminApi.userUpdate({
          id: this.data.user.id,
          action: 'quota',
          quotaImage: toNum(q.image),
          quotaVideo: toNum(q.video)
        }),
      '配额已更新',
      () => this.setData({ showQuota: false })
    );
  },

  async removeUser() {
    if (!this.data.isSuper) return toast('只有超级管理员可以删除用户');
    const ok = await confirm(
      '将删除该用户及其全部任务记录与云端文件，操作不可恢复。确定吗？',
      '删除用户'
    );
    if (!ok) return;
    this.setData({ saving: true });
    adminApi
      .userUpdate({ id: this.data.user.id, action: 'delete' })
      .then(() => {
        toast('已删除', 'success');
        setTimeout(() => wx.navigateBack(), 700);
      })
      .catch(() => this.setData({ saving: false }));
  },

  copyOpenid() {
    const u = this.data.user;
    if (!u || !u.openid) return;
    wx.setClipboardData({
      data: u.openid,
      success: () => toast('已复制 openid')
    });
  },

  openJob(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    app.globalData.pending = { jobId: id };
    wx.navigateTo({ url: '/pages/result/index' });
  },

  act(fn, successMsg, after) {
    this.setData({ saving: true });
    fn()
      .then(() => {
        toast(successMsg || '操作成功', 'success');
        if (typeof after === 'function') after();
        this.setData({ saving: false });
        this._needReload = true;
        return this.load();
      })
      .catch(() => this.setData({ saving: false }));
  }
});

function promptText(placeholder) {
  return new Promise((resolve) => {
    wx.showModal({
      title: '封禁用户',
      editable: true,
      placeholderText: placeholder || '',
      confirmColor: '#A32D2D',
      success: (res) => resolve(res.confirm ? res.content || '' : null),
      fail: () => resolve(null)
    });
  });
}
