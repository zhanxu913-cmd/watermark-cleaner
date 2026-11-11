/**
 * 视频下载额度（纯本地，零后端）
 *
 * 规则：
 *   - 图片处理完全免费，不消耗额度
 *   - 每下载 1 段视频（保存到相册 / 导出文件）消耗 1 条
 *   - 新用户首次使用自动送 QUOTA_FREE 条
 *   - 额度用完 → 观看激励视频广告 → 每次解锁 QUOTA_PER_AD 条
 *   - 数据存本机 storage，清理小程序缓存会重置（可接受：额度本来就是本地权益）
 */

'use strict';

const { QUOTA_FREE } = require('./constants');

const KEY = 'wc_quota_v1'; // { n: 剩余条数, init: 是否已发过新手额度 }

function read() {
  try {
    const v = wx.getStorageSync(KEY);
    if (v && typeof v === 'object') return v;
  } catch (e) {
    /* 存储异常按新用户处理 */
  }
  return null;
}

function write(obj) {
  try {
    wx.setStorageSync(KEY, obj);
  } catch (e) {
    /* 写失败时额度仅本次会话内有效 */
  }
}

/** 取剩余条数；首次调用自动发放新手免费额度 */
function get() {
  let v = read();
  if (!v) {
    v = { n: QUOTA_FREE, init: 1 };
    write(v);
  }
  return Math.max(0, Number(v.n) || 0);
}

/** 增加条数（看广告解锁后调用） */
function add(n) {
  const cur = get();
  const next = { n: Math.min(9999, cur + Math.max(0, Number(n) || 0)), init: 1 };
  write(next);
  return next.n;
}

/**
 * 扣减条数（处理成功后调用）
 * @returns {boolean} 是否扣减成功（不足时不扣）
 */
function consume(n) {
  const cur = get();
  const cost = Math.max(1, Number(n) || 1);
  if (cur < cost) return false;
  write({ n: cur - cost, init: 1 });
  return true;
}

module.exports = { get, add, consume };
