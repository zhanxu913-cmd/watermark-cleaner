/**
 * 激励视频广告（按微信官方示例实现）
 *
 * 官方示例结构：
 *   let videoAd = null
 *   if (wx.createRewardedVideoAd) {
 *     videoAd = wx.createRewardedVideoAd({ adUnitId: 'xxx' })
 *     videoAd.onLoad(() => {})
 *     videoAd.onError((err) => { console.error('激励视频广告加载失败', err) })
 *     videoAd.onClose((res) => {})
 *   }
 *   // 用户触发广告后
 *   videoAd.show().catch(() => {
 *     videoAd.load().then(() => videoAd.show()).catch(err => { ... })
 *   })
 *
 * 本文件在此基础上只做三件事（不改变调用方式）：
 *   1. 实例按页面缓存（官方要求实例仅对当前页面有效，不允许跨页复用）
 *   2. onClose 里用 res.isEnded 判断是否完整观看，决定是否发放额度
 *   3. 把关键事件写入本机存储，供「关于 → 广告诊断」在真机上查看
 *
 * 额度规则：图片免费；视频下载 1 段 = 1 条额度。
 *   QUOTA_FREE = 0  → 新用户不送免费额度，第一次下载即需看广告
 *   QUOTA_PER_AD = 3 → 每看完一次广告解锁 3 次下载
 */

'use strict';

const { AD_UNITS, QUOTA_PER_AD, QUOTA_ENABLED } = require('../utils/constants');
const quota = require('../utils/quota');
const { toast } = require('../utils/util');

// 页面路由 → 广告实例
const _ads = {};
// 页面路由 → 是否已拉取成功
const _adLoaded = {};
// 页面路由 → 最近一次错误
const _adErrors = {};

// 当前等待 onClose 的 promise（同一时刻只会有一个广告在播）
let _pending = null;
// 最近一次闸门未通过的原因（页面屏上提示用）
let _gateError = '';

/* ---------- 真机可读的诊断日志 ---------- */
const AD_LOG_KEY = 'wc_ad_log_v1';
const AD_LOG_MAX = 40;

function logAd(msg, extra) {
  const line =
    '[' + new Date().toTimeString().slice(0, 8) + '] ' + msg + (extra ? ' · ' + extra : '');
  try {
    console.log('[广告] ' + line);
  } catch (e) {
    /* 忽略 */
  }
  try {
    const arr = wx.getStorageSync(AD_LOG_KEY) || [];
    arr.push(line);
    while (arr.length > AD_LOG_MAX) arr.shift();
    wx.setStorageSync(AD_LOG_KEY, arr);
  } catch (e) {
    /* 忽略 */
  }
}

function isConfigured() {
  return !!AD_UNITS.REWARDED;
}

/** 当前页面路由（实例按页面隔离的缓存键） */
function pageKey() {
  try {
    const pages = getCurrentPages();
    const cur = pages[pages.length - 1];
    return (cur && cur.route) || 'none';
  } catch (e) {
    return 'none';
  }
}

/** 创建（或复用）当前页面的广告实例，等价于官方示例里 onLoad 中的那段 */
function getAd() {
  const key = pageKey();
  if (_ads[key]) return _ads[key];

  if (typeof wx.createRewardedVideoAd !== 'function') {
    _adErrors[key] = '当前基础库不支持激励视频广告';
    logAd('不支持激励视频', '基础库版本过低');
    return null;
  }
  if (!isConfigured()) {
    _adErrors[key] = '广告位未配置';
    logAd('广告位未配置', 'AD_UNITS.REWARDED 为空');
    return null;
  }

  let ad = null;
  try {
    ad = wx.createRewardedVideoAd({ adUnitId: AD_UNITS.REWARDED });
  } catch (e) {
    _adErrors[key] = (e && e.message) || '创建广告实例失败';
    logAd('创建实例失败', _adErrors[key]);
    return null;
  }
  if (!ad) {
    _adErrors[key] = '创建广告实例失败';
    logAd('创建实例失败', '返回空对象');
    return null;
  }

  ad.onLoad(() => {
    _adLoaded[key] = true;
    _adErrors[key] = '';
    logAd('广告加载成功', 'route=' + key);
  });

  ad.onError((err) => {
    _adLoaded[key] = false;
    _adErrors[key] =
      'errCode=' + ((err && err.errCode) || '-') + ' errMsg=' + ((err && err.errMsg) || '-');
    logAd('广告加载失败', _adErrors[key]);
  });

  ad.onClose((res) => {
    // 官方：res.isEnded === true 表示完整观看；低版本 res 为 undefined 时按看完处理
    const ended = !res || res.isEnded !== false;
    logAd('广告关闭', 'isEnded=' + (res ? String(res.isEnded) : 'undefined'));
    if (_pending) {
      const p = _pending;
      _pending = null;
      if (p.timer) clearTimeout(p.timer);
      p.resolve(ended ? 'ended' : 'skipped');
    }
  });

  _ads[key] = ad;
  return ad;
}

/**
 * 展示激励视频（官方示例的调用方式，失败自动 load 重试一次）
 * @returns {Promise<'ended'|'skipped'>}
 */
function showRewardedAd() {
  return new Promise((resolve, reject) => {
    const ad = getAd();
    if (!ad) {
      return reject(new Error(_adErrors[pageKey()] || '广告实例不可用'));
    }

    // 兜底超时：onClose 迟迟不回调时不让页面永远等下去
    const timer = setTimeout(() => {
      if (!_pending) return;
      _pending = null;
      logAd('广告超时', '45 秒未收到 onClose');
      reject(new Error('广告播放超时（45 秒未关闭）'));
    }, 45000);
    _pending = { resolve, reject, timer };

    logAd('调用 show');
    ad.show()
      .catch(() => {
        logAd('show 失败，load 后重试');
        return ad.load().then(() => ad.show());
      })
      .then(() => logAd('show 成功，等待关闭'))
      .catch((err) => {
        if (!_pending) return; // 已由 onClose / 超时处理
        const p = _pending;
        _pending = null;
        if (p.timer) clearTimeout(p.timer);
        const raw = (err && (err.errMsg || err.message)) || '';
        // 优先用 onError 里带 errCode 的信息，便于定位（1004/1005/1008 等）
        const msg = _adErrors[pageKey()] || raw || '广告显示失败';
        logAd('广告显示失败', msg);
        try {
          console.error('[广告] show 失败，原始错误：', err);
        } catch (e2) {
          /* 忽略 */
        }
        reject(new Error(msg));
      });
  });
}

/* ---------- 每日观看次数 ---------- */
const AD_DAILY_KEY = 'wc_ad_daily_v1'; // { date: 'YYYY-MM-DD', count }
const MAX_AD_PER_DAY = 10;

function todayStr() {
  const d = new Date();
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function dailyCount() {
  try {
    const v = wx.getStorageSync(AD_DAILY_KEY);
    if (v && v.date === todayStr()) return Math.max(0, Number(v.count) || 0);
  } catch (e) {
    /* 按 0 处理 */
  }
  return 0;
}

function bumpDailyCount() {
  const next = { date: todayStr(), count: dailyCount() + 1 };
  try {
    wx.setStorageSync(AD_DAILY_KEY, next);
  } catch (e) {
    /* 写失败仅当日计数失效 */
  }
  return next.count;
}

/** 页面 onLoad 时调用：提前创建并拉取，减少首次点击等待 */
function preload() {
  if (!QUOTA_ENABLED) return;
  try {
    const ad = getAd();
    if (!ad) return;
    const r = ad.load();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (e) {
    /* 忽略 */
  }
}

/** 统一信息弹窗 */
function tip(title, content) {
  wx.showModal({
    title,
    content,
    showCancel: false,
    confirmText: '知道了',
    confirmColor: '#185FA5'
  });
}

/**
 * 额度闸门：视频下载前调用
 * 有额度 → 放行；没额度 → 引导看广告，完整看完才发额度
 * @returns {Promise<boolean>}
 */
async function ensureQuota() {
  if (!QUOTA_ENABLED) return true;

  const left = quota.get();
  logAd('闸门进入', '剩余额度=' + left + ' 今日已看=' + dailyCount() + '/' + MAX_AD_PER_DAY);
  if (left > 0) {
    _gateError = '';
    return true;
  }

  if (dailyCount() >= MAX_AD_PER_DAY) {
    logAd('已达每日观看上限');
    _gateError = '今日观看次数已达上限';
    tip('今日观看次数已达上限', '每个用户每天可观看的广告次数有限，明天再来解锁更多下载额度吧。');
    return false;
  }

  const go = await new Promise((resolve) => {
    wx.showModal({
      title: '看广告解锁下载',
      content:
        '图片处理完全免费；下载视频每条需要 1 次额度。看完一段短视频广告，即可解锁 ' +
        QUOTA_PER_AD +
        ' 次下载。',
      confirmText: '看广告解锁',
      cancelText: '暂不',
      confirmColor: '#185FA5',
      success: (r) => resolve(!!(r && r.confirm)),
      fail: () => resolve(false)
    });
  });
  if (!go) {
    logAd('用户点了暂不');
    _gateError = '用户取消';
    return false;
  }

  try {
    const r = await showRewardedAd();
    if (r === 'ended') {
      quota.add(QUOTA_PER_AD);
      bumpDailyCount();
      logAd('发放额度', '+' + QUOTA_PER_AD + '，今日第 ' + dailyCount() + ' 次');
      toast('已解锁 ' + QUOTA_PER_AD + ' 次下载', 'success');
      _gateError = '';
      return true;
    }
    logAd('未看完，不发额度');
    _gateError = '广告未看完';
    toast('广告未看完，本次未解锁');
    return false;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    logAd('广告异常', msg);
    try {
      console.error('[广告] 播放失败，原始错误：', e);
    } catch (e2) {
      /* 忽略 */
    }
    _gateError = msg;
    wx.showModal({
      title: '广告无法播放',
      content: msg + '\n\n点「看诊断」可查看完整错误码与日志。',
      confirmText: '看诊断',
      cancelText: '知道了',
      confirmColor: '#185FA5',
      success: (r) => {
        if (r && r.confirm) {
          try {
            wx.navigateTo({ url: '/packageCommon/pages/about/index?diag=1' });
          } catch (e3) {
            /* 忽略 */
          }
        }
      }
    });
    return false;
  }
}

/* ---------- 诊断 ---------- */
function getDiag() {
  let sys = {};
  try {
    sys = wx.getSystemInfoSync() || {};
  } catch (e) {
    /* 忽略 */
  }
  const key = pageKey();
  let logs = [];
  try {
    logs = (wx.getStorageSync(AD_LOG_KEY) || []).slice(-20);
  } catch (e) {
    /* 忽略 */
  }
  return {
    enabled: QUOTA_ENABLED,
    unitId: AD_UNITS.REWARDED || '(未配置)',
    platform: (sys.platform || '-') + ' / 基础库 ' + (sys.SDKVersion || '-'),
    route: key,
    loaded: _adLoaded[key] ? '已拉取' : '未拉取',
    lastError: _adErrors[key] || '无',
    quota: quota.get(),
    daily: dailyCount() + ' / ' + MAX_AD_PER_DAY,
    gateError: _gateError || '无',
    logs: logs.length ? logs : ['（暂无记录，请先点一次「测试拉起激励视频」）']
  };
}

/** 最近一次闸门未通过的原因（页面屏上提示用） */
function lastGateError() {
  return _gateError;
}

function clearDiagLogs() {
  try {
    wx.removeStorageSync(AD_LOG_KEY);
  } catch (e) {
    /* 忽略 */
  }
}

/** 手动测试拉起（不发额度，只验证能否播放） */
async function testShow() {
  logAd('=== 手动测试 ===');
  try {
    const r = await showRewardedAd();
    return r === 'ended' ? '广告播放完成（isEnded=true）' : '广告被提前关闭（isEnded=false）';
  } catch (e) {
    return '失败：' + ((e && e.message) || e);
  }
}

module.exports = {
  ensureQuota,
  showRewardedAd,
  preload,
  isConfigured,
  getDiag,
  clearDiagLogs,
  testShow,
  lastGateError
};
