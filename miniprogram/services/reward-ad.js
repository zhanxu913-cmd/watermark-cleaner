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
// 页面路由 → 该实例创建时使用的广告位 ID
// （换广告位后必须重建实例，否则内存里一直是旧 ID 的实例）
const _adUnit = {};
// 页面路由 → 是否已拉取成功
const _adLoaded = {};
// 页面路由 → 最近一次错误
const _adErrors = {};

// 当前等待 onClose 的会话（同一时刻只会有一个广告在播）
let _pending = null;
// 最近一次闸门未通过的原因（页面屏上提示用）
let _gateError = '';

/* ---------- errCode 中文释义 ---------- */
const ERR_TEXT = {
  1000: '网络异常，请检查网络后重试',
  1001: '广告位 ID 无效',
  1002: '广告位已被关闭',
  1004: '广告位无效，或类型不是「激励视频」',
  1005: '广告位不属于当前小程序',
  1006: '广告位已被删除',
  1008: '广告暂无填充（新流量主 / 新广告位通常要等后台放量）',
  2001: '广告组件未就绪，请稍后重试',
  2002: '广告组件已失效，请退出页面重新进入'
};

/**
 * 把微信返回的原始错误翻译成能看懂的一句话
 * @param {object} err 微信回调里的 err 对象
 * @param {string} [fallback] 没有 errCode 时的兜底文案
 */
function describeErr(err, fallback) {
  const raw = (err && (err.errMsg || err.message)) || '';
  let code = Number((err && (err.errCode || err.errno)) || 0);
  if (!code) {
    const m = String(raw).match(/\b(1\d{3}|2\d{3})\b/);
    if (m) code = Number(m[1]);
  }
  if (code && ERR_TEXT[code]) return '[' + code + '] ' + ERR_TEXT[code];
  if (fallback) return fallback;
  if (raw) {
    // 从 "errCode=1008 errMsg=..." 里再抠一次
    const m2 = String(raw).match(/(?:errCode=)?\b(1\d{3}|2\d{3})\b/);
    if (m2 && ERR_TEXT[Number(m2[1])]) return '[' + m2[1] + '] ' + ERR_TEXT[Number(m2[1])];
    return raw;
  }
  return '广告显示失败';
}

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
  // 缓存只在「广告位没变」时复用。换过 adUnitId 后旧实例必须重建，
  // 否则改了常量却不生效（这是排查时最容易误判的一环）。
  if (_ads[key] && _adUnit[key] === AD_UNITS.REWARDED) return _ads[key];
  if (_ads[key] && _adUnit[key] !== AD_UNITS.REWARDED) {
    logAd('广告位已变更，重建实例', _adUnit[key] + ' → ' + AD_UNITS.REWARDED);
    delete _ads[key];
    delete _adLoaded[key];
    delete _adErrors[key];
  }

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
    _adErrors[key] = describeErr(e, '创建广告实例失败');
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
    const text = describeErr(err);
    _adErrors[key] = text;
    logAd('广告加载失败', text);
    try {
      console.error('[广告] onError 原始错误：', err);
    } catch (e2) {
      /* 忽略 */
    }
    // 拉取就失败了，没必要让调用方等到 45 秒超时
    if (_pending) _pending.done(new Error(text));
  });

  ad.onClose((res) => {
    // 官方语义：res.isEnded === true 才算完整观看。
    // 低版本回调不带 res（undefined），此时按看完处理，避免误伤用户。
    const ended = !res ? true : res.isEnded === true;
    logAd('广告关闭', 'isEnded=' + (res ? String(res.isEnded) : 'undefined'));
    if (_pending) _pending.done(null, ended ? 'ended' : 'skipped');
  });

  _ads[key] = ad;
  _adUnit[key] = AD_UNITS.REWARDED;
  return ad;
}

/** 带超时的 load：无填充时 load 可能既不 resolve 也不 reject，必须自己兜底 */
function loadWithTimeout(ad, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('[超时] 广告素材加载超时'));
    }, ms);
    let p = null;
    try {
      p = ad.load();
    } catch (e) {
      done = true;
      clearTimeout(t);
      return reject(e);
    }
    if (!p || typeof p.then !== 'function') {
      done = true;
      clearTimeout(t);
      return resolve();
    }
    p.then(() => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve();
    }).catch((e) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      reject(e);
    });
  });
}

/**
 * 展示激励视频（官方示例的调用方式，失败自动 load 重试一次）
 *
 * 相比官方示例多做了三件事，都是为了「点下去必须有可见反馈」：
 *   1. 全程挂「加载广告…」的 loading，用户不会以为点击没生效
 *   2. load 加 8 秒超时，避免无填充时无限挂起
 *   3. 失败原因翻译成中文错误码说明，而不是甩英文 errMsg
 *
 * @returns {Promise<'ended'|'skipped'>}
 */
function showRewardedAd() {
  return new Promise((resolve, reject) => {
    const ad = getAd();
    const key = pageKey();
    if (!ad) {
      return reject(new Error(_adErrors[key] || '广告实例不可用'));
    }

    let settled = false;
    let timer = null;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (_pending === holder) _pending = null;
      try {
        wx.hideLoading();
      } catch (e) {
        /* 忽略 */
      }
      if (err) reject(err);
      else resolve(val);
    };

    // onClose / onError 通过这个句柄回到这里
    const holder = { done: finish };
    _pending = holder;

    // 兜底超时：onClose 迟迟不回调时不让页面永远等下去
    timer = setTimeout(() => {
      logAd('广告超时', '45 秒未收到 onClose');
      finish(new Error(_adErrors[key] || '[超时] 广告播放超时，请稍后重试'));
    }, 45000);

    // 立刻给出可见反馈
    try {
      wx.showLoading({ title: '加载广告…', mask: false });
    } catch (e) {
      /* 忽略 */
    }

    logAd('调用 show', 'unit=' + AD_UNITS.REWARDED);
    ad.show()
      .then(() => {
        logAd('show 成功，等待关闭');
        try {
          wx.hideLoading();
        } catch (e) {
          /* 忽略 */
        }
      })
      .catch(() => {
        logAd('show 失败，load 后重试');
        return loadWithTimeout(ad, 8000)
          .then(() => ad.show())
          .then(() => {
            logAd('重试 show 成功，等待关闭');
            try {
              wx.hideLoading();
            } catch (e) {
              /* 忽略 */
            }
          });
      })
      .catch((err) => {
        const msg = describeErr(err, _adErrors[key]);
        logAd('广告显示失败', msg);
        try {
          console.error('[广告] 显示失败，原始错误：', err);
        } catch (e2) {
          /* 忽略 */
        }
        finish(new Error(msg));
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
