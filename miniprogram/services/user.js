/**
 * 用户相关接口
 */

const cloud = require('../utils/cloud');
const { FN } = require('../utils/constants');

module.exports = {
  /** 登录 / 注册（wx.login 取 code 后建档，首次自动注册） */
  signIn() {
    return new Promise((resolve, reject) => {
      wx.login({
        success: (r) => {
          if (!r.code) return reject(new Error('wx.login 未返回 code'));
          cloud
            .call(FN.LOGIN, 'signIn', { code: r.code }, { silent: true })
            .then((d) => {
              if (d && d.token) cloud.setToken(d.token);
              resolve(d);
            })
            .catch(reject);
        },
        fail: reject
      });
    });
  },

  /** 拉取用户资料与配额 */
  profile() {
    return cloud.call(FN.LOGIN, 'profile');
  },

  /** 更新昵称 / 头像 */
  updateProfile(data) {
    return cloud.call(FN.LOGIN, 'updateProfile', data, { loading: '保存中' });
  },

  /** 单独查配额（处理前校验用） */
  quota() {
    return cloud.call(FN.LOGIN, 'quota', {}, { silent: true });
  },

  /** 个人统计：累计处理、本月、节省空间 */
  stats() {
    return cloud.call(FN.LOGIN, 'stats');
  },

  /** 消费一次配额（由云函数在任务创建时扣减，这里仅用于本地预判失败提示） */
  consume(type) {
    return cloud.call(FN.LOGIN, 'consume', { type }, { silent: true });
  }
};
