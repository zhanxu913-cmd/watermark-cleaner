/**
 * 后端 API 统一封装（自建服务版，替代原云开发封装）
 *
 * 约定：所有接口返回 { code, data, msg }
 *   code = 0    成功
 *   code = 401  未登录
 *   code = 403  无权限 / 被封禁
 *   code = 404  资源不存在
 *   code = 429  配额或频率受限
 *   code = 500  服务端异常
 *
 * 对页面与服务层的接口保持不变：call / upload / removeFiles / tempUrls
 */

const { API_BASE_URL, CACHE } = require('./constants');
const { getKey, setKey } = require('./auth');

/** 带业务错误码的异常，页面可据 err.code 做分支处理 */
class CloudError extends Error {
  constructor(code, msg, data) {
    super(msg || '请求失败');
    this.name = 'CloudError';
    this.code = code;
    this.data = data || null;
  }
}

/* ---------------- Token ---------------- */

function getToken() {
  try {
    return wx.getStorageSync(CACHE.TOKEN) || '';
  } catch (e) {
    return '';
  }
}

function setToken(token) {
  try {
    wx.setStorageSync(CACHE.TOKEN, String(token || ''));
  } catch (e) { /* 忽略 */ }
}

function clearToken() {
  try {
    wx.removeStorageSync(CACHE.TOKEN);
  } catch (e) { /* 忽略 */ }
}

/** 是否已配置后端地址 */
function isConfigured() {
  return !!API_BASE_URL && API_BASE_URL.indexOf('your-domain') === -1;
}

function isReady() {
  return isConfigured();
}

/* ---------------- 请求 ---------------- */

/**
 * 调用后端接口
 * @param {string} name 模块名：login | job | videoProc | admin
 * @param {string} action 动作
 * @param {object} payload 业务数据
 * @param {object} [opts] { loading: string|true, silent: boolean }
 */
function call(name, action, payload, opts) {
  const options = opts || {};
  const body = Object.assign({}, payload || {});

  // 管理后台相关的调用自动附带访问密钥（兼容小程序端旧流程）
  if (name === 'admin' && action !== 'login') {
    const key = getKey();
    if (key) body.__key = key;
  }

  if (options.loading) {
    wx.showLoading({ title: options.loading === true ? '加载中' : options.loading, mask: true });
  }

  return new Promise((resolve, reject) => {
    if (!isConfigured()) {
      if (options.loading) wx.hideLoading();
      const e = new CloudError(500, '尚未配置后端地址：请打开 miniprogram/utils/constants.js 填入 API_BASE_URL');
      if (!options.silent) toastError(e);
      return reject(e);
    }

    const header = { 'content-type': 'application/json' };
    const token = getToken();
    if (token) header.Authorization = 'Bearer ' + token;

    wx.request({
      url: API_BASE_URL + '/api/' + name + '/' + action,
      method: 'POST',
      data: body,
      header,
      timeout: 20000,
      success: (res) => {
        if (options.loading) wx.hideLoading();
        const r = res.data || {};

        // 401：登录态失效，清 token 让下次重新登录
        if (r.code === 401) clearToken();

        if (r.code === 0) {
          // 密钥登录成功后自动缓存，后续 admin 调用会自动附带
          if (name === 'admin' && action === 'login' && payload && payload.key) {
            setKey(payload.key);
          }
          return resolve(r.data);
        }

        const e = new CloudError(
          typeof r.code === 'number' ? r.code : 500,
          r.msg || '请求失败',
          r.data
        );
        if (!options.silent) toastError(e);
        reject(e);
      },
      fail: (err) => {
        if (options.loading) wx.hideLoading();
        const raw = (err && (err.errMsg || err.message)) || '';
        console.error('[cloud] 请求失败:', API_BASE_URL + '/api/' + name + '/' + action, raw);

        let msg = '网络异常，请检查网络后重试';
        if (raw.indexOf('url not in domain list') > -1) {
          msg = '请在「详情→本地设置」勾选「不校验合法域名」后再试';
        } else if (raw.indexOf('timeout') > -1) {
          msg = '请求超时，请确认后端服务已启动';
        } else if (raw.indexOf('ERR_CONNECTION') > -1 || raw.indexOf('Failed to connect') > -1) {
          msg = '无法连接后端服务，请确认 server 已启动且地址正确';
        } else if (raw) {
          // 未知错误：附上原始信息便于定位（截断防溢出）
          msg = '网络异常：' + raw.slice(0, 60);
        }
        const e = new CloudError(500, msg);
        if (!options.silent) toastError(e);
        reject(e);
      }
    });
  });
}

function toastError(err) {
  if (!err) return;
  // 配额用尽时用弹窗，让用户看清引导；其余用轻提示
  if (err.code === 429) {
    wx.showModal({
      title: '次数已用完',
      content: err.message || '今日可用次数已用完',
      showCancel: false,
      confirmColor: '#185FA5'
    });
    return;
  }
  wx.showToast({ title: err.message || '请求失败', icon: 'none', duration: 2000 });
}

/* ---------------- 文件 ---------------- */

/**
 * 上传本地文件到后端
 * @param {string} filePath 本地临时路径
 * @param {string} dir 目录，如 'output/images'
 * @param {function} [onProgress] (percent 0-100) => void
 * @returns {Promise<{fileID:string, url:string}>}
 */
function upload(filePath, dir, onProgress) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) return reject(new CloudError(500, '尚未配置后端地址'));

    const header = {};
    const token = getToken();
    if (token) header.Authorization = 'Bearer ' + token;

    const task = wx.uploadFile({
      url: API_BASE_URL + '/api/upload',
      filePath,
      name: 'file',
      formData: { dir: dir || 'misc' },
      header,
      timeout: 300000,
      success: (res) => {
        let r = {};
        try {
          r = JSON.parse(res.data || '{}');
        } catch (e) {
          return reject(new CloudError(500, '上传响应解析失败'));
        }
        if (r.code === 0) return resolve(r.data);
        const e = new CloudError(r.code || 500, r.msg || '上传失败');
        toastError(e);
        reject(e);
      },
      fail: (err) => reject(new CloudError(500, (err && err.errMsg) || '上传失败'))
    });

    if (task && task.onProgressUpdate && typeof onProgress === 'function') {
      task.onProgressUpdate((p) => onProgress(p.progress || 0, p));
    }
  });
}

/**
 * 删除服务端文件（失败不抛出，避免阻断主流程）
 */
function removeFiles(fileIDs) {
  const list = (Array.isArray(fileIDs) ? fileIDs : [fileIDs]).filter(Boolean);
  if (!list.length) return Promise.resolve({ deleted: 0 });

  const header = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) header.Authorization = 'Bearer ' + token;

  return new Promise((resolve) => {
    wx.request({
      url: API_BASE_URL + '/api/file/remove',
      method: 'POST',
      data: { fileIDs: list },
      header,
      success: (res) => resolve({ deleted: (res.data && res.data.data && res.data.data.deleted) || 0 }),
      fail: () => resolve({ deleted: 0 })
    });
  });
}

/**
 * 把 fileID 换成可访问的 URL（本版本文件由后端静态托管，直接拼地址即可）
 */
function tempUrls(fileIDs) {
  const list = (Array.isArray(fileIDs) ? fileIDs : [fileIDs]).filter(Boolean);
  const map = {};
  list.forEach((id) => {
    if (id) map[id] = API_BASE_URL + '/files/' + String(id).replace(/\\/g, '/');
  });
  return Promise.resolve(map);
}

module.exports = {
  CloudError,
  call,
  upload,
  removeFiles,
  tempUrls,
  getToken,
  setToken,
  clearToken,
  isConfigured,
  isReady
};
