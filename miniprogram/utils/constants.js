/**
 * 全局常量与配置
 *
 * 零后台架构：
 *   - 图片处理全部在小程序本地完成，不依赖任何服务
 *   - 只有「视频去水印」需要一台能跑 FFmpeg 的机器
 *
 * 部署前唯一要改的是 VIDEO_API_BASE_URL（见下方说明），
 * 其它常量都是业务配置，一般不用动。
 */

// ============================================================
// 视频服务地址（图片功能不需要配置，留空也能正常用）
// ============================================================
//
// ① 本地调试：先起 video-service-lite，再填电脑的局域网 IP
//      const VIDEO_API_BASE_URL = 'http://192.168.31.74:3100';
//    手机必须和电脑同一 WiFi，开发者工具需勾选「不校验合法域名」
//
// ② 云托管 / 服务器：填平台给的 https 地址
//      const VIDEO_API_BASE_URL = 'https://xxxx.sh.run.tcloudbase.com';
//
const VIDEO_API_BASE_URL = '';

// 与服务端 .env 的 CLIENT_TOKEN 保持一致；两边都留空则不校验（仅建议本地调试时留空）
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

module.exports = {
  VIDEO_API_BASE_URL,
  VIDEO_CLIENT_TOKEN,
  API_BASE_URL,
  VIDEO_LIMITS,
  JOB_TYPE,
  JOB_STATUS,
  JOB_STATUS_LABEL,
  MODE,
  MODE_LABEL,
  MODE_DESC,
  TOOL
};
