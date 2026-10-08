/**
 * 用户侧接口：/api/login/*
 *   signIn        登录（wx.login code 换 openid，首次自动建档）
 *   profile       用户资料与配额
 *   updateProfile 更新昵称/头像
 *   quota         单独查配额
 *   stats         个人统计
 *   consume       消费一次配额（预扣）
 */

'use strict';

const express = require('express');
const db = require('../db');
const { ok, fail, wrap } = require('../lib/resp');
const { BizError } = require('../lib/biz');
const wechat = require('../lib/wechat');
const settings = require('../lib/settings');
const quota = require('../lib/quota');
const auth = require('../lib/auth');
const { shapeUser } = require('../lib/shape');

function register(app) {
  const r = express.Router();

  // ---------- 登录（免鉴权） ----------
  r.post('/signIn', wrap(async (req, res) => {
    const code = String((req.body && req.body.code) || '');
    const { openid, dev } = await wechat.codeToOpenid(code);

    let user = await db.get('SELECT * FROM wc_users WHERE openid = ?', [openid]);
    let isNew = false;

    if (!user) {
      const s = await settings.getSettings();
      if (!s.registerEnabled) throw new BizError(403, '小程序暂未开放注册，请联系管理员');

      const r2 = await db.exec('INSERT INTO wc_users (openid, last_active_at) VALUES (?, NOW())', [openid]);
      user = await db.get('SELECT * FROM wc_users WHERE id = ?', [r2.insertId]);
      isNew = true;
    } else {
      await db.exec('UPDATE wc_users SET last_active_at = NOW() WHERE id = ?', [user.id]);
    }

    if (user.banned) throw new BizError(403, '账号已被限制：' + (user.ban_reason || '请联系管理员'));

    const s = await settings.getPublicSettings();
    const q = quota.shapeQuota(user, s);
    const token = auth.signUser({ uid: user.id, openid: user.openid });

    const admin = await db.get('SELECT * FROM wc_admins WHERE openid = ?', [openid]);

    ok(res, {
      token,
      isNew,
      dev,
      user: shapeUser(user, q),
      settings: s,
      isAdmin: !!admin,
      adminRole: admin ? admin.role : ''
    });
  }));

  // ---------- 以下均需用户登录 ----------
  r.post('/profile', auth.requireUser, wrap(async (req, res) => {
    const s = await settings.getPublicSettings();
    ok(res, { user: shapeUser(req.user, quota.shapeQuota(req.user, s)), settings: s });
  }));

  r.post('/updateProfile', auth.requireUser, wrap(async (req, res) => {
    const patch = {};
    if (req.body.nickName !== undefined) {
      patch.nickname = String(req.body.nickName).slice(0, 20);
    }
    if (req.body.avatarUrl !== undefined) {
      patch.avatar_url = String(req.body.avatarUrl).slice(0, 500);
    }
    const keys = Object.keys(patch);
    if (keys.length) {
      await db.exec('UPDATE wc_users SET ' + keys.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?',
        keys.map((k) => patch[k]).concat([req.user.id]));
    }
    const user = await db.get('SELECT * FROM wc_users WHERE id = ?', [req.user.id]);
    const s = await settings.getPublicSettings();
    ok(res, { user: shapeUser(user, quota.shapeQuota(user, s)) });
  }));

  r.post('/quota', auth.requireUser, wrap(async (req, res) => {
    const s = await settings.getPublicSettings();
    ok(res, quota.shapeQuota(req.user, s));
  }));

  r.post('/stats', auth.requireUser, wrap(async (req, res) => {
    const openid = req.user.openid;
    const totalRow = await db.get('SELECT COUNT(*) AS n FROM wc_jobs WHERE openid = ?', [openid]);
    const monthRow = await db.get(
      'SELECT COUNT(*) AS n FROM wc_jobs WHERE openid = ? AND created_at >= DATE_FORMAT(NOW(), "%Y-%m-01")',
      [openid]
    );
    const imageRow = await db.get('SELECT COUNT(*) AS n FROM wc_jobs WHERE openid = ? AND type = "image"', [openid]);
    const videoRow = await db.get('SELECT COUNT(*) AS n FROM wc_jobs WHERE openid = ? AND type = "video"', [openid]);
    const sizeRow = await db.get('SELECT COALESCE(SUM(out_size), 0) AS n FROM wc_jobs WHERE openid = ?', [openid]);

    ok(res, {
      total: totalRow.n,
      month: monthRow.n,
      image: imageRow.n,
      video: videoRow.n,
      savedSize: Number(sizeRow.n) || 0
    });
  }));

  r.post('/consume', auth.requireUser, wrap(async (req, res) => {
    const type = req.body.type === 'video' ? 'video' : 'image';
    const s = await settings.getPublicSettings();
    const r2 = await quota.consume(req.user.id, type, s);
    ok(res, r2);
  }));

  app.use('/api/login', r);
}

module.exports = { register };
