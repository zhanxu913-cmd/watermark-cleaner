/**
 * 本地记录仓库（零后台版）
 *
 * 设计要点：
 *   1. 记录元数据存 USER_DATA_PATH/wc/data/records.json
 *      —— 不用 wx.setStorageSync，是因为 Storage 单个 key 上限 1MB，记录多了会写爆
 *   2. 缩略图存 wc/thumbs、成品存 wc/outputs，均为持久化本地文件
 *      —— 编辑器拿到的 tempFilePath 重启即失效，必须 copyFile 落盘
 *   3. 总容量超过 MAX_BYTES 时，按创建时间从旧到新清理「成品文件」，
 *      保留记录条目与缩略图，用户点开旧记录时会看到「文件已过期」而不是空白
 *   4. 所有 fs 操作都不抛出，避免一条脏记录让整个记录页白屏
 *
 * 对外返回的记录结构与原后端 shapeJob 保持一致，
 * 页面层（records / result / index）无需改动字段名。
 */

'use strict';

const fs = wx.getFileSystemManager();

const ROOT = wx.env.USER_DATA_PATH + '/wc';
const DIR = {
  root: ROOT,
  data: ROOT + '/data',
  thumbs: ROOT + '/thumbs',
  outputs: ROOT + '/outputs'
};
const FILE = DIR.data + '/records.json';

/** 本地文件总容量上限：150MB（小程序用户目录上限 200MB，留出余量） */
const MAX_BYTES = 150 * 1024 * 1024;
/** 最多保留记录条数 */
const MAX_RECORDS = 300;

let store = null;
let seq = 0;
let dirsReady = false;
/** 记录文件存在但解析失败：此时禁止执行 gc，否则会把所有图片当孤儿删掉 */
let parseFailed = false;

/* ============================================================
   基础工具
   ============================================================ */

function ensureDirs() {
  if (dirsReady) return;
  Object.keys(DIR).forEach((k) => {
    const p = DIR[k];
    try {
      fs.accessSync(p);
    } catch (e) {
      try {
        fs.mkdirSync(p, true);
      } catch (e2) {
        /* 已存在或并发创建，忽略 */
      }
    }
  });
  dirsReady = true;
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function fmt(d) {
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds())
  );
}

function guessExt(p) {
  const m = /\.([a-zA-Z0-9]{2,5})(?:\?|$)/.exec(String(p || ''));
  return m ? m[1].toLowerCase() : 'jpg';
}

function sizeOf(p) {
  if (!p) return 0;
  try {
    const s = fs.statSync(p);
    return (s && s.size) || 0;
  } catch (e) {
    return 0;
  }
}

function deleteFile(p) {
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch (e) {
    /* 文件不存在或已被系统清理 */
  }
}

function exists(p) {
  if (!p) return false;
  try {
    fs.accessSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

/* ============================================================
   读写
   ============================================================ */

function load() {
  if (store) return store;
  ensureDirs();

  let arr = [];
  if (exists(FILE)) {
    try {
      const txt = fs.readFileSync(FILE, 'utf8');
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed)) {
        arr = parsed;
      } else {
        parseFailed = true;
      }
    } catch (e) {
      // 文件损坏：本次仍可继续使用（记录从空开始），但不要据此清理文件
      parseFailed = true;
      console.error('[localdb] 记录文件解析失败，本次跳过孤儿文件清理', e);
    }
  }

  seq = arr.reduce((m, j) => Math.max(m, Number(j._seq) || 0), 0);
  store = arr;
  return store;
}

function save(arr) {
  ensureDirs();
  store = arr;
  const txt = JSON.stringify(arr);
  try {
    fs.writeFileSync(FILE, txt, 'utf8');
  } catch (e) {
    // 写失败时退一步：清掉只读状态重试一次
    try {
      fs.writeFileSync(FILE, txt, 'utf8');
    } catch (e2) {
      console.error('[localdb] 写入记录失败', e2);
    }
  }
}

/** 去掉内部字段，保持与原后端返回一致 */
function publicJob(j) {
  const o = Object.assign({}, j);
  delete o._seq;
  return o;
}

/* ============================================================
   文件持久化
   ============================================================ */

/**
 * 把临时文件复制到本地持久目录
 * @param {string} tempPath 编辑器/相册得到的临时路径
 * @param {'thumb'|'output'} kind
 * @param {string} [ext] 扩展名，缺省从路径推断
 * @returns {string} 本地持久路径；失败返回空串
 */
function persistFile(tempPath, kind, ext) {
  if (!tempPath) return '';
  ensureDirs();

  const dir = kind === 'thumb' ? DIR.thumbs : DIR.outputs;
  const prefix = kind === 'thumb' ? 't' : 'o';
  const suffix = String(ext || '').replace(/^\./, '').toLowerCase() || guessExt(tempPath);
  const name =
    prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) + '.' + suffix;
  const dest = dir + '/' + name;

  try {
    fs.copyFileSync(tempPath, dest);
    return dest;
  } catch (e) {
    console.error('[localdb] 保存文件失败', e);
    return '';
  }
}

/* ============================================================
   容量管理
   ============================================================ */

/** 超出容量时从最旧的成品开始删；缩略图保留，保证列表还能看 */
function sweep() {
  const arr = load();
  let total = 0;
  arr.forEach((j) => {
    total += sizeOf(j.outFileID) + sizeOf(j.thumbFileID);
  });
  if (total <= MAX_BYTES) return;

  const oldest = arr.slice().sort((a, b) => (a._seq || 0) - (b._seq || 0));
  let changed = false;

  for (let i = 0; i < oldest.length && total > MAX_BYTES; i++) {
    const j = oldest[i];
    const s = sizeOf(j.outFileID);
    if (s > 0) {
      deleteFile(j.outFileID);
      j.outFileID = '';
      total -= s;
      changed = true;
    }
  }

  if (changed) save(arr);
}

/* ============================================================
   记录 CRUD
   ============================================================ */

/**
 * 新增一条记录
 * @param {object} data
 * @returns {object} 记录对象
 */
function create(data) {
  const d = data || {};
  const arr = load();
  const now = new Date();
  const id =
    'l' + now.getTime().toString(36) + Math.random().toString(36).slice(2, 6);

  const job = {
    id,
    type: d.type || 'image',
    mode: d.mode || '',
    status: d.status || 'done',
    progress: d.progress === undefined ? 100 : Number(d.progress) || 0,
    fileName: d.fileName || '',
    region: d.region || null,
    regions: d.regions || (d.region && d.region.regions) || null,
    timeRange: d.timeRange || null,
    duration: Number(d.duration) || 0,
    strength: Number(d.strength) || 0,
    width: Number(d.width) || 0,
    height: Number(d.height) || 0,
    regionCount: Number(d.regionCount) || 0,
    srcFileID: d.srcFileID || '',
    remoteId: d.remoteId || '',
    outFileID: d.outFileID || '',
    thumbFileID: d.thumbFileID || '',
    size: Number(d.size) || sizeOf(d.outFileID) || 0,
    outSize: Number(d.outSize) || sizeOf(d.outFileID) || 0,
    error: d.error || '',
    saved: !!d.saved,
    createdAt: fmt(now),
    finishedAt: (d.status || 'done') === 'done' ? fmt(now) : '',
    expiresAt: '',
    _seq: ++seq
  };

  arr.unshift(job);

  // 条数超限：丢弃最旧的记录，连文件一起清掉
  if (arr.length > MAX_RECORDS) {
    const dropped = arr.splice(MAX_RECORDS);
    dropped.forEach((j) => {
      deleteFile(j.outFileID);
      deleteFile(j.thumbFileID);
    });
  }

  save(arr);
  sweep();
  return publicJob(job);
}

/**
 * 局部更新（视频任务进度回填用）
 */
function update(id, patch) {
  const arr = load();
  const job = arr.find((j) => j.id === id);
  if (!job) return null;
  Object.assign(job, patch || {});
  if (patch && (patch.status === 'done' || patch.status === 'failed')) {
    job.finishedAt = job.finishedAt || fmt(new Date());
  }
  save(arr);
  return publicJob(job);
}

function detail(id) {
  const job = load().find((j) => j.id === id);
  return job ? publicJob(job) : null;
}

/**
 * 分页查询
 * @param {{page?:number,pageSize?:number,filter?:string,keyword?:string}} params
 */
function list(params) {
  const p = params || {};
  const page = Math.max(1, Number(p.page) || 1);
  const pageSize = Math.max(1, Number(p.pageSize) || 20);
  const filter = p.filter || 'all';
  const keyword = String(p.keyword || '').trim().toLowerCase();

  let arr = load().slice().sort((a, b) => (b._seq || 0) - (a._seq || 0));

  if (filter === 'image' || filter === 'video') {
    arr = arr.filter((j) => j.type === filter);
  } else if (filter === 'unsaved') {
    arr = arr.filter((j) => !j.saved);
  }

  if (keyword) {
    arr = arr.filter((j) => String(j.fileName || '').toLowerCase().indexOf(keyword) > -1);
  }

  const total = arr.length;
  const start = (page - 1) * pageSize;
  const slice = arr.slice(start, start + pageSize).map(publicJob);

  return {
    list: slice,
    total,
    page,
    pageSize,
    hasMore: start + pageSize < total
  };
}

function remove(ids) {
  const set = {};
  (Array.isArray(ids) ? ids : [ids]).forEach((id) => {
    if (id) set[id] = true;
  });

  const arr = load();
  const kept = [];
  let deleted = 0;

  arr.forEach((j) => {
    if (set[j.id]) {
      deleteFile(j.outFileID);
      deleteFile(j.thumbFileID);
      deleted += 1;
    } else {
      kept.push(j);
    }
  });

  if (deleted) save(kept);
  return { deleted };
}

function removeAll() {
  const arr = load();
  arr.forEach((j) => {
    deleteFile(j.outFileID);
    deleteFile(j.thumbFileID);
  });
  save([]);
  return { deleted: arr.length };
}

function markSaved(id) {
  const arr = load();
  const job = arr.find((j) => j.id === id);
  if (!job || job.saved) return null;
  job.saved = true;
  save(arr);
  return publicJob(job);
}

/** 首页/「我的」用的统计 */
function stats() {
  const arr = load();
  let image = 0;
  let video = 0;
  let saved = 0;
  let bytes = 0;

  arr.forEach((j) => {
    if (j.type === 'video') video += 1;
    else image += 1;
    if (j.saved) saved += 1;
    bytes += sizeOf(j.outFileID);
  });

  return {
    total: arr.length,
    image,
    video,
    saved,
    unsaved: arr.length - saved,
    bytes,
    bytesText: (bytes / 1024 / 1024).toFixed(1) + ' MB'
  };
}

/** 清理孤儿文件（记录里已经不存在的文件），启动时调一次即可 */
function gc() {
  ensureDirs();
  const arr = load();
  if (parseFailed) {
    console.warn('[localdb] 记录不可读，跳过 gc');
    return;
  }
  const used = {};
  arr.forEach((j) => {
    if (j.outFileID) used[j.outFileID] = true;
    if (j.thumbFileID) used[j.thumbFileID] = true;
  });

  [DIR.thumbs, DIR.outputs].forEach((dir) => {
    let names = [];
    try {
      names = fs.readdirSync(dir) || [];
    } catch (e) {
      names = [];
    }
    names.forEach((n) => {
      const full = dir + '/' + n;
      if (!used[full]) deleteFile(full);
    });
  });
}

module.exports = {
  DIR,
  ROOT,
  exists,
  persistFile,
  create,
  update,
  detail,
  list,
  remove,
  removeAll,
  markSaved,
  stats,
  gc,
  sizeOf
};
