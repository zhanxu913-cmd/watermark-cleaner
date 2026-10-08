/**
 * 后台账号密码模块
 *
 * 密码存储：Node 内置 crypto.scrypt，格式 scrypt$<saltHex>$<hashHex>
 *   - 不引入 bcrypt 等原生依赖，避免 Windows 编译问题
 *   - scrypt 是内存硬算法，抗 GPU 爆破，强度足够
 *
 * 账号来源：wc_admins 表（account 非空的行即为后台账号）
 *   - openid 非空：同时是小程序端管理员（双身份）
 *   - openid 为空：纯 Web 后台账号
 *
 * 首次启动：若表里没有可用账号，自动创建 admin / admin123 并打印提示
 */

'use strict';

const crypto = require('crypto');
const db = require('../db');
const { BizError } = require('./biz');

const SCRYPT_N = 16384; // CPU/内存成本
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;

const DEFAULT_ACCOUNT = 'admin';
const DEFAULT_PASSWORD = 'admin123';

/* ---------------- 密码哈希 ---------------- */

/**
 * 生成密码哈希
 * @param {string} plain
 * @returns {string} scrypt$salt$hash
 */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .scryptSync(String(plain), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p })
    .toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

/**
 * 校验密码（时间恒定比较，防时序侧信道）
 * @param {string} plain
 * @param {string} stored
 * @returns {boolean}
 */
function verifyPassword(plain, stored) {
  if (!plain || !stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = parts[1];
  const expect = parts[2];
  let actual;
  try {
    actual = crypto
      .scryptSync(String(plain), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p })
      .toString('hex');
  } catch (e) {
    return false;
  }
  if (actual.length !== expect.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expect, 'hex'));
}

/* ---------------- 账号查询 ---------------- */

/** 按账号查（含禁用行，便于给出准确错误） */
async function getByAccount(account) {
  const acc = String(account || '').trim();
  if (!acc) return null;
  return db.get('SELECT * FROM wc_admins WHERE account = ? LIMIT 1', [acc]);
}

/** 列出所有后台账号（account 非空） */
async function listAccounts() {
  return db.query(
    'SELECT * FROM wc_admins WHERE account <> "" ORDER BY role DESC, id ASC'
  );
}

/** 账号是否已存在（排除指定 id，用于改名查重） */
async function accountExists(account, exceptId) {
  const row = await db.get(
    'SELECT id FROM wc_admins WHERE account = ?' + (exceptId ? ' AND id <> ?' : '') + ' LIMIT 1',
    exceptId ? [account, exceptId] : [account]
  );
  return !!row;
}

/* ---------------- 登录 ---------------- */

/**
 * 账号密码登录校验
 * @param {string} account
 * @param {string} password
 * @returns {Promise<object>} wc_admins 行
 */
async function login(account, password) {
  const acc = String(account || '').trim();
  const pwd = String(password || '');
  if (!acc) throw new BizError(401, '请输入账号');
  if (!pwd) throw new BizError(401, '请输入密码');

  const row = await getByAccount(acc);

  // 账号不存在：仍执行一次哈希运算，避免通过响应耗时枚举账号
  if (!row) {
    crypto.scryptSync(pwd, 'dummy_salt_for_timing', 64, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
    throw new BizError(401, '账号或密码不正确');
  }
  if (!row.enabled) throw new BizError(403, '该账号已被禁用，请联系超级管理员');
  if (!row.password_hash) throw new BizError(401, '该账号尚未设置密码，请用密钥登录后在后台设置');

  if (!verifyPassword(pwd, row.password_hash)) {
    throw new BizError(401, '账号或密码不正确');
  }

  await db.exec('UPDATE wc_admins SET last_login_at = NOW() WHERE id = ?', [row.id]);
  return row;
}

/* ---------------- 账号管理 ---------------- */

/**
 * 创建后台账号
 * @param {{account:string, password:string, name?:string, role?:string, openid?:string}} opts
 */
async function createAccount(opts) {
  const account = String(opts.account || '').trim();
  const password = String(opts.password || '');
  const role = opts.role === 'super' ? 'super' : 'operator';

  if (!/^[A-Za-z0-9_@.-]{3,32}$/.test(account)) {
    throw new BizError(400, '账号需为 3-32 位字母、数字、_ @ . - 组合');
  }
  if (password.length < 6) throw new BizError(400, '密码至少 6 位');
  if (await accountExists(account)) throw new BizError(400, '账号「' + account + '」已存在');

  const openid = String(opts.openid || '').trim() || null; // NULL 而非 ''，避免撞 uk_openid 唯一约束

  // 若指定 openid 已在白名单里，则升级该行（补齐账号密码）而不是新增
  if (openid) {
    const exist = await db.get('SELECT * FROM wc_admins WHERE openid = ? LIMIT 1', [openid]);
    if (exist) {
      await db.exec(
        'UPDATE wc_admins SET account = ?, password_hash = ?, name = ?, role = ?, enabled = 1 WHERE id = ?',
        [account, hashPassword(password), String(opts.name || '').slice(0, 64), role, exist.id]
      );
      return exist.id;
    }
  }

  const r = await db.exec(
    'INSERT INTO wc_admins (openid, account, password_hash, name, role, enabled) VALUES (?, ?, ?, ?, ?, 1)',
    [openid, account, hashPassword(password), String(opts.name || '').slice(0, 64), role]
  );
  return r.insertId;
}

/**
 * 更新后台账号
 * @param {number} id
 * @param {{password?:string, name?:string, role?:string, enabled?:boolean, account?:string}} patch
 */
async function updateAccount(id, patch) {
  const row = await db.get('SELECT * FROM wc_admins WHERE id = ?', [Number(id) || 0]);
  if (!row) throw new BizError(404, '账号不存在');

  const sets = [];
  const params = [];

  if (patch.account !== undefined) {
    const account = String(patch.account || '').trim();
    if (!/^[A-Za-z0-9_@.-]{3,32}$/.test(account)) {
      throw new BizError(400, '账号需为 3-32 位字母、数字、_ @ . - 组合');
    }
    if (await accountExists(account, row.id)) throw new BizError(400, '账号「' + account + '」已被占用');
    sets.push('account = ?');
    params.push(account);
  }

  if (patch.password) {
    if (String(patch.password).length < 6) throw new BizError(400, '密码至少 6 位');
    sets.push('password_hash = ?');
    params.push(hashPassword(String(patch.password)));
  }

  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(String(patch.name || '').slice(0, 64));
  }

  if (patch.role !== undefined) {
    sets.push('role = ?');
    params.push(patch.role === 'super' ? 'super' : 'operator');
  }

  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }

  if (!sets.length) throw new BizError(400, '没有需要更新的内容');

  params.push(row.id);
  await db.exec('UPDATE wc_admins SET ' + sets.join(', ') + ' WHERE id = ?', params);
  return true;
}

/** 删除后台账号（不允许删除最后一个可用的 super） */
async function removeAccount(id) {
  const row = await db.get('SELECT * FROM wc_admins WHERE id = ?', [Number(id) || 0]);
  if (!row) throw new BizError(404, '账号不存在');

  if (row.account && row.role === 'super') {
    const left = await db.get(
      'SELECT COUNT(*) AS n FROM wc_admins WHERE account <> "" AND role = "super" AND enabled = 1 AND id <> ?',
      [row.id]
    );
    if (!left.n) throw new BizError(400, '至少保留一个启用的超级管理员账号');
  }

  // 若该行还挂着 openid 白名单，只清账号密码，保留白名单身份
  if (row.openid) {
    await db.exec(
      'UPDATE wc_admins SET account = "", password_hash = "", last_login_at = NULL WHERE id = ?',
      [row.id]
    );
    return;
  }
  await db.exec('DELETE FROM wc_admins WHERE id = ?', [row.id]);
}

/** 修改自己的密码（校验旧密码） */
async function changeOwnPassword(id, oldPwd, newPwd) {
  const row = await db.get('SELECT * FROM wc_admins WHERE id = ?', [Number(id) || 0]);
  if (!row) throw new BizError(404, '账号不存在');
  if (!row.password_hash) throw new BizError(400, '当前账号未设置密码，请用密钥登录后设置');
  if (!verifyPassword(String(oldPwd || ''), row.password_hash)) {
    throw new BizError(401, '原密码不正确');
  }
  if (String(newPwd || '').length < 6) throw new BizError(400, '新密码至少 6 位');
  await db.exec('UPDATE wc_admins SET password_hash = ? WHERE id = ?', [hashPassword(String(newPwd)), row.id]);
}

/* ---------------- 首次启动初始化 ---------------- */

/**
 * 确保存在一个可登录的超级管理员账号
 * 表里没有任何可用账号时，创建 admin / admin123
 * @returns {Promise<{account:string, password:string}|null>} 仅新建时返回明文用于打印
 */
async function ensureDefaultAccount() {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM wc_admins WHERE account <> "" AND password_hash <> "" AND enabled = 1'
  );
  if (row && row.n > 0) return null;

  const exist = await getByAccount(DEFAULT_ACCOUNT);
  if (exist) {
    await db.exec(
      'UPDATE wc_admins SET password_hash = ?, role = "super", enabled = 1 WHERE id = ?',
      [hashPassword(DEFAULT_PASSWORD), exist.id]
    );
  } else {
    await db.exec(
      'INSERT INTO wc_admins (openid, account, password_hash, name, role, enabled) VALUES (NULL, ?, ?, "超级管理员", "super", 1)',
      [DEFAULT_ACCOUNT, hashPassword(DEFAULT_PASSWORD)]
    );
  }
  return { account: DEFAULT_ACCOUNT, password: DEFAULT_PASSWORD };
}

module.exports = {
  hashPassword,
  verifyPassword,
  getByAccount,
  listAccounts,
  accountExists,
  login,
  createAccount,
  updateAccount,
  removeAccount,
  changeOwnPassword,
  ensureDefaultAccount,
  DEFAULT_ACCOUNT,
  DEFAULT_PASSWORD
};
