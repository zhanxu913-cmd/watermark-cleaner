/**
 * 通用工具函数
 */

const { API_BASE_URL } = require('./constants');

/* ---------------- 数值 / 文本 ---------------- */

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 秒 → 00:05 */
function formatDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return pad(m) + ':' + pad(r);
}

/** 秒 → 1分30秒 */
function humanDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? m + ' 分 ' + r + ' 秒' : m + ' 分';
}

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

function formatTime(ts) {
  const d = toDate(ts);
  if (!d) return '';
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  );
}

/** 今天 14:32 / 昨天 20:15 / 9月22日 / 2025年9月22日 */
function relativeTime(ts) {
  const d = toDate(ts);
  if (!d) return '';
  const now = new Date();
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return '今天 ' + hm;

  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (
    d.getFullYear() === yest.getFullYear() &&
    d.getMonth() === yest.getMonth() &&
    d.getDate() === yest.getDate()
  ) {
    return '昨天 ' + hm;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.getMonth() + 1 + '月' + d.getDate() + '日';
  }
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function toDate(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

/** 手机号 / 昵称脱敏 */
function maskName(name) {
  const s = String(name || '');
  if (s.length <= 1) return s || '匿名用户';
  if (s.length === 2) return s[0] + '*';
  return s[0] + '*'.repeat(Math.min(s.length - 2, 3)) + s[s.length - 1];
}

/* ---------------- 控制流 ---------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debounce(fn, wait) {
  let timer = null;
  return function () {
    const args = arguments;
    const self = this;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(self, args);
    }, wait || 300);
  };
}

function throttle(fn, wait) {
  let last = 0;
  return function () {
    const now = Date.now();
    if (now - last < (wait || 500)) return;
    last = now;
    fn.apply(this, arguments);
  };
}

/** 并发池：按 concurrency 并发执行 tasks，单项失败不阻塞整体 */
function runPool(items, worker, concurrency) {
  const list = items.slice();
  const limit = Math.max(1, concurrency || 3);
  const results = new Array(list.length);
  let cursor = 0;

  return new Promise((resolve) => {
    let running = 0;
    let finished = 0;

    function next() {
      while (running < limit && cursor < list.length) {
        const index = cursor++;
        running++;
        Promise.resolve()
          .then(() => worker(list[index], index))
          .then(
            (r) => {
              results[index] = { ok: true, value: r };
            },
            (e) => {
              results[index] = { ok: false, error: e };
            }
          )
          .then(() => {
            running--;
            finished++;
            if (finished === list.length) resolve(results);
            else next();
          });
      }
      if (list.length === 0) resolve(results);
    }

    next();
  });
}

/* ---------------- 校验 ---------------- */

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function isPhone(v) {
  return /^1[3-9]\d{9}$/.test(String(v || ''));
}

function isEmail(v) {
  return /^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(String(v || ''));
}

function randomId(prefix) {
  return (
    (prefix || 'id') +
    '_' +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

/* ---------------- 交互反馈 ---------------- */

function toast(title, icon) {
  wx.showToast({ title: String(title || ''), icon: icon || 'none', duration: 1800 });
}

function loading(title) {
  wx.showLoading({ title: title || '处理中', mask: true });
}

function hideLoading() {
  try {
    wx.hideLoading();
  } catch (e) {
    /* 忽略 */
  }
}

function confirm(content, title) {
  return new Promise((resolve) => {
    wx.showModal({
      title: title || '提示',
      content: String(content || ''),
      confirmColor: '#185FA5',
      success: (res) => resolve(!!res.confirm),
      fail: () => resolve(false)
    });
  });
}

function prompt(placeholder, title) {
  return new Promise((resolve) => {
    wx.showModal({
      title: title || '请输入',
      editable: true,
      placeholderText: placeholder || '',
      confirmColor: '#185FA5',
      success: (res) => resolve(res.confirm ? (res.content || '') : null),
      fail: () => resolve(null)
    });
  });
}

function copy(text) {
  return new Promise((resolve) => {
    wx.setClipboardData({
      data: String(text || ''),
      success: () => resolve(true),
      fail: () => resolve(false)
    });
  });
}

/* ---------------- 权限 ---------------- */

/** 申请相册写入权限（保存图片/视频用） */
function ensureAlbumAuth() {
  return new Promise((resolve) => {
    wx.getSetting({
      success: (res) => {
        const auth = res.authSetting || {};
        if (auth['scope.writePhotosAlbum'] === true) return resolve(true);
        if (auth['scope.writePhotosAlbum'] === false) {
          wx.showModal({
            title: '需要相册权限',
            content: '保存结果需要你把相册权限打开，是否现在去设置？',
            confirmColor: '#185FA5',
            success: (m) => {
              if (!m.confirm) return resolve(false);
              wx.openSetting({
                success: (s) => resolve(!!(s.authSetting || {})['scope.writePhotosAlbum']),
                fail: () => resolve(false)
              });
            },
            fail: () => resolve(false)
          });
          return;
        }
        wx.authorize({
          scope: 'scope.writePhotosAlbum',
          success: () => resolve(true),
          fail: () => resolve(false)
        });
      },
      fail: () => resolve(false)
    });
  });
}

/**
 * 下载远端文件到本地临时路径，带进度回调
 * @param {string} url 远端地址，或后端相对路径（如 output/videos/x.mp4）
 * @param {function} [onProgress] (percent 0-100) => void
 * @returns {Promise<string>} tempFilePath
 */
function downloadFile(url, onProgress) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error('文件地址不存在'));

    const raw = String(url);

    // 只放行真正的小程序本地路径前缀：
    //   wxfile://  http://tmp/  https://tmp/  wxblob://  file://  /var/  /tmp/  /storage/
    // 其余非 http(s) 的裸相对路径（后端 fileID，如 output/videos/x.mp4）
    // 必须补全成后端静态地址，否则会被误当成本地路径直接返回，
    // 后续 saveVideoToPhotosAlbum / saveImageToPhotosAlbum 必然失败。
    const isMiniLocal =
      /^(wxfile|wxblob|file):\/\//i.test(raw) ||
      /^https?:\/\/tmp\//i.test(raw) ||
      /^\/(var|tmp|storage)\//i.test(raw);

    if (isMiniLocal) return resolve(raw);

    let target = raw;
    if (!/^https?:\/\//i.test(target)) {
      const base = String(API_BASE_URL || '').replace(/\/+$/, '');
      if (!base) return reject(new Error('后端地址未配置，无法下载'));
      target = base + '/files/' + target.replace(/^\/+/, '');
    }

    const task = wx.downloadFile({
      url: target,
      timeout: 300000,
      success: (res) => {
        if (res.statusCode === 200) return resolve(res.tempFilePath);
        if (res.statusCode === 404) return reject(new Error('文件已过期或被清理'));
        reject(new Error('下载失败（' + res.statusCode + '）'));
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('timeout') > -1) return reject(new Error('下载超时，请检查网络后重试'));
        if (msg.indexOf('domain') > -1) return reject(new Error('请在「详情→本地设置」勾选「不校验合法域名」'));
        reject(new Error('下载失败：' + (msg || '网络异常')));
      }
    });

    if (task && task.onProgressUpdate && typeof onProgress === 'function') {
      task.onProgressUpdate((p) => onProgress(Number(p.progress) || 0, p));
    }
  });
}

/* ---------------- 文件名 / 格式 ---------------- */

/** 取扩展名（小写，不含点），取不到返回 '' */
function extName(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  if (i < 0 || i === s.length - 1) return '';
  const ext = s.slice(i + 1).toLowerCase();
  return /^[a-z0-9]{1,6}$/.test(ext) ? ext : '';
}

/** 展开名 → 展示名（mp4 → MP4） */
function extLabel(ext) {
  return String(ext || '').toUpperCase();
}

/** 从路径/地址/文件名里推断扩展名，优先用显式传入的 fileName */
function guessExt(url, fileName, type) {
  const fromName = extName(fileName);
  if (fromName) return fromName;
  const fromUrl = extName(String(url || '').split('?')[0].split('#')[0]);
  if (fromUrl) return fromUrl;
  return type === 'video' ? 'mp4' : 'png';
}

/**
 * 生成下载用的默认文件名：时间戳 + 类型
 * 形如 20260930_190002_去水印视频.mp4
 * @param {string} type 'video' | 'image'
 * @param {string} url 结果地址（用于推断扩展名）
 * @param {string} [fileName] 原文件名（用于推断扩展名）
 * @returns {string}
 */
function defaultFileName(type, url, fileName) {
  const now = new Date();
  const stamp =
    now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
    '_' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
  const label = type === 'video' ? '去水印视频' : '去水印图片';
  const ext = guessExt(url, fileName, type);
  return stamp + '_' + label + '.' + ext;
}

/**
 * 保存到小程序本地文件系统并重命名（saveFile 支持自定义 filePath，从而落地为规范文件名）
 * 失败时返回原始临时路径，不阻断主流程
 * @param {string} tempFilePath downloadFile 得到的临时路径
 * @param {string} fileName 目标文件名
 * @returns {Promise<string>} 落地后的路径
 */
function renameLocalFile(tempFilePath, fileName) {
  return new Promise((resolve) => {
    if (!tempFilePath || !fileName) return resolve(tempFilePath);
    try {
      const fs = wx.getFileSystemManager();
      const target = wx.env.USER_DATA_PATH + '/' + fileName;
      fs.saveFile({
        tempFilePath,
        filePath: target,
        success: (res) => resolve((res && res.savedFilePath) || target),
        fail: () => resolve(tempFilePath)
      });
    } catch (e) {
      resolve(tempFilePath);
    }
  });
}

/** 打开文档（视频用 video 类型，图片用 image），失败静默 */
function openDocument(filePath, fileType) {
  return new Promise((resolve) => {
    const type = fileType || (/\.(mp4|mov|m4v|avi|mkv)$/i.test(filePath) ? 'video' : 'image');
    wx.openDocument({
      filePath,
      fileType: type === 'video' ? 'mp4' : type,
      showMenu: true,
      success: () => resolve(true),
      fail: () => resolve(false)
    });
  });
}

module.exports = {
  formatSize,
  formatDuration,
  humanDuration,
  formatTime,
  relativeTime,
  maskName,
  pad,
  sleep,
  debounce,
  throttle,
  runPool,
  clamp,
  isPhone,
  isEmail,
  randomId,
  toast,
  loading,
  hideLoading,
  confirm,
  prompt,
  copy,
  ensureAlbumAuth,
  downloadFile,
  extName,
  extLabel,
  guessExt,
  defaultFileName,
  renameLocalFile,
  openDocument
};
