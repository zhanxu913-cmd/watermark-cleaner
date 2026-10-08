/**
 * 视频接口：/api/videoProc/*
 *   submit  提交视频处理任务（扣视频配额 → 落库 pending → 入队）
 *   status  轮询任务状态
 *   service 探测视频处理可用性（FFmpeg 是否就绪）
 */

'use strict';

const { execFile } = require('child_process');
const express = require('express');
const db = require('../db');
const binpath = require('../lib/binpath');
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

  // ---------- 提交 ----------
  r.post('/submit', wrap(async (req, res) => {
    const b = req.body || {};
    const s = await settingsLib.getSettings();

    if (!s.videoServiceEnabled) {
      throw new BizError(503, '视频处理功能未开启，请联系管理员');
    }

    const srcFileID = String(b.srcFileID || '').trim();
    if (!srcFileID) throw new BizError(500, '缺少视频文件');
    files.absOf(srcFileID); // 校验路径合法性

    const duration = Number(b.duration) || 0;
    if (s.maxVideoDuration > 0 && duration > s.maxVideoDuration + 1) {
      throw new BizError(500, '视频时长超过上限（' + s.maxVideoDuration + ' 秒）');
    }

    // 扣视频配额（429 = 今日次数用完）
    const q = await quota.consume(req.user.id, 'video', s);

    const id = auth.randomId('v');
    await db.exec(
      'INSERT INTO wc_jobs (id, openid, type, mode, status, progress, file_name, region, time_range, duration, src_file, thumb_file, size, created_at) ' +
      'VALUES (?, ?, "video", ?, "pending", 0, ?, ?, ?, ?, ?, ?, ?, NOW())',
      [
        id, req.user.openid,
        String(b.mode || 'fill').slice(0, 16),
        String(b.fileName || '').slice(0, 250),
        JSON.stringify({ regions: normalizeRegions(b) }),
        JSON.stringify(b.timeRange || null),
        duration,
        srcFileID,
        String(b.thumbFileID || '').slice(0, 250),
        Math.floor(Number(b.size) || 0)
      ]
    );

    if (ctx && ctx.videoQueue) ctx.videoQueue.push(id);

    ok(res, { jobId: id, status: 'pending', remainVideo: q.remain, used: q.used, limit: q.limit });
  }));

  // ---------- 轮询状态 ----------
  r.post('/status', wrap(async (req, res) => {
    const row = await db.get('SELECT * FROM wc_jobs WHERE id = ?', [String(req.body.id || '')]);
    if (!row || row.openid !== req.user.openid) throw new BizError(404, '任务不存在');

    const p = Number(row.progress) || 0;
    ok(res, {
      status: row.status,
      progress: p,
      progressText:
        row.status === 'processing'
          ? '处理中 ' + p + '%'
          : row.status === 'pending'
            ? '排队中…'
            : '',
      error: row.error || '',
      job: shapeJob(row)
    });
  }));

  // ---------- 服务可用性 ----------
  r.post('/service', wrap(async (req, res) => {
    const s = await settingsLib.getSettings();
    const ffmpegOk = await probeFfmpeg();
    const bins = binpath.describe();
    ok(res, {
      enabled: !!s.videoServiceEnabled,
      ffmpeg: ffmpegOk,
      available: !!s.videoServiceEnabled && ffmpegOk,
      // 实际使用的可执行文件与来源：换电脑后自检时看这两个字段最直观
      ffmpegPath: bins.ffmpeg,
      ffmpegFrom: bins.ffmpegSource,
      message: !s.videoServiceEnabled
        ? '视频处理功能未开启'
        : !ffmpegOk
          ? '未找到可用的 FFmpeg（已尝试 .env 配置 / 项目内置 tools/bin / 系统 PATH）'
          : '视频处理就绪（' + bins.ffmpegSource + '）'
    });
  }));

  app.use('/api/videoProc', r);
}

function normalizeRegions(b) {
  if (Array.isArray(b.regions)) return b.regions;
  if (Array.isArray(b.region)) return b.region;
  if (b.region && b.region.x !== undefined) return [b.region];
  if (b.regions && b.regions.regions) return b.regions.regions;
  return [];
}

function probeFfmpeg() {
  return new Promise((resolve) => {
    execFile(binpath.ffmpeg(), ['-version'], { timeout: 4000 }, (err) => {
      resolve(!err);
    });
  });
}

module.exports = { register };
