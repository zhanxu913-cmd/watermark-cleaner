/**
 * 任务（处理记录）相关接口
 */

const cloud = require('../utils/cloud');
const { FN } = require('../utils/constants');

module.exports = {
  /** 创建图片处理任务（图片已在本地处理完成，这里只落库 + 存文件） */
  create(data) {
    return cloud.call(FN.JOB, 'create', data, { loading: '保存记录' });
  },

  /** 记录列表（支持类型 / 状态 / 关键词筛选 + 分页） */
  list(params) {
    return cloud.call(FN.JOB, 'list', params);
  },

  detail(id) {
    return cloud.call(FN.JOB, 'detail', { id });
  },

  /** 删除记录（同时删云存储文件） */
  remove(ids) {
    return cloud.call(FN.JOB, 'remove', { ids }, { loading: '删除中' });
  },

  /** 清空全部记录 */
  removeAll() {
    return cloud.call(FN.JOB, 'removeAll', {}, { loading: '清理中' });
  },

  retry(id) {
    return cloud.call(FN.JOB, 'retry', { id }, { loading: '重新提交' });
  },

  /** 标记结果已保存到相册（仅更新状态，不阻塞用户操作） */
  markSaved(id) {
    return cloud.call(FN.JOB, 'markSaved', { id }, { silent: true });
  },

  /** 个人维度的统计 */
  stats() {
    return cloud.call(FN.JOB, 'stats');
  },

  /* ---------- 视频：走云端处理 ---------- */

  /** 提交视频处理任务，返回 jobId */
  submitVideo(data, onProgress) {
    return cloud.call(FN.VIDEO, 'submit', data, { loading: '提交任务' });
  },

  /** 轮询视频任务状态 */
  videoStatus(jobId) {
    return cloud.call(FN.VIDEO, 'status', { id: jobId }, { silent: true });
  },

  /** 视频服务可用性探测 */
  videoService() {
    return cloud.call(FN.VIDEO, 'service', {}, { silent: true });
  }
};
