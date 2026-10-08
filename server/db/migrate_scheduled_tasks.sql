-- ============================================================
-- 定时任务表（后台可配置：定时清理任务记录 / 产物文件 / 日志）
-- 执行：mysql -uroot -p wc_watermark < db/migrate_scheduled_tasks.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS wc_scheduled_tasks (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(64) NOT NULL DEFAULT '',
  -- 清理范围：expired(过期任务) | failed(失败任务) | logs(旧日志) | done_before(指定天数前的已完成任务)
  scope VARCHAR(24) NOT NULL DEFAULT 'expired',
  -- 频率：daily(每天) | hourly(每小时) | weekly(每周) | interval(自定义间隔)
  freq VARCHAR(16) NOT NULL DEFAULT 'daily',
  -- interval 频率下的间隔分钟数
  interval_minutes INT NOT NULL DEFAULT 1440,
  -- 执行时间点：daily/weekly 用 "HH:MM"，hourly/interval 忽略
  run_at VARCHAR(8) NOT NULL DEFAULT '03:00',
  -- weekly 用：0-6（0=周日）
  weekday TINYINT NOT NULL DEFAULT 0,
  -- done_before 用：保留天数，早于该天数的已完成任务会被清理
  keep_days INT NOT NULL DEFAULT 7,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  -- 运行状态
  last_run_at DATETIME NULL,
  last_result VARCHAR(255) NOT NULL DEFAULT '',
  last_affected INT NOT NULL DEFAULT 0,
  next_run_at DATETIME NULL,
  run_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_enabled (enabled),
  KEY idx_next (next_run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 默认内置一条「每日 03:00 清理过期任务与文件」，方便开箱即用
INSERT IGNORE INTO wc_scheduled_tasks
  (id, name, scope, freq, interval_minutes, run_at, weekday, keep_days, enabled)
VALUES
  ('st_default_expired', '每日清理过期任务与文件', 'expired', 'daily', 1440, '03:00', 0, 7, 1);
