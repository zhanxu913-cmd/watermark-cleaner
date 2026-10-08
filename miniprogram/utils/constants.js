/**
 * 全局常量与配置
 * 部署前必改：API_BASE_URL 换成你自己的后端地址（见 server/ 目录）
 */

// ============ 后端地址（改这里就够了）============
// 三种场景，改下面一行即可：
//
// ① 开发者工具模拟器调试（默认）
//    const API_BASE_URL = 'http://192.168.31.74:3000';
//
// ② 手机扫码真机测试 —— 换成电脑的局域网 IP（后端启动时会打印，形如 192.168.x.x）
//    const API_BASE_URL = 'http://192.168.31.74:3000';
//    手机必须和电脑连同一个 WiFi；电脑防火墙要放行 3000 端口
//
// ③ 正式上线 —— 必须 https + 已备案域名，并在公众平台配置 request/uploadFile 合法域名
//    const API_BASE_URL = 'https://api.your-domain.com';
//
const API_BASE_URL = 'http://192.168.31.74:3000';
// ================================================

// 集合名统一加 wc_ 前缀，避免与同环境其它项目冲突
const COLLECTIONS = {
  USERS: 'wc_users',
  JOBS: 'wc_jobs',
  ADMINS: 'wc_admins',
  LOGS: 'wc_logs',
  SETTINGS: 'wc_settings'
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

// 遮盖方式：全部在本地/云端以「蒙版 + 修补」实现
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

// 角色
const ROLE = { USER: 'user', OPERATOR: 'operator', SUPER: 'super' };
const ROLE_LABEL = { user: '普通用户', operator: '运营', super: '超级管理员' };

// 操作日志动作
const LOG_ACTION = {
  LOGIN_ADMIN: 'admin.login',
  USER_BAN: 'user.ban',
  USER_UNBAN: 'user.unban',
  USER_QUOTA: 'user.quota',
  USER_ROLE: 'user.role',
  USER_DELETE: 'user.delete',
  JOB_DELETE: 'job.delete',
  JOB_RETRY: 'job.retry',
  CONFIG_UPDATE: 'config.update',
  ADMIN_ADD: 'admin.add',
  ADMIN_REMOVE: 'admin.remove',
  DATA_CLEAN: 'data.clean'
};

const LOG_ACTION_LABEL = {
  'admin.login': '登录后台',
  'user.ban': '封禁用户',
  'user.unban': '解封用户',
  'user.quota': '调整配额',
  'user.role': '变更角色',
  'user.delete': '删除用户',
  'job.delete': '删除任务',
  'job.retry': '重试任务',
  'config.update': '更新配置',
  'admin.add': '新增管理员',
  'admin.remove': '移除管理员',
  'data.clean': '清理数据'
};

// 后台设置的默认值
const DEFAULT_SETTINGS = {
  freeImagePerDay: 10,
  freeVideoPerDay: 1,
  maxVideoDuration: 60,
  maxVideoSizeMB: 500,
  videoServiceEnabled: true,
  registerEnabled: true,
  globalNotice: '',
  maintenanceNotice: '',
  copyrightTip: '请仅处理你拥有版权的素材。去除他人作品水印可能构成侵权。',
  cloudKeepHours: 1,
  adminKey: ''
};

// 后端模块名（对应 server/routes/ 下的路由前缀）
const FN = {
  LOGIN: 'login',
  JOB: 'job',
  VIDEO: 'videoProc',
  ADMIN: 'admin'
};

// 本地缓存 key
const CACHE = {
  TOKEN: 'wc_token',
  ADMIN_KEY: 'wc_admin_key',
  USER_CACHE: 'wc_user_cache'
};

module.exports = {
  API_BASE_URL,
  JOB_TYPE,
  JOB_STATUS,
  JOB_STATUS_LABEL,
  MODE,
  MODE_LABEL,
  MODE_DESC,
  TOOL,
  ROLE,
  ROLE_LABEL,
  LOG_ACTION,
  LOG_ACTION_LABEL,
  DEFAULT_SETTINGS,
  FN,
  CACHE
};
