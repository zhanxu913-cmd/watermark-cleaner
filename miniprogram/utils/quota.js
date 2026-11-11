/**
 * 视频下载额度（纯本地，零后端）
 *
 * 规则：
 *   - 图片处理完全免费，不消耗额度
 *   - 每下载 1 段视频消耗 1 条额度
 *   - QUOTA_FREE = 0：新用户不送免费额度，第一次下载即需看广告
 *   - 看完一次激励视频 → QUOTA_PER_AD 条
 *   - 数据存本机 storage，清理小程序缓存会重置（可接受：额度是本地权益）
 */

'use strict';

const { QUOTA_FREE } = require('./constants');

const KEY = 'wc_quota_v1';
// 版本号：v2 起取消新用户免费额度。
// 老版本（无 v 字段或 v < 2）的本地额度会被重置，避免历史赠送的额度继续生效。
const VER = 2;

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
  obj.v = VER;
  try {
    wx.setStorageSync(KEY, obj);
  } catch (e) {
    /* 写失败时额度仅本次会话内有效 */
  }
}

/** 取剩余条数；首次（或版本升级）自动按当前规则重置 */
function get() {
  let v = read();
  if (!v || v.v !== VER) {
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
 * 扣减条数（保存成功后调用）
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
