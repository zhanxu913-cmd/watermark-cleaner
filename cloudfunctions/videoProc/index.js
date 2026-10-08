/**
 * 云函数 videoProc
 * 职责：视频处理任务调度 + 接收云托管服务的处理结果回调
 *
 * 两种调用形态：
 *   1) 小程序调用（event.action）—— submit / status / service
 *   2) HTTP 触发（云托管服务回调）—— event.httpMethod 存在时走 handleCallback
 *
 * 视频处理链路：
 *   小程序上传视频 → videoProc.submit → 云托管 video-service（FFmpeg）
 *   → 处理完回调 videoProc（HTTP 触发）→ 写回 wc_jobs
 */

const cloud = require('wx-server-sdk');
const https = require('https');
const http = require('http');
const { URL } = require('url');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const C = {
  JOBS: 'wc_jobs',
  SETTINGS: 'wc_settings',
  USERS: 'wc_users'
};

const DEFAULT_SERVICE_NAME = 'video-service';
const REMOTE_TIMEOUT = 15000;

/* ============================================================
   入口
   ============================================================ */

exports.main = async (event) => {
  // ---------- HTTP 回调 ----------
  if (event && (event.httpMethod || event.headers)) {
    return await handleCallback(event);
  }

  // ---------- 小程序调用 ----------
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return fail(401, '无法识别用户身份');

  const action = event.action || 'status';

  try {
    switch (action) {
      case 'submit':
        return await submit(openid, event);
      case 'status':
        return await status(openid, event);
      case 'service':
        return await service();
      default:
        return fail(400, '未知操作：' + action);
    }
  } catch (e) {
    console.error('[videoProc] error', action, e);
    return fail(500, e.message || '服务异常，请稍后重试');
  }
};

/* ============================================================
   小程序动作
   ============================================================ */

async function submit(openid, event) {
  const settings = await getSettings();

  if (!settings.videoServiceEnabled) {
    return fail(403, '视频服务未启用，请联系管理员');
  }

  const serviceUrl = String(settings.videoServiceUrl || '').trim();
  const serviceName = String(settings.videoServiceName || DEFAULT_SERVICE_NAME).trim();

  if (!serviceUrl && !serviceName) {
    return fail(503, '视频服务地址未配置');
  }

  // 回调地址是链路闭环的前提：没有它就永远收不到处理结果
  const callbackUrl = String(settings.videoCallbackUrl || '').trim();
  if (!callbackUrl) {
    return fail(503, '未配置视频回调地址（videoCallbackUrl），处理结果无法回传');
  }

  let jobId = event.jobId;

  // ---- 首次提交：先创建任务记录（配额在 job 云函数里统一扣减）----
  if (!jobId) {
    const createRes = await cloud.callFunction({
      name: 'job',
      data: {
        action: 'create',
        type: 'video',
        fileName: event.fileName,
        mode: event.mode,
        srcFileID: event.srcFileID,
        thumbFileID: event.thumbFileID,
        duration: event.duration,
        width: event.width,
        height: event.height,
        region: event.region,
        timeRange: event.timeRange
      }
    });

    const r = createRes && createRes.result;
    if (!r || r.code !== 0) {
      return fail((r && r.code) || 500, (r && r.msg) || '创建任务失败');
    }
    jobId = r.data.jobId;
  }

  const job = await getJob(jobId);
  if (!job) return fail(404, '任务不存在');
  if (job._openid !== openid) return fail(403, '无权操作该任务');

  // ---- 下发到云托管服务 ----
  const payload = {
    jobId,
    srcFileID: job.srcFileID,
    thumbFileID: job.thumbFileID,
    mode: job.mode,
    region: job.region,
    timeRange: job.timeRange,
    duration: job.duration,
    keepHours: Number(settings.cloudKeepHours) || 1,
    callbackUrl,
    serviceKey: String(settings.videoServiceKey || '')
  };

  await db.collection(C.JOBS).doc(jobId).update({
    data: { status: 'processing', progress: 5, progressText: '已下发处理', dispatchedAt: new Date() }
  });

  try {
    const res = await postJson(serviceUrl, payload);
    if (!res || res.statusCode >= 300) {
      throw new Error('服务返回状态 ' + ((res && res.statusCode) || '未知'));
    }
    return ok({ jobId, dispatched: true, service: res.body || null });
  } catch (e) {
    console.error('[videoProc] dispatch failed', e.message);
    await db.collection(C.JOBS).doc(jobId).update({
      data: {
        status: 'failed',
        error: '视频服务不可达：' + (e.message || '未知原因'),
        progressText: '',
        finishedAt: new Date()
      }
    });
    return fail(502, '视频服务不可达，请稍后重试或联系管理员');
  }
}

async function status(openid, event) {
  if (!event.id) return fail(400, '缺少任务 id');

  const job = await getJob(event.id);
  if (!job) return fail(404, '任务不存在');
  if (job._openid !== openid) return fail(403, '无权查看该任务');

  return ok({
    _id: job._id,
    status: job.status,
    progress: job.progress || 0,
    progressText: job.progressText || '',
    error: job.error || '',
    outFileID: job.outFileID || ''
  });
}

async function service() {
  const settings = await getSettings();
  const url = String(settings.videoServiceUrl || '').trim();
  const enabled = !!settings.videoServiceEnabled;

  if (!enabled || !url) {
    return ok({ available: false, reason: enabled ? '未配置服务地址' : '管理员未开启视频服务' });
  }

  try {
    const res = await postJson(joinUrl(url, '/api/ping'), { ping: true });
    const body = (res && res.body) || {};
    return ok({
      available: res.statusCode === 200 && body.ok !== false,
      version: body.version || '',
      ffmpeg: !!body.ffmpeg
    });
  } catch (e) {
    return ok({ available: false, reason: e.message || '服务不可达' });
  }
}

/* ============================================================
   HTTP 回调（云托管服务处理完成后调用）
   ============================================================ */

async function handleCallback(event) {
  const method = (event.httpMethod || 'POST').toUpperCase();

  if (method === 'OPTIONS') {
    return httpRes(204, null);
  }
  if (method === 'GET') {
    return httpRes(200, { ok: true, hint: 'videoProc callback endpoint' });
  }

  let body = event.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  body = body || {};

  const settings = await getSettings();
  const expectKey = String(settings.videoServiceKey || '');
  const gotKey = String(body.serviceKey || '');

  if (expectKey && gotKey !== expectKey) {
    console.warn('[videoProc] callback key mismatch');
    return httpRes(403, { error: 'invalid serviceKey' });
  }

  const jobId = body.jobId;
  if (!jobId) return httpRes(400, { error: 'missing jobId' });

  const patch = { callbackAt: new Date() };

  if (body.progress !== undefined) {
    const p = Number(body.progress);
    if (isFinite(p)) patch.progress = Math.max(0, Math.min(100, Math.round(p)));
  }
  if (body.progressText) patch.progressText = String(body.progressText).slice(0, 60);
  if (body.outFileID) patch.outFileID = String(body.outFileID);
  if (body.size) patch.size = Number(body.size) || 0;
  if (body.width) patch.width = Number(body.width) || 0;
  if (body.height) patch.height = Number(body.height) || 0;
  if (body.thumbFileID) patch.thumbFileID = String(body.thumbFileID);

  const status = body.status;

  if (status === 'done') {
    patch.status = 'done';
    patch.progress = 100;
    patch.progressText = '处理完成';
    patch.error = '';
    patch.finishedAt = new Date();
  } else if (status === 'failed') {
    patch.status = 'failed';
    patch.error = String(body.error || '处理失败').slice(0, 200);
    patch.progressText = '';
    patch.finishedAt = new Date();
  } else if (status === 'processing') {
    patch.status = 'processing';
    if (!patch.progressText) patch.progressText = '处理中';
  }

  try {
    await db.collection(C.JOBS).doc(jobId).update({ data: patch });

    // 清理不再需要的源视频（结果已生成）
    if (patch.status === 'done' && body.deleteSrc !== false) {
      const job = await getJob(jobId);
      if (job && job.srcFileID) {
        try {
          await cloud.deleteFile({ fileList: [job.srcFileID] });
          await db.collection(C.JOBS).doc(jobId).update({ data: { srcFileID: '' } });
        } catch (e) {
          console.warn('[videoProc] delete src failed', e.message);
        }
      }
    }

    return httpRes(200, { ok: true, jobId, status: patch.status || 'processing' });
  } catch (e) {
    console.error('[videoProc] callback write failed', e);
    return httpRes(500, { error: e.message || 'write failed' });
  }
}

/* ============================================================
   内部工具
   ============================================================ */

async function getJob(id) {
  const res = await db.collection(C.JOBS).doc(id).get().catch(() => null);
  return (res && res.data) || null;
}

async function getSettings() {
  const res = await db.collection(C.SETTINGS).where({ _id: 'global' }).limit(1).get();
  return (
    res.data[0] || {
      _id: 'global',
      videoServiceEnabled: false,
      videoServiceUrl: '',
      cloudKeepHours: 1
    }
  );
}

function postJson(urlStr, payload) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(new Error('服务地址格式不正确'));
    }

    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(payload || {});

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data)
        },
        timeout: REMOTE_TIMEOUT
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(raw);
          } catch (e) {
            body = { raw: raw.slice(0, 500) };
          }
          resolve({ statusCode: res.statusCode, body });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('请求服务超时')));
    req.on('error', (e) => reject(new Error(e.message || '网络错误')));
    req.write(data);
    req.end();
  });
}

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return b + '/' + p;
}

function httpRes(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-admin-key'
    },
    body: body ? JSON.stringify(body) : ''
  };
}

function ok(data) {
  return { code: 0, data: data || {}, msg: 'ok' };
}

function fail(code, msg, data) {
  return { code, data: data || null, msg: msg || '请求失败' };
}
