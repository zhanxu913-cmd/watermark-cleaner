/**
 * 云函数 cleanup
 * 职责：定时清理过期数据（由 config.json 里的定时触发器调用，也可手动触发）
 *
 * 清理规则：
 *   1) 已过 expiresAt 的已完成/失败任务 —— 删除云存储文件 + 记录
 *   2) 卡死超过 2 小时仍在 pending/processing 的任务 —— 标记为失败
 *   3) 超过 90 天的操作日志 —— 删除
 *   4) 孤儿文件：src 目录下已无对应任务记录的文件（可选，默认关闭）
 *
 * 定时触发器：每小时执行一次（见同目录 config.json）
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const C = {
  JOBS: 'wc_jobs',
  LOGS: 'wc_logs',
  USERS: 'wc_users',
  SETTINGS: 'wc_settings'
};

const STUCK_MS = 2 * 3600 * 1000; // 卡死判定阈值
const LOG_KEEP_DAYS = 90;
const BATCH = 500;
const MAX_ROUNDS = 20;

/* ============================================================
   入口
   ============================================================ */

exports.main = async (event) => {
  const opts = event || {};
  const dryRun = !!opts.dryRun;

  const result = {
    expired: 0,
    expiredFiles: 0,
    stuck: 0,
    removedLogs: 0,
    dryRun
  };

  try {
    const keepHours = await readKeepHours();

    // ---- 1) 过期任务 ----
    const expiredRes = await sweepExpired(keepHours, dryRun);
    result.expired = expiredRes.removed;
    result.expiredFiles = expiredRes.files;

    // ---- 2) 卡死任务 ----
    if (!dryRun) result.stuck = await markStuck();

    // ---- 3) 过期日志 ----
    if (!dryRun) result.removedLogs = await cleanLogs();

    console.log('[cleanup] done', JSON.stringify(result));
    return { code: 0, data: result, msg: 'ok' };
  } catch (e) {
    console.error('[cleanup] error', e);
    return { code: 500, data: result, msg: e.message || '清理失败' };
  }
};

/* ============================================================
   清理动作
   ============================================================ */

/**
 * 清理过期任务
 * 判定依据优先用记录上的 expiresAt，缺失时用 createdAt + keepHours 兜底
 */
async function sweepExpired(keepHours, dryRun) {
  const now = new Date();
  const fallbackBefore = new Date(now.getTime() - keepHours * 3600 * 1000);

  let removed = 0;
  let files = 0;

  for (let i = 0; i < MAX_ROUNDS; i++) {
    const res = await db
      .collection(C.JOBS)
      .where(
        _.and([
          { status: _.in(['done', 'failed']) },
          _.or([
            { expiresAt: _.lte(now) },
            _.and([{ expiresAt: _.exists(false) }, { createdAt: _.lte(fallbackBefore) }])
          ])
        ])
      )
      .limit(BATCH)
      .field({ outFileID: true, thumbFileID: true, srcFileID: true })
      .get();

    const rows = res.data || [];
    if (!rows.length) break;

    rows.forEach((r) => {
      if (r.outFileID) files++;
      if (r.thumbFileID) files++;
      if (r.srcFileID) files++;
    });

    if (!dryRun) {
      await purgeFiles(rows);
      await db
        .collection(C.JOBS)
        .where({ _id: _.in(rows.map((r) => r._id)) })
        .remove();
    }

    removed += rows.length;
    if (rows.length < BATCH) break;
  }

  return { removed, files };
}

/** 长时间停留在排队/处理中的任务，统一标记为失败，避免用户无限等待 */
async function markStuck() {
  const before = new Date(Date.now() - STUCK_MS);

  const res = await db
    .collection(C.JOBS)
    .where({
      status: _.in(['pending', 'processing']),
      createdAt: _.lte(before)
    })
    .limit(BATCH)
    .field({ _id: true })
    .get();

  const rows = res.data || [];
  if (!rows.length) return 0;

  await Promise.all(
    rows.map((r) =>
      db
        .collection(C.JOBS)
        .doc(r._id)
        .update({
          data: {
            status: 'failed',
            error: '处理超时，已自动回收',
            progressText: '',
            finishedAt: new Date()
          }
        })
        .catch(() => null)
    )
  );

  return rows.length;
}

async function cleanLogs() {
  const before = new Date(Date.now() - LOG_KEEP_DAYS * 24 * 3600 * 1000);
  try {
    const res = await db.collection(C.LOGS).where({ createdAt: _.lte(before) }).remove();
    return (res.stats && res.stats.removed) || 0;
  } catch (e) {
    console.warn('[cleanup] cleanLogs failed', e.message);
    return 0;
  }
}

/* ============================================================
   内部工具
   ============================================================ */

async function purgeFiles(rows) {
  const files = [];
  (rows || []).forEach((j) => {
    if (j.outFileID) files.push(j.outFileID);
    if (j.thumbFileID) files.push(j.thumbFileID);
    if (j.srcFileID) files.push(j.srcFileID);
  });
  if (!files.length) return;

  for (let i = 0; i < files.length; i += 50) {
    try {
      await cloud.deleteFile({ fileList: files.slice(i, i + 50) });
    } catch (e) {
      console.warn('[cleanup] deleteFile failed', e.message);
    }
  }
}

async function readKeepHours() {
  try {
    const res = await db.collection(C.SETTINGS).where({ _id: 'global' }).limit(1).get();
    const doc = res.data[0];
    const h = Number(doc && doc.cloudKeepHours);
    return isFinite(h) && h > 0 ? h : 1;
  } catch (e) {
    return 1;
  }
}
