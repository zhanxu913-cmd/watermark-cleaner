/**
 * 管理后台接口：/api/admin/*
 *
 * 鉴权（lib/auth.resolveAdmin，三选一）：
 *   1. 密钥令牌（Web 后台 /admin/login 换取）       → super
 *   2. 用户令牌 + openid 在 wc_admins 白名单        → 按记录角色
 *   3. 请求体 __key 等于 adminKey（小程序旧流程）    → super
 *
 * 权限矩阵：operator 只读（overview/users/userDetail/jobs/settings/logs/admins/check）
 *          super 可写（userUpdate/jobUpdate/settingsUpdate/adminAdd/adminRemove/cleanData）
 */

'use strict';

const express = require('express');
const db = require('../db');
const files = require('../lib/files');
const storage = require('../lib/storage');
const { ok, wrap } = require('../lib/resp');
const { BizError } = require('../lib/biz');
const auth = require('../lib/auth');
const account = require('../lib/account');
const settingsLib = require('../lib/settings');
const quota = require('../lib/quota');
const logger = require('../lib/log');
const scheduler = require('../services/scheduler');
const { shapeUser, shapeJob, shapeLog, shapeAdmin } = require('../lib/shape');

function register(app, ctx) {
  const r = express.Router();

  // ---------- 登录：账号密码（推荐） ----------
  r.post('/accountLogin', wrap(async (req, res) => {
    const b = req.body || {};
    const acc = await account.login(b.account, b.password);
    const token = auth.signAccount(acc);
    logger.writeLog(
      { openid: acc.openid || '', name: acc.name || acc.account },
      'admin.login',
      '账号登录：' + acc.account
    );
    ok(res, { token, role: acc.role, account: acc.account, name: acc.name || acc.account });
  }));

  // ---------- 登录：密钥（保留兜底，用于首次进入/找回） ----------
  r.post('/login', wrap(async (req, res) => {
    const key = String((req.body && req.body.key) || '').trim();
    if (!key) throw new BizError(401, '请输入后台访问密钥');

    const s = await settingsLib.getSettings();
    if (!s.adminKey) throw new BizError(500, '后台密钥未初始化，请重启服务端生成');
    if (key !== s.adminKey) throw new BizError(403, '密钥不正确');

    const token = auth.signAdmin();
    logger.writeLog({ openid: '', name: '密钥登录' }, 'admin.login', '通过密钥登录后台');

    ok(res, { token, role: 'super', account: '', name: '密钥登录' });
  }));

  // ---------- 当前登录者信息 ----------
  r.post('/me', auth.requireAdmin(false), wrap(async (req, res) => {
    ok(res, {
      role: req.admin.role,
      name: req.admin.name,
      account: req.admin.account || '',
      via: req.admin.via,
      canWrite: req.admin.role === 'super'
    });
  }));

  // ---------- 修改自己的密码 ----------
  r.post('/changePassword', auth.requireAdmin(false), wrap(async (req, res) => {
    if (!req.admin.aid) throw new BizError(400, '密钥登录无法改密，请使用账号登录');
    const b = req.body || {};
    await account.changeOwnPassword(req.admin.aid, b.oldPassword, b.newPassword);
    logger.writeLog(req.admin, 'admin.pwd', '修改自己的密码');
    ok(res, { done: true });
  }));

  // ---------- 后台账号列表 ----------
  r.post('/accounts', auth.requireAdmin(false), wrap(async (req, res) => {
    const rows = await account.listAccounts();
    ok(res, {
      list: rows.map((a) => ({
        id: a.id,
        account: a.account,
        name: a.name,
        role: a.role,
        enabled: !!a.enabled,
        openid: a.openid,
        lastLoginAt: a.last_login_at,
        createdAt: a.created_at
      }))
    });
  }));

  // ---------- 新建后台账号 ----------
  r.post('/accountAdd', auth.requireAdmin(true), wrap(async (req, res) => {
    const b = req.body || {};
    const id = await account.createAccount({
      account: b.account,
      password: b.password,
      name: b.name,
      role: b.role,
      openid: b.openid
    });
    logger.writeLog(req.admin, 'admin.add', '新建后台账号：' + String(b.account || '').slice(0, 32));
    ok(res, { id });
  }));

  // ---------- 更新后台账号（改名/改密/角色/启用） ----------
  r.post('/accountUpdate', auth.requireAdmin(true), wrap(async (req, res) => {
    const b = req.body || {};
    await account.updateAccount(b.id, {
      account: b.account,
      password: b.password,
      name: b.name,
      role: b.role,
      enabled: b.enabled
    });
    logger.writeLog(req.admin, 'admin.update', '更新后台账号 #' + (Number(b.id) || 0));
    ok(res, { done: true });
  }));

  // ---------- 删除后台账号 ----------
  r.post('/accountRemove', auth.requireAdmin(true), wrap(async (req, res) => {
    const b = req.body || {};
    await account.removeAccount(b.id);
    logger.writeLog(req.admin, 'admin.del', '删除后台账号 #' + (Number(b.id) || 0));
    ok(res, { done: true });
  }));

  // ---------- 身份检查（用户令牌白名单，或请求体密钥兜底） ----------
  r.post('/check', wrap(async (req, res) => {
    const admin = await auth.resolveAdmin(req);
    if (!admin) return ok(res, { isAdmin: false, role: '', openid: '' });

    const t = auth.parseToken(req) || {};
    let openid = t.openid || '';
    if (!openid && t.uid) {
      const u = await db.get('SELECT openid FROM wc_users WHERE id = ?', [t.uid]);
      openid = u ? u.openid : '';
    }
    ok(res, { isAdmin: true, role: admin.role, name: admin.name, openid });
  }));

  // ---------- 概览 ----------
  r.post('/overview', auth.requireAdmin(false), wrap(async (req, res) => {
    const [usersTotal, usersToday, usersBanned, jobsTotal, jobsToday, jobsPending, jobsFailed, storageRow, recentLogs] =
      await Promise.all([
        db.get('SELECT COUNT(*) AS n FROM wc_users'),
        db.get('SELECT COUNT(*) AS n FROM wc_users WHERE created_at >= CURDATE()'),
        db.get('SELECT COUNT(*) AS n FROM wc_users WHERE banned = 1'),
        db.get('SELECT COUNT(*) AS n FROM wc_jobs'),
        db.get('SELECT COUNT(*) AS n FROM wc_jobs WHERE created_at >= CURDATE()'),
        db.get('SELECT COUNT(*) AS n FROM wc_jobs WHERE status IN ("pending", "processing")'),
        db.get('SELECT COUNT(*) AS n FROM wc_jobs WHERE status = "failed"'),
        db.get('SELECT COALESCE(SUM(out_size), 0) AS n FROM wc_jobs'),
        db.query('SELECT * FROM wc_logs ORDER BY id DESC LIMIT 8')
      ]);

    ok(res, {
      users: { total: usersTotal.n, today: usersToday.n, banned: usersBanned.n },
      jobs: {
        total: jobsTotal.n,
        today: jobsToday.n,
        processing: jobsPending.n,
        failed: jobsFailed.n
      },
      storageBytes: Number(storageRow.n) || 0,
      recentLogs: recentLogs.map(shapeLog)
    });
  }));

  // ---------- 用户列表 ----------
  r.post('/users', auth.requireAdmin(false), wrap(async (req, res) => {
    const b = req.body || {};
    const page = Math.max(1, Math.floor(Number(b.page) || 1));
    const pageSize = Math.min(50, Math.max(5, Math.floor(Number(b.pageSize) || 15)));

    const where = ['1 = 1'];
    const params = [];

    if (b.keyword) {
      where.push('(openid LIKE ? OR nickname LIKE ?)');
      const kw = '%' + String(b.keyword).slice(0, 50) + '%';
      params.push(kw, kw);
    }
    if (b.filter === 'banned') where.push('banned = 1');
    if (b.filter === 'admin') where.push('openid IN (SELECT openid FROM wc_admins)');
    if (b.filter === 'today') where.push('created_at >= CURDATE()');

    const whereSql = 'WHERE ' + where.join(' AND ');
    const totalRow = await db.get('SELECT COUNT(*) AS n FROM wc_users ' + whereSql, params);
    const rows = await db.query(
      'SELECT * FROM wc_users ' + whereSql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
      params.concat([pageSize, (page - 1) * pageSize])
    );

    const s = await settingsLib.getPublicSettings();
    ok(res, {
      list: rows.map((u) => shapeUser(u, quota.shapeQuota(u, s))),
      total: totalRow.n,
      page,
      pageSize,
      hasMore: page * pageSize < totalRow.n
    });
  }));

  // ---------- 用户详情 ----------
  r.post('/userDetail', auth.requireAdmin(false), wrap(async (req, res) => {
    const id = Number(req.body.id) || 0;
    const user = await db.get('SELECT * FROM wc_users WHERE id = ?', [id]);
    if (!user) throw new BizError(404, '用户不存在');

    const admin = await db.get('SELECT * FROM wc_admins WHERE openid = ?', [user.openid]);
    const jobs = await db.query(
      'SELECT * FROM wc_jobs WHERE openid = ? ORDER BY created_at DESC LIMIT 20',
      [user.openid]
    );
    const s = await settingsLib.getPublicSettings();

    ok(res, {
      user: shapeUser(user, quota.shapeQuota(user, s)),
      admin: admin ? shapeAdmin(admin) : null,
      jobs: jobs.map(shapeJob)
    });
  }));

  // ---------- 用户更新：封禁 / 角色 / 配额 / 删除 ----------
  r.post('/userUpdate', auth.requireAdmin(true), wrap(async (req, res) => {
    const b = req.body || {};
    const id = Number(b.id) || 0;
    const user = await db.get('SELECT * FROM wc_users WHERE id = ?', [id]);
    if (!user) throw new BizError(404, '用户不存在');

    const op = { openid: req.admin.name || '', name: req.admin.name || '管理员' };
    let acted = false;

    // 封禁 / 解封
    if (b.banned !== undefined) {
      const banned = !!b.banned;
      await db.exec('UPDATE wc_users SET banned = ?, ban_reason = ? WHERE id = ?', [
        banned ? 1 : 0,
        banned ? String(b.banReason || '违反使用规范').slice(0, 200) : '',
        id
      ]);
      logger.writeLog(op, banned ? 'user.ban' : 'user.unban',
        (user.nickname || user.openid.slice(-8)) + (banned ? '：' + String(b.banReason || '违反使用规范') : '：解除限制'));
      acted = true;
    }

    // 变更角色（写入/更新白名单；role 为空 = 移出白名单）
    if (b.role !== undefined) {
      const role = b.role === 'super' || b.role === 'operator' ? b.role : '';
      if (role) {
        const exists = await db.get('SELECT id FROM wc_admins WHERE openid = ?', [user.openid]);
        if (exists) {
          await db.exec('UPDATE wc_admins SET role = ?, name = COALESCE(NULLIF(?, ""), name) WHERE openid = ?', [
            role, String(b.name || ''), user.openid
          ]);
        } else {
          await db.exec('INSERT INTO wc_admins (openid, name, role) VALUES (?, ?, ?)', [
            user.openid, String(b.name || ''), role
          ]);
        }
        logger.writeLog(op, 'user.role', (user.nickname || user.openid.slice(-8)) + ' → ' + role);
      } else {
        await db.exec('DELETE FROM wc_admins WHERE openid = ?', [user.openid]);
        logger.writeLog(op, 'user.role', (user.nickname || user.openid.slice(-8)) + ' → 移出管理白名单');
      }
      acted = true;
    }

    // 独享配额
    if (b.limitImage !== undefined || b.limitVideo !== undefined) {
      const li = b.limitImage !== undefined ? b.limitImage : user.limit_image;
      const lv = b.limitVideo !== undefined ? b.limitVideo : user.limit_video;
      await quota.setLimits(id, li, lv);
      logger.writeLog(op, 'user.quota',
        (user.nickname || user.openid.slice(-8)) + '：图 ' + li + ' / 视频 ' + lv + '（0=跟随全局）');
      acted = true;
    }

    // 删除用户（连同其任务与文件）
    if (b.remove) {
      const jobs = await db.query('SELECT * FROM wc_jobs WHERE openid = ?', [user.openid]);
      const fileList = [];
      jobs.forEach((j) => [j.src_file, j.out_file, j.thumb_file].filter(Boolean)
        .forEach((f) => fileList.push(f)));
      files.remove(fileList);
      await db.exec('DELETE FROM wc_jobs WHERE openid = ?', [user.openid]);
      await db.exec('DELETE FROM wc_admins WHERE openid = ?', [user.openid]);
      await db.exec('DELETE FROM wc_users WHERE id = ?', [id]);
      logger.writeLog(op, 'user.delete', (user.nickname || user.openid.slice(-8)) + '：账号及其 ' + jobs.length + ' 条任务');
      acted = true;
    }

    if (!acted) throw new BizError(500, '没有需要执行的操作');

    const fresh = await db.get('SELECT * FROM wc_users WHERE id = ?', [id]);
    if (!fresh) return ok(res, { removed: true });
    const s = await settingsLib.getPublicSettings();
    ok(res, { user: shapeUser(fresh, quota.shapeQuota(fresh, s)) });
  }));

  // ---------- 任务列表 ----------
  r.post('/jobs', auth.requireAdmin(false), wrap(async (req, res) => {
    const b = req.body || {};
    const page = Math.max(1, Math.floor(Number(b.page) || 1));
    const pageSize = Math.min(50, Math.max(5, Math.floor(Number(b.pageSize) || 15)));

    const where = ['1 = 1'];
    const params = [];

    if (b.keyword) {
      where.push('(id LIKE ? OR file_name LIKE ? OR openid LIKE ?)');
      const kw = '%' + String(b.keyword).slice(0, 50) + '%';
      params.push(kw, kw, kw);
    }
    if (b.type === 'image' || b.type === 'video') {
      where.push('type = ?');
      params.push(b.type);
    }
    if (b.status && ['pending', 'processing', 'done', 'failed'].indexOf(b.status) > -1) {
      where.push('status = ?');
      params.push(b.status);
    }

    const whereSql = 'WHERE ' + where.join(' AND ');
    const totalRow = await db.get('SELECT COUNT(*) AS n FROM wc_jobs ' + whereSql, params);
    const rows = await db.query(
      'SELECT * FROM wc_jobs ' + whereSql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
      params.concat([pageSize, (page - 1) * pageSize])
    );

    ok(res, {
      list: rows.map(shapeJob),
      total: totalRow.n,
      page,
      pageSize,
      hasMore: page * pageSize < totalRow.n
    });
  }));

  // ---------- 任务操作：重试 / 删除 ----------
  r.post('/jobUpdate', auth.requireAdmin(true), wrap(async (req, res) => {
    const b = req.body || {};
    const id = String(b.id || '');
    const row = await db.get('SELECT * FROM wc_jobs WHERE id = ?', [id]);
    if (!row) throw new BizError(404, '任务不存在');

    const op = { openid: '', name: req.admin.name || '管理员' };

    if (b.action === 'retry') {
      if (row.type !== 'video') throw new BizError(500, '只有视频任务支持重试');
      if (!row.src_file) throw new BizError(500, '源文件已被清理，无法重试');
      await db.exec(
        'UPDATE wc_jobs SET status = "pending", progress = 0, error = "", out_file = "", finished_at = NULL WHERE id = ?',
        [id]
      );
      if (ctx && ctx.videoQueue) ctx.videoQueue.push(id);
      logger.writeLog(op, 'job.retry', row.id + '（' + row.file_name + '）');
      return ok(res, { status: 'pending' });
    }

    if (b.action === 'remove') {
      files.remove([row.src_file, row.out_file, row.thumb_file].filter(Boolean));
      await db.exec('DELETE FROM wc_jobs WHERE id = ?', [id]);
      logger.writeLog(op, 'job.delete', row.id + '（' + row.file_name + '）');
      return ok(res, { removed: true });
    }

    throw new BizError(500, '未知操作');
  }));

  // ---------- 配置读取 ----------
  r.post('/settings', auth.requireAdmin(false), wrap(async (req, res) => {
    const s = await settingsLib.getSettings();
    // operator 不下发密钥
    if (req.admin.role !== 'super') {
      return ok(res, Object.assign({}, s, { adminKey: '' }));
    }
    ok(res, s);
  }));

  // ---------- 配置更新 ----------
  r.post('/settingsUpdate', auth.requireAdmin(true), wrap(async (req, res) => {
    const patch = Object.assign({}, req.body);
    delete patch.__key;
    const s = await settingsLib.updateSettings(patch);
    logger.writeLog({ openid: '', name: req.admin.name || '管理员' }, 'config.update', '更新全局配置');
    ok(res, { settings: s });
  }));

  // ---------- 存储路径：读取 ----------
  // 返回后台配置值 + 实际生效的绝对路径 + 目录占用 / 文件数
  r.post('/storage', auth.requireAdmin(false), wrap(async (req, res) => {
    ok(res, { storage: storage.describe() });
  }));

  // ---------- 存储路径：预览（校验目标目录 + 迁移影响面，不写库）----------
  r.post('/storageCheck', auth.requireAdmin(true), wrap(async (req, res) => {
    const b = req.body || {};
    const p = storage.preview({
      root: b.root,
      srcDir: b.srcDir,
      outDir: b.outDir,
      thumbDir: b.thumbDir
    });
    ok(res, p);
  }));

  // ---------- 存储路径：保存并立即生效 ----------
  r.post('/storageSave', auth.requireAdmin(true), wrap(async (req, res) => {
    const b = req.body || {};
    const r = await storage.save(
      { root: b.root, srcDir: b.srcDir, outDir: b.outDir, thumbDir: b.thumbDir },
      { migrate: !!b.migrate, removeSource: !!b.removeSource }
    );

    const rep = r.report || {};
    let detail = r.previous.root + ' → ' + r.config.root;
    if (rep.migrated) {
      detail += '｜迁移 ' + (rep.copied || 0) + ' 个文件';
      if (rep.renamed && rep.renamed.length) detail += '，子目录改名 ' + rep.renamed.join('、');
      if (rep.rows) detail += '，更新记录 ' + rep.rows + ' 条';
      if (rep.removedSource) detail += '，已删除原目录';
      if (rep.removeSkipped) detail += '，' + rep.removeSkipped;
    } else if (rep.rootChanged || rep.dirsChanged) {
      detail += '｜未迁移已有文件';
    }
    logger.writeLog({ openid: '', name: req.admin.name || '管理员' }, 'storage.update', detail);

    ok(res, { storage: r.config, report: rep, previous: r.previous });
  }));

  // ---------- 存储路径：目录浏览（仅限项目文件夹内）----------
  // 供后台「选择目录」使用；空白路径 = 项目根目录
  r.post('/dirList', auth.requireAdmin(false), wrap(async (req, res) => {
    const b = req.body || {};
    ok(res, { list: storage.listDirs(b.path) });
  }));

  // ---------- 存储路径：在项目内新建文件夹 ----------
  r.post('/dirCreate', auth.requireAdmin(true), wrap(async (req, res) => {
    const b = req.body || {};
    const entry = storage.createDir(b.parent, b.name);
    logger.writeLog({ openid: '', name: req.admin.name || '管理员' }, 'storage.mkdir', '新建存储目录 ' + entry.path);
    ok(res, { entry });
  }));

  // ---------- 日志 ----------
  r.post('/logs', auth.requireAdmin(false), wrap(async (req, res) => {
    const b = req.body || {};
    const page = Math.max(1, Math.floor(Number(b.page) || 1));
    const pageSize = Math.min(100, Math.max(5, Math.floor(Number(b.pageSize) || 20)));

    const where = ['1 = 1'];
    const params = [];
    if (b.action) {
      where.push('action LIKE ?');
      params.push(String(b.action).replace(/\*$/, '%') + '%');
    }

    const whereSql = 'WHERE ' + where.join(' AND ');
    const totalRow = await db.get('SELECT COUNT(*) AS n FROM wc_logs ' + whereSql, params);
    const rows = await db.query(
      'SELECT * FROM wc_logs ' + whereSql + ' ORDER BY id DESC LIMIT ? OFFSET ?',
      params.concat([pageSize, (page - 1) * pageSize])
    );

    ok(res, {
      list: rows.map(shapeLog),
      total: totalRow.n,
      page,
      pageSize,
      hasMore: page * pageSize < totalRow.n
    });
  }));

  // ---------- 管理员白名单 ----------
  r.post('/admins', auth.requireAdmin(false), wrap(async (req, res) => {
    const rows = await db.query('SELECT * FROM wc_admins ORDER BY created_at DESC');
    ok(res, { list: rows.map(shapeAdmin), pending: [] });
  }));

  r.post('/adminAdd', auth.requireAdmin(true), wrap(async (req, res) => {
    const b = req.body || {};
    const openid = String(b.openid || '').trim();
    const name = String(b.name || '').trim().slice(0, 60);
    const role = b.role === 'super' ? 'super' : 'operator';

    if (openid.length < 10) throw new BizError(500, '请填写完整的 openid');
    const exists = await db.get('SELECT id FROM wc_admins WHERE openid = ?', [openid]);
    if (exists) throw new BizError(500, '该 openid 已在管理员名单中');

    await db.exec('INSERT INTO wc_admins (openid, name, role) VALUES (?, ?, ?)', [openid, name, role]);
    logger.writeLog({ openid: '', name: req.admin.name || '管理员' }, 'admin.add', name + '（' + role + '）');
    ok(res, { done: true });
  }));

  r.post('/adminRemove', auth.requireAdmin(true), wrap(async (req, res) => {
    const openid = String((req.body && req.body.openid) || '').trim();
    if (!openid) throw new BizError(500, '缺少 openid');
    await db.exec('DELETE FROM wc_admins WHERE openid = ?', [openid]);
    logger.writeLog({ openid: '', name: req.admin.name || '管理员' }, 'admin.remove', openid.slice(-8));
    ok(res, { done: true });
  }));

  // ---------- 手动清理 ----------
  // 与定时任务共用 scheduler.runScope()，保证「手动清理」与「自动清理」行为完全一致。
  // 支持 4 种范围：expired / failed / done_before / logs（后者两种需传 keepDays）。
  r.post('/cleanData', auth.requireAdmin(true), wrap(async (req, res) => {
    const b = req.body || {};
    const scope = scheduler.SCOPES.indexOf(b.scope) > -1 ? b.scope : 'expired';
    // 日志默认保留 90 天，其余默认 7 天；避免漏传 keepDays 时误删过多数据
    const fallback = scope === 'logs' ? 90 : 7;
    const keepDays = Math.max(1, Math.floor(Number(b.keepDays) || fallback));

    const r1 = await scheduler.runScope(scope, { keepDays });

    // 审计日志带上被删记录 ID（截断），便于误删后追溯
    const idBrief = r1.ids.slice(0, 10).join(',') +
      (r1.ids.length > 10 ? ' 等 ' + r1.ids.length + ' 条' : '');
    logger.writeLog({ openid: '', name: req.admin.name || '管理员' }, 'data.clean',
      (scheduler.SCOPE_LABEL[scope] || scope) + '：' + r1.affected + ' 条' +
      (idBrief ? '｜' + idBrief : ''));

    ok(res, {
      scope,
      keepDays,
      affected: r1.affected,
      detail: r1.detail,
      ids: r1.ids.slice(0, 50)
    });
  }));

  // ---------- 手动清理 · 预览（只统计，不删除）----------
  r.post('/cleanPreview', auth.requireAdmin(false), wrap(async (req, res) => {
    const b = req.body || {};
    const scope = scheduler.SCOPES.indexOf(b.scope) > -1 ? b.scope : 'expired';
    const fallback = scope === 'logs' ? 90 : 7;
    const keepDays = Math.max(1, Math.floor(Number(b.keepDays) || fallback));

    let n = 0;
    if (scope === 'expired') {
      const r1 = await db.get(
        'SELECT COUNT(*) AS n FROM wc_jobs WHERE status = "done" AND expires_at IS NOT NULL AND expires_at < NOW()'
      );
      n = r1.n;
    } else if (scope === 'failed') {
      const r1 = await db.get('SELECT COUNT(*) AS n FROM wc_jobs WHERE status = "failed"');
      n = r1.n;
    } else if (scope === 'logs') {
      const r1 = await db.get(
        'SELECT COUNT(*) AS n FROM wc_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
        [keepDays]
      );
      n = r1.n;
    } else if (scope === 'done_before') {
      const r1 = await db.get(
        'SELECT COUNT(*) AS n FROM wc_jobs WHERE status = "done" AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
        [keepDays]
      );
      n = r1.n;
    }

    ok(res, { scope, keepDays, count: n });
  }));

  /* ============================================================
     定时任务：任务记录 / 产物文件的自动清理
     ============================================================ */

  // ---------- 列表 ----------
  r.post('/tasks', auth.requireAdmin(false), wrap(async (req, res) => {
    const rows = await db.query(
      'SELECT * FROM wc_scheduled_tasks ORDER BY enabled DESC, created_at DESC'
    );
    ok(res, {
      list: rows.map(scheduler.shapeTask),
      scopes: scheduler.SCOPES.map((s) => ({ value: s, label: scheduler.SCOPE_LABEL[s] })),
      freqs: scheduler.FREQS.map((f) => ({ value: f, label: scheduler.FREQ_LABEL[f] }))
    });
  }));

  // ---------- 新增 ----------
  r.post('/taskAdd', auth.requireAdmin(true), wrap(async (req, res) => {
    const b = req.body || {};
    const id = 'st_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const scope = scheduler.SCOPES.indexOf(b.scope) > -1 ? b.scope : 'expired';
    const freq = scheduler.FREQS.indexOf(b.freq) > -1 ? b.freq : 'daily';
    const name = String(b.name || '').trim().slice(0, 64) || scheduler.SCOPE_LABEL[scope] + '自动清理';

    const row = {
      id,
      name,
      scope,
      freq,
      interval_minutes: Math.max(1, Math.floor(Number(b.intervalMinutes) || 1440)),
      run_at: /^\d{1,2}:\d{1,2}$/.test(String(b.runAt || '')) ? String(b.runAt) : '03:00',
      weekday: Math.min(6, Math.max(0, Math.floor(Number(b.weekday) || 0))),
      keep_days: Math.max(1, Math.floor(Number(b.keepDays) || 7)),
      enabled: b.enabled === false || b.enabled === 0 ? 0 : 1
    };
    const next = scheduler.computeNextRun(row, new Date());

    await db.exec(
      'INSERT INTO wc_scheduled_tasks (id, name, scope, freq, interval_minutes, run_at, weekday, keep_days, enabled, next_run_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.id, row.name, row.scope, row.freq, row.interval_minutes, row.run_at,
        row.weekday, row.keep_days, row.enabled, scheduler.toSqlTime(next)]
    );

    logger.writeLog({ openid: '', name: req.admin.name || '管理员' }, 'task.add', row.name + '（' + scope + '/' + freq + '）');
    ok(res, { id });
  }));

  // ---------- 修改 ----------
  r.post('/taskUpdate', auth.requireAdmin(true), wrap(async (req, res) => {
    const b = req.body || {};
    const id = String(b.id || '');
    const row = await db.get('SELECT * FROM wc_scheduled_tasks WHERE id = ?', [id]);
    if (!row) throw new BizError(404, '定时任务不存在');

    const sets = [];
    const params = [];

    if (b.name !== undefined) {
      sets.push('name = ?');
      params.push(String(b.name).trim().slice(0, 64));
    }
    if (b.scope !== undefined && scheduler.SCOPES.indexOf(b.scope) > -1) {
      sets.push('scope = ?');
      params.push(b.scope);
    }
    if (b.freq !== undefined && scheduler.FREQS.indexOf(b.freq) > -1) {
      sets.push('freq = ?');
      params.push(b.freq);
    }
    if (b.intervalMinutes !== undefined) {
      sets.push('interval_minutes = ?');
      params.push(Math.max(1, Math.floor(Number(b.intervalMinutes) || 1440)));
    }
    if (b.runAt !== undefined && /^\d{1,2}:\d{1,2}$/.test(String(b.runAt))) {
      sets.push('run_at = ?');
      params.push(String(b.runAt));
    }
    if (b.weekday !== undefined) {
      sets.push('weekday = ?');
      params.push(Math.min(6, Math.max(0, Math.floor(Number(b.weekday) || 0))));
    }
    if (b.keepDays !== undefined) {
      sets.push('keep_days = ?');
      params.push(Math.max(1, Math.floor(Number(b.keepDays) || 7)));
    }
    if (b.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(b.enabled === true || b.enabled === 1 || b.enabled === '1' ? 1 : 0);
    }

    // 重新计算下次执行时间（任何影响调度的改动都重算）
    const merged = Object.assign({}, row, {
      name: b.name !== undefined ? b.name : row.name,
      scope: b.scope !== undefined ? b.scope : row.scope,
      freq: b.freq !== undefined ? b.freq : row.freq,
      interval_minutes: b.intervalMinutes !== undefined ? b.intervalMinutes : row.interval_minutes,
      run_at: b.runAt !== undefined ? b.runAt : row.run_at,
      weekday: b.weekday !== undefined ? b.weekday : row.weekday
    });
    const enabledNow = b.enabled !== undefined
      ? (b.enabled === true || b.enabled === 1 || b.enabled === '1')
      : !!row.enabled;
    sets.push('next_run_at = ?');
    params.push(enabledNow ? scheduler.toSqlTime(scheduler.computeNextRun(merged, new Date())) : null);

    if (sets.length) {
      params.push(id);
      await db.exec('UPDATE wc_scheduled_tasks SET ' + sets.join(', ') + ' WHERE id = ?', params);
    }

    logger.writeLog({ openid: '', name: req.admin.name || '管理员' }, 'task.update', row.name + '（' + id + '）');
    ok(res, { done: true });
  }));

  // ---------- 删除 ----------
  r.post('/taskRemove', auth.requireAdmin(true), wrap(async (req, res) => {
    const id = String((req.body && req.body.id) || '');
    const row = await db.get('SELECT * FROM wc_scheduled_tasks WHERE id = ?', [id]);
    if (!row) throw new BizError(404, '定时任务不存在');
    await db.exec('DELETE FROM wc_scheduled_tasks WHERE id = ?', [id]);
    logger.writeLog({ openid: '', name: req.admin.name || '管理员' }, 'task.delete', row.name + '（' + id + '）');
    ok(res, { removed: true });
  }));

  // ---------- 立即执行一次 ----------
  r.post('/taskRun', auth.requireAdmin(true), wrap(async (req, res) => {
    const id = String((req.body && req.body.id) || '');
    const row = await db.get('SELECT * FROM wc_scheduled_tasks WHERE id = ?', [id]);
    if (!row) throw new BizError(404, '定时任务不存在');
    const r = await scheduler.runTask(row);
    logger.writeLog({ openid: '', name: req.admin.name || '管理员' }, 'task.runNow', row.name);
    ok(res, { affected: r.affected, result: r.result });
  }));

  // ---------- 手动预览：按 scope 统计将清理多少条 ----------
  r.post('/taskPreview', auth.requireAdmin(false), wrap(async (req, res) => {
    const b = req.body || {};
    const scope = scheduler.SCOPES.indexOf(b.scope) > -1 ? b.scope : 'expired';
    const keepDays = Math.max(1, Math.floor(Number(b.keepDays) || 7));
    let n = 0;

    if (scope === 'expired') {
      const r1 = await db.get(
        'SELECT COUNT(*) AS n FROM wc_jobs WHERE status = "done" AND expires_at IS NOT NULL AND expires_at < NOW()'
      );
      n = r1.n;
    } else if (scope === 'failed') {
      const r1 = await db.get('SELECT COUNT(*) AS n FROM wc_jobs WHERE status = "failed"');
      n = r1.n;
    } else if (scope === 'logs') {
      const r1 = await db.get('SELECT COUNT(*) AS n FROM wc_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [keepDays]);
      n = r1.n;
    } else if (scope === 'done_before') {
      const r1 = await db.get(
        'SELECT COUNT(*) AS n FROM wc_jobs WHERE status = "done" AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
        [keepDays]
      );
      n = r1.n;
    }

    ok(res, { scope, keepDays, count: n });
  }));

  app.use('/api/admin', r);
}

module.exports = { register };
