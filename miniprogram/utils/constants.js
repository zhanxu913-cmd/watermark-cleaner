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

// 兼容旧引用：util.js 在把「相对路径」补全成完整地址时会用到（现已无远程地址）
const API_BASE_URL = '';
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
