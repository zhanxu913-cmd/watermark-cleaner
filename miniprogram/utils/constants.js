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
// 广告解锁额度（激励视频）
//   规则：新用户送 QUOTA_FREE 条；每处理 1 张图 / 1 段视频消耗 1 条；
//         额度用完 → 观看激励视频 → 解锁 QUOTA_PER_AD 条。
//   上线前必做：mp.weixin.qq.com → 流量主 → 创建「激励视频」广告位
//   → 把广告位 ID 填入 AD_UNIT_ID。
//   未配置时：开发者工具模拟器直接解锁（方便测试）；真机会提示未配置。
// ============================================================
const AD_UNIT_ID = '';
const QUOTA_FREE = 3; // 新用户免费额度
const QUOTA_PER_AD = 3; // 每次完整看完广告解锁条数

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
  AD_UNIT_ID,
  QUOTA_FREE,
  QUOTA_PER_AD
};
