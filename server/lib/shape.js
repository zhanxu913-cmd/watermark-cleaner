/**
 * 用户字段整形：数据库行 → 小程序端期望的驼峰结构
 */

'use strict';

/** 用户 + 配额 → 前端 user 对象 */
function shapeUser(u, q) {
  const quota = q || {};
  return {
    id: u.id,
    openid: u.openid,
    nickName: u.nickname || '',
    avatarUrl: u.avatar_url || '',
    banned: !!u.banned,
    status: u.banned ? 'banned' : 'normal',
    banReason: u.ban_reason || '',
    remainImage: quota.remainImage !== undefined ? quota.remainImage : 0,
    remainVideo: quota.remainVideo !== undefined ? quota.remainVideo : 0,
    limitImage: quota.limitImage !== undefined ? quota.limitImage : 0,
    limitVideo: quota.limitVideo !== undefined ? quota.limitVideo : 0,
    usedImage: quota.usedImage || 0,
    usedVideo: quota.usedVideo || 0,
    totalCount: u.total_count || 0,
    createdAt: u.created_at || null
  };
}

/** 任务行 → 前端 job 对象（fileID 字段沿用旧命名，值是相对路径） */
function shapeJob(r) {
  let region = null;
  let timeRange = null;
  try {
    if (r.region) region = JSON.parse(r.region);
  } catch (e) { /* 保持 null */ }
  try {
    if (r.time_range) timeRange = JSON.parse(r.time_range);
  } catch (e) { /* 保持 null */ }

  return {
    id: r.id,
    openid: r.openid,
    type: r.type,
    mode: r.mode,
    status: r.status,
    progress: r.progress || 0,
    fileName: r.file_name || '',
    region,
    regions: region && region.regions ? region.regions : region,
    timeRange,
    duration: Number(r.duration) || 0,
    strength: r.strength || 0,
    width: r.width || 0,
    height: r.height || 0,
    regionCount: r.region_count || 0,
    srcFileID: r.src_file || '',
    outFileID: r.out_file || '',
    thumbFileID: r.thumb_file || '',
    size: Number(r.size) || 0,
    outSize: Number(r.out_size) || 0,
    error: r.error || '',
    saved: !!r.saved,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    expiresAt: r.expires_at
  };
}

/** 日志行 */
function shapeLog(r) {
  return {
    id: r.id,
    openid: r.openid,
    operator: r.operator,
    action: r.action,
    detail: r.detail,
    createdAt: r.created_at
  };
}

/** 管理员行 */
function shapeAdmin(r) {
  return {
    openid: r.openid,
    name: r.name || '',
    role: r.role,
    createdAt: r.created_at
  };
}

module.exports = { shapeUser, shapeJob, shapeLog, shapeAdmin };
