/**
 * 定时任务调度器
 *
 * 表：wc_scheduled_tasks
 * 职责：
 *   1. 计算 next_run_at（daily / weekly / hourly / interval）
 *   2. 每分钟轮询到期的任务并执行清理
 *   3. 回收孤儿任务（服务重启后 next_run_at 为空的重算）
 *
 * 清理范围 scope：
 *   expired     过期任务（done 且 expires_at < NOW）：删文件 + 删记录
 *   failed      失败任务：删文件 + 删记录
 *   logs        90 天前日志
 *   done_before 保留 N 天：早于 N 天的已完成任务（含文件）
 */

'use strict';

const db = require('../db');
const files = require('../lib/files');
const logger = require('../lib/log');

const TICK_MS = 60 * 1000; // 每分钟检查一次

const SCOPES = ['expired', 'failed', 'logs', 'done_before'];
const FREQS = ['daily', 'weekly', 'hourly', 'interval'];

const SCOPE_LABEL = {
  expired: '过期任务与文件',
  failed: '失败任务',
  logs: '旧日志',
  done_before: '指定天数前的已完成任务'
};

const FREQ_LABEL = {
  daily: '每天',
  weekly: '每周',
  hourly: '每小时',
  interval: '间隔'
};

/* ---------------- 时间计算 ----------------
 *
 * 基准说明：本机 MySQL 的 NOW() 返回**本机时区**（+08:00）的时间字面值，
 * 连接池已声明 timezone:'+08:00'，因此 JS Date ↔ DATETIME 换算保持一致。
 *
 * 结论：computeNextRun 一律使用本地时间（get / set 系列，而非 getUTC / setUTC），
 * 同时把结果格式化为本地 'YYYY-MM-DD HH:mm:ss' 写入 next_run_at，
 * 这样与 SQL 里的 NOW() 比较才是同一基准。
 */

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

/** 解析 "HH:MM" → { h, m }，非法则回落到 03:00 */
function parseRunAt(v) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v || '').trim());
  if (!m) return { h: 3, m: 0 };
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const mi = Math.min(59, Math.max(0, Number(m[2])));
  return { h, m: mi };
}

/**
 * 把 Date 转成 'YYYY-MM-DD HH:mm:ss'（本地时间，与 MySQL NOW() 同基准）
 */
function toSqlTime(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/**
 * 计算下一次执行时间（本地时间基准）
 * @param {object} t 任务行
 * @param {Date} [from] 基准时间，默认当前
 * @returns {Date}
 */
function computeNextRun(t, from) {
  const now = from || new Date();
  const freq = FREQS.indexOf(t.freq) > -1 ? t.freq : 'daily';

  if (freq === 'hourly') {
    const next = new Date(now.getTime());
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next;
  }

  if (freq === 'interval') {
    const mins = Math.max(1, Number(t.interval_minutes) || 1440);
    return new Date(now.getTime() + mins * 60 * 1000);
  }

  const { h, m } = parseRunAt(t.run_at);

  if (freq === 'weekly') {
    const target = Math.min(6, Math.max(0, Number(t.weekday) || 0));
    const next = new Date(now.getTime());
    next.setHours(h, m, 0, 0);
    let add = (target - next.getDay() + 7) % 7;
    if (add === 0 && next.getTime() <= now.getTime()) add = 7;
    next.setDate(next.getDate() + add);
    return next;
  }

  // daily
  const next = new Date(now.getTime());
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/* ---------------- 行整形 ---------------- */

function shapeTask(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name || '',
    scope: r.scope,
    scopeLabel: SCOPE_LABEL[r.scope] || r.scope,
    freq: r.freq,
    freqLabel: FREQ_LABEL[r.freq] || r.freq,
    intervalMinutes: r.interval_minutes || 1440,
    runAt: r.run_at || '03:00',
    weekday: r.weekday || 0,
    keepDays: r.keep_days || 7,
    enabled: !!r.enabled,
    lastRunAt: r.last_run_at,
    lastResult: r.last_result || '',
    lastAffected: r.last_affected || 0,
    nextRunAt: r.next_run_at,
    runCount: r.run_count || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

/* ---------------- 清理执行 ---------------- */

/**
 * 按 scope 执行一次清理
 * @returns {Promise<{scope:string, affected:number, detail:string}>}
 */
async function runScope(scope, opts) {
  const o = opts || {};
  const s = SCOPES.indexOf(scope) > -1 ? scope : 'expired';
  let affected = 0;
  // 被删除的记录 ID，供调用方写审计日志（便于误删后追溯）
  let ids = [];

  if (s === 'expired') {
    const rows = await db.query(
      'SELECT * FROM wc_jobs WHERE status = "done" AND expires_at IS NOT NULL AND expires_at < NOW() LIMIT 500'
    );
    if (rows.length) {
      ids = rows.map((j) => j.id);
      files.remove(rows.map((j) => [j.src_file, j.out_file, j.thumb_file].filter(Boolean)).flat());
      await db.exec(
        'DELETE FROM wc_jobs WHERE id IN (' + rows.map(() => '?').join(',') + ')',
        rows.map((j) => j.id)
      );
    }
    affected = rows.length;
  } else if (s === 'failed') {
    const rows = await db.query('SELECT * FROM wc_jobs WHERE status = "failed" LIMIT 500');
    if (rows.length) {
      ids = rows.map((j) => j.id);
      files.remove(rows.map((j) => [j.src_file, j.out_file, j.thumb_file].filter(Boolean)).flat());
      await db.exec(
        'DELETE FROM wc_jobs WHERE id IN (' + rows.map(() => '?').join(',') + ')',
        rows.map((j) => j.id)
      );
    }
    affected = rows.length;
  } else if (s === 'logs') {
    const days = Math.max(1, Number(o.keepDays) || 90);
    const r2 = await db.exec(
      'DELETE FROM wc_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days]
    );
    affected = r2.affectedRows;
  } else if (s === 'done_before') {
    const days = Math.max(1, Number(o.keepDays) || 7);
    // 当天任务（含正在处理的）不动，只清 N 天前已完成的
    const rows = await db.query(
      'SELECT * FROM wc_jobs WHERE status = "done" AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 500',
      [days]
    );
    if (rows.length) {
      ids = rows.map((j) => j.id);
      files.remove(rows.map((j) => [j.src_file, j.out_file, j.thumb_file].filter(Boolean)).flat());
      await db.exec(
        'DELETE FROM wc_jobs WHERE id IN (' + rows.map(() => '?').join(',') + ')',
        rows.map((j) => j.id)
      );
    }
    affected = rows.length;
  }

  return {
    scope: s,
    affected,
    ids,
    // 保留日期（仅 logs / done_before 有意义）
    keepDays: o.keepDays,
    detail: '清理 ' + (SCOPE_LABEL[s] || s) + '：' + affected + ' 条'
  };
}

/**
 * 执行单条定时任务（并推进 next_run_at）
 */
async function runTask(row) {
  const started = Date.now();
  let result = '';
  let affected = 0;
  try {
    const r = await runScope(row.scope, { keepDays: row.keep_days });
    affected = r.affected;
    result = r.detail;
  } catch (e) {
    result = '执行失败：' + (e.message || '未知错误').slice(0, 120);
  }

  const next = computeNextRun(row, new Date());
  const cost = Date.now() - started;

  await db.exec(
    'UPDATE wc_scheduled_tasks SET last_run_at = NOW(), last_result = ?, last_affected = ?, ' +
    'next_run_at = ?, run_count = run_count + 1 WHERE id = ?',
    [result.slice(0, 250), affected, toSqlTime(next), row.id]
  );

  logger.writeLog({ openid: '', name: '定时任务' }, 'task.run',
    (row.name || row.id) + ' → ' + result + '（' + cost + 'ms）');

  console.log('[scheduler] 执行任务', row.id, row.name, '→', result);
  return { affected, result };
}

/* ---------------- 调度循环 ---------------- */

let timer = null;
let running = false;

/** 每分钟检查一次到期任务 */
async function tick() {
  if (running) return; // 上一轮未跑完，跳过本轮
  running = true;
  try {
    const due = await db.query(
      'SELECT * FROM wc_scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL ' +
      'AND next_run_at <= NOW() LIMIT 20'
    );
    for (const row of due) {
      await runTask(row);
    }
  } catch (e) {
    console.error('[scheduler] tick 异常:', e.message);
  } finally {
    running = false;
  }
}

/** 启动调度器（服务启动时调用） */
async function start() {
  try {
    // 1) 回收：启用但 next_run_at 为空（或已过期很久）的任务，重算下次时间
    const stale = await db.query(
      'SELECT * FROM wc_scheduled_tasks WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at < DATE_SUB(NOW(), INTERVAL 7 DAY))'
    );
    for (const row of stale) {
      const next = computeNextRun(row, new Date());
      await db.exec('UPDATE wc_scheduled_tasks SET next_run_at = ? WHERE id = ?', [toSqlTime(next), row.id]);
    }
    if (stale.length) console.log('[scheduler] 重算', stale.length, '个任务的执行时间');

    const cnt = await db.get('SELECT COUNT(*) AS n FROM wc_scheduled_tasks WHERE enabled = 1');
    console.log('[scheduler] 已启动，每分钟检查一次，当前启用任务 ' + (cnt ? cnt.n : 0) + ' 个');
  } catch (e) {
    console.warn('[scheduler] 启动检查失败（请先执行 db/migrate_scheduled_tasks.sql）：' + e.message);
  }

  if (timer) clearInterval(timer);
  timer = setInterval(() => tick().catch((e) => console.error('[scheduler]', e.message)), TICK_MS);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  start,
  stop,
  tick,
  runTask,
  runScope,
  computeNextRun,
  toSqlTime,
  shapeTask,
  SCOPES,
  FREQS,
  SCOPE_LABEL,
  FREQ_LABEL
};
