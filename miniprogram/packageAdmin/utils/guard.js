/**
 * 管理后台统一鉴权
 * 进入任何后台页面前都必须先过这一关。
 * 校验的是「当前 openid 是否在 wc_admins 白名单内」，云函数侧二次校验，前端无法绕过。
 */

const adminApi = require('../../../services/admin');
const { CACHE } = require('../../../utils/constants');

function guard(page) {
  return adminApi
    .check()
    .then((res) => {
      if (!res || !res.isAdmin) {
        return deny(
          '无权限',
          '你当前不是管理员。可在「我的 → 管理员登录」输入访问密钥后重试。'
        );
      }
      page.setData({
        adminRole: res.role || 'operator',
        isSuper: res.role === 'super',
        adminName: res.name || ''
      });
      return res;
    })
    .catch((e) => {
      if (e && e.__denied) return Promise.reject(e);
      return deny('无法进入后台', (e && e.message) || '请检查网络后重试');
    });
}

function deny(title, content) {
  return new Promise((resolve, reject) => {
    wx.showModal({
      title,
      content,
      showCancel: false,
      confirmColor: '#185FA5',
      complete: () => {
        const pages = getCurrentPages();
        if (pages.length > 1) wx.navigateBack();
        else wx.switchTab({ url: '/pages/mine/index' });
        const e = new Error('denied');
        e.__denied = true;
        reject(e);
      }
    });
  });
}

/** 退出后台 */
function logout() {
  try {
    wx.removeStorageSync(CACHE.ADMIN_KEY);
  } catch (e) {
    /* 忽略 */
  }
  wx.switchTab({ url: '/pages/mine/index' });
}

module.exports = { guard, logout };
