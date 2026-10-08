/**
 * 统一响应信封：{ code, data, msg }
 * 业务码沿用小程序端约定：
 *   0 成功 / 401 未登录 / 403 无权限 / 404 不存在 / 429 配额受限 / 500 服务异常
 */

'use strict';

function ok(res, data) {
  res.json({ code: 0, data: data === undefined ? null : data, msg: '' });
}

function fail(res, code, msg, data) {
  res.json({ code, msg: msg || '请求失败', data: data === undefined ? null : data });
}

/** 包装 async 路由：BizError 保留业务码，其余统一落 500 */
function wrap(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch((e) => {
      const isBiz = e && e.name === 'BizError';
      if (!isBiz) console.error('[route]', req.method, req.originalUrl, '\n', e);
      const code = isBiz && e.code ? e.code : 500;
      if (!res.headersSent) fail(res, code, e.message || '服务异常，请稍后重试');
    });
  };
}

module.exports = { ok, fail, wrap };
