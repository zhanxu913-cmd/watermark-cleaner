/**
 * 微信 code2session
 *
 * - 已配置 WX_APPID / WX_SECRET：正常换取 openid
 * - 未配置（本地调试）：openid 用 code 哈希模拟，方便不开真实 AppID 也能跑通全流程
 */

'use strict';

const axios = require('axios');
const { BizError } = require('./biz');

const isConfigured = () => !!process.env.WX_APPID && !!process.env.WX_SECRET;

/**
 * @param {string} code wx.login 拿到的临时凭证
 * @returns {Promise<{openid:string, sessionKey:string, dev:boolean}>}
 */
async function codeToOpenid(code) {
  if (!code) throw new BizError(401, '缺少登录凭证');

  if (!isConfigured()) {
    // 开发态必须用固定身份：wx.login 的 code 是一次性的，按 code 派生 openid
    // 会导致每次重新登录都换一个新用户，历史任务全部「记录不存在」。
    // 可用 WX_DEV_OPENID 环境变量覆盖默认开发账号。
    const openid = String(process.env.WX_DEV_OPENID || 'dev_user').slice(0, 32);
    return { openid, sessionKey: '', dev: true };
  }

  try {
    const r = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: {
        appid: process.env.WX_APPID,
        secret: process.env.WX_SECRET,
        js_code: code,
        grant_type: 'authorization_code'
      },
      timeout: 8000
    });

    const d = r.data || {};
    if (d.openid) return { openid: d.openid, sessionKey: d.session_key || '', dev: false };

    // 40029 code 无效 / 45011 频率限制等
    throw new BizError(401, '微信登录失败（' + (d.errcode || '?') + '）：' + (d.errmsg || '未知错误'));
  } catch (e) {
    if (e instanceof BizError) throw e;
    throw new BizError(500, '微信登录服务不可用：' + (e.message || '网络异常'));
  }
}

module.exports = { codeToOpenid, isConfigured };
