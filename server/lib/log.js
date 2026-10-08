/**
 * 操作日志：写 wc_logs
 */

'use strict';

const db = require('../db');

/**
 * @param {object} operator { openid, name }，密钥登录时 openid 可为空
 * @param {string} action  动作标识，如 user.ban / config.update
 * @param {string} detail  人类可读的描述
 */
async function writeLog(operator, action, detail) {
  const op = operator || {};
  try {
    await db.exec('INSERT INTO wc_logs (openid, operator, action, detail) VALUES (?, ?, ?, ?)', [
      String(op.openid || ''),
      String(op.name || ''),
      String(action || ''),
      String(detail || '').slice(0, 500)
    ]);
  } catch (e) {
    // 日志失败不阻断主流程
    console.error('[log] 写入失败:', e.message);
  }
}

module.exports = { writeLog };
