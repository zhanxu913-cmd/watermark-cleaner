/**
 * 云函数 job
 * 职责：任务记录的增删查、配额扣减、个人统计
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const C = {
  USERS: 'wc_users',
  JOBS: 'wc_jobs',
  SETTINGS: 'wc_settings'
};

const LIST_FIELD = {
  type: true,
  status: true,
  fileName: true,
  mode: true,
  outFileID: true,
  thumbFileID: true,
  width: true,
  height: true,
  size: true,
  duration: true,
  saved: true,
  error: true,
  progressText: true,
  createdAt: true,
  finishedAt: true,
  expiresAt: true
};

/* ============================================================
   入口
   ============================================================ */

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return fail(401, '无法识别用户身份');

  const action = event.action || 'list';

  try {
    switch (action) {
      case 'create':
        return await create(openid, event);
      case 'list':
        return await list(openid, event);
      case 'detail':
        return await detail(openid, event);
      case 'remove':
        return await remove(openid, event);
      case 'removeAll':
        return await removeAll(openid);
      case 'retry':
        return await retry(openid, event);
      case 'stats':
        return await stats(openid);
      case 'markSaved':
        return await markSaved(openid, event);
      default:
        return fail(400, '未知操作：' + action);
    }
  } catch (e) {
    console.error('[job] error', action, e);
    return fail(500, e.message || '服务异常，请稍后重试');
  }
};

/* ============================================================
   动作
   ============================================================ */

async function create(openid, event) {
  const user = await findUser(openid);
  if (!user) return fail(404, '用户不存在，请重新进入小程序');
  if (user.status === 'banned') return fail(403, user.banReason || '账号已被限制');

  const type = event.type === 'video' ? 'video' : 'image';
  const settings = await getSettings();
  const today = dateKey(new Date());

  // ---- 配额校验 ----
  const limit =
    type === 'video'
      ? user.quotaVideo == null
        ? Number(settings.freeVideoPerDay) || 0
        : Number(user.quotaVideo)
      : user.quotaImage == null
      ? Number(settings.freeImagePerDay) || 0
      : Number(user.quotaImage);

  const used =
    type === 'video'
      ? user.usedVideoDate === today
        ? user.usedVideoToday || 0
        : 0
      : user.usedImageDate === today
      ? user.usedImageToday || 0
      : 0;

  if (used >= limit) {
    return fail(
      429,
      type === 'video' ? '今日视频处理次数已用完' : '今日图片处理次数已用完'
    );
  }

  // ---- 落库 ----
  const now = new Date();
  const keepHours = Number(settings.cloudKeepHours) || 1;
  const isVideo = type === 'video';

  const doc = {
    _openid: openid,
    openid,
    type,
    status: isVideo ? 'pending' : 'done',
    fileName: String(event.fileName || '未命名素材').slice(0, 120),
    mode: event.mode || 'fill',

    srcFileID: String(event.srcFileID || ''),
    outFileID: String(event.outFileID || ''),
    thumbFileID: String(event.thumbFileID || ''),

    width: Number(event.width) || 0,
    height: Number(event.height) || 0,
    size: Number(event.size) || 0,
    duration: Number(event.duration) || 0,

    region: event.region || null,
    timeRange: event.timeRange || null,
    regionCount: Number(event.regionCount) || 0,

    saved: false,
    error: '',
    progress: isVideo ? 0 : 100,
    progressText: isVideo ? '排队中' : '',
    retryCount: 0,

    createdAt: now,
    finishedAt: isVideo ? null : now,
    expiresAt: new Date(now.getTime() + keepHours * 3600 * 1000)
  };

  const res = await db.collection(C.JOBS).add({ data: doc });

  // ---- 扣减配额（用 inc 保证并发下计数准确）----
  const patch = {
    lastActiveAt: now,
    jobCount: _.inc(1)
  };
  if (isVideo) {
    if (user.usedVideoDate !== today) {
      patch.usedVideoDate = today;
      patch.usedVideoToday = 0;
    }
    patch.usedVideoToday = _.inc(1);
  } else {
    if (user.usedImageDate !== today) {
      patch.usedImageDate = today;
      patch.usedImageToday = 0;
    }
    patch.usedImageToday = _.inc(1);
  }
  await db.collection(C.USERS).doc(user._id).update({ data: patch });

  return ok({
    jobId: res._id,
    remain: Math.max(0, limit - used - 1),
    type
  });
}

async function list(openid, event) {
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(event.pageSize) || 20));
  const filter = event.filter || 'all';

  const where = { _openid: openid };

  if (filter === 'image') where.type = 'image';
  else if (filter === 'video') where.type = 'video';
  else if (filter === 'failed') where.status = 'failed';
  else if (filter === 'unsaved') {
    where.status = 'done';
    where.saved = _.neq(true);
  }

  const keyword = String(event.keyword || '').trim();
  if (keyword) {
    where.fileName = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' });
  }

  const res = await db
    .collection(C.JOBS)
    .where(where)
    .orderBy('createdAt', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .field(LIST_FIELD)
    .get();

  return ok({
    list: res.data || [],
    page,
    pageSize,
    hasMore: (res.data || []).length === pageSize
  });
}

async function detail(openid, event) {
  if (!event.id) return fail(400, '缺少记录 id');

  const res = await db.collection(C.JOBS).doc(event.id).get().catch(() => null);
  const job = res && res.data;
  if (!job) return fail(404, '记录不存在或已被删除');
  if (job._openid !== openid) return fail(403, '无权访问该记录');

  return ok(job);
}

async function remove(openid, event) {
  const ids = Array.isArray(event.ids) ? event.ids.filter(Boolean) : [event.ids].filter(Boolean);
  if (!ids.length) return fail(400, '没有指定要删除的记录');
  if (ids.length > 100) return fail(400, '单次最多删除 100 条');

  const res = await db
    .collection(C.JOBS)
    .where({ _id: _.in(ids), _openid: openid })
    .get();

  const rows = res.data || [];
  if (!rows.length) return ok({ removed: 0 });

  await purgeFiles(rows);
  await db.collection(C.JOBS).where({ _id: _.in(ids), _openid: openid }).remove();

  return ok({ removed: rows.length });
}

async function removeAll(openid) {
  const MAX = 500;
  let removed = 0;

  // 分批删，避免一次性拉取过多
  for (let i = 0; i < 20; i++) {
    const res = await db.collection(C.JOBS).where({ _openid: openid }).limit(MAX).get();
    const rows = res.data || [];
    if (!rows.length) break;

    await purgeFiles(rows);
    await db.collection(C.JOBS).where({ _id: _.in(rows.map((r) => r._id)) }).remove();
    removed += rows.length;
    if (rows.length < MAX) break;
  }

  return ok({ removed });
}

async function retry(openid, event) {
  if (!event.id) return fail(400, '缺少记录 id');

  const res = await db.collection(C.JOBS).doc(event.id).get().catch(() => null);
  const job = res && res.data;
  if (!job) return fail(404, '记录不存在');
  if (job._openid !== openid) return fail(403, '无权操作该记录');
  if (job.type !== 'video') return fail(400, '只有视频任务支持重新处理');

  await db.collection(C.JOBS).doc(event.id).update({
    data: {
      status: 'pending',
      error: '',
      progress: 0,
      progressText: '重新排队中',
      retryCount: _.inc(1),
      finishedAt: null
    }
  });

  // 交给 videoProc 重新入队
  try {
    await cloud.callFunction({
      name: 'videoProc',
      data: { action: 'submit', jobId: event.id, requeue: true }
    });
  } catch (e) {
    console.error('[job] retry dispatch failed', e);
    return fail(500, '重新提交失败，请稍后再试');
  }

  return ok({ jobId: event.id });
}

async function stats(openid) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [totalRes, monthRes] = await Promise.all([
    db.collection(C.JOBS).where({ _openid: openid, status: 'done' }).count(),
    db
      .collection(C.JOBS)
      .where({ _openid: openid, status: 'done', createdAt: _.gte(monthStart) })
      .count()
  ]);

  return ok({
    total: totalRes.total || 0,
    month: monthRes.total || 0
  });
}

async function markSaved(openid, event) {
  if (!event.id) return fail(400, '缺少记录 id');

  const res = await db.collection(C.JOBS).doc(event.id).get().catch(() => null);
  const job = res && res.data;
  if (!job) return fail(404, '记录不存在');
  if (job._openid !== openid) return fail(403, '无权操作该记录');

  await db.collection(C.JOBS).doc(event.id).update({
    data: { saved: true, savedAt: new Date() }
  });

  return ok({ updated: 1 });
}

/* ============================================================
   内部工具
   ============================================================ */

/** 删除任务关联的云存储文件（失败不阻断主流程） */
async function purgeFiles(rows) {
  const files = [];
  rows.forEach((j) => {
    if (j.outFileID) files.push(j.outFileID);
    if (j.thumbFileID) files.push(j.thumbFileID);
    if (j.srcFileID) files.push(j.srcFileID);
  });
  if (!files.length) return;

  // 云存储单次最多 50 个
  for (let i = 0; i < files.length; i += 50) {
    const chunk = files.slice(i, i + 50);
    try {
      await cloud.deleteFile({ fileList: chunk });
    } catch (e) {
      console.warn('[job] deleteFile failed', e.message);
    }
  }
}

async function findUser(openid) {
  const res = await db.collection(C.USERS).where({ _openid: openid }).limit(1).get();
  return res.data[0] || null;
}

async function getSettings() {
  const res = await db.collection(C.SETTINGS).where({ _id: 'global' }).limit(1).get();
  return res.data[0] || { _id: 'global', freeImagePerDay: 10, freeVideoPerDay: 1, cloudKeepHours: 1 };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dateKey(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
}

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

function ok(data) {
  return { code: 0, data: data || {}, msg: 'ok' };
}

function fail(code, msg, data) {
  return { code, data: data || null, msg: msg || '请求失败' };
}
