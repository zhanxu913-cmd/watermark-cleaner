/**
 * 云函数 admin
 * 职责：管理后台统一入口（小程序端 + Web 端共用一套 action）
 *
 * 两种调用形态：
 *   1) 小程序调用（event.action）—— 走 openid 白名单 + 密钥双重校验
 *   2) HTTP 触发（Web 管理后台）—— 校验 x-admin-key / ?key=，视为超级管理员
 *
 * 鉴权模型：
 *   - 读操作：运营（operator）及以上
 *   - 写操作：超级管理员（super）
 *   - check 动作例外：只校验 openid 白名单，仅回显调用者自己的身份
 *
 * 统一信封：{ code, data, msg }
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

const C = {
  USERS: 'wc_users',
  JOBS: 'wc_jobs',
  ADMINS: 'wc_admins',
  LOGS: 'wc_logs',
  SETTINGS: 'wc_settings'
};

const DEFAULT_SETTINGS = {
  freeImagePerDay: 10,
  freeVideoPerDay: 1,
  maxVideoDuration: 60,
  maxVideoSizeMB: 100,
  videoServiceEnabled: false,
  videoServiceUrl: '',
  videoServiceName: 'video-service',
  videoCallbackUrl: '',
  videoServiceKey: '',
  registerEnabled: true,
  globalNotice: '',
  maintenanceNotice: '',
  copyrightTip: '请仅处理你拥有版权的素材。去除他人作品水印可能构成侵权。',
  cloudKeepHours: 1,
  adminKey: ''
};

// 可写字段白名单（其余字段一律忽略，避免前端越权写入）
const EDIT_KEYS = [
  'freeImagePerDay',
  'freeVideoPerDay',
  'maxVideoDuration',
  'maxVideoSizeMB',
  'videoServiceEnabled',
  'videoServiceUrl',
  'videoServiceName',
  'videoCallbackUrl',
  'videoServiceKey',
  'registerEnabled',
  'globalNotice',
  'maintenanceNotice',
  'copyrightTip',
  'cloudKeepHours',
  'adminKey'
];

const NUM_KEYS = [
  'freeImagePerDay',
  'freeVideoPerDay',
  'maxVideoDuration',
  'maxVideoSizeMB',
  'cloudKeepHours'
];

const ACT = {
  LOGIN_ADMIN: 'admin.login',
  USER_BAN: 'user.ban',
  USER_UNBAN: 'user.unban',
  USER_QUOTA: 'user.quota',
  USER_ROLE: 'user.role',
  USER_DELETE: 'user.delete',
  JOB_DELETE: 'job.delete',
  JOB_RETRY: 'job.retry',
  CONFIG_UPDATE: 'config.update',
  ADMIN_ADD: 'admin.add',
  ADMIN_REMOVE: 'admin.remove',
  DATA_CLEAN: 'data.clean'
};

// 写操作：需要 super
const WRITE_ACTIONS = [
  'userUpdate',
  'jobUpdate',
  'settingsUpdate',
  'adminAdd',
  'adminRemove',
  'cleanData'
];

const USER_LIST_FIELD = {
  openid: true,
  nickName: true,
  avatarUrl: true,
  role: true,
  status: true,
  banReason: true,
  quotaImage: true,
  quotaVideo: true,
  usedImageToday: true,
  usedVideoToday: true,
  jobCount: true,
  createdAt: true,
  lastActiveAt: true
};

const JOB_LIST_FIELD = {
  openid: true,
  type: true,
  status: true,
  fileName: true,
  mode: true,
  size: true,
  duration: true,
  progress: true,
  progressText: true,
  error: true,
  saved: true,
  createdAt: true,
  finishedAt: true,
  retryCount: true
};

const LOG_LIST_FIELD = {
  action: true,
  category: true,
  operator: true,
  operatorName: true,
  operatorRole: true,
  target: true,
  detail: true,
  createdAt: true
};

/* ============================================================
   入口
   ============================================================ */

exports.main = async (event) => {
  // ---------- HTTP 触发（Web 管理后台） ----------
  if (event && (event.httpMethod || event.headers)) {
    return await handleHttp(event);
  }

  // ---------- 小程序调用 ----------
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return fail(401, '无法识别用户身份，请重新进入小程序');

  const action = event.action || 'check';
  const key = event.__key || '';

  // check 只需白名单，避免密钥轮换时把自己锁在门外
  if (action === 'check') {
    try {
      const rec = await findAdmin(openid);
      if (!rec || rec.status !== 'active') return ok({ isAdmin: false });
      return ok({ isAdmin: true, role: rec.role, name: rec.name || '' });
    } catch (e) {
      console.error('[admin] check error', e);
      return fail(500, e.message || '服务异常');
    }
  }

  if (action === 'login') {
    try {
      return await login(openid, key);
    } catch (e) {
      console.error('[admin] login error', e);
      return fail(500, e.message || '登录失败，请稍后重试');
    }
  }

  const actor = await resolveActor(openid, key);
  if (!actor) {
    return fail(403, '后台权限校验未通过，请重新登录');
  }

  return await run(action, actor, event);
};

/* ============================================================
   统一分发
   ============================================================ */

async function run(action, actor, payload) {
  // 写操作权限闸门
  if (WRITE_ACTIONS.indexOf(action) > -1 && actor.role !== 'super') {
    return fail(403, '当前角色为「' + roleLabel(actor.role) + '」，没有该操作的权限');
  }

  try {
    switch (action) {
      case 'overview':
        return await overview();
      case 'users':
        return await users(payload);
      case 'userDetail':
        return await userDetail(payload);
      case 'userUpdate':
        return await userUpdate(actor, payload);
      case 'jobs':
        return await jobs(payload);
      case 'jobUpdate':
        return await jobUpdate(actor, payload);
      case 'settings':
        return await settings(actor);
      case 'settingsUpdate':
        return await settingsUpdate(actor, payload);
      case 'logs':
        return await logs(payload);
      case 'admins':
        return await admins();
      case 'adminAdd':
        return await adminAdd(actor, payload);
      case 'adminRemove':
        return await adminRemove(actor, payload);
      case 'cleanData':
        return await cleanData(actor, payload);
      default:
        return fail(400, '未知操作：' + action);
    }
  } catch (e) {
    console.error('[admin] error', action, e);
    return fail(500, e.message || '服务异常，请稍后重试');
  }
}

/* ============================================================
   鉴权
   ============================================================ */

/**
 * 解析操作者身份
 * 优先 openid 白名单（取记录里的角色），其次密钥（视为 super，供 Web 后台使用）
 */
async function resolveActor(openid, key) {
  const settings = await getSettings();
  const expect = String(settings.adminKey || '');
  const given = String(key || '');

  if (openid) {
    const rec = await findAdmin(openid);
    if (rec && rec.status === 'active') {
      // 双重校验：白名单命中后，密钥也必须对得上
      if (!expect || given === expect) {
        return {
          openid,
          role: rec.role || 'operator',
          name: rec.name || '',
          via: 'openid'
        };
      }
      console.warn('[admin] key mismatch for whitelisted openid');
      return null;
    }
  }

  if (expect && given === expect) {
    return { openid: openid || '', role: 'super', name: 'Web 管理员', via: 'key' };
  }

  return null;
}

/**
 * 用访问密钥登录后台
 * 密钥正确时把当前 openid 写入白名单（首次登录者成为超级管理员）
 */
async function login(openid, key) {
  const settings = await getSettings();
  const expect = String(settings.adminKey || '');

  if (!expect) {
    return fail(503, '后台密钥尚未初始化，请先运行 initdb 云函数生成密钥');
  }
  if (String(key || '') !== expect) {
    return fail(403, '访问密钥不正确');
  }

  const now = new Date();
  let rec = await findAdmin(openid);

  if (!rec) {
    const total = await countOf(C.ADMINS);
    const role = total === 0 ? 'super' : 'operator';
    const user = await findUser(openid);
    const name = (user && user.nickName) || (role === 'super' ? '超级管理员' : '运营');

    const doc = {
      _openid: openid,
      openid,
      name,
      role,
      status: 'active',
      createdAt: now,
      lastLoginAt: now,
      updatedAt: now
    };
    const res = await db.collection(C.ADMINS).add({ data: doc });
    rec = Object.assign({ _id: res._id }, doc);

    await writeLog(
      { openid, role, name, via: 'openid' },
      ACT.LOGIN_ADMIN,
      'admin',
      shortId(openid),
      '首次以密钥登录，角色 ' + roleLabel(role)
    );
  } else {
    const patch = { lastLoginAt: now, updatedAt: now };
    if (rec.status !== 'active') patch.status = 'active';
    await db.collection(C.ADMINS).doc(rec._id).update({ data: patch });
    rec = Object.assign({}, rec, patch);

    await writeLog(
      { openid, role: rec.role, name: rec.name, via: 'openid' },
      ACT.LOGIN_ADMIN,
      'admin',
      shortId(openid),
      '密钥登录'
    );
  }

  return ok({
    isAdmin: true,
    role: rec.role,
    name: rec.name || '',
    welcome: rec.role === 'super' ? '已进入超级管理员后台' : '已进入运营后台'
  });
}

/* ============================================================
   概览
   ============================================================ */

async function overview() {
  const todayStart = startOfToday();

  const [
    userCount,
    todayNewUsers,
    bannedUsers,
    jobCount,
    todayJobs,
    failedJobs,
    processingJobs,
    imageJobs,
    videoJobs,
    adminCount,
    logCount
  ] = await Promise.all([
    countOf(C.USERS),
    countWhere(C.USERS, { createdAt: _.gte(todayStart) }),
    countWhere(C.USERS, { status: 'banned' }),
    countOf(C.JOBS),
    countWhere(C.JOBS, { createdAt: _.gte(todayStart) }),
    countWhere(C.JOBS, { status: 'failed' }),
    countWhere(C.JOBS, { status: _.in(['pending', 'processing']) }),
    countWhere(C.JOBS, { type: 'image' }),
    countWhere(C.JOBS, { type: 'video' }),
    countOf(C.ADMINS),
    countOf(C.LOGS)
  ]);

  const totalSize = await sumJobSize();

  return ok({
    userCount,
    todayNewUsers,
    bannedUsers,
    jobCount,
    todayJobs,
    failedJobs,
    processingJobs,
    imageJobs,
    videoJobs,
    adminCount,
    logCount,
    totalSize,
    generatedAt: new Date()
  });
}

/* ============================================================
   用户
   ============================================================ */

async function users(payload) {
  const page = Math.max(1, Number(payload.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(payload.pageSize) || 20));
  const filter = payload.filter || 'all';
  const keyword = String(payload.keyword || '').trim();

  const conds = [];

  if (filter === 'banned') conds.push({ status: 'banned' });
  else if (filter === 'normal') conds.push({ status: _.neq('banned') });
  else if (filter === 'vip') {
    conds.push(
      _.or([
        { quotaImage: _.neq(null).and(_.exists(true)) },
        { quotaVideo: _.neq(null).and(_.exists(true)) }
      ])
    );
  }

  if (keyword) {
    const reg = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' });
    conds.push(_.or([{ nickName: reg }, { openid: reg }]));
  }

  const where = conds.length === 0 ? {} : conds.length === 1 ? conds[0] : _.and(conds);

  const [listRes, totalRes] = await Promise.all([
    db
      .collection(C.USERS)
      .where(where)
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .field(USER_LIST_FIELD)
      .get(),
    db.collection(C.USERS).where(where).count()
  ]);

  const list = (listRes.data || []).map((u) => Object.assign({}, u, { _id: u._id }));

  return ok({
    list,
    page,
    pageSize,
    total: totalRes.total || 0,
    hasMore: list.length === pageSize
  });
}

async function userDetail(payload) {
  const id = payload.id;
  if (!id) return fail(400, '缺少用户 id');

  const res = await db.collection(C.USERS).doc(id).get().catch(() => null);
  const user = res && res.data;
  if (!user) return fail(404, '用户不存在或已被删除');

  const jobsRes = await db
    .collection(C.JOBS)
    .where({ _openid: user.openid })
    .orderBy('createdAt', 'desc')
    .limit(20)
    .field(JOB_LIST_FIELD)
    .get();

  return ok({ user, jobs: jobsRes.data || [] });
}

async function userUpdate(actor, payload) {
  const id = payload.id;
  const act = payload.action;
  if (!id) return fail(400, '缺少用户 id');
  if (!act) return fail(400, '缺少操作类型');

  const res = await db.collection(C.USERS).doc(id).get().catch(() => null);
  const user = res && res.data;
  if (!user) return fail(404, '用户不存在');

  const now = new Date();

  if (act === 'ban') {
    const reason = String(payload.reason || '').slice(0, 100);
    await db.collection(C.USERS).doc(id).update({
      data: { status: 'banned', banReason: reason, bannedAt: now, updatedAt: now }
    });
    await writeLog(actor, ACT.USER_BAN, 'user', shortId(user.openid), reason || '无原因');
    return ok({ updated: 1 });
  }

  if (act === 'unban') {
    await db.collection(C.USERS).doc(id).update({
      data: { status: 'normal', banReason: '', updatedAt: now }
    });
    await writeLog(actor, ACT.USER_UNBAN, 'user', shortId(user.openid), '解除限制');
    return ok({ updated: 1 });
  }

  if (act === 'role') {
    const role = payload.role;
    if (['user', 'operator', 'super'].indexOf(role) < 0) return fail(400, '角色不合法');
    await db.collection(C.USERS).doc(id).update({ data: { role, updatedAt: now } });
    await writeLog(
      actor,
      ACT.USER_ROLE,
      'user',
      shortId(user.openid),
      (user.role || 'user') + ' → ' + role
    );
    return ok({ updated: 1, role });
  }

  if (act === 'quota') {
    const patch = { updatedAt: now };
    patch.quotaImage = normalizeQuota(payload.quotaImage);
    patch.quotaVideo = normalizeQuota(payload.quotaVideo);
    await db.collection(C.USERS).doc(id).update({ data: patch });
    await writeLog(
      actor,
      ACT.USER_QUOTA,
      'user',
      shortId(user.openid),
      '图 ' + quotaText(patch.quotaImage) + ' / 视频 ' + quotaText(patch.quotaVideo)
    );
    return ok({ updated: 1, quotaImage: patch.quotaImage, quotaVideo: patch.quotaVideo });
  }

  if (act === 'delete') {
    // 先清云端文件，再删记录
    let removedJobs = 0;
    for (let i = 0; i < 20; i++) {
      const batch = await db
        .collection(C.JOBS)
        .where({ _openid: user.openid })
        .limit(500)
        .field({ outFileID: true, thumbFileID: true, srcFileID: true })
        .get();
      const rows = batch.data || [];
      if (!rows.length) break;

      await purgeFiles(rows);
      await db
        .collection(C.JOBS)
        .where({ _id: _.in(rows.map((r) => r._id)) })
        .remove();
      removedJobs += rows.length;
      if (rows.length < 500) break;
    }

    // 用户自己的头像也一并删除
    if (user.avatarUrl && String(user.avatarUrl).indexOf('cloud://') === 0) {
      try {
        await cloud.deleteFile({ fileList: [user.avatarUrl] });
      } catch (e) {
        console.warn('[admin] delete avatar failed', e.message);
      }
    }

    await db.collection(C.USERS).doc(id).remove();
    await writeLog(
      actor,
      ACT.USER_DELETE,
      'user',
      shortId(user.openid),
      '连带删除 ' + removedJobs + ' 条任务'
    );
    return ok({ removed: 1, removedJobs });
  }

  return fail(400, '不支持的操作：' + act);
}

/* ============================================================
   任务
   ============================================================ */

async function jobs(payload) {
  const page = Math.max(1, Number(payload.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(payload.pageSize) || 20));
  const filter = payload.filter || 'all';
  const keyword = String(payload.keyword || '').trim();

  const conds = [];

  if (filter === 'image') conds.push({ type: 'image' });
  else if (filter === 'video') conds.push({ type: 'video' });
  else if (filter === 'failed') conds.push({ status: 'failed' });
  else if (filter === 'processing') conds.push({ status: _.in(['pending', 'processing']) });

  if (keyword) {
    const reg = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' });
    conds.push(_.or([{ fileName: reg }, { openid: reg }]));
  }

  const where = conds.length === 0 ? {} : conds.length === 1 ? conds[0] : _.and(conds);

  const [listRes, totalRes] = await Promise.all([
    db
      .collection(C.JOBS)
      .where(where)
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .field(JOB_LIST_FIELD)
      .get(),
    db.collection(C.JOBS).where(where).count()
  ]);

  const list = listRes.data || [];
  const ownerMap = await loadOwnerNames(list.map((j) => j.openid));

  return ok({
    list: list.map((j) =>
      Object.assign({}, j, {
        ownerName: ownerMap[j.openid] || '未知用户'
      })
    ),
    page,
    pageSize,
    total: totalRes.total || 0,
    hasMore: list.length === pageSize
  });
}

async function jobUpdate(actor, payload) {
  const id = payload.id;
  const act = payload.action;
  if (!id) return fail(400, '缺少任务 id');
  if (!act) return fail(400, '缺少操作类型');

  const res = await db.collection(C.JOBS).doc(id).get().catch(() => null);
  const job = res && res.data;
  if (!job) return fail(404, '任务不存在');

  if (act === 'delete') {
    await purgeFiles([job]);
    await db.collection(C.JOBS).doc(id).remove();
    await writeLog(
      actor,
      ACT.JOB_DELETE,
      'job',
      shortId(job.openid),
      (job.fileName || '未命名') + '（' + id.slice(-6) + '）'
    );
    return ok({ removed: 1 });
  }

  if (act === 'retry') {
    if (job.type !== 'video') return fail(400, '只有视频任务支持重新处理');

    await db.collection(C.JOBS).doc(id).update({
      data: {
        status: 'pending',
        error: '',
        progress: 0,
        progressText: '管理员重新排队',
        retryCount: _.inc(1),
        finishedAt: null
      }
    });

    try {
      await cloud.callFunction({
        name: 'videoProc',
        data: { action: 'submit', jobId: id, requeue: true }
      });
    } catch (e) {
      console.error('[admin] retry dispatch failed', e);
      return fail(500, '重新提交失败：' + (e.message || '未知原因'));
    }

    await writeLog(actor, ACT.JOB_RETRY, 'job', shortId(job.openid), job.fileName || '未命名');
    return ok({ jobId: id });
  }

  return fail(400, '不支持的操作：' + act);
}

/* ============================================================
   配置
   ============================================================ */

async function settings(actor) {
  const s = await getSettings();
  const out = Object.assign({}, DEFAULT_SETTINGS);
  EDIT_KEYS.forEach((k) => {
    if (s[k] !== undefined && s[k] !== null) out[k] = s[k];
  });
  out._id = 'global';
  out.updatedAt = s.updatedAt || null;

  // 密钥属于高敏字段，仅超级管理员可见
  if (actor.role !== 'super') {
    out.adminKey = '';
    out.videoServiceKey = '';
  }

  return ok(out);
}

async function settingsUpdate(actor, payload) {
  const patch = {};
  const changed = [];

  EDIT_KEYS.forEach((k) => {
    if (payload[k] === undefined || payload[k] === null) return;

    // 密钥类字段传空视为「不修改」，避免误清空导致后台再也登不进去
    if ((k === 'adminKey' || k === 'videoServiceKey') && String(payload[k]).trim() === '') return;

    if (NUM_KEYS.indexOf(k) > -1) {
      const n = Number(payload[k]);
      patch[k] = isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    } else if (k === 'videoServiceEnabled' || k === 'registerEnabled') {
      patch[k] = !!payload[k];
    } else {
      const max =
        k === 'copyrightTip' ? 200 : k === 'globalNotice' || k === 'maintenanceNotice' ? 500 : 512;
      patch[k] = String(payload[k]).slice(0, max);
    }
    changed.push(k);
  });

  if (!changed.length) return fail(400, '没有需要更新的配置');

  patch.updatedAt = new Date();
  patch.updatedBy = actor.openid || 'web';

  const existing = await getSettings();
  if (existing && existing._id) {
    await db.collection(C.SETTINGS).doc(existing._id).update({ data: patch });
  } else {
    await db.collection(C.SETTINGS).add({ data: Object.assign({ _id: 'global' }, DEFAULT_SETTINGS, patch) });
  }

  // 密钥类字段不写进日志明文
  const safe = changed
    .map((k) => {
      if (k === 'adminKey' || k === 'videoServiceKey') return k + '(已更新)';
      return k + '=' + String(patch[k]).slice(0, 40);
    })
    .join('; ');

  await writeLog(actor, ACT.CONFIG_UPDATE, 'config', 'global', safe);

  const out = await getSettings();
  return ok({ updated: changed.length, settings: out });
}

/* ============================================================
   日志
   ============================================================ */

async function logs(payload) {
  const page = Math.max(1, Number(payload.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(payload.pageSize) || 20));
  const filter = payload.filter || 'all';

  const where =
    filter === 'all' ? {} : { category: filter === 'config' ? _.in(['config', 'data']) : filter };

  const [listRes, totalRes] = await Promise.all([
    db
      .collection(C.LOGS)
      .where(where)
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .field(LOG_LIST_FIELD)
      .get(),
    db.collection(C.LOGS).where(where).count()
  ]);

  return ok({
    list: listRes.data || [],
    page,
    pageSize,
    total: totalRes.total || 0,
    hasMore: (listRes.data || []).length === pageSize
  });
}

/* ============================================================
   管理员
   ============================================================ */

async function admins() {
  const res = await db
    .collection(C.ADMINS)
    .orderBy('createdAt', 'asc')
    .limit(200)
    .get();

  const list = [];
  const pending = [];
  (res.data || []).forEach((a) => {
    const item = {
      _id: a._id,
      openid: a.openid,
      openidShort: shortId(a.openid),
      name: a.name || '',
      role: a.role || 'operator',
      status: a.status || 'active',
      createdAt: a.createdAt,
      lastLoginAt: a.lastLoginAt || null
    };
    if (item.status === 'active') list.push(item);
    else pending.push(item);
  });

  return ok({ list, pending });
}

async function adminAdd(actor, payload) {
  const openid = String(payload.openid || '').trim();
  if (openid.length < 10) return fail(400, '请填写完整的 openid');

  const role = payload.role === 'super' ? 'super' : 'operator';
  const name = String(payload.name || '').slice(0, 20) || (role === 'super' ? '超级管理员' : '运营');
  const now = new Date();

  const exist = await findAdmin(openid);
  if (exist) {
    await db.collection(C.ADMINS).doc(exist._id).update({
      data: { role, name, status: 'active', updatedAt: now }
    });
    await writeLog(actor, ACT.ADMIN_ADD, 'admin', shortId(openid), '更新为 ' + roleLabel(role));
    return ok({ updated: 1, role });
  }

  const doc = {
    _openid: openid,
    openid,
    name,
    role,
    status: 'active',
    createdAt: now,
    updatedAt: now
  };
  const res = await db.collection(C.ADMINS).add({ data: doc });

  await writeLog(actor, ACT.ADMIN_ADD, 'admin', shortId(openid), '新增 ' + roleLabel(role));
  return ok({ added: 1, id: res._id, role });
}

async function adminRemove(actor, payload) {
  const openid = String(payload.openid || '').trim();
  if (!openid) return fail(400, '缺少 openid');

  if (actor.via === 'openid' && actor.openid === openid) {
    return fail(400, '不能移除自己的后台权限');
  }

  const rec = await findAdmin(openid);
  if (!rec) return fail(404, '该 openid 不在管理员列表中');

  if (rec.role === 'super') {
    const superCount = await countWhere(C.ADMINS, { role: 'super', status: 'active' });
    if (superCount <= 1) return fail(400, '至少需要保留一名超级管理员');
  }

  await db.collection(C.ADMINS).doc(rec._id).remove();
  await writeLog(actor, ACT.ADMIN_REMOVE, 'admin', shortId(openid), '移除 ' + roleLabel(rec.role));

  return ok({ removed: 1 });
}

/* ============================================================
   数据维护
   ============================================================ */

async function cleanData(actor, payload) {
  const days = Math.min(365, Math.max(1, Number(payload.days) || 30));
  const before = new Date(Date.now() - days * 24 * 3600 * 1000);

  let removed = 0;
  let files = 0;

  // 分批清理已完成/失败的历史任务
  for (let i = 0; i < 20; i++) {
    const batch = await db
      .collection(C.JOBS)
      .where({
        createdAt: _.lt(before),
        status: _.in(['done', 'failed'])
      })
      .limit(500)
      .field({ outFileID: true, thumbFileID: true, srcFileID: true })
      .get();

    const rows = batch.data || [];
    if (!rows.length) break;

    rows.forEach((r) => {
      if (r.outFileID) files++;
      if (r.thumbFileID) files++;
      if (r.srcFileID) files++;
    });

    await purgeFiles(rows);
    await db
      .collection(C.JOBS)
      .where({ _id: _.in(rows.map((r) => r._id)) })
      .remove();
    removed += rows.length;

    if (rows.length < 500) break;
  }

  // 顺带清理过期日志（保留最近 90 天）
  const logBefore = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  let removedLogs = 0;
  try {
    const r = await db.collection(C.LOGS).where({ createdAt: _.lt(logBefore) }).remove();
    removedLogs = (r.stats && r.stats.removed) || 0;
  } catch (e) {
    console.warn('[admin] clean logs failed', e.message);
  }

  await writeLog(
    actor,
    ACT.DATA_CLEAN,
    'data',
    days + ' 天前',
    '清理 ' + removed + ' 条任务 / ' + files + ' 个文件 / ' + removedLogs + ' 条日志'
  );

  return ok({ removed, files, removedLogs });
}

/* ============================================================
   HTTP 触发（供 Web 管理后台使用）
   ============================================================ */

async function handleHttp(event) {
  const method = String(event.httpMethod || 'GET').toUpperCase();

  if (method === 'OPTIONS') return httpRes(204, null);

  const headers = lowerHeaders(event.headers);
  const qs = event.queryStringParameters || parseQuery(event.queryString || event.rawQueryString || '');

  let key = headers['x-admin-key'] || qs.key || '';
  let payload = {};

  if (method === 'POST' || method === 'PUT') {
    let body = event.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        body = {};
      }
    }
    payload = body || {};
    if (!key && payload.key) key = payload.key;
  } else {
    payload = Object.assign({}, qs);
  }

  const action = payload.action || qs.action;
  if (!action) return httpRes(400, envelope(400, '缺少 action 参数'));

  const actor = await resolveActor('', key);
  if (!actor) return httpRes(403, envelope(403, '访问密钥不正确'));

  if (action === 'check') {
    return httpRes(200, envelope(0, 'ok', { isAdmin: true, role: actor.role, name: actor.name }));
  }

  const result = await run(action, actor, payload);
  return httpRes(result.code === 0 ? 200 : httpStatusOf(result.code), result);
}

function httpStatusOf(code) {
  if (code === 401) return 401;
  if (code === 403) return 403;
  if (code === 404) return 404;
  if (code === 429) return 429;
  if (code === 400) return 400;
  return 500;
}

function lowerHeaders(h) {
  const out = {};
  Object.keys(h || {}).forEach((k) => {
    out[String(k).toLowerCase()] = h[k];
  });
  return out;
}

function parseQuery(raw) {
  const out = {};
  String(raw || '')
    .split('&')
    .filter(Boolean)
    .forEach((kv) => {
      const i = kv.indexOf('=');
      const k = i < 0 ? kv : kv.slice(0, i);
      const v = i < 0 ? '' : kv.slice(i + 1);
      if (k) out[decodeURIComponent(k)] = decodeURIComponent(v);
    });
  return out;
}

function httpRes(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
      'access-control-allow-headers': 'content-type,x-admin-key'
    },
    body: body ? JSON.stringify(body) : ''
  };
}

/* ============================================================
   内部工具
   ============================================================ */

async function findAdmin(openid) {
  if (!openid) return null;
  const res = await db.collection(C.ADMINS).where({ openid }).limit(1).get();
  return res.data[0] || null;
}

async function findUser(openid) {
  const res = await db.collection(C.USERS).where({ _openid: openid }).limit(1).get();
  return res.data[0] || null;
}

async function getSettings() {
  const res = await db.collection(C.SETTINGS).where({ _id: 'global' }).limit(1).get();
  const doc = res.data[0];
  if (!doc) return Object.assign({ _id: 'global' }, DEFAULT_SETTINGS);

  const merged = Object.assign({}, DEFAULT_SETTINGS);
  Object.keys(DEFAULT_SETTINGS).forEach((k) => {
    if (doc[k] !== undefined && doc[k] !== null) merged[k] = doc[k];
  });
  merged._id = doc._id || 'global';
  merged.updatedAt = doc.updatedAt || null;
  return merged;
}

/** 批量取用户昵称，用于任务列表显示归属 */
async function loadOwnerNames(openids) {
  const uniq = Array.from(new Set((openids || []).filter(Boolean)));
  const map = {};
  if (!uniq.length) return map;

  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const res = await db
      .collection(C.USERS)
      .where({ openid: _.in(chunk) })
      .limit(50)
      .field({ openid: true, nickName: true })
      .get();
    (res.data || []).forEach((u) => {
      map[u.openid] = u.nickName || '未命名用户';
    });
  }
  return map;
}

async function countOf(name) {
  const res = await db.collection(name).count();
  return res.total || 0;
}

async function countWhere(name, where) {
  const res = await db.collection(name).where(where).count();
  return res.total || 0;
}

async function sumJobSize() {
  try {
    const res = await db
      .collection(C.JOBS)
      .aggregate()
      .group({ _id: null, total: $.sum('$size') })
      .end();
    const first = (res.list || [])[0];
    return (first && first.total) || 0;
  } catch (e) {
    console.warn('[admin] sumJobSize failed', e.message);
    return 0;
  }
}

/** 删除任务关联的云存储文件（失败不阻断主流程） */
async function purgeFiles(rows) {
  const files = [];
  (rows || []).forEach((j) => {
    if (j.outFileID) files.push(j.outFileID);
    if (j.thumbFileID) files.push(j.thumbFileID);
    if (j.srcFileID) files.push(j.srcFileID);
  });
  if (!files.length) return;

  for (let i = 0; i < files.length; i += 50) {
    const chunk = files.slice(i, i + 50);
    try {
      await cloud.deleteFile({ fileList: chunk });
    } catch (e) {
      console.warn('[admin] deleteFile failed', e.message);
    }
  }
}

/** 写操作日志（失败不影响主流程） */
async function writeLog(actor, action, category, target, detail) {
  try {
    await db.collection(C.LOGS).add({
      data: {
        action,
        category: category || 'other',
        operator: (actor && actor.openid) || '',
        operatorName: (actor && actor.name) || '未知',
        operatorRole: (actor && actor.role) || 'super',
        via: (actor && actor.via) || 'openid',
        target: String(target || '').slice(0, 120),
        detail: String(detail || '').slice(0, 300),
        createdAt: new Date()
      }
    });
  } catch (e) {
    console.warn('[admin] writeLog failed', e.message);
  }
}

function normalizeQuota(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function quotaText(v) {
  return v === null ? '跟随全局' : String(v);
}

function roleLabel(role) {
  if (role === 'super') return '超级管理员';
  if (role === 'operator') return '运营';
  return '普通用户';
}

function shortId(openid) {
  const s = String(openid || '');
  return s ? '…' + s.slice(-8) : '未知';
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function envelope(code, msg, data) {
  return { code, data: data || null, msg: msg || '请求失败' };
}

function ok(data) {
  return { code: 0, data: data || {}, msg: 'ok' };
}

function fail(code, msg, data) {
  return { code, data: data || null, msg: msg || '请求失败' };
}
