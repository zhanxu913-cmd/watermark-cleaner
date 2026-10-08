/**
 * 云开发（云存储）访问封装
 *
 * 微信云托管容器与云开发环境绑定后，@cloudbase/node-sdk 会自动获得容器内的
 * 临时凭证，无需把 SecretId 写进代码。若部署在自有服务器，可通过环境变量
 * CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY 显式注入。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

let tcb = null;
try {
  tcb = require('@cloudbase/node-sdk');
} catch (e) {
  tcb = null;
}

let app = null;

function getApp() {
  if (app) return app;
  if (!tcb) {
    throw new Error('缺少依赖 @cloudbase/node-sdk，请先执行 npm install');
  }

  const env =
    process.env.CLOUDBASE_ENV_ID ||
    process.env.CBR_ENV_ID ||
    process.env.TCB_ENV_ID ||
    '';

  const config = { env };
  const secretId = process.env.CLOUDBASE_SECRET_ID;
  const secretKey = process.env.CLOUDBASE_SECRET_KEY;
  if (secretId && secretKey) {
    config.secretId = secretId;
    config.secretKey = secretKey;
  }

  app = tcb.init(config);
  return app;
}

/* ============================================================
   下载
   ============================================================ */

/**
 * 把云存储文件下载到本地
 * 优先用临时链接流式下载（不占内存），失败再退回 SDK 下载
 */
async function downloadFileID(fileID, destPath, onProgress) {
  ensureDir(path.dirname(destPath));

  const url = await getTempUrl(fileID);
  if (url) {
    try {
      await streamDownload(url, destPath, onProgress);
      return destPath;
    } catch (e) {
      console.warn('[cloud] stream download failed, fallback to sdk:', e.message);
    }
  }

  const res = await getApp().downloadFile({ fileID });
  const content = res.fileContent || res.fileContentBuffer;
  if (!content) throw new Error('云存储下载失败：返回内容为空');

  await writeStreamOrBuffer(content, destPath);
  return destPath;
}

async function getTempUrl(fileID) {
  try {
    const res = await getApp().getTempFileURL({ fileList: [fileID] });
    const first = (res.fileList || [])[0];
    if (first && first.tempFileURL) return first.tempFileURL;
    return '';
  } catch (e) {
    console.warn('[cloud] getTempFileURL failed:', e.message);
    return '';
  }
}

function streamDownload(urlStr, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(new Error('临时链接格式不正确'));
    }

    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        headers: { 'user-agent': 'watermark-service/1.0' },
        timeout: 60000
      },
      (res) => {
        // 跟随重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return streamDownload(new URL(res.headers.location, urlStr).toString(), destPath, onProgress)
            .then(resolve)
            .catch(reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('下载返回状态 ' + res.statusCode));
        }

        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        const out = fs.createWriteStream(destPath);

        res.on('data', (c) => {
          got += c.length;
          if (total && typeof onProgress === 'function') {
            onProgress(Math.min(0.99, got / total));
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(destPath)));
        out.on('error', reject);
        res.on('error', reject);
      }
    );

    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

/* ============================================================
   上传
   ============================================================ */

/**
 * 上传本地文件到云存储
 * @returns {Promise<{fileID:string, cloudPath:string}>}
 */
async function uploadFile(localPath, cloudPath) {
  const res = await getApp().uploadFile({
    cloudPath,
    fileContent: fs.createReadStream(localPath)
  });

  const fileID = res.fileID || (res.fileList && res.fileList[0] && res.fileList[0].fileID);
  if (!fileID) throw new Error('云存储上传失败：未返回 fileID');
  return { fileID, cloudPath };
}

async function removeFiles(fileIDs) {
  const list = (Array.isArray(fileIDs) ? fileIDs : [fileIDs]).filter(Boolean);
  if (!list.length) return { deleted: 0 };
  try {
    const res = await getApp().deleteFile({ fileList: list });
    return { deleted: ((res && res.fileList) || []).length };
  } catch (e) {
    console.warn('[cloud] deleteFile failed:', e.message);
    return { deleted: 0 };
  }
}

/** 探测 SDK 是否可用（健康检查用） */
async function selfCheck() {
  if (!tcb) return { ok: false, reason: '未安装 @cloudbase/node-sdk' };
  const env =
    process.env.CLOUDBASE_ENV_ID || process.env.CBR_ENV_ID || process.env.TCB_ENV_ID || '';
  if (!env) return { ok: false, reason: '未配置云环境 ID（CLOUDBASE_ENV_ID / CBR_ENV_ID）' };
  return { ok: true, env };
}

/* ============================================================
   工具
   ============================================================ */

function ensureDir(dir) {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* 已存在 */
  }
}

function writeStreamOrBuffer(content, destPath) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(content)) {
      fs.writeFile(destPath, content, (e) => (e ? reject(e) : resolve(destPath)));
      return;
    }
    if (typeof content === 'string') {
      fs.writeFile(destPath, content, 'binary', (e) => (e ? reject(e) : resolve(destPath)));
      return;
    }
    // 可读流
    const out = fs.createWriteStream(destPath);
    content.pipe(out);
    out.on('finish', () => out.close(() => resolve(destPath)));
    out.on('error', reject);
  });
}

function safeExt(fileID, fallback) {
  const m = /\.([a-zA-Z0-9]{2,5})(\?|$)/.exec(String(fileID || ''));
  return m ? '.' + m[1].toLowerCase() : fallback || '.mp4';
}

module.exports = {
  getApp,
  downloadFileID,
  getTempUrl,
  uploadFile,
  removeFiles,
  selfCheck,
  ensureDir,
  safeExt
};
