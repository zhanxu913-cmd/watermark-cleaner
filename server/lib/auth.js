/**
 * JWT 鉴权
 *
 * 两类令牌：
 *   1. 用户令牌   { uid, openid }               —— wx.login 登录后下发
 *   2. 管理令牌   { admin: true, role, aid? }
 *        - 无 aid：密钥换取（super）
 *        - 有 aid：后台账号密码登录换取（见 lib/account.js）
 *
 * 管理接口的准入（四选一）：
 *   - 账号令牌（回库校验启用状态，角色按 wc_admins.role）
 *   - 密钥令牌（role = super，可读写）
 *   - 用户令牌且 openid 在 wc_admins 白名单（角色按白名单记录）
 *   - 请求体携带 __key 且等于 settings.adminKey（兼容小程序端旧流程，视为 super）
 */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const settings = require('./settings');
const { BizError } = require('./biz');

const SECRET = () => process.env.JWT_SECRET || 'dev-secret-please-change';
const EXPIRES = '7d';

function signUser(payload) {
  return jwt.sign(payload, SECRET(), { expiresIn: EXPIRES });
}

function signAdmin() {
  return jwt.sign({ admin: true, role: 'super' }, SECRET(), { expiresIn: '3d' });
}

function verify(token) {
  try {
    return jwt.verify(token, SECRET());
  } catch (e) {
    return null;
  }
}

/**
 * 签发后台账号令牌
 * @param {{id:number, account:string, name:string, role:string}} acc
 */
function signAccount(acc) {
  return jwt.sign(
    { admin: true, aid: acc.id, account: acc.account, name: acc.name || acc.account, role: acc.role },
    SECRET(),
    { expiresIn: '3d' }
  );
}

/** 从请求头解析令牌（可能为 null） */
function parseToken(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? verify(m[1]) : null;
}

/** 要求用户登录；把 { uid, openid, auth } 挂到 req 上 */
async function requireUser(req, res, next) {
  try {
    const auth = parseToken(req);
    if (!auth || auth.admin || !auth.uid) throw new BizError(401, '请先登录');

    const user = await db.get('SELECT * FROM wc_users WHERE id = ?', [auth.uid]);
    if (!user) throw new BizError(401, '账号不存在，请重新登录');
    if (user.banned) {
      const e = new BizError(403, '账号已被限制：' + (user.ban_reason || '请联系管理员'));
      e.banned = true;
      throw e;
    }

    req.user = user;
    req.auth = auth;
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * 解析管理员身份（不通过则返回 null）
 * @returns {Promise<{role:'super'|'operator', name:string, via:'token'|'whitelist'|'key'}|null>}
 */
async function resolveAdmin(req) {
  const auth = parseToken(req);

  // 1a) 后台账号令牌（账号密码登录）—— 角色以令牌为准，但需回库确认未被禁用/删除
  if (auth && auth.admin && auth.aid) {
    const acc = await db.get('SELECT * FROM wc_admins WHERE id = ?', [auth.aid]);
    if (!acc || !acc.enabled) return null;
    return {
      role: acc.role === 'super' ? 'super' : 'operator',
      name: acc.name || acc.account,
      account: acc.account,
      aid: acc.id,
      via: 'account'
    };
  }

  // 1b) 密钥令牌（超级权限）
  if (auth && auth.admin) {
    return { role: 'super', name: '密钥登录', via: 'token' };
  }

  // 2) 用户令牌 + 白名单
  if (auth && auth.uid) {
    const user = await db.get('SELECT * FROM wc_users WHERE id = ?', [auth.uid]);
    if (!user || user.banned) return null;
    const admin = await db.get('SELECT * FROM wc_admins WHERE openid = ?', [user.openid]);
    if (admin) {
      if (admin.enabled === 0) return null;
      return {
        role: admin.role === 'super' ? 'super' : 'operator',
        name: admin.name || '',
        account: admin.account || '',
        aid: admin.id,
        via: 'whitelist'
      };
    }
  }

  // 3) 请求体密钥兜底（小程序端旧流程）
  const key = req.body && req.body.__key;
  if (key) {
    const s = await settings.getSettings();
    if (s.adminKey && String(key) === s.adminKey) {
      return { role: 'super', name: '密钥登录', via: 'key' };
    }
  }

  return null;
}

/** 要求管理员；read=true 时 operator 也可通过，否则需要 super */
function requireAdmin(write) {
  return async function (req, res, next) {
    try {
      const admin = await resolveAdmin(req);
      if (!admin) throw new BizError(401, '无管理权限，请先用密钥登录');
      if (write && admin.role !== 'super') {
        throw new BizError(403, '该操作需要超级管理员权限');
      }
      req.admin = admin;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** 生成随机任务 ID */
function randomId(prefix) {
  return (prefix || 'j') + Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

module.exports = {
  signUser,
  signAdmin,
  signAccount,
  verify,
  parseToken,
  requireUser,
  resolveAdmin,
  requireAdmin,
  randomId
};
