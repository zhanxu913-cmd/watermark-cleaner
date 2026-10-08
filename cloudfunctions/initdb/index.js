/**
 * 云函数 initdb
 * 职责：一次性初始化（部署后手动执行一次）
 *
 *   1) 创建 5 个集合（已存在则跳过）
 *   2) 写入 wc_settings 的全局配置（_id = 'global'），自动生成后台访问密钥
 *   3) 输出需要在控制台手工建立的索引清单
 *   4) 输出数据库权限建议
 *
 * 安全：首次执行（环境里还没有 adminKey）任何人可执行；
 *       之后必须带上正确的 key 才能再次执行，避免密钥被围观者重置。
 *       如需轮换密钥：传 { action: 'rotateKey' } 会自动生成新密钥并返回。
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const COLLECTIONS = ['wc_users', 'wc_jobs', 'wc_admins', 'wc_logs', 'wc_settings'];

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

const INDEX_PLAN = [
  {
    collection: 'wc_users',
    indexes: [
      { name: 'openid_uniq', keys: [['openid', 'asc']], unique: true },
      { name: 'createdAt_desc', keys: [['createdAt', 'desc']] },
      { name: 'status_createdAt', keys: [['status', 'asc'], ['createdAt', 'desc']] }
    ]
  },
  {
    collection: 'wc_jobs',
    indexes: [
      { name: 'openid_createdAt', keys: [['_openid', 'asc'], ['createdAt', 'desc']] },
      { name: 'status_expiresAt', keys: [['status', 'asc'], ['expiresAt', 'asc']] },
      { name: 'type_createdAt', keys: [['type', 'asc'], ['createdAt', 'desc']] },
      { name: 'createdAt_desc', keys: [['createdAt', 'desc']] }
    ]
  },
  {
    collection: 'wc_admins',
    indexes: [
      { name: 'openid_uniq', keys: [['openid', 'asc']], unique: true },
      { name: 'role_status', keys: [['role', 'asc'], ['status', 'asc']] }
    ]
  },
  {
    collection: 'wc_logs',
    indexes: [
      { name: 'createdAt_desc', keys: [['createdAt', 'desc']] },
      { name: 'category_createdAt', keys: [['category', 'asc'], ['createdAt', 'desc']] }
    ]
  },
  {
    collection: 'wc_settings',
    indexes: [{ name: '_id 为内置索引，无需另建', keys: [] }]
  }
];

const SECURITY_RULE_HINT = [
  '数据库 → 权限设置：5 个集合全部选「仅管理端可读写」（自定义安全规则 { "read": false, "write": false }）。',
  '原因：所有读写都经由云函数（云函数以管理员身份运行，不受安全规则限制），',
  '直接放开给客户端读写会让任何人绕过配额与鉴权刷数据。'
];

/* ============================================================
   入口
   ============================================================ */

exports.main = async (event) => {
  const opts = event || {};

  try {
    const existing = await readSettings();
    const currentKey = (existing && existing.adminKey) || '';

    // 已初始化过 → 必须带正确密钥才能再次执行
    if (currentKey && String(opts.key || '') !== currentKey) {
      return {
        code: 403,
        data: null,
        msg: '环境已初始化。如需重新初始化，请传入正确的 key（{ "key": "你的后台密钥" }）'
      };
    }

    const report = {
      collections: { created: [], existed: [], failed: [] },
      settings: '',
      adminKey: '',
      videoServiceKey: '',
      indexes: INDEX_PLAN,
      security: SECURITY_RULE_HINT,
      envId: ''
    };

    // ---- 1) 创建集合 ----
    for (let i = 0; i < COLLECTIONS.length; i++) {
      const name = COLLECTIONS[i];
      const r = await ensureCollection(name);
      if (r === 'created') report.collections.created.push(name);
      else if (r === 'existed') report.collections.existed.push(name);
      else report.collections.failed.push(name);
    }

    // ---- 2) 写入全局配置 ----
    const rotate = opts.action === 'rotateKey' || opts.rotateKey === true;
    const adminKey = rotate || !currentKey ? opts.adminKey || genKey() : currentKey;
    const videoServiceKey =
      (existing && existing.videoServiceKey) || opts.videoServiceKey || genKey('vs');

    const patch = Object.assign({}, DEFAULT_SETTINGS, existing || {}, {
      _id: 'global',
      adminKey,
      videoServiceKey,
      updatedAt: new Date()
    });
    // 不允许前端通过 initdb 顺带改配置
    delete patch._openid;

    if (existing && existing._id) {
      await db.collection('wc_settings').doc(existing._id).update({ data: patch });
      report.settings = '已更新 wc_settings/global';
    } else {
      await db.collection('wc_settings').add({ data: patch });
      report.settings = '已创建 wc_settings/global';
    }

    report.adminKey = adminKey;
    report.videoServiceKey = videoServiceKey;
    report.rotated = rotate;

    try {
      report.envId = cloud.getWXContext().ENV || '';
    } catch (e) {
      report.envId = '';
    }

    console.log('[initdb] done', JSON.stringify(report.collections));

    return {
      code: 0,
      data: report,
      msg: '初始化完成。请复制 adminKey 妥善保存，并到控制台按清单建立索引。'
    };
  } catch (e) {
    console.error('[initdb] error', e);
    return { code: 500, data: null, msg: e.message || '初始化失败' };
  }
};

/* ============================================================
   内部工具
   ============================================================ */

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
    return 'created';
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || '');
    if (msg.indexOf('exist') > -1 || msg.indexOf('已存在') > -1 || (e && e.errCode === -501001)) {
      return 'existed';
    }
    console.warn('[initdb] createCollection failed', name, msg);
    return 'failed';
  }
}

async function readSettings() {
  try {
    const res = await db.collection('wc_settings').where({ _id: 'global' }).limit(1).get();
    return res.data[0] || null;
  } catch (e) {
    // 集合还不存在
    return null;
  }
}

function genKey(prefix) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 24; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return (prefix ? prefix + '-' : 'wk-') + s;
}
