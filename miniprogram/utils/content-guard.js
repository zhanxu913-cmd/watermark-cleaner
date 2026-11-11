'use strict';

/**
 * 内容安全守卫
 *
 * 背景：微信审核要求 UGC 类小程序接入内容安全能力，并在检测到违规内容时
 * 提示「该内容含违规信息」即可（审核意见第 2 条）。
 *
 * 当前版本不依赖任何服务端，已落地的三件事：
 *   1. 首次进入弹出「使用规范」，明确禁止处理违法违规内容
 *   2. 开始处理前必须确认已知晓规范（未确认则不进入处理）
 *   3. 违规提示统一文案，页面无需各自拼字符串
 *
 * 将来若接入官方内容安全接口（/wxa/msg_sec_check、/wxa/media_check_async，
 * 需服务端或云函数持 access_token 调用），只需把 SEC_CHECK_ENABLED 置 true，
 * 并在 check() 里补上请求逻辑 —— 页面调用方完全不用改。
 */

// 素材检测开关：false = 当前无检测，一律放行（纯本地）
const SEC_CHECK_ENABLED = false;

// 本机是否已确认过使用规范
const STORAGE_KEY = 'wc_sec_agree_v1';

// 违规提示文案（与审核意见里的表述保持一致）
const VIOLATION_TEXT = '该内容含违规信息，无法处理。';

const NOTICE_TITLE = '使用规范';
const NOTICE_CONTENT =
  '本小程序仅用于处理你自己拍摄、自己制作或已获得授权的素材。\n\n' +
  '请勿处理含有违法违规内容的图片或视频，包括但不限于色情低俗、暴力血腥、恐怖主义、赌博诈骗、违法广告等。\n\n' +
  '如检测到内容含违规信息，将提示「该内容含违规信息」并拒绝处理。';

let _agreed = null; // 内存缓存
let _pending = null; // 同一时刻只弹一次

function readAgreed() {
  if (_agreed !== null) return _agreed;
  try {
    _agreed = !!wx.getStorageSync(STORAGE_KEY);
  } catch (e) {
    _agreed = false;
  }
  return _agreed;
}

function markAgreed() {
  _agreed = true;
  try {
    wx.setStorageSync(STORAGE_KEY, 1);
  } catch (e) {
    /* 存不进也不影响本次会话 */
  }
}

/** 弹出使用规范，仅一个「我已知晓」按钮 */
function showNotice() {
  return new Promise((resolve) => {
    wx.showModal({
      title: NOTICE_TITLE,
      content: NOTICE_CONTENT,
      showCancel: false,
      // 注意：confirmText 最多 4 个字符，超限会导致弹窗静默失败
      confirmText: '我已知晓',
      confirmColor: '#185FA5',
      success: () => {
        markAgreed();
        resolve(true);
      },
      // 弹窗本身调用失败（极罕见）时不阻塞用户，按已知晓处理
      fail: () => resolve(true)
    });
  });
}

/**
 * 确保用户已确认使用规范。未确认时弹窗，返回是否继续。
 * @returns {Promise<boolean>}
 */
function ensureAgreed() {
  if (readAgreed()) return Promise.resolve(true);
  if (_pending) return _pending;
  _pending = showNotice().then((ok) => {
    _pending = null;
    return ok;
  });
  return _pending;
}

/** 违规提示（供将来真正接入检测时调用，也供页面兜底） */
function showViolation() {
  return new Promise((resolve) => {
    wx.showModal({
      title: '内容安全提示',
      content: VIOLATION_TEXT,
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#185FA5',
      success: () => resolve(true),
      fail: () => resolve(true)
    });
  });
}

/**
 * 素材检测入口（统一收口）
 *
 * 返回 'pass' 表示可用；返回 'block' 表示含违规内容，调用方应停止处理。
 * 当前 SEC_CHECK_ENABLED=false，一律放行。
 *
 * 接入服务端后在此处改为：
 *   const res = await request({ url: '...', data: { fileID } });
 *   return res.suggest === 'pass' ? 'pass' : 'block';
 *
 * @param {string[]} paths 待检测的本地临时文件路径
 * @returns {Promise<'pass'|'block'>}
 */
async function check(paths) {
  if (!SEC_CHECK_ENABLED) return 'pass';
  // 占位：开启检测但未接服务端时，同样放行，避免误拦正常用户
  return 'pass';
}

/**
 * 处理前的完整校验：规范确认 + 素材检测。
 * @returns {Promise<boolean>} true 表示可以继续处理
 */
async function beforeProcess(paths) {
  const ok = await ensureAgreed();
  if (!ok) return false;

  const result = await check(paths);
  if (result === 'block') {
    await showViolation();
    return false;
  }
  return true;
}

module.exports = {
  SEC_CHECK_ENABLED,
  VIOLATION_TEXT,
  ensureAgreed,
  showViolation,
  check,
  beforeProcess
};
