-- ============================================================
-- 迁移 2：修正 openid 唯一约束，支持多个「纯 Web 后台账号」
--
-- 背景：原 uk_openid 是普通唯一索引，多行 openid='' 会触发
--       Duplicate entry '' for key 'uk_openid'。
--       MySQL 的唯一索引允许多个 NULL，因此把列改为可空、
--       空值统一写 NULL，即可放开「一行一个后台账号」。
--
-- 执行：mysql -u root -p < db/migrate_admin_account2.sql
-- 幂等：可重复执行
-- ============================================================

USE wc_watermark;

-- 1) 先让列可空（顺序不能反：先删非空约束才能写 NULL）
ALTER TABLE wc_admins MODIFY COLUMN openid VARCHAR(64) NULL DEFAULT NULL;

-- 2) 现有空串改为 NULL（NULL 不参与唯一约束）
UPDATE wc_admins SET openid = NULL WHERE openid = '';
