/**
 * 文件存储：server 本地磁盘（uploads 目录）
 * - fileID = 相对 uploads 的路径，如 output/images/xxx.jpg
 * - 通过 GET /files/<fileID> 静态访问
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BizError } = require('./biz');

let rootDir = '';

/**
 * 设置存储根目录并确保存在。
 * 可运行时调用（后台修改「存储路径」后立即生效，无需重启）。
 * @param {string} dir 绝对路径，或以 server 目录为基准的相对路径
 */
function setRoot(dir) {
  rootDir = path.isAbsolute(dir) ? path.normalize(dir) : path.join(__dirname, '..', dir);
  fs.mkdirSync(rootDir, { recursive: true });
  return rootDir;
}

function init(dir) {
  return setRoot(dir);
}

function getRoot() {
  if (!rootDir) throw new Error('文件存储未初始化');
  return rootDir;
}

/** 校验 fileID 合法（防止 ../ 穿越），并返回绝对路径 */
function absOf(fileID) {
  const rel = String(fileID || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.indexOf('..') > -1) throw new BizError(404, '文件不存在');
  const abs = path.join(getRoot(), rel);
  if (abs.indexOf(getRoot()) !== 0) throw new BizError(404, '文件不存在');
  return { rel, abs };
}

/** 保存 Buffer，返回 fileID */
function save(buffer, dir, ext) {
  const safeDir = String(dir || 'misc')
    .replace(/\\/g, '/')
    .replace(/[^a-zA-Z0-9/_-]/g, '')
    .replace(/^\/+|\/+$/g, '') || 'misc';

  const name = Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex') + (ext || '.bin');
  const rel = safeDir + '/' + name;
  const abs = path.join(getRoot(), rel);

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return rel;
}

/** 读取文件（不存在返回 null） */
function read(fileID) {
  try {
    const { abs } = absOf(fileID);
    return fs.readFileSync(abs);
  } catch (e) {
    return null;
  }
}

/** 删除文件（容错：不存在不算失败），返回实际删除数 */
function remove(fileIDs) {
  const list = Array.isArray(fileIDs) ? fileIDs : [fileIDs];
  let n = 0;
  list.filter(Boolean).forEach((id) => {
    try {
      const { abs } = absOf(id);
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        n++;
      }
    } catch (e) {
      /* 单个失败不阻断 */
    }
  });
  return n;
}

/** 供静态服务使用 */
function staticRoot() {
  return getRoot();
}

module.exports = { init, setRoot, absOf, save, read, remove, staticRoot, getRoot };
