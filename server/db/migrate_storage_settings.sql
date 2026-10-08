-- ============================================================
-- 存储路径自定义：为 wc_settings 增加 4 个配置列
-- 执行：mysql -uroot -p wc_watermark < db/migrate_storage_settings.sql
--
-- 说明：MySQL 不支持 ADD COLUMN IF NOT EXISTS，
--       故先用 information_schema 判断列是否存在，再动态执行 ALTER。
--       可重复执行，已存在的列会跳过。
-- ============================================================

USE wc_watermark;

-- 1) 存储根目录（留空 = 沿用 .env 的 UPLOAD_DIR；支持绝对路径）
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wc_settings' AND COLUMN_NAME = 'storage_root') = 0,
  'ALTER TABLE wc_settings ADD COLUMN storage_root VARCHAR(200) NOT NULL DEFAULT '''' COMMENT ''存储根目录，空=沿用 .env 的 UPLOAD_DIR'' AFTER cloud_keep_hours',
  'DO 0'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) 上传源文件子目录名
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wc_settings' AND COLUMN_NAME = 'storage_src_dir') = 0,
  'ALTER TABLE wc_settings ADD COLUMN storage_src_dir VARCHAR(32) NOT NULL DEFAULT ''src'' COMMENT ''上传源文件子目录名'' AFTER storage_root',
  'DO 0'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3) 去水印产物子目录名
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wc_settings' AND COLUMN_NAME = 'storage_output_dir') = 0,
  'ALTER TABLE wc_settings ADD COLUMN storage_output_dir VARCHAR(32) NOT NULL DEFAULT ''output'' COMMENT ''去水印产物子目录名'' AFTER storage_src_dir',
  'DO 0'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4) 封面缩略图子目录名
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wc_settings' AND COLUMN_NAME = 'storage_thumb_dir') = 0,
  'ALTER TABLE wc_settings ADD COLUMN storage_thumb_dir VARCHAR(32) NOT NULL DEFAULT ''thumb'' COMMENT ''封面缩略图子目录名'' AFTER storage_output_dir',
  'DO 0'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT, COLUMN_COMMENT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wc_settings'
   AND COLUMN_NAME LIKE 'storage\_%';
