/**
 * 管理后台接口
 * 所有调用都会由 utils/cloud.js 自动附带 __key（本地缓存的访问密钥），
 * 云函数侧先校验密钥，再校验 openid 是否在管理员白名单内 —— 双重校验。
 */

const cloud = require('../utils/cloud');
const { FN } = require('../utils/constants');

module.exports = {
  /** 校验当前身份是否为管理员（openid 白名单），静默失败 */
  check() {
    return cloud.call(FN.ADMIN, 'check', {}, { silent: true });
  },

  /** 用访问密钥登录后台 */
  login(key) {
    return cloud.call(FN.ADMIN, 'login', { key }, { loading: '验证中' });
  },

  /* ---------- 概览 ---------- */

  overview() {
    return cloud.call(FN.ADMIN, 'overview');
  },

  /* ---------- 用户 ---------- */

  users(params) {
    return cloud.call(FN.ADMIN, 'users', params);
  },

  userDetail(id) {
    return cloud.call(FN.ADMIN, 'userDetail', { id });
  },

  userUpdate(params) {
    return cloud.call(FN.ADMIN, 'userUpdate', params, { loading: '保存中' });
  },

  /* ---------- 任务 ---------- */

  jobs(params) {
    return cloud.call(FN.ADMIN, 'jobs', params);
  },

  jobUpdate(params) {
    return cloud.call(FN.ADMIN, 'jobUpdate', params, { loading: '处理中' });
  },

  /* ---------- 配置 ---------- */

  settings() {
    return cloud.call(FN.ADMIN, 'settings');
  },

  settingsUpdate(params) {
    return cloud.call(FN.ADMIN, 'settingsUpdate', params, { loading: '保存中' });
  },

  /* ---------- 日志 ---------- */

  logs(params) {
    return cloud.call(FN.ADMIN, 'logs', params);
  },

  /* ---------- 管理员 ---------- */

  admins() {
    return cloud.call(FN.ADMIN, 'admins');
  },

  adminAdd(params) {
    return cloud.call(FN.ADMIN, 'adminAdd', params, { loading: '添加中' });
  },

  adminRemove(params) {
    return cloud.call(FN.ADMIN, 'adminRemove', params, { loading: '移除中' });
  },

  /* ---------- 数据维护 ---------- */

  cleanData(params) {
    return cloud.call(FN.ADMIN, 'cleanData', params, { loading: '清理中' });
  }
};
