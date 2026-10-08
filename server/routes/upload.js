/**
 * 上传与文件删除：/api/upload、/api/file/remove
 * 文件存本地磁盘（lib/files），通过 /files/<fileID> 静态访问
 */

'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');
const files = require('../lib/files');
const storage = require('../lib/storage');
const { ok, wrap } = require('../lib/resp');
const { BizError } = require('../lib/biz');
const auth = require('../lib/auth');

const MAX_MB = 200;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 }
});

const ALLOWED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp',
  '.mp4', '.mov', '.m4v', '.avi', '.webm'
]);

function register(app) {
  const r = express.Router();

  // 上传（需登录）
  r.post('/upload', auth.requireUser, upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw new BizError(500, '未收到文件');

    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw new BizError(500, '不支持的文件类型：' + (ext || '未知'));

    // 前端传的是语义目录（src/output/thumb/…），由 storage 映射为后台配置的实际目录名
    const dir = String((req.body && req.body.dir) || 'misc');
    const fileID = files.save(req.file.buffer, storage.mapUploadDir(dir), ext);

    ok(res, {
      fileID,
      url: '/files/' + fileID,
      size: req.file.size
    });
  }));

  // 删除文件（需登录；仅能删 uploads 内的文件）
  r.post('/remove', auth.requireUser, wrap(async (req, res) => {
    const list = (Array.isArray(req.body.fileIDs) ? req.body.fileIDs : [req.body.fileIDs])
      .filter(Boolean).slice(0, 100);
    const n = files.remove(list);
    ok(res, { deleted: n });
  }));

  app.use('/api', r);          // → /api/upload、/api/file/remove
  app.use('/api/file', r);     // → /api/file/upload（兼容另一种写法）
}

module.exports = { register };
