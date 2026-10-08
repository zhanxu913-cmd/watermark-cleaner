const adminApi = require('../../../services/admin');
const adminGuard = require('../../utils/guard');
const { ROLE, ROLE_LABEL, DEFAULT_SETTINGS, CACHE } = require('../../../utils/constants');
const { toast, confirm, formatTime } = require('../../../utils/util');

// 数值型字段（保存时转数字）
const NUM_KEYS = [
  'freeImagePerDay',
  'freeVideoPerDay',
  'maxVideoDuration',
  'maxVideoSizeMB',
  'cloudKeepHours'
];

Page({
  data: {
    tab: 'settings',
    loading: true,
    saving: false,

    adminRole: '',
    isSuper: false,
    canEdit: false,

    form: {},
    admins: [],
    pendingAdmins: [],
    roleLabels: [ROLE_LABEL[ROLE.OPERATOR], ROLE_LABEL[ROLE.SUPER]],
    showAdd: false,
    newAdmin: { openid: '', name: '', role: ROLE.OPERATOR }
  },

  onLoad(options) {
    const tab = options && options.tab === 'admins' ? 'admins' : 'settings';
    this.setData({ tab });

    adminGuard
      .guard(this)
      .then(() => {
        this.setData({ canEdit: this.data.isSuper });
        return this.load();
      })
      .catch(() => this.setData({ loading: false }));
  },

  load() {
    this.setData({ loading: true });
    const tasks = [
      adminApi.settings().then((s) => this.setData({ form: mergeDefaults(s) }))
    ];
    if (this.data.tab === 'admins') {
      tasks.push(
        adminApi.admins().then((res) => {
          const list = ((res && res.list) || []).map((a) =>
            Object.assign({}, a, {
              roleLabel: ROLE_LABEL[a.role] || a.role,
              timeText: formatTime(a.createdAt),
              openidShort: (a.openid || '').slice(-8)
            })
          );
          this.setData({ admins: list, pendingAdmins: (res && res.pending) || [] });
        })
      );
    }
    return Promise.all(tasks)
      .then(() => this.setData({ loading: false }))
      .catch(() => this.setData({ loading: false }));
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab, loading: true });
    this.load();
  },

  /* ================= 表单 ================= */

  onInput(e) {
    const key = e.currentTarget.dataset.key;
    const form = Object.assign({}, this.data.form);
    form[key] = e.detail.value;
    this.setData({ form });
  },

  onSwitch(e) {
    if (!this.data.canEdit) return toast('只有超级管理员可以修改配置');
    const key = e.currentTarget.dataset.key;
    const form = Object.assign({}, this.data.form);
    form[key] = !!e.detail.value;
    this.setData({ form });
  },

  resetDefaults() {
    if (!this.data.canEdit) return toast('只有超级管理员可以修改配置');
    this.setData({ form: Object.assign({}, DEFAULT_SETTINGS) });
    toast('已恢复默认值，记得点保存');
  },

  save() {
    if (!this.data.canEdit) return toast('只有超级管理员可以修改配置');
    if (this.data.saving) return;

    const payload = Object.assign({}, this.data.form);
    NUM_KEYS.forEach((k) => {
      const n = Number(payload[k]);
      payload[k] = isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    });

    this.setData({ saving: true });
    adminApi
      .settingsUpdate(payload)
      .then(() => {
        toast('配置已保存', 'success');
        this.setData({ saving: false });
      })
      .catch(() => this.setData({ saving: false }));
  },

  /* ================= 管理员 ================= */

  toggleAdd() {
    if (!this.data.isSuper) return toast('只有超级管理员可以添加管理员');
    this.setData({
      showAdd: !this.data.showAdd,
      newAdmin: { openid: '', name: '', role: ROLE.OPERATOR }
    });
  },

  onNewAdminInput(e) {
    const key = e.currentTarget.dataset.key;
    const newAdmin = Object.assign({}, this.data.newAdmin);
    newAdmin[key] = e.detail.value;
    this.setData({ newAdmin });
  },

  onRoleChange(e) {
    const roles = [ROLE.OPERATOR, ROLE.SUPER];
    const newAdmin = Object.assign({}, this.data.newAdmin);
    newAdmin.role = roles[Number(e.detail.value)] || ROLE.OPERATOR;
    this.setData({ newAdmin });
  },

  addAdmin() {
    const n = this.data.newAdmin;
    const openid = String(n.openid || '').trim();
    if (openid.length < 10) return toast('请填写完整的 openid');

    this.setData({ saving: true });
    adminApi
      .adminAdd({ openid, name: String(n.name || '').trim(), role: n.role })
      .then(() => {
        toast('已添加', 'success');
        this.setData({ saving: false, showAdd: false });
        this.load();
      })
      .catch(() => this.setData({ saving: false }));
  },

  async removeAdmin(e) {
    const openid = e.currentTarget.dataset.openid;
    const name = e.currentTarget.dataset.name;
    if (!openid) return;

    const ok = await confirm('将移除管理员「' + (name || openid.slice(-8)) + '」的后台权限，确定吗？');
    if (!ok) return;

    adminApi
      .adminRemove({ openid })
      .then(() => {
        toast('已移除', 'success');
        this.load();
      })
      .catch(() => {});
  },

  copyOpenid(e) {
    const openid = e.currentTarget.dataset.openid;
    if (!openid) return;
    wx.setClipboardData({ data: openid, success: () => toast('已复制') });
  },

  copyKey() {
    const key = wx.getStorageSync(CACHE.ADMIN_KEY) || '';
    if (!key) return toast('当前会话没有密钥');
    wx.setClipboardData({
      data: key,
      success: () => toast('已复制，可用于 Web 后台登录')
    });
  }
});

function mergeDefaults(s) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  const src = s || {};
  Object.keys(out).forEach((k) => {
    if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
  });
  return out;
}
