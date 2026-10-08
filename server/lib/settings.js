/**
 * 全局配置（wc_settings 单行）
 * 数据库存 snake_case，对外统一 camelCase；内存缓存 15 秒
 */

'use strict';

const db = require('../db');
const { BizError } = require('./biz');

const DEFAULTS = {
  freeImagePerDay: 10,
  freeVideoPerDay: 10,
  maxVideoDuration: 60,
  maxVideoSizeMB: 500,
  videoServiceEnabled: true,
  registerEnabled: true,
  globalNotice: '',
  maintenanceNotice: '',
  copyrightTip: '请仅处理你拥有版权的素材。去除他人作品水印可能构成侵权。',
  cloudKeepHours: 1,
  adminKey: ''
};

// snake_case 列 → camelCase 字段
const COLUMN_MAP = {
  free_image_per_day: 'freeImagePerDay',
  free_video_per_day: 'freeVideoPerDay',
  max_video_duration: 'maxVideoDuration',
  max_video_size_mb: 'maxVideoSizeMB',
  video_enabled: 'videoServiceEnabled',
  register_enabled: 'registerEnabled',
  global_notice: 'globalNotice',
  maintenance_notice: 'maintenanceNotice',
  copyright_tip: 'copyrightTip',
  cloud_keep_hours: 'cloudKeepHours',
  admin_key: 'adminKey'
};

// 数值字段（写库前转整数）
const NUM_KEYS = ['freeImagePerDay', 'freeVideoPerDay', 'maxVideoDuration', 'maxVideoSizeMB', 'cloudKeepHours'];
// 布尔字段
const BOOL_KEYS = ['videoServiceEnabled', 'registerEnabled'];
// 字符串长度上限
const STR_LIMITS = { globalNotice: 500, maintenanceNotice: 500, copyrightTip: 200, adminKey: 64 };

let cache = null;
let cacheAt = 0;
const TTL = 15000;

function rowToSettings(row) {
  const out = Object.assign({}, DEFAULTS);
  if (row) {
    Object.keys(COLUMN_MAP).forEach((col) => {
      const key = COLUMN_MAP[col];
      if (row[col] !== undefined && row[col] !== null) out[key] = row[col];
    });
    out.videoServiceEnabled = !!out.videoServiceEnabled;
    out.registerEnabled = !!out.registerEnabled;
  }
  return out;
}

/** 读取配置（带缓存）。adminKey 默认不对外下发，由调用方决定是否剔除 */
async function getSettings(force) {
  if (!force && cache && Date.now() - cacheAt < TTL) return cache;
  const row = await db.get('SELECT * FROM wc_settings WHERE id = 1');
  cache = rowToSettings(row);
  cacheAt = Date.now();
  return cache;
}

/** 剔除敏感字段后的公开配置（下发到小程序端） */
async function getPublicSettings() {
  const s = await getSettings();
  const out = Object.assign({}, s);
  delete out.adminKey;
  return out;
}

/** 更新配置（仅允许 DEFAULTS 里已知的 key），返回更新后的配置 */
async function updateSettings(patch) {
  const sets = [];
  const params = [];

  Object.keys(COLUMN_MAP).forEach((col) => {
    const key = COLUMN_MAP[col];
    if (!(key in (patch || {}))) return;

    let v = patch[key];
    if (NUM_KEYS.indexOf(key) > -1) {
      const n = Number(v);
      v = isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    } else if (BOOL_KEYS.indexOf(key) > -1) {
      v = v === true || v === 1 || v === '1' ? 1 : 0;
    } else {
      v = String(v === undefined || v === null ? '' : v).slice(0, STR_LIMITS[key] || 255);
    }

    // 密钥传空 = 不修改（防止误清空后后台登不进去）
    if (key === 'adminKey' && !v) return;

    sets.push(col + ' = ?');
    params.push(v);
  });

  if (sets.length) {
    await db.exec('UPDATE wc_settings SET ' + sets.join(', ') + ' WHERE id = 1', params);
    await getSettings(true);
  }
  return getSettings();
}

/** 确保存在单行配置；若无密钥则生成 */
async function ensureRow(initKey) {
  const row = await db.get('SELECT id FROM wc_settings WHERE id = 1');
  if (!row) {
    await db.exec('INSERT IGNORE INTO wc_settings (id) VALUES (1)');
  }
  const s = await getSettings(true);
  if (!s.adminKey) {
    const key = initKey || require('crypto').randomBytes(16).toString('hex');
    await db.exec('UPDATE wc_settings SET admin_key = ? WHERE id = 1', [key]);
    await getSettings(true);
    return key;
  }
  return '';
}

module.exports = { getSettings, getPublicSettings, updateSettings, ensureRow, DEFAULTS, BizError };
