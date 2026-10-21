/**
 * 极简视频服务客户端
 *
 * 对接 video-service-lite（无数据库、无登录，只有一个可选的静态令牌）。
 * 接口约定：
 *   POST /api/video/submit   multipart：file + mode/region/timeRange/duration/fileName
 *   GET  /api/video/status   ?id=xxx
 *   GET  /api/video/service  探测 FFmpeg 是否就绪
 *
 * 统一返回 { code: 0, data } / { code: 非0, msg }。
 */

'use strict';

const { VIDEO_API_BASE_URL, VIDEO_CLIENT_TOKEN } = require('../utils/constants');

function base() {
  return String(VIDEO_API_BASE_URL || '').replace(/\/+$/, '');
}

/** 视频功能是否可用（地址没配就是纯图片模式） */
function isConfigured() {
  const b = base();
  return !!b && b.indexOf('your-') === -1;
}

function headers() {
  const h = {};
  if (VIDEO_CLIENT_TOKEN) h['X-Client-Token'] = VIDEO_CLIENT_TOKEN;
  return h;
}

function errOf(code, msg) {
  const e = new Error(msg || '视频服务异常');
  e.code = code || 500;
  return e;
}

/** 解析服务端返回（wx.request 会自动把 JSON 转成对象，uploadFile 则是字符串） */
function parseBody(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw) || {};
  } catch (e) {
    return {};
  }
}

/**
 * 提交视频处理任务
 * @param {object} payload { src, mode, region, timeRange, duration, fileName }
 * @param {function} [onProgress] (percent 0-100) => void
 * @returns {Promise<{id:string}>}
 */
function submit(payload, onProgress) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) {
      return reject(errOf(503, '视频服务地址未配置，请在 utils/constants.js 填写 VIDEO_API_BASE_URL'));
    }
    const p = payload || {};
    if (!p.src) return reject(errOf(400, '缺少视频文件'));

    let region = '{}';
    let timeRange = '{}';
    try {
      region = JSON.stringify(p.region || {});
      timeRange = JSON.stringify(p.timeRange || {});
    } catch (e) {
      /* 保持空对象 */
    }

    const task = wx.uploadFile({
      url: base() + '/api/video/submit',
      filePath: p.src,
      name: 'file',
      formData: {
        mode: p.mode || 'blur',
        region,
        timeRange,
        duration: String(p.duration || 0),
        fileName: p.fileName || ''
      },
      header: headers(),
      timeout: 600000,
      success: (res) => {
        const r = parseBody(res.data);
        if (r.code === 0 && r.data && r.data.id) return resolve(r.data);
        reject(errOf(r.code || 500, r.msg || '视频提交失败'));
      },
      fail: (err) => {
        const raw = (err && err.errMsg) || '';
        let msg = '上传失败，请检查视频服务是否可达';
        if (raw.indexOf('url not in domain list') > -1) {
          msg = '请在小程序后台把视频服务域名加入 uploadFile 合法域名';
        } else if (raw.indexOf('timeout') > -1) {
          msg = '上传超时，视频可能过大或网络较慢';
        }
        reject(errOf(500, msg));
      }
    });

    if (task && task.onProgressUpdate && typeof onProgress === 'function') {
      task.onProgressUpdate((x) => onProgress(x.progress || 0));
    }
  });
}

/**
 * 查询任务状态
 * @param {string} id
 * @returns {Promise<{id,status,progress,url,thumbUrl,error}>}
 */
function status(id) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) return reject(errOf(503, '视频服务未配置'));
    if (!id) return reject(errOf(400, '缺少任务 ID'));

    wx.request({
      url: base() + '/api/video/status?id=' + encodeURIComponent(id),
      method: 'GET',
      header: headers(),
      timeout: 15000,
      success: (res) => {
        const r = parseBody(res.data);
        if (r.code === 0 && r.data) return resolve(r.data);
        reject(errOf(r.code || 500, r.msg || '查询失败'));
      },
      fail: (err) => reject(errOf(500, (err && err.errMsg) || '查询失败'))
    });
  });
}

/**
 * 探测服务可用性
 * @returns {Promise<{available:boolean,message:string,ffmpegFrom?:string}>}
 */
function service() {
  return new Promise((resolve) => {
    if (!isConfigured()) {
      return resolve({ available: false, message: '未配置视频服务地址' });
    }
    wx.request({
      url: base() + '/api/video/service',
      method: 'GET',
      header: headers(),
      timeout: 8000,
      success: (res) => {
        const r = parseBody(res.data);
        if (r.code === 0 && r.data) return resolve(r.data);
        resolve({ available: false, message: r.msg || '服务异常' });
      },
      fail: () => resolve({ available: false, message: '无法连接视频服务' })
    });
  });
}

module.exports = {
  isConfigured,
  submit,
  status,
  service,
  base
};
