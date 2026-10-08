/**
 * MySQL 连接池与查询辅助
 */

'use strict';

const mysql = require('mysql2/promise');

let pool = null;

function init(cfg) {
  pool = mysql.createPool(
    Object.assign(
      {
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        charset: 'utf8mb4_unicode_ci',
        // DATETIME 统一转为 JS Date
        dateStrings: false,
        // 本机 MySQL 的 NOW() 返回的是本机时区（+08:00）的时间，而非 UTC。
        // 显式声明时区，保证 JS Date ↔ DATETIME 的换算与数据库基准一致，
        // 避免定时任务的 next_run_at 出现 8 小时偏差导致到点不执行。
        timezone: '+08:00'
      },
      cfg
    )
  );
  return pool;
}

function getPool() {
  if (!pool) throw new Error('数据库尚未初始化');
  return pool;
}

/** 返回 rows（SELECT） */
async function query(sql, params) {
  const [rows] = await getPool().query(sql, params || []);
  return rows;
}

/** 返回第一行或 null */
async function get(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/** 返回 { insertId, affectedRows } */
async function exec(sql, params) {
  const [result] = await getPool().query(sql, params || []);
  return result;
}

module.exports = { init, getPool, query, get, exec };
