/**
 * 任务（处理记录）接口 —— 零后台版
 *
 *  图片记录：全部落在本机（utils/localdb.js），不产生任何网络请求
 *  视频任务：提交给极简视频服务后，把远程任务号记在本地记录里，
 *           由记录页轮询进度并回填结果地址
 *
 * 方法签名保持与原版本一致，页面层只需去掉登录/配额相关调用。
 */

'use strict';

const localdb = require('../utils/localdb');
const video = require('./video');

/** 把同步调用包成 Promise，保持页面层 .then / .catch 写法不变 */
function asPromise(fn) {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e);
  }
}

module.exports = {
  /* ---------- 本地记录 ---------- */

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

  /** 局部更新（视频任务进度回填） */
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
  },

  /* ---------- 视频：走极简服务 ---------- */

  /**
   * 提交视频任务
   * @param {object} data { src 本地视频路径, mode, region, timeRange, duration, fileName }
   * @param {function} [onProgress]
   */
  submitVideo(data, onProgress) {
    return video.submit(data, onProgress).then((r) => ({ jobId: r.id }));
  },

  /** 轮询远程任务状态 */
  videoStatus(remoteId) {
    return video.status(remoteId);
  },

  /** 视频服务可用性探测 */
  videoService() {
    return video.service();
  }
};
