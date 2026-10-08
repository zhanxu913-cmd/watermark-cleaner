/**
 * 任务接口：/api/job/*
 *   create / list / detail / remove / removeAll / retry / stats / markSaved
 * 全部要求用户登录，且只能操作自己的记录
 */

'use strict';

const express = require('express');
const db = require('../db');
const files = require('../lib/files');
const { ok, wrap } = require('../lib/resp');
const { BizError } = require('../lib/biz');
const auth = require('../lib/auth');
const quota = require('../lib/quota');
const settingsLib = require('../lib/settings');
const { shapeJob } = require('../lib/shape');

function register(app, ctx) {
  const r = express.Router();
  r.use(auth.requireUser);

  // ---------- 创建图片任务（图片已在本地处理完，这里落库 + 扣配额） ----------
  r.post('/create', wrap(async (req, res) => {
    const b = req.body || {};
    const type = b.type === 'video' ? 'video' : 'image';
    if (type !== 'image') throw new BizError(500, '视频任务请走视频提交接口');

    const s = await settingsLib.getSettings();
    const q = await quota.consume(req.user.id, 'image', s);

    const id = auth.randomId('j');
    const keepMs = Math.max(1, Number(s.cloudKeepHours) || 1) * 3600 * 1000;

    await db.exec(
      'INSERT INTO wc_jobs (id, openid, type, mode, status, progress, file_name, strength, width, height, region_count, out_file, thumb_file, out_size, created_at, finished_at, expires_at) ' +
      'VALUES (?, ?, ?, ?, "done", 100, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?)',
      [
        id, req.user.openid, 'image',
        String(b.mode || '').slice(0, 16),
        String(b.fileName || '').slice(0, 250),
        Math.floor(Number(b.strength) || 0),
        Math.floor(Number(b.width) || 0),
        Math.floor(Number(b.height) || 0),
        Math.floor(Number(b.regionCount) || 0),
        String(b.outFileID || '').slice(0, 250),
        String(b.thumbFileID || '').slice(0, 250),
        Math.floor(Number(b.outSize) || 0),
        new Date(Date.now() + keepMs)
      ]
    );

    ok(res, { jobId: id, remainImage: q.remain, used: q.used, limit: q.limit });
  }));

  // ---------- 列表 ----------
  r.post('/list', wrap(async (req, res) => {
    const b = req.body || {};
    const page = Math.max(1, Math.floor(Number(b.page) || 1));
    const pageSize = Math.min(50, Math.max(5, Math.floor(Number(b.pageSize) || 15)));

    const where = ['openid = ?'];
    const params = [req.user.openid];

    if (b.type === 'image' || b.type === 'video') {
      where.push('type = ?');
      params.push(b.type);
    }
    if (b.status && ['pending', 'processing', 'done', 'failed'].indexOf(b.status) > -1) {
      where.push('status = ?');
      params.push(b.status);
    }
    if (b.unsaved) {
      where.push('saved = 0 AND status = "done"');
    }
    if (b.keyword) {
      where.push('file_name LIKE ?');
      params.push('%' + String(b.keyword).slice(0, 50) + '%');
    }

    const whereSql = 'WHERE ' + where.join(' AND ');
    const totalRow = await db.get('SELECT COUNT(*) AS n FROM wc_jobs ' + whereSql, params);
    const rows = await db.query(
      'SELECT * FROM wc_jobs ' + whereSql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
      params.concat([pageSize, (page - 1) * pageSize])
    );

    ok(res, {
      list: rows.map(shapeJob),
      total: totalRow.n,
      page,
      pageSize,
      hasMore: page * pageSize < totalRow.n
    });
  }));

  // ---------- 详情 ----------
  r.post('/detail', wrap(async (req, res) => {
    const row = await db.get('SELECT * FROM wc_jobs WHERE id = ?', [String(req.body.id || '')]);
    if (!row || row.openid !== req.user.openid) throw new BizError(404, '记录不存在');
    ok(res, { job: shapeJob(row) });
  }));

  // ---------- 删除（连同磁盘文件） ----------
  r.post('/remove', wrap(async (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids])
      .filter(Boolean).map((v) => String(v)).slice(0, 100);
    if (!ids.length) return ok(res, { deleted: 0 });

    const marks = ids.map(() => '?').join(',');
    const rows = await db.query(
      'SELECT * FROM wc_jobs WHERE id IN (' + marks + ') AND openid = ?',
      ids.concat([req.user.openid])
    );

    const fileList = [];
    rows.forEach((row) => {
      [row.src_file, row.out_file, row.thumb_file].filter(Boolean).forEach((f) => fileList.push(f));
    });
    files.remove(fileList);

    await db.exec('DELETE FROM wc_jobs WHERE id IN (' + marks + ') AND openid = ?', ids.concat([req.user.openid]));
    ok(res, { deleted: rows.length });
  }));

  // ---------- 清空 ----------
  r.post('/removeAll', wrap(async (req, res) => {
    let deleted = 0;
    for (let i = 0; i < 20; i++) {
      const rows = await db.query(
        'SELECT * FROM wc_jobs WHERE openid = ? LIMIT 500',
        [req.user.openid]
      );
      if (!rows.length) break;

      const fileList = [];
      rows.forEach((row) => {
        [row.src_file, row.out_file, row.thumb_file].filter(Boolean).forEach((f) => fileList.push(f));
      });
      files.remove(fileList);

      const ids = rows.map((row) => row.id);
      await db.exec(
        'DELETE FROM wc_jobs WHERE id IN (' + ids.map(() => '?').join(',') + ')',
        ids
      );
      deleted += rows.length;
    }
    ok(res, { deleted });
  }));

  // ---------- 重试（仅视频） ----------
  r.post('/retry', wrap(async (req, res) => {
    const row = await db.get('SELECT * FROM wc_jobs WHERE id = ?', [String(req.body.id || '')]);
    if (!row || row.openid !== req.user.openid) throw new BizError(404, '记录不存在');
    if (row.type !== 'video') throw new BizError(500, '只有视频任务支持重试');
    if (row.status === 'processing' || row.status === 'pending') throw new BizError(500, '任务正在处理中');

    await db.exec(
      'UPDATE wc_jobs SET status = "pending", progress = 0, error = "", out_file = "", finished_at = NULL WHERE id = ?',
      [row.id]
    );
    if (ctx && ctx.videoQueue) ctx.videoQueue.push(row.id);
    ok(res, { jobId: row.id, status: 'pending' });
  }));

  // ---------- 个人统计 ----------
  r.post('/stats', wrap(async (req, res) => {
    const openid = req.user.openid;
    const totalRow = await db.get('SELECT COUNT(*) AS n FROM wc_jobs WHERE openid = ?', [openid]);
    const monthRow = await db.get(
      'SELECT COUNT(*) AS n FROM wc_jobs WHERE openid = ? AND created_at >= DATE_FORMAT(NOW(), "%Y-%m-01")',
      [openid]
    );
    const unsavedRow = await db.get(
      'SELECT COUNT(*) AS n FROM wc_jobs WHERE openid = ? AND saved = 0 AND status = "done"',
      [openid]
    );
    ok(res, { total: totalRow.n, month: monthRow.n, unsaved: unsavedRow.n });
  }));

  // ---------- 标记已保存到相册 ----------
  r.post('/markSaved', wrap(async (req, res) => {
    await db.exec('UPDATE wc_jobs SET saved = 1 WHERE id = ? AND openid = ?', [
      String(req.body.id || ''), req.user.openid
    ]);
    ok(res, { done: true });
  }));

  app.use('/api/job', r);
}

module.exports = { register };
