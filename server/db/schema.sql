-- ============================================================
-- 水印清理小程序 · MySQL 数据库初始化脚本
-- 用法：mysql -u root -p < db/schema.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS wc_watermark
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;
USE wc_watermark;

-- ---------------- 用户表 ----------------
CREATE TABLE IF NOT EXISTS wc_users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  openid VARCHAR(64) NOT NULL,
  nickname VARCHAR(64) NOT NULL DEFAULT '',
  avatar_url VARCHAR(512) NOT NULL DEFAULT '',
  banned TINYINT(1) NOT NULL DEFAULT 0,
  ban_reason VARCHAR(255) NOT NULL DEFAULT '',
  -- 0 表示跟随全局配额；>0 表示该用户独享配额
  limit_image INT NOT NULL DEFAULT 0,
  limit_video INT NOT NULL DEFAULT 0,
  used_image INT NOT NULL DEFAULT 0,
  used_video INT NOT NULL DEFAULT 0,
  used_image_date DATE NULL,
  used_video_date DATE NULL,
  total_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME NULL,
  UNIQUE KEY uk_openid (openid),
  KEY idx_created (created_at),
  KEY idx_banned (banned)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 任务（处理记录）表 ----------------
CREATE TABLE IF NOT EXISTS wc_jobs (
  id VARCHAR(32) PRIMARY KEY,
  openid VARCHAR(64) NOT NULL,
  type VARCHAR(10) NOT NULL DEFAULT 'image',        -- image | video
  mode VARCHAR(16) NOT NULL DEFAULT '',             -- fill | blur | mosaic | crop
  status VARCHAR(16) NOT NULL DEFAULT 'pending',    -- pending | processing | done | failed
  progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
  file_name VARCHAR(255) NOT NULL DEFAULT '',
  region TEXT NULL,                                 -- JSON：归一化遮盖区域
  time_range VARCHAR(64) NOT NULL DEFAULT '',       -- JSON：{start,end}
  duration DECIMAL(8,2) NOT NULL DEFAULT 0,
  strength INT NOT NULL DEFAULT 0,
  width INT NOT NULL DEFAULT 0,
  height INT NOT NULL DEFAULT 0,
  region_count INT NOT NULL DEFAULT 0,
  src_file VARCHAR(255) NOT NULL DEFAULT '',        -- 相对 uploads 的文件路径
  out_file VARCHAR(255) NOT NULL DEFAULT '',
  thumb_file VARCHAR(255) NOT NULL DEFAULT '',
  size BIGINT NOT NULL DEFAULT 0,
  out_size BIGINT NOT NULL DEFAULT 0,
  error VARCHAR(500) NOT NULL DEFAULT '',
  saved TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  expires_at DATETIME NULL,
  KEY idx_openid (openid),
  KEY idx_status (status),
  KEY idx_created (created_at),
  KEY idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 管理员（openid 白名单 + 角色）表 ----------------
CREATE TABLE IF NOT EXISTS wc_admins (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  openid VARCHAR(64) NULL DEFAULT NULL,                  -- NULL = 纯 Web 后台账号（多个 NULL 不冲突）
  account VARCHAR(64) NOT NULL DEFAULT '',               -- 后台登录账号
  password_hash VARCHAR(255) NOT NULL DEFAULT '',        -- scrypt$salt$hash
  name VARCHAR(64) NOT NULL DEFAULT '',
  role VARCHAR(16) NOT NULL DEFAULT 'operator',          -- operator | super
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_openid (openid),
  KEY idx_account (account),
  KEY idx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 操作日志表 ----------------
CREATE TABLE IF NOT EXISTS wc_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  openid VARCHAR(64) NOT NULL DEFAULT '',           -- 操作者
  operator VARCHAR(64) NOT NULL DEFAULT '',         -- 操作者备注名
  action VARCHAR(32) NOT NULL DEFAULT '',
  detail VARCHAR(500) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_action (action),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 全局配置表（单行） ----------------
CREATE TABLE IF NOT EXISTS wc_settings (
  id TINYINT UNSIGNED PRIMARY KEY DEFAULT 1,
  free_image_per_day INT NOT NULL DEFAULT 10,
  free_video_per_day INT NOT NULL DEFAULT 1,
  max_video_duration INT NOT NULL DEFAULT 60,
  max_video_size_mb INT NOT NULL DEFAULT 100,
  video_enabled TINYINT(1) NOT NULL DEFAULT 0,
  register_enabled TINYINT(1) NOT NULL DEFAULT 1,
  global_notice VARCHAR(500) NOT NULL DEFAULT '',
  maintenance_notice VARCHAR(500) NOT NULL DEFAULT '',
  copyright_tip VARCHAR(200) NOT NULL DEFAULT '请仅处理你拥有版权的素材。去除他人作品水印可能构成侵权。',
  cloud_keep_hours INT NOT NULL DEFAULT 1,
  -- 存储路径（后台可自定义，见 lib/storage.js）
  storage_root VARCHAR(200) NOT NULL DEFAULT '',              -- 空 = 沿用 .env 的 UPLOAD_DIR
  storage_src_dir VARCHAR(32) NOT NULL DEFAULT 'src',
  storage_output_dir VARCHAR(32) NOT NULL DEFAULT 'output',
  storage_thumb_dir VARCHAR(32) NOT NULL DEFAULT 'thumb',
  admin_key VARCHAR(64) NOT NULL DEFAULT '',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_single_row CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 首次初始化：写入单行默认配置（admin_key 由后端首次启动时自动填充）
INSERT IGNORE INTO wc_settings (id) VALUES (1);
