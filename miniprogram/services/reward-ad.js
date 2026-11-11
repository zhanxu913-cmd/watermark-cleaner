/**
 * 激励视频广告实例（严格按官方文档规范实现）
 *
 * 官方文档要点：
 *   - wx.createRewardedVideoAd 返回单例，但实例【仅对当前页面有效，不允许跨页面使用】
 *     → 因此按页面路由缓存实例，每个页面各自创建/复用自己的实例
 *   - 广告组件默认隐藏、自动拉取；建议展示前提前创建以初始化
 *   - show() 被 reject 时调用 load() 重新拉取后再 show()
 *   - onClose 的 res.isEnded 判断是否完整观看（true 才发奖）
 *   - 多次调用 onClose 等监听会产生多次回调 → 先 offClose 再 onClose，保证单监听
 *
 * 额度只约束「视频下载」：每下载 1 段视频扣 1 条；图片处理完全免费。
 * 上线前必须配置 utils/constants.js 的 AD_UNITS.REWARDED。
 * 未配置时：开发者工具模拟器直接发放额度（测试用）；真机提示未配置。
 */

'use strict';

const { AD_UNITS, QUOTA_PER_AD, QUOTA_ENABLED, IS_DEVTOOLS } = require('../utils/constants');
const quota = require('../utils/quota');
const { toast } = require('../utils/util');

// 按页面路由缓存广告实例：{ route: RewardedVideoAd }
const _ads = {};
// 各页面广告是否已拉取就绪：{ route: boolean }
const _adLoaded = {};
// 各页面最近一次 onError 信息：{ route: errMsg }
const _adErrors = {};

/* ---------- 真机可读的诊断日志 ----------
 * 真机上 console 默认看不到，所以把关键事件写进本机 storage 环形缓冲，
 * 在「我的 → 关于 → 广告诊断」里直接查看，无需连电脑。
 */
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

/** 取当前页面的广告实例；没有则创建并注册一次性监听（onLoad/onError 只挂一次）
 *  创建失败（如低版本基础库/环境不支持）返回 null，调用方须判空并给出友好提示 */
function getAd() {
  const key = pageKey();
  if (_ads[key]) return _ads[key];

  let ad = null;
  try {
    logAd('创建广告实例', 'route=' + key + ' unit=' + AD_UNITS.REWARDED);
    ad = wx.createRewardedVideoAd({ adUnitId: AD_UNITS.REWARDED });
  } catch (e) {
    _adLoaded[key] = false;
    _adErrors[key] = (e && e.message) || '当前环境不支持激励视频广告';
    logAd('创建实例失败', _adErrors[key]);
    return null;
  }
  if (!ad) {
    _adLoaded[key] = false;
    _adErrors[key] = '当前环境不支持激励视频广告';
    logAd('创建实例失败', '返回空对象');
    return null;
  }
  ad.onLoad(() => {
    // 拉取成功（无参数）→ 记录就绪状态，供「展示前判断拉取是否成功」使用
    _adLoaded[key] = true;
    logAd('广告拉取成功', 'route=' + key);
  });
  ad.onError((err) => {
    _adLoaded[key] = false;
    _adErrors[key] = (err && (err.errMsg || err.errCode)) || '广告加载失败';
    logAd(
      '广告拉取失败',
      'errCode=' + ((err && err.errCode) || '-') + ' errMsg=' + ((err && err.errMsg) || '-')
    );
  });
  _ads[key] = ad;
  return ad;
}

/** 当前页面的广告是否已拉取成功（官方建议：展示广告按钮前先判断） */
function isAdLoaded() {
  return !!_adLoaded[pageKey()];
}

/**
 * 确保广告拉取就绪：未就绪则主动 load() 并短暂等待（最多 waitMs 毫秒）。
 * 用于弹「看广告解锁」弹窗之前，避免用户点了却拉不到广告。
 */
async function ensureLoaded(waitMs) {
  if (isAdLoaded()) return true;
  const ad = getAd();
  if (!ad) return false;
  try {
    const r = ad.load();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (e) {
    /* 忽略 */
  }
  const deadline = Date.now() + (waitMs || 3000);
  while (Date.now() < deadline) {
    await sleep(200);
    if (isAdLoaded()) return true;
  }
  return isAdLoaded();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 统一的信息弹窗（只有「知道了」，不阻塞业务流） */
function tip(title, content) {
  wx.showModal({
    title,
    content,
    showCancel: false,
    confirmText: '知道了',
    confirmColor: '#185FA5'
  });
}

/* ---------- 每日观看次数防护 ----------
 * 官方说明：每个用户每天可观看激励视频广告的次数有限（平台侧限制，
 * 官方未公布具体数值，按用户流量质量动态调整）。超限后 show() 必然失败，
 * 与其让用户白等，不如本地先拦。
 *
 * 本地上限设为 MAX_AD_PER_DAY = 10 次/天：
 *   - 每次看完解锁 3 次下载 → 每天最多可解锁 30 次视频下载，对真实用户绰绰有余
 *   - 行业通行值：工具类小程序每天 5~10 次激励视频
 *   - 达到 10 次即触发友好提示，避免触碰平台限制后白白调用
 */
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

/**
 * 预加载当前页面的广告（页面 onLoad 时调用，提前初始化组件）
 * 静默执行，失败不影响页面功能。
 */
function preload() {
  // 额度闸门关闭时不会展示激励视频，无需预拉取
  if (!QUOTA_ENABLED) return;
  try {
    if (typeof wx.createRewardedVideoAd !== 'function' || !isConfigured()) return;
    const ad = getAd();
    if (!ad) return;
    const r = ad.load();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 把可能返回 undefined 的旧版接口（show/load）统一成 Promise，
 * 避免低版本基础库上 `.catch` 报 TypeError
 */
function callAd(fn, ctx) {
  try {
    const r = fn.call(ctx);
    return r && typeof r.then === 'function' ? r : Promise.resolve(r);
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * 拉起激励视频广告
 * @returns {Promise<'ended'|'skipped'>} ended = 完整看完（可发奖）
 */
function showRewardedAd() {
  return new Promise((resolve, reject) => {
    if (typeof wx.createRewardedVideoAd !== 'function') {
      return reject(new Error('当前微信版本不支持激励视频广告'));
    }
    if (!isConfigured()) {
      return reject(
        new Error(
          '广告位未配置：请先在 mp 后台开通流量主并创建激励视频广告位，再把 ID 填入 utils/constants.js 的 AD_UNITS.REWARDED'
        )
      );
    }

    const key = pageKey();
    const ad = getAd();
    if (!ad) {
      return reject(new Error(_adErrors[key] || '当前环境不支持激励视频广告'));
    }

    let settled = false;
    let timer = null;

    // 单监听：挂新监听前先清空历史监听，避免多次观看后 onClose 累积重复回调
    const closeHandler = (res) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeClose();
      logAd('广告关闭', 'isEnded=' + (res && typeof res.isEnded !== 'undefined' ? res.isEnded : 'undefined'));
      // 兼容低版本：res 为 undefined 时视为看完（旧版关闭按钮只在播完后出现）
      resolve(res && res.isEnded === false ? 'skipped' : 'ended');
    };
    const removeClose = () => {
      try {
        ad.offClose && ad.offClose(closeHandler);
      } catch (e) {
        /* 忽略 */
      }
    };

    // 播放超时保护：onClose 迟迟不回调时不至于让用户永远卡在「保存中…」
    const AD_TIMEOUT_MS = 90000;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      removeClose();
      reject(new Error('广告播放超时，请稍后再试'));
    }, AD_TIMEOUT_MS);

    try {
      ad.offClose && ad.offClose(); // 清空历史监听（无参 = 全部移除）
    } catch (e) {
      /* 忽略 */
    }
    ad.onClose(closeHandler);

    // 每次播放结束后组件都需要重新 load 才能再次 show，先标记为未就绪
    _adLoaded[key] = false;

    // 拉取失败 → load() 重新拉取 → 再 show()（官方推荐写法）
    logAd('调用 show');
    callAd(ad.show, ad)
      .then(() => logAd('show 成功，等待用户关闭'))
      .catch((e1) => {
        logAd('show 失败，重新 load', (e1 && (e1.errMsg || e1.message)) || '-');
        return callAd(ad.load, ad).then(() => callAd(ad.show, ad)).then(() => logAd('重试 show 成功'));
      })
      .catch((e2) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        removeClose();
        logAd('广告展示失败', (e2 && (e2.errMsg || e2.message)) || '-');
        reject(new Error(_adErrors[key] || '广告拉取失败，请稍后再试'));
      });
  });
}

/**
 * 额度闸门：视频下载/保存前调用。
 * 有额度 → 直接放行；没额度 → 弹窗引导看广告，看完发奖后放行。
 *
 * 弹窗前做两道官方建议的防护：
 *   1. 每日观看次数已达上限 → 直接告知，不再弹广告入口（平台对每用户每日次数有限制）
 *   2. 广告未拉取成功 → 先主动 load() 并短暂等待；仍失败则提示稍后再试
 * @returns {Promise<boolean>} true = 可以继续下载
 */
async function ensureQuota() {
  // 总开关关闭：下载不校验额度、不弹广告，直接放行
  if (!QUOTA_ENABLED) return true;
  try {
    return await ensureQuotaInner();
  } catch (e) {
    // 未预期异常：明确告知用户，不放行（避免静默失败）
    console.warn('[广告闸门] 异常:', (e && e.message) || e);
    tip('广告暂时无法播放', '请稍后再试。');
    return false;
  }
}

async function ensureQuotaInner() {
  const left = quota.get();
  logAd('闸门进入', '剩余额度=' + left + ' 今日已看=' + dailyCount() + '/' + MAX_AD_PER_DAY + ' 就绪=' + isAdLoaded());

  if (left > 0) return true;

  // 开发者工具：广告基本拉不到，跳过闸门直接放行，便于工具内自测保存流程
  if (IS_DEVTOOLS) {
    logAd('开发者工具环境，跳过广告直接放行');
    return true;
  }

  // 防护一：每日观看次数上限（平台侧每用户每天有观看/拉取次数限制）
  if (dailyCount() >= MAX_AD_PER_DAY) {
    logAd('已达每日观看上限，拦截');
    tip('今日观看次数已达上限', '每个用户每天可观看的广告次数有限，明天再来解锁更多下载额度吧。');
    return false;
  }

  // 防护二：展示广告入口前先确认拉取成功（未就绪时主动拉取，最多等 3 秒）
  if (isConfigured()) {
    const ready = await ensureLoaded(3000);
    logAd('拉取检查', 'ready=' + ready + ' lastError=' + (_adErrors[pageKey()] || '无'));
    if (!ready) {
      // 广告拉不到：明确提示，本次不下载
      tip('广告暂时无法播放', '广告还在准备中，请稍后再试。');
      return false;
    }
  } else {
    logAd('广告位未配置', 'AD_UNITS.REWARDED 为空');
  }

  const go = await new Promise((resolve) => {
    wx.showModal({
      title: '下载额度已用完',
      content:
        '图片处理免费；下载视频每次消耗 1 条。观看一段短视频广告，即可解锁 ' +
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
    logAd('用户在解锁弹窗点了暂不');
    return false;
  }
  logAd('用户确认看广告，开始 show()');

  try {
    const r = await showRewardedAd();
    if (r === 'ended') {
      quota.add(QUOTA_PER_AD);
      bumpDailyCount(); // 计入当日观看次数（官方：每用户每天次数有限）
      logAd('发奖成功', '+' + QUOTA_PER_AD + ' 条，今日第 ' + dailyCount() + ' 次');
      toast('已解锁 ' + QUOTA_PER_AD + ' 次下载', 'success');
      return true;
    }
    // 用户中途关闭广告（isEnded = false）：按官方规范不发奖
    logAd('广告未看完，不发奖');
    toast('广告未看完，本次未解锁');
    return false;
  } catch (e) {
    // 模拟器 + 未配置广告位：直接发放，方便开发测试（真机不会走这条分支）
    const isSimulator = (() => {
      try {
        return wx.getSystemInfoSync().platform === 'devtools';
      } catch (e2) {
        return false;
      }
    })();
    if (isSimulator && !isConfigured()) {
      quota.add(QUOTA_PER_AD);
      toast('开发模式：直接解锁 ' + QUOTA_PER_AD + ' 条（上线前需配置广告位）');
      return true;
    }
    // 广告播放失败（无填充/网络/机型问题）→ 给出具体原因，本次不下载
    console.warn('[广告闸门] 广告播放失败:', (e && e.message) || e);
    tip('广告暂时无法播放', (e && e.message) || '请稍后再试。');
    return false;
  }
}

/**
 * 广告诊断信息（关于页展示用）——真机看不到 console 时的唯一排查入口
 */
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
    loaded: !!_adLoaded[key] ? '已拉取' : '未拉取',
    lastError: _adErrors[key] || '无',
    quota: quota.get(),
    daily: dailyCount() + ' / ' + MAX_AD_PER_DAY,
    logs: logs.length ? logs : ['（暂无记录，请先点一次「测试拉起激励视频」）']
  };
}

/** 清除诊断日志 */
function clearDiagLogs() {
  try {
    wx.removeStorageSync(AD_LOG_KEY);
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 直接测试拉起激励视频（关于页按钮用），不校验额度、不发奖，
 * 只为验证「这台手机 + 这个广告位」到底能不能播。
 * @returns {Promise<string>} 结果文案
 */
async function testShow() {
  logAd('=== 手动测试开始 ===');
  try {
    const r = await showRewardedAd();
    return r === 'ended' ? '广告播放完成（isEnded=true）' : '广告被提前关闭（isEnded=false）';
  } catch (e) {
    return '失败：' + ((e && e.message) || e);
  }
}

module.exports = { ensureQuota, showRewardedAd, preload, isConfigured, getDiag, clearDiagLogs, testShow };
