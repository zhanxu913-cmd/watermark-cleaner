/**
 * 激励视频广告 + 额度闸门
 *
 * 上线前必须配置 utils/constants.js 的 AD_UNIT_ID：
 *   mp.weixin.qq.com → 流量主（累计 1000 独立访客后可开通）→ 广告位管理
 *   → 新建「激励视频」广告位 → 把 adunit-xxxx 填入 AD_UNIT_ID。
 *
 * 未配置 AD_UNIT_ID 时的行为：
 *   - 开发者工具模拟器：直接发放额度（方便开发测试完整流程）
 *   - 真机：明确提示「广告位未配置」，不发放
 */

'use strict';

const { AD_UNIT_ID, QUOTA_PER_AD } = require('../utils/constants');
const quota = require('../utils/quota');
const { toast } = require('../utils/util');

let _ad = null; // RewardedVideoAd 全局单例
let _adError = ''; // 最近一次广告加载错误（用于提示）

function isConfigured() {
  return !!AD_UNIT_ID;
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
          '广告位未配置：请先在 mp 后台开通流量主并创建激励视频广告位，再把 ID 填入 utils/constants.js 的 AD_UNIT_ID'
        )
      );
    }

    if (!_ad) {
      _ad = wx.createRewardedVideoAd({ adUnitId: AD_UNIT_ID });
      _ad.onError((err) => {
        _adError = (err && (err.errMsg || err.errCode)) || '广告加载失败';
      });
    }

    // 每次 show 前重挂 onClose，避免旧回调累积
    const onClose = (res) => {
      _ad.offClose && _ad.offClose(onClose);
      // 兼容低版本：res 为 undefined 时视为看完（旧版基础库关闭按钮只在播完后出现）
      resolve(res && res.isEnded === false ? 'skipped' : 'ended');
    };
    try {
      _ad.offClose && _ad.offClose(onClose);
    } catch (e) {
      /* 忽略 */
    }
    _ad.onClose(onClose);

    const show = () =>
      _ad.show().catch(() => _ad.load().then(() => _ad.show()));

    show().catch((e) => {
      reject(new Error(_adError || (e && e.errMsg) || '广告拉取失败，请稍后再试'));
    });
  });
}

/**
 * 额度闸门：编辑器提交前调用。
 * 有额度 → 直接放行；没额度 → 弹窗引导看广告，看完发奖后放行。
 * @returns {Promise<boolean>} true = 可以继续处理
 */
async function ensureQuota() {
  const left = quota.get();

  if (left > 0) return true;

  const go = await new Promise((resolve) => {
    wx.showModal({
      title: '免费额度已用完',
      content: '观看一段短视频广告，即可解锁 ' + QUOTA_PER_AD + ' 条去水印额度。',
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

module.exports = { ensureQuota, isConfigured };
