/**
 * 业务异常：携带业务码，路由层可据此精准回包
 */

'use strict';

class BizError extends Error {
  constructor(code, msg) {
    super(msg || '请求失败');
    this.name = 'BizError';
    this.code = code;
  }
}

module.exports = { BizError };
