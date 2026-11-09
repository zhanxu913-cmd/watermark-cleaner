/**
 * 任务（处理记录）接口 —— 零后台版
 *
 * 图片与视频全部在本机处理，记录落 utils/localdb.js，
 * 不产生任何网络请求，也没有远程任务轮询。
 *
 * 方法签名保持与原版本一致，页面层无需感知实现变化。
 */

'use strict';

const localdb = require('../utils/localdb');

/** 把同步调用包成 Promise，保持页面层 .then / .catch 写法不变 */
function asPromise(fn) {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e);
  }
}

module.exports = {
  create(data) {
    return asPromise(() => localdb.create(data));
  },

  list(params) {
    return asPromise(() => localdb.list(params));
  },

  detail(id) {
    return asPromise(() => {
      const job = localdb.detail(id);
      if (!job) {
        const e = new Error('记录不存在或已被清理');
        e.code = 404;
        throw e;
      }
      return job;
    });
  },

  /** 局部更新（处理进度回填） */
  update(id, patch) {
    return asPromise(() => localdb.update(id, patch));
  },

  remove(ids) {
    return asPromise(() => localdb.remove(ids));
  },

  removeAll() {
    return asPromise(() => localdb.removeAll());
  },

  markSaved(id) {
    return asPromise(() => localdb.markSaved(id));
  },

  stats() {
    return asPromise(() => localdb.stats());
  },

  /**
   * 历史版本支持「重试」，零后台后源文件不再保留，无法重跑。
   * 保留方法是为了让旧页面调用不会直接 TypeError。
   */
  retry() {
    return Promise.reject(new Error('记录不支持重试，请重新选择素材处理'));
  }
};
