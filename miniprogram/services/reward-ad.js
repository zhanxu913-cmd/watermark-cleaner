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

const { AD_UNITS, QUOTA_PER_AD } = require('../utils/constants');
const quota = require('../utils/quota');
const { toast } = require('../utils/util');

// 按页面路由缓存广告实例：{ route: RewardedVideoAd }
const _ads = {};
// 各页面最近一次 onError 信息：{ route: errMsg }
const _adErrors = {};

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

/** 取当前页面的广告实例；没有则创建并注册一次性监听（onLoad/onError 只挂一次） */
function getAd() {
  const key = pageKey();
  if (_ads[key]) return _ads[key];

  const ad = wx.createRewardedVideoAd({ adUnitId: AD_UNITS.REWARDED });
  ad.onLoad(() => {
    // 拉取成功（无参数）→ 记录就绪状态，供「展示前判断拉取是否成功」使用
    _adLoaded[key] = true;
  });
  ad.onError((err) => {
    _adLoaded[key] = false;
    _adErrors[key] = (err && (err.errMsg || err.errCode)) || '广告加载失败';
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
  try {
    ad.load().catch(() => {});
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
  try {
    if (typeof wx.createRewardedVideoAd !== 'function' || !isConfigured()) return;
    getAd().load().catch(() => {});
  } catch (e) {
    /* 忽略 */
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

    const ad = getAd();

    // 单监听：先取消旧的 onClose 再挂新的，避免多次回调
    const onClose = (res) => {
      ad.offClose && ad.offClose(onClose);
      // 兼容低版本：res 为 undefined 时视为看完（旧版关闭按钮只在播完后出现）
      resolve(res && res.isEnded === false ? 'skipped' : 'ended');
    };
    try {
      ad.offClose && ad.offClose(onClose);
    } catch (e) {
      /* 忽略 */
    }
    ad.onClose(onClose);

    // 拉取失败 → load() 重新拉取 → 再 show()（官方推荐写法）
    ad.show()
      .catch(() => ad.load().then(() => ad.show()))
      .catch(() => {
        reject(
          new Error(_adErrors[pageKey()] || '广告拉取失败，请稍后再试')
        );
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
  const left = quota.get();

  if (left > 0) return true;

  // 防护一：每日观看次数上限（平台侧每用户每天有观看/拉取次数限制）
  if (dailyCount() >= MAX_AD_PER_DAY) {
    wx.showModal({
      title: '今日观看次数已达上限',
      content: '每个用户每天可观看的广告次数有限，明天再来解锁更多下载额度吧。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#185FA5'
    });
    return false;
  }

  // 防护二：展示广告入口前先确认拉取成功（未就绪时主动拉取，最多等 3 秒）
  if (isConfigured()) {
    const ready = await ensureLoaded(3000);
    if (!ready) {
      wx.showModal({
        title: '广告暂时无法播放',
        content: '广告还在准备中，请稍后重试。',
        showCancel: false,
        confirmText: '知道了',
        confirmColor: '#185FA5'
      });
      return false;
    }
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
  if (!go) return false;

  try {
    const r = await showRewardedAd();
    if (r === 'ended') {
      quota.add(QUOTA_PER_AD);
      bumpDailyCount(); // 计入当日观看次数（官方：每用户每天次数有限）
      toast('已解锁 ' + QUOTA_PER_AD + ' 条额度', 'success');
      return true;
    }
    // 走到这里只有一种情况：完整看完但渠道未计奖（理论不会发生），不发奖
    toast('未完成观看，额度未解锁');
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
    wx.showModal({
      title: '广告暂时无法播放',
      content: (e && e.message) || '请稍后再试',
      showCancel: false,
      confirmColor: '#185FA5'
    });
    return false;
  }
}

module.exports = { ensureQuota, showRewardedAd, preload, isConfigured };
