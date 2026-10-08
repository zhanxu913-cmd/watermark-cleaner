/**
 * 管理员身份（本地缓存访问密钥）
 *
 * 说明：小程序端不缓存角色，角色永远以云函数返回为准。
 * 这里只缓存访问密钥，用于：
 *   1. Web 管理后台的密钥可复制到小程序端使用
 *   2. HTTP 触发方式下的鉴权
 */

const { CACHE } = require('./constants');

function getKey() {
  try {
    return wx.getStorageSync(CACHE.ADMIN_KEY) || '';
  } catch (e) {
    return '';
  }
}

function setKey(key) {
  try {
    wx.setStorageSync(CACHE.ADMIN_KEY, String(key || ''));
  } catch (e) {
    /* 存储失败不阻断 */
  }
}

function clearKey() {
  try {
    wx.removeStorageSync(CACHE.ADMIN_KEY);
  } catch (e) {
    /* 忽略 */
  }
}

function hasKey() {
  return !!getKey();
}

module.exports = { getKey, setKey, clearKey, hasKey };
