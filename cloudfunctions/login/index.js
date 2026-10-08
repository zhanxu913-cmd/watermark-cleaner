/**
 * 云函数 login
 * 职责：登录建档、用户资料、配额查询与每日重置、个人统计
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const C = {
  USERS: 'wc_users',
  ADMINS: 'wc_admins',
  SETTINGS: 'wc_settings',
  JOBS: 'wc_jobs'
};

const DEFAULT_SETTINGS = {
  freeImagePerDay: 10,
  freeVideoPerDay: 1,
  maxVideoDuration: 60,
  maxVideoSizeMB: 100,
  videoServiceEnabled: false,
  videoServiceUrl: '',
  registerEnabled: true,
  globalNotice: '',
  maintenanceNotice: '',
  copyrightTip: '请仅处理你拥有版权的素材。去除他人作品水印可能构成侵权。',
  cloudKeepHours: 1
};

/* ============================================================
   入口
   ============================================================ */

exports.main = async (event) => {
  const wxCtx = cloud.getWXContext();
  const openid = wxCtx.OPENID;

  if (!openid) return fail(401, '无法识别用户身份，请重新进入小程序');

  const action = event.action || 'signIn';

  try {
    switch (action) {
      case 'signIn':
        return await signIn(openid);
      case 'profile':
        return await profile(openid);
      case 'updateProfile':
        return await updateProfile(openid, event);
      case 'quota':
        return await quota(openid);
      case 'stats':
        return await stats(openid);
      default:
        return fail(400, '未知操作：' + action);
    }
  } catch (e) {
    console.error('[login] error', action, e);
    return fail(500, e.message || '服务异常，请稍后重试');
  }
};

/* ============================================================
   动作
   ============================================================ */

async function signIn(openid) {
  const now = new Date();
  const today = dateKey(now);

  let user = await findUser(openid);

  if (!user) {
    const settings = await getSettings();
    if (settings.registerEnabled === false) {
      return fail(403, '当前暂不开放新用户注册，请稍后再试');
    }

    const doc = {
      _openid: openid,
      openid,
      nickName: '',
      avatarUrl: '',
      role: 'user',
      status: 'normal',
      banReason: '',
      quotaImage: null,
      quotaVideo: null,
      usedImageDate: today,
      usedImageToday: 0,
      usedVideoDate: today,
      usedVideoToday: 0,
      jobCount: 0,
      createdAt: now,
      lastActiveAt: now,
      updatedAt: now
    };
    const res = await db.collection(C.USERS).add({ data: doc });
    user = Object.assign({ _id: res._id }, doc);
  } else {
    // 跨天则重置当日用量
    const patch = { lastActiveAt: now, updatedAt: now };
    if (user.usedImageDate !== today) {
      patch.usedImageDate = today;
      patch.usedImageToday = 0;
    }
    if (user.usedVideoDate !== today) {
      patch.usedVideoDate = today;
      patch.usedVideoToday = 0;
    }
    await db.collection(C.USERS).doc(user._id).update({ data: patch });
    user = Object.assign({}, user, patch);
  }

  const settings = await getSettings();
  const admin = await findAdmin(openid);

  return ok({
    user: shapeUser(user, settings),
    isAdmin: !!admin,
    adminRole: admin ? admin.role : '',
    settings: publicSettings(settings)
  });
}

async function profile(openid) {
  const user = await findUser(openid);
  if (!user) return fail(404, '用户不存在，请重新进入小程序');
  const settings = await getSettings();
  return ok({ user: shapeUser(user, settings) });
}

async function updateProfile(openid, event) {
  const user = await findUser(openid);
  if (!user) return fail(404, '用户不存在');

  const patch = { updatedAt: new Date() };
  if (typeof event.nickName === 'string') {
    const name = event.nickName.trim().slice(0, 20);
    if (name) patch.nickName = name;
  }
  if (typeof event.avatarUrl === 'string' && event.avatarUrl) {
    patch.avatarUrl = event.avatarUrl.slice(0, 512);
  }

  if (Object.keys(patch).length <= 1) return fail(400, '没有需要更新的内容');

  await db.collection(C.USERS).doc(user._id).update({ data: patch });
  const settings = await getSettings();
  return ok({ user: shapeUser(Object.assign({}, user, patch), settings) });
}

async function quota(openid) {
  const user = await findUser(openid);
  if (!user) return fail(404, '用户不存在');
  const settings = await getSettings();
  const shaped = shapeUser(user, settings);
  return ok({
    remainImage: shaped.remainImage,
    remainVideo: shaped.remainVideo,
    limitImage: shaped.limitImage,
    limitVideo: shaped.limitVideo,
    status: shaped.status
  });
}

async function stats(openid) {
  const settings = await getSettings();
  const user = await findUser(openid);
  if (!user) return fail(404, '用户不存在');

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
    month: monthRes.total || 0,
    quota: shapeUser(user, settings)
  });
}

/* ============================================================
   内部工具
   ============================================================ */

async function findUser(openid) {
  const res = await db.collection(C.USERS).where({ _openid: openid }).limit(1).get();
  return res.data[0] || null;
}

async function findAdmin(openid) {
  const res = await db
    .collection(C.ADMINS)
    .where({ openid, status: 'active' })
    .limit(1)
    .get();
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
  merged._id = 'global';
  return merged;
}

/** 下发给客户端的设置：剔除管理密钥等敏感字段 */
function publicSettings(s) {
  return {
    freeImagePerDay: s.freeImagePerDay,
    freeVideoPerDay: s.freeVideoPerDay,
    maxVideoDuration: s.maxVideoDuration,
    maxVideoSizeMB: s.maxVideoSizeMB,
    videoServiceEnabled: !!s.videoServiceEnabled,
    globalNotice: s.globalNotice || '',
    maintenanceNotice: s.maintenanceNotice || '',
    copyrightTip: s.copyrightTip || DEFAULT_SETTINGS.copyrightTip,
    cloudKeepHours: s.cloudKeepHours
  };
}

function shapeUser(u, s) {
  const limitImage = u.quotaImage == null ? Number(s.freeImagePerDay) || 0 : Number(u.quotaImage);
  const limitVideo = u.quotaVideo == null ? Number(s.freeVideoPerDay) || 0 : Number(u.quotaVideo);
  const usedImage = u.usedImageToday || 0;
  const usedVideo = u.usedVideoToday || 0;

  return {
    _id: u._id,
    openid: u.openid,
    nickName: u.nickName || '',
    avatarUrl: u.avatarUrl || '',
    role: u.role || 'user',
    status: u.status || 'normal',
    banReason: u.banReason || '',
    quotaImage: u.quotaImage == null ? null : u.quotaImage,
    quotaVideo: u.quotaVideo == null ? null : u.quotaVideo,
    usedImageToday: usedImage,
    usedVideoToday: usedVideo,
    limitImage,
    limitVideo,
    remainImage: Math.max(0, limitImage - usedImage),
    remainVideo: Math.max(0, limitVideo - usedVideo),
    jobCount: u.jobCount || 0,
    createdAt: u.createdAt
  };
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
