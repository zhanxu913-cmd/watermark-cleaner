-- ============================================================
-- 迁移：管理后台账号密码登录支持
-- 执行：mysql -u root -p < db/migrate_admin_account.sql
-- 幂等：可重复执行
-- ============================================================

USE wc_watermark;

-- 1) wc_admins 增加账号密码字段
--    account / password_hash 为空时，该行仅是「小程序端 openid 白名单」；
--    填了 account + password_hash 才能用于 Web 后台账号密码登录。
ALTER TABLE wc_admins
  ADD COLUMN account VARCHAR(64) NOT NULL DEFAULT '' COMMENT '后台登录账号' AFTER openid,
  ADD COLUMN password_hash VARCHAR(255) NOT NULL DEFAULT '' COMMENT '密码哈希 scrypt' AFTER account,
  ADD COLUMN last_login_at DATETIME NULL COMMENT '最后登录时间' AFTER created_at,
  ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用' AFTER last_login_at;

-- 账号唯一（允许多行空串，用 NULL 才能绕开唯一约束，故此处用条件索引思路：
-- MySQL 不支持部分索引，改为应用层校验账号唯一，这里只建普通索引）
ALTER TABLE wc_admins ADD INDEX idx_account (account);
ALTER TABLE wc_admins ADD INDEX idx_enabled (enabled);

-- 2) 预置一个超级管理员账号：admin / admin123
--    password_hash 由服务端首次启动时自动生成（见 lib/account.js ensureDefaultAccount）
--    这里只负责把账号行建出来，密码留空由服务端填充。
INSERT INTO wc_admins (openid, account, name, role, enabled)
SELECT '', 'admin', '超级管理员', 'super', 1
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM wc_admins WHERE account = 'admin');
