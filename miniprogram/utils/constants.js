/**
 * 全局常量与配置
 *
 * 零后端架构（图片 + 视频全离线）：
 *   - 图片：Canvas 端内处理，不联网
 *   - 视频：VideoDecoder 解码 + WebGL 抹水印 + MediaRecorder 录制
 *           + MediaContainer 合并音轨（utils/local-video.js），不联网
 *   - 无服务器、无数据库、无域名、零费用
 *
 * 没有任何需要部署前修改的地址，其它常量都是业务配置。
 */

// ============================================================
// 视频处理双链路
//   真机：全离线（utils/local-video.js），不需要任何地址
//   开发者工具模拟器：MediaRecorder 是空壳，只能走电脑上的
//   video-service-lite 处理（双击 start-video-service.bat 启动）
// ============================================================

// 模拟器测试用的电脑服务地址；真机完全不使用它
const VIDEO_API_BASE_URL = 'http://127.0.0.1:3100';

// 与 video-service-lite/.env 的 CLIENT_TOKEN 保持一致；两边都留空则不校验
const VIDEO_CLIENT_TOKEN = '';

// 兼容旧引用：util.js 在把「相对路径」补全成完整地址时会用到
const API_BASE_URL = VIDEO_API_BASE_URL;
// ============================================================

// 视频限制（原先是后台可配项，零后台后固化为本地常量）
const VIDEO_LIMITS = {
  maxDuration: 60, // 秒
  maxSizeMB: 500
};

const JOB_TYPE = { IMAGE: 'image', VIDEO: 'video' };

const JOB_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  DONE: 'done',
  FAILED: 'failed'
};

const JOB_STATUS_LABEL = {
  pending: '排队中',
  processing: '处理中',
  done: '已完成',
  failed: '处理失败'
};

// 遮盖方式
const MODE = {
  FILL: 'fill',
  BLUR: 'blur',
  MOSAIC: 'mosaic',
  CROP: 'crop'
};

const MODE_LABEL = {
  fill: '智能填充',
  blur: '模糊',
  mosaic: '马赛克',
  crop: '裁剪去边'
};

const MODE_DESC = {
  fill: '按周围像素向内推算填充，适合纯色背景',
  blur: '选区做高斯模糊，保留画面结构',
  mosaic: '像素块打散，最省性能',
  crop: '直接裁掉含水的边缘，画质无损'
};

// 编辑工具
const TOOL = { BRUSH: 'brush', RECT: 'rect', CROP: 'crop' };

// ============================================================
// 广告位配置（共 3 个，把后台创建的 ID 粘贴到对应引号内即可生效）
//
//   获取位置：mp.weixin.qq.com → 流量主 → 广告位管理 → 新建广告位
//
//   1. REWARDED（激励视频）已配置
//      创建类型选「激励视频」→ 用于视频下载额度解锁（看完 +3 次下载）
//   2. BANNER_HOME（Banner 广告）待填
//      创建类型选「Banner 广告」→ 显示在首页底部
//   3. BANNER_IMAGE（Banner 广告）待填
//      创建类型选「Banner 广告」→ 显示在图片编辑页底部
//
//   填写格式：adunit-xxxxxxxxxx（在后台复制完整 ID）
//   留空则该位不渲染，不影响其它功能。
// ============================================================
const AD_UNITS = {
  REWARDED: 'adunit-263b6ae765f8393e', // 激励视频：视频下载额度解锁
  BANNER_HOME: 'adunit-cf46acd2d060f865', // ← 首页底部 Banner 广告位
  BANNER_IMAGE: 'adunit-68089657cc56cc21', // ← 图片页底部 Banner 广告位
  BANNER_RESULT: 'adunit-e7749e993b25c1a3', // ← 结果页底部 Banner（独立广告位）
  BANNER_MINE: 'adunit-b8a70c04e7e13303', // ← 个人中心底部 Banner（独立广告位）
  BANNER_VIDEO: 'adunit-a5a8fcd3fa6e35ab' // ← 视频去水印页底部 Banner（独立广告位）
};

// ============================================================
// 开发者工具环境标记（真机恒为 false）
//
// 为什么需要：
//   1. 广告组件（<ad>）在开发者工具里渲染异常，会刷屏
//      「removeTextView: fail no root view」，并可能拖垮页面，
//      导致页面所有点击都无响应 —— 所以开发环境不渲染 Banner
//   2. 激励视频在开发者工具里基本拉不到（1004 / 不回调）。
//      注意：工具内**不会**跳过额度闸门，行为与真机一致，
//      拉不到时会弹出「广告无法播放 + 错误码」的明确提示，不静默。
//      验证广告与下载链路请以真机为准。
// ============================================================
const IS_DEVTOOLS = (() => {
  try {
    return wx.getSystemInfoSync().platform === 'devtools';
  } catch (e) {
    return false;
  }
})();

if (IS_DEVTOOLS) {
  AD_UNITS.BANNER_HOME = '';
  AD_UNITS.BANNER_IMAGE = '';
  AD_UNITS.BANNER_RESULT = '';
  AD_UNITS.BANNER_MINE = '';
  AD_UNITS.BANNER_VIDEO = '';
}
const QUOTA_FREE = 0; // 新用户不送免费额度（视频下载一律先看广告）
const QUOTA_PER_AD = 3; // 每次完整看完激励视频解锁的下载次数

// 视频下载额度闸门总开关：
//   true  = 视频下载必须先看激励视频解锁额度（当前状态，线上必须是 true）
//   false = 关掉闸门，下载不再需要看广告也不扣额度（仅在紧急止损时临时使用）
// 关闭时 Banner 广告仍会展示，不受影响。
const QUOTA_ENABLED = true;

// 屏幕调试信息开关（result / records 页顶部的黑色步骤条）：
//   false = 不在屏幕上显示，排查日志仍会写入本机（关于 → 点击追踪可查）
//   true  = 在屏幕上显示「① 点击已收到」这类步骤，仅用于真机排障
// 提审/发布必须保持 false —— 否则用户会一直看到一条调试黑条。
const DEBUG_UI = false;

// 构建标记：每次发版前更新一次。关于页底部与启动日志会打印，
// 用来确认手机/电脑跑的是不是最新上传的代码（排查「改了没生效」最直接的办法）。
const BUILD_TAG = '2026-11-11 18:04';

module.exports = {
  API_BASE_URL,
  VIDEO_API_BASE_URL,
  VIDEO_CLIENT_TOKEN,
  VIDEO_LIMITS,
  JOB_TYPE,
  JOB_STATUS,
  JOB_STATUS_LABEL,
  MODE,
  MODE_LABEL,
  MODE_DESC,
  TOOL,
  AD_UNITS,
  IS_DEVTOOLS,
  DEBUG_UI,
  BUILD_TAG,
  QUOTA_ENABLED,
  QUOTA_FREE,
  QUOTA_PER_AD
};
