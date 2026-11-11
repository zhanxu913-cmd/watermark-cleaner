/**
 * 模拟器专用视频处理客户端（对接电脑上的 video-service-lite）
 *
 * 仅在开发者工具模拟器中使用：MediaRecorder 在模拟器里是空壳，
 * 全离线链路跑不了，改走电脑上的 FFmpeg 服务。
 * 真机永远走 utils/local-video.js 全离线，不经过本文件。
 *
 * 服务接口（video-service-lite/server.js）：
 *   POST /api/video/submit   multipart: file + mode/region/timeRange/duration/fileName
 *   GET  /api/video/status   ?id=xxx → {status, progress, url, error, ...}
 *   GET  /files/:name        产物下载
 */

'use strict';

const { VIDEO_API_BASE_URL, VIDEO_CLIENT_TOKEN } = require('../utils/constants');

const POLL_INTERVAL = 1000;
const POLL_MAX_MS = 3 * 60 * 1000; // 超时兜底
const MAX_CONSECUTIVE_FAILS = 8; // 连续查询失败次数上限（服务断开时快速报错）

/** 回调式 API 转 Promise */
function callP(obj, method, opts) {
  return new Promise((resolve, reject) => {
    try {
      obj[method](
        Object.assign({}, opts, {
          success: resolve,
          fail: (e) => reject(new Error((e && e.errMsg) || method + ' 失败'))
        })
      );
    } catch (e) {
      reject(e);
    }
  });
}

/** 公共请求头（服务端开启 CLIENT_TOKEN 校验时需要带上） */
function authHeader() {
  return VIDEO_CLIENT_TOKEN ? { 'X-Client-Token': VIDEO_CLIENT_TOKEN } : {};
}

/** 提交任务，返回远程任务 id */
async function submitRemote(opts, onUploadProgress) {
  const base = VIDEO_API_BASE_URL.replace(/\/+$/, '');
  if (!base) throw new Error('未配置视频服务地址（utils/constants.js → VIDEO_API_BASE_URL）');

  const res = await new Promise((resolve, reject) => {
    const up = wx.uploadFile({
      url: base + '/api/video/submit',
      filePath: opts.src,
      name: 'file',
      formData: {
        mode: opts.mode || 'blur',
        region: JSON.stringify(opts.region || {}),
        timeRange: JSON.stringify(opts.timeRange || { start: 0, end: 0 }),
        duration: String(opts.duration || 0),
        fileName: (opts.fileName || 'video.mp4').slice(0, 200)
      },
      header: authHeader(),
      success: resolve,
      fail: (e) =>
        reject(
          new Error(
            '无法连接电脑上的视频服务（' +
              base +
              '）。请先双击 start-video-service.bat 启动，并确认工具已勾选「不校验合法域名」。'
          )
        )
    });
    if (up && typeof up.onProgressUpdate === 'function') {
      up.onProgressUpdate((p) => onUploadProgress && onUploadProgress(p.progress || 0));
    }
  });

  let body = null;
  try {
    body = JSON.parse(res.data);
  } catch (e) {
    throw new Error('视频服务响应异常（HTTP ' + res.statusCode + '）');
  }
  if (!body || body.code !== 0 || !body.data || !body.data.id) {
    throw new Error((body && body.msg) || '提交失败');
  }
  return body.data.id;
}

/** 查询一次任务状态 */
async function statusRemote(id) {
  const base = VIDEO_API_BASE_URL.replace(/\/+$/, '');
  const res = await new Promise((resolve, reject) => {
    wx.request({
      url: base + '/api/video/status?id=' + encodeURIComponent(id),
      header: authHeader(),
      success: resolve,
      fail: (e) => reject(new Error((e && e.errMsg) || '查询失败'))
    });
  });
  let body = null;
  try {
    body = JSON.parse(res.data);
  } catch (e) {
    throw new Error('视频服务响应异常');
  }
  if (!body || body.code !== 0 || !body.data) throw new Error((body && body.msg) || '查询失败');
  return body.data;
}

/**
 * 远程处理主流程：提交 → 轮询 → 下载成品
 * 返回结构与 local-video.processVideo 一致，页面层零感知。
 */
async function processVideoRemote(opts) {
  const o = opts || {};
  const report = (pct, label) => {
    try {
      o.onProgress && o.onProgress(Math.max(0, Math.min(100, Math.round(pct))), label || '');
    } catch (e) {
      /* 进度回调异常不中断主流程 */
    }
  };

  // 上传：0 → 35（仅模拟器测试用；真机/线上走全离线，不会出现这段文案）
  report(2, '模拟器测试：传到电脑处理');
  const id = await submitRemote(o, (p) => report(2 + p * 0.33, '模拟器测试：传到电脑 ' + p + '%'));

  // 轮询：35 → 90（连续查询失败达到上限时快速报错，不傻等）
  const startedAt = Date.now();
  let info = null;
  let fails = 0;
  while (Date.now() - startedAt < POLL_MAX_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    try {
      info = await statusRemote(id);
      fails = 0;
    } catch (e) {
      if (++fails >= MAX_CONSECUTIVE_FAILS) {
        throw new Error('与电脑服务失去连接，请确认 start-video-service.bat 正在运行后重新提交');
      }
      continue;
    }
    if (info.status === 'done') break;
    if (info.status === 'failed') throw new Error(info.error || '处理失败');
    const p = Math.max(0, Math.min(100, Number(info.progress) || 0));
    report(35 + p * 0.55, info.progressText || '处理中');
  }
  if (!info || info.status !== 'done') throw new Error('处理超时，请重试或缩短视频时长');

  // 下载：90 → 100
  report(92, '取回成品');
  const dl = await callP(wx, 'downloadFile', { url: info.url, header: authHeader() });
  if (!dl || !dl.tempFilePath) throw new Error('成品下载失败');
  if (dl.statusCode !== 200) throw new Error('成品下载失败（HTTP ' + dl.statusCode + '）');
  report(100, '完成');

  return {
    tempFilePath: dl.tempFilePath,
    width: info.width || 0,
    height: info.height || 0,
    duration: info.duration || 0,
    hasAudio: true, // 服务端转码保留音轨
    audioDropped: false
  };
}

/** 服务健康检查（模拟器进页时探测一次，决定提示文案） */
async function serviceAvailable() {
  const base = VIDEO_API_BASE_URL.replace(/\/+$/, '');
  if (!base) return false;
  try {
    const res = await new Promise((resolve, reject) => {
      wx.request({
        url: base + '/healthz',
        timeout: 3000,
        success: resolve,
        fail: reject
      });
    });
    const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return !!(body && body.ok);
  } catch (e) {
    return false;
  }
}

module.exports = {
  processVideoRemote,
  serviceAvailable
};
