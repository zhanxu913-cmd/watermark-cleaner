/**
 * 配额：读取 / 校验 / 原子扣减
 *
 * 设计要点：
 * - limit_image / limit_video 为 0 表示跟随全局配置，> 0 表示该用户独享
 * - 扣减用单条 UPDATE 原子完成（跨天重置 + 上限校验 + 封禁校验），避免并发超扣
 */

'use strict';

const db = require('../db');
const { BizError } = require('./biz');

const TYPE_FIELD = {
  image: { used: 'used_image', date: 'used_image_date', limit: 'limit_image' },
  video: { used: 'used_video', date: 'used_video_date', limit: 'limit_video' }
};

/** 返回用户今日剩余次数 { remainImage, remainVideo, limitImage, limitVideo, usedImage, usedVideo } */
function shapeQuota(user, settings) {
  const today = todayStr();

  const limitImage = user.limit_image > 0 ? user.limit_image : settings.freeImagePerDay;
  const limitVideo = user.limit_video > 0 ? user.limit_video : settings.freeVideoPerDay;

  const usedImage = user.used_image_date && strOf(user.used_image_date) === today ? user.used_image : 0;
  const usedVideo = user.used_video_date && strOf(user.used_video_date) === today ? user.used_video : 0;

  return {
    limitImage,
    limitVideo,
    usedImage,
    usedVideo,
    remainImage: Math.max(0, limitImage - usedImage),
    remainVideo: Math.max(0, limitVideo - usedVideo)
  };
}

/**
 * 原子扣减一次配额；失败抛 429（封禁抛 403）
 * @returns {Promise<{used:number, remain:number, limit:number}>}
 */
async function consume(userId, type, settings) {
  const f = TYPE_FIELD[type];
  if (!f) throw new BizError(500, '未知的配额类型');

  const user = await db.get('SELECT * FROM wc_users WHERE id = ?', [userId]);
  if (!user) throw new BizError(401, '账号不存在');
  if (user.banned) throw new BizError(403, '账号已被限制：' + (user.ban_reason || '请联系管理员'));

  const limit = user[f.limit] > 0 ? user[f.limit] : (type === 'image' ? settings.freeImagePerDay : settings.freeVideoPerDay);

  const sql =
    'UPDATE wc_users SET ' +
    f.used + ' = IF(' + f.date + ' = CURDATE(), ' + f.used + ' + 1, 1), ' +
    f.date + ' = CURDATE(), ' +
    'total_count = total_count + 1, last_active_at = NOW() ' +
    'WHERE id = ? AND banned = 0 AND IF(' + f.date + ' = CURDATE(), ' + f.used + ', 0) < ?';

  const r = await db.exec(sql, [userId, limit]);
  if (!r.affectedRows) {
    throw new BizError(429,
      '今日' + (type === 'image' ? '图片' : '视频') + '处理次数已用完（' + limit + ' 次/天），明天再来或联系管理员提升配额');
  }

  const after = await db.get('SELECT * FROM wc_users WHERE id = ?', [userId]);
  const used = after[f.date] && strOf(after[f.date]) === todayStr() ? after[f.used] : 0;
  return { used, remain: Math.max(0, limit - used), limit };
}

/** 更新用户独享配额（管理员操作），返回影响的行数 */
async function setLimits(userId, limitImage, limitVideo) {
  return db.exec('UPDATE wc_users SET limit_image = ?, limit_video = ? WHERE id = ?', [
    Math.max(0, Math.floor(Number(limitImage) || 0)),
    Math.max(0, Math.floor(Number(limitVideo) || 0)),
    userId
  ]);
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function strOf(v) {
  if (v instanceof Date) {
    return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
  }
  return String(v || '').slice(0, 10);
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

module.exports = { shapeQuota, consume, setLimits };
