/**
 * 存储路径配置（后台可自定义）
 *
 * 配置项存在 wc_settings 单行表：
 *   storage_root        存储根目录。留空 = 沿用 .env 的 UPLOAD_DIR；自定义值必须位于项目文件夹内
 *                       （相对路径以项目文件夹为基准，如 storage、server/uploads）
 *   storage_src_dir     上传源文件子目录名，默认 src
 *   storage_output_dir  去水印产物子目录名，默认 output
 *   storage_thumb_dir   封面缩略图子目录名，默认 thumb
 *
 * 设计要点：
 *   1. fileID = 相对「存储根目录」的路径（如 output/videos/xxx.mp4），所以换根目录
 *      只要把文件一起搬过去，数据库里的记录无需改动；换子目录名则必须同步改 fileID 前缀。
 *   2. 所有目录拼装统一走本模块，业务代码不再硬编码目录名。
 *   3. 迁移只「复制」不「删除」源目录，除非显式传 removeSource，避免误删不可找回。
 *   4. 位置限制：存储根目录必须落在项目文件夹内（不允许跨盘、不允许指向项目外的位置），
 *      且不能占用项目代码目录。所有校验集中在本模块，接口与界面只是调用方。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db');
const files = require('./files');
const { BizError } = require('./biz');

const DEFAULTS = { root: '', srcDir: 'src', outDir: 'output', thumbDir: 'thumb' };

const COLUMN_MAP = {
  storage_root: 'root',
  storage_src_dir: 'srcDir',
  storage_output_dir: 'outDir',
  storage_thumb_dir: 'thumbDir'
};

const LABEL = {
  root: '存储根目录',
  srcDir: '上传源文件子目录',
  outDir: '去水印产物子目录',
  thumbDir: '封面缩略图子目录'
};

/** 前端上传时使用的语义名，与角色一一对应，不可被其它角色占用 */
const SEMANTIC = { srcDir: 'src', outDir: 'output', thumbDir: 'thumb' };

const DIR_RE = /^[A-Za-z0-9_-]{1,32}$/;
const SCAN_LIMIT = 100000;

/* ---------------- 位置约束（项目文件夹内） ---------------- */

/** 项目文件夹：所有存储目录必须位于此目录之内 */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
/** server 目录：配置里相对路径的基准（与 .env 的 UPLOAD_DIR 语义一致） */
const SERVER_DIR = path.resolve(__dirname, '..');
/** 项目内的代码目录，不允许被用作存储目录（命中即拒） */
const BLOCKED_ABS = [
  PROJECT_ROOT,
  path.join(PROJECT_ROOT, 'server'),
  path.join(PROJECT_ROOT, 'miniprogram'),
  path.join(PROJECT_ROOT, 'admin-web'),
  path.join(PROJECT_ROOT, 'cloudfunctions'),
  path.join(PROJECT_ROOT, 'video-service')
];
/** 这些目录及其所有子目录都不允许存放文件 */
const BLOCKED_PREFIX = [
  path.join(PROJECT_ROOT, 'miniprogram'),
  path.join(PROJECT_ROOT, 'admin-web'),
  path.join(PROJECT_ROOT, 'cloudfunctions'),
  path.join(PROJECT_ROOT, 'video-service'),
  path.join(PROJECT_ROOT, 'server', 'lib'),
  path.join(PROJECT_ROOT, 'server', 'routes'),
  path.join(PROJECT_ROOT, 'server', 'services'),
  path.join(PROJECT_ROOT, 'server', 'db'),
  path.join(PROJECT_ROOT, 'server', 'public')
];
/** 项目资料目录（文档 / 设计稿 / 脚本），同样不允许混放用户文件 */
const BLOCKED_ASSET = [
  path.join(PROJECT_ROOT, 'design'),
  path.join(PROJECT_ROOT, 'docs'),
  path.join(PROJECT_ROOT, 'tools')
];
/** 路径中出现这些目录名一律不允许 */
const BLOCKED_SEG = ['node_modules'];

let cfg = Object.assign({}, DEFAULTS);
let loadedFromDb = false;

/* ---------------- 基础工具 ---------------- */

function envRootRaw() {
  return process.env.UPLOAD_DIR || 'uploads';
}

function sameCase(a, b) {
  return process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;
}

/** 判断某绝对路径能否作为存储目录；可则返回空串，不可则返回原因 */
function rootIssue(abs) {
  const target = path.resolve(abs);
  const root = path.resolve(PROJECT_ROOT);

  if (!sameCase(path.parse(target).root, path.parse(root).root)) {
    return '与项目不在同一磁盘';
  }
  if (sameCase(target, root)) {
    return '这是项目根目录本身，请改选项目内的子目录';
  }
  if (!sameCase(target.slice(0, root.length), root) || target[root.length] !== path.sep) {
    return '位于项目文件夹之外';
  }
  if (BLOCKED_ABS.some((b) => sameCase(path.resolve(b), target))) {
    return '这是项目代码目录';
  }
  const inPrefix = BLOCKED_PREFIX.some((b) => {
    const base = path.resolve(b);
    if (sameCase(target, base)) return true;
    return sameCase(target.slice(0, base.length), base) && target[base.length] === path.sep;
  });
  if (inPrefix) {
    return '这是项目代码目录';
  }
  if (BLOCKED_ASSET.some((b) => sameCase(path.resolve(b), target))) {
    return '这是项目资料目录';
  }
  const segs = path.relative(root, target).split(path.sep).map((s) => s.toLowerCase());
  if (segs.some((s) => s.charAt(0) === '.')) {
    return '位于隐藏目录内';
  }
  if (segs.indexOf('node_modules') > -1) {
    return '位于 node_modules 目录内';
  }
  return '';
}

/** 强制：存储目录必须位于项目文件夹内，否则抛业务异常 */
function assertInsideProject(abs) {
  const issue = rootIssue(abs);
  if (issue) {
    throw new BizError(500, '存储目录不可用：' + issue + '；' + displayPath(abs) + '（项目文件夹：' + displayPath(PROJECT_ROOT) + '）');
  }
  return path.resolve(abs);
}

/** 相对路径以 server 目录为基准，统一转绝对路径（仅用于 .env 的 UPLOAD_DIR 默认值） */
function toAbs(v) {
  const raw = String(v || '').replace(/\\/g, '/').trim();
  if (!raw) return path.join(SERVER_DIR, envRootRaw());
  return path.isAbsolute(raw) ? path.normalize(raw) : path.join(SERVER_DIR, raw);
}

/** 自定义根目录：相对路径以「项目文件夹」为基准（更直观，且天然不会跑出项目） */
function resolveFromProject(v) {
  const raw = String(v || '').replace(/\\/g, '/').trim();
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(PROJECT_ROOT, raw);
}

/** 绝对路径 → 配置里存的值（相对项目文件夹，正斜杠） */
function toStoredValue(abs) {
  const rel = path.relative(PROJECT_ROOT, path.resolve(abs));
  return rel.split(path.sep).join('/') || '.';
}

function displayPath(abs) {
  return path.resolve(abs).split(path.sep).join('/');
}

/** 统计目录下的文件数与总字节（迭代遍历，避免深层递归爆栈） */
function scan(root) {
  let count = 0;
  let bytes = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        if (count >= SCAN_LIMIT) {
          truncated = true;
          continue;
        }
        count++;
        try {
          bytes += fs.statSync(p).size;
        } catch (err) {
          /* 忽略单个文件统计失败 */
        }
      }
    }
  }
  return { count, bytes, truncated };
}

/** 写权限探针文件名（固定名，避免每次刷新都换个新名字累积垃圾） */
const PROBE_NAME = '.__wc_write_test__';
/** 历史遗留的探针名（旧版带 pid 与时间戳），一并清理 */
const PROBE_RE = /^\.wc_write_test_|^\.__wc_write_test__/;

/** 清掉残留的探针文件：正常会被立即删除，进程被强杀时会剩下来 */
function sweepProbes(dir) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  let n = 0;
  const now = Date.now();
  for (const e of ents) {
    if (!e.isFile() || !PROBE_RE.test(e.name)) continue;
    const p = path.join(dir, e.name);
    try {
      // 只清 30 秒前的，避免误删此刻正在写入的那个
      if (now - fs.statSync(p).mtimeMs < 30000) continue;
      fs.unlinkSync(p);
      n++;
    } catch (err) {
      /* 单个失败不影响主流程 */
    }
  }
  return n;
}

/** 检查目录是否可写（不抛异常） */
function tryWritable(abs) {
  try {
    fs.mkdirSync(abs, { recursive: true });
  } catch (e) {
    return { ok: false, message: '无法创建目录：' + e.message };
  }
  sweepProbes(abs);
  const probe = path.join(abs, PROBE_NAME);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true, message: '' };
  } catch (e) {
    try {
      fs.unlinkSync(probe);
    } catch (err) { /* 删不掉就算了，下次 sweep 会清 */ }
    return { ok: false, message: '目录不可写入：' + e.message };
  }
}

/** 创建目录并确保可写；失败抛 BizError */
function ensureDirWritable(abs, label) {
  const r = tryWritable(abs);
  if (!r.ok) throw new BizError(500, (label || '目录') + '：' + r.message);
  return abs;
}

/** 禁止新旧根目录互相包含（否则复制会自套自） */
function assertNoNesting(curAbs, nextAbs) {
  const a = path.resolve(curAbs);
  const b = path.resolve(nextAbs);
  if (a === b) return;
  const sep = path.sep;
  if (b.indexOf(a + sep) === 0) throw new BizError(500, '新目录不能位于当前存储目录之内');
  if (a.indexOf(b + sep) === 0) throw new BizError(500, '新目录不能是当前存储目录的上级目录');
}

function copyFileSafe(src, dst, stat) {
  if (fs.existsSync(dst)) {
    stat.skipped++;
    return;
  }
  try {
    fs.copyFileSync(src, dst);
    stat.files++;
    stat.bytes += fs.statSync(dst).size;
  } catch (err) {
    stat.failed++;
  }
}

/** 递归复制目录（子层不参与改名） */
function copyTreeFlat(from, to, stat) {
  fs.mkdirSync(to, { recursive: true });
  let ents = [];
  try {
    ents = fs.readdirSync(from, { withFileTypes: true });
  } catch (e) {
    return stat;
  }
  for (const e of ents) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyTreeFlat(src, dst, stat);
    else if (e.isFile()) copyFileSafe(src, dst, stat);
  }
  return stat;
}

/**
 * 复制整棵树，顶层目录名按 dirMap 重写
 * 用于「换根 + 同时改子目录名」的场景，一步到位，避免在新根留下废弃目录
 */
function copyTopMapped(from, to, dirMap, stat) {
  fs.mkdirSync(to, { recursive: true });
  let ents = [];
  try {
    ents = fs.readdirSync(from, { withFileTypes: true });
  } catch (e) {
    return stat;
  }
  for (const e of ents) {
    const mapped = dirMap[e.name] || e.name;
    const src = path.join(from, e.name);
    const dst = path.join(to, mapped);
    if (e.isDirectory()) copyTreeFlat(src, dst, stat);
    else if (e.isFile()) copyFileSafe(src, dst, stat);
  }
  return stat;
}

/* ---------------- 配置读写 ---------------- */

/** 校验并规整一份配置；非法直接抛 BizError */
function sanitize(input) {
  const p = input || {};
  const out = Object.assign({}, DEFAULTS);

  const rawRoot = String(p.root === undefined || p.root === null ? cfg.root : p.root).replace(/\\/g, '/').trim();
  if (rawRoot.length > 200) throw new BizError(500, LABEL.root + '过长（最多 200 字符）');
  if (/[\u0000-\u001f<>"|?*]/.test(rawRoot)) throw new BizError(500, LABEL.root + '包含非法字符');
  out.root = rawRoot === '.' || rawRoot === './' ? '' : rawRoot;

  // 位置限制：解析后的绝对路径必须落在项目文件夹内（禁止跨盘 / 项目外 / 占用代码目录）
  if (out.root) assertInsideProject(resolveFromProject(out.root));

  ['srcDir', 'outDir', 'thumbDir'].forEach((k) => {
    const raw = p[k];
    const v = String(raw === undefined || raw === null || raw === '' ? DEFAULTS[k] : raw)
      .trim().replace(/^\/+|\/+$/g, '');
    if (!DIR_RE.test(v)) {
      throw new BizError(500, LABEL[k] + '只能使用字母、数字、下划线、短横线（1-32 位）');
    }
    out[k] = v;
  });

  // 先查保留名冲突（错误定位更准），再查彼此重复
  Object.keys(SEMANTIC).forEach((k) => {
    Object.keys(SEMANTIC).forEach((j) => {
      if (k !== j && out[k] === SEMANTIC[j]) {
        throw new BizError(500, LABEL[k] + '不能使用保留名「' + SEMANTIC[j] + '」');
      }
    });
  });

  if (new Set([out.srcDir, out.outDir, out.thumbDir]).size < 3) {
    throw new BizError(500, '三个子目录名不能重复');
  }

  return out;
}

/** 配置里的根目录值 → 实际绝对路径 */
function rootAbsOf(next) {
  return next.root ? resolveFromProject(next.root) : toAbs('');
}

/** 应用配置到 files（立即生效） */
function apply(next) {
  cfg = Object.assign({}, DEFAULTS, next);
  files.setRoot(rootAbsOf(cfg));
  return cfg;
}

/** 启动时从数据库加载；表未迁移则回退 .env */
async function load() {
  let row = null;
  try {
    row = await db.get(
      'SELECT storage_root, storage_src_dir, storage_output_dir, storage_thumb_dir FROM wc_settings WHERE id = 1'
    );
    loadedFromDb = true;
  } catch (e) {
    console.warn('[storage] 读取存储配置失败，回退 .env 的 UPLOAD_DIR（请执行 db/migrate_storage_settings.sql）：' + e.message);
  }

  const next = Object.assign({}, DEFAULTS);
  if (row) {
    Object.keys(COLUMN_MAP).forEach((col) => {
      const k = COLUMN_MAP[col];
      const v = row[col];
      if (v !== undefined && v !== null && String(v).trim() !== '') next[k] = String(v).trim();
    });
  }

  let safe;
  try {
    safe = sanitize(next);
  } catch (e) {
    // 库里的值不合法（改过盘符 / 项目被移动过 / 指向了项目外）→ 退回默认，避免启动即报错
    console.warn('[storage] 数据库中的存储配置不合法，已回退默认：' + e.message);
    safe = Object.assign({}, DEFAULTS);
  }
  apply(safe);
  return describe();
}

/** 当前配置快照 */
function get() {
  return Object.assign({}, cfg);
}

/** 运行态信息（供后台展示） */
function describe() {
  const root = files.getRoot();
  const st = scan(root);
  const w = tryWritable(root);
  return {
    root,
    rootInput: cfg.root,
    envRoot: envRootRaw(),
    source: cfg.root ? 'custom' : 'env',
    srcDir: cfg.srcDir,
    outDir: cfg.outDir,
    thumbDir: cfg.thumbDir,
    semantic: Object.assign({}, SEMANTIC),
    migrateSupported: loadedFromDb,
    writable: w.ok,
    writableMessage: w.message,
    fileCount: st.count,
    bytes: st.bytes,
    truncated: st.truncated,
    // 位置限制相关（后台据此提示「只能在项目文件夹内选」）
    projectRoot: displayPath(PROJECT_ROOT),
    serverDir: displayPath(SERVER_DIR),
    rootValue: toStoredValue(root),
    rootInsideProject: !rootIssue(root)
  };
}

/* ---------------- 目录映射（供业务调用） ---------------- */

/**
 * 把前端上传时传的语义目录映射为实际目录
 * 'src/videos' → '<srcDir>/videos'；未知前缀原样保留（如 misc）
 */
function mapUploadDir(dir) {
  const raw = String(dir || 'misc').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = raw.split('/').filter(Boolean);
  const head = parts[0] || 'misc';
  const mapped = SEMANTIC.srcDir === head ? cfg.srcDir
    : SEMANTIC.outDir === head ? cfg.outDir
      : SEMANTIC.thumbDir === head ? cfg.thumbDir
        : head;
  return [mapped].concat(parts.slice(1)).join('/');
}

/** 去水印视频产物目录（fileID 前缀） */
function outVideoDir() {
  return cfg.outDir + '/videos';
}

/** 视频封面目录（fileID 前缀） */
function thumbVideoDir() {
  return cfg.thumbDir + '/videos';
}

/* ---------------- 目录浏览（后台「选择目录」，只在项目文件夹内） ---------------- */

/**
 * 解析浏览目标路径：空 = 项目根目录
 * 允许以项目根目录本身作为「浏览位置」，但不允许把它当作存储目录
 */
function resolveBrowse(v) {
  const raw = String(v === undefined || v === null ? '' : v).replace(/\\/g, '/').trim();
  let abs;
  if (!raw) abs = PROJECT_ROOT;
  else if (path.isAbsolute(raw)) abs = path.normalize(raw);
  else abs = path.resolve(PROJECT_ROOT, raw);

  const target = path.resolve(abs);
  const root = path.resolve(PROJECT_ROOT);
  if (!sameCase(target.slice(0, root.length), root) || (target.length > root.length && target[root.length] !== path.sep)) {
    throw new BizError(500, '只能浏览项目文件夹内的目录：' + PROJECT_ROOT);
  }
  return target;
}

function briefEntry(full) {
  const allowed = !rootIssue(full);
  return {
    name: path.basename(full),
    path: displayPath(full),
    rel: path.relative(PROJECT_ROOT, full).split(path.sep).join('/'),
    rootValue: toStoredValue(full),
    allowed,
    reason: allowed ? '' : rootIssue(full),
    hasChildren: hasSubDir(full)
  };
}

function hasSubDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some(
      (e) => e.isDirectory() && e.name.charAt(0) !== '.' && BLOCKED_SEG.indexOf(e.name.toLowerCase()) === -1
    );
  } catch (e) {
    return false;
  }
}

/**
 * 列出某目录下的子目录（仅项目文件夹内）
 * @param {string} v 绝对路径；留空 = 项目根目录
 */
function listDirs(v) {
  const abs = resolveBrowse(v);
  let ents;
  try {
    ents = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    throw new BizError(500, '无法读取目录：' + e.message);
  }

  const entries = ents
    .filter((e) => e.isDirectory() && e.name.charAt(0) !== '.' && BLOCKED_SEG.indexOf(e.name.toLowerCase()) === -1)
    .map((e) => briefEntry(path.join(abs, e.name)))
    .sort((a, b) => {
      if (a.allowed !== b.allowed) return a.allowed ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh');
    });

  const atRoot = sameCase(abs, PROJECT_ROOT);
  return {
    projectRoot: displayPath(PROJECT_ROOT),
    serverDir: displayPath(SERVER_DIR),
    path: displayPath(abs),
    rel: path.relative(PROJECT_ROOT, abs).split(path.sep).join('/') || '.',
    rootValue: toStoredValue(abs),
    allowed: atRoot ? false : !rootIssue(abs),
    reason: atRoot ? '这是项目根目录本身，请改选项目内的子目录' : rootIssue(abs),
    parent: atRoot ? null : displayPath(path.dirname(abs)),
    entries
  };
}

/** 在项目内的某个目录下新建文件夹 */
function createDir(parent, name) {
  const base = resolveBrowse(parent);

  const n = String(name || '').trim();
  if (!n) throw new BizError(500, '请输入文件夹名');
  if (n.length > 32) throw new BizError(500, '文件夹名最多 32 个字符');
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,32}$/.test(n)) {
    throw new BizError(500, '文件夹名只能使用中英文、数字、下划线、短横线');
  }

  const full = path.join(base, n);
  assertInsideProject(full);
  if (fs.existsSync(full)) throw new BizError(500, '该文件夹已存在：' + n);
  try {
    fs.mkdirSync(full, { recursive: true });
  } catch (e) {
    throw new BizError(500, '创建失败：' + e.message);
  }
  return briefEntry(full);
}

/** 项目内可直接作为存储目录的候选（供后台快捷展示） */
function suggestDirs() {
  const out = [];
  try {
    fs.readdirSync(PROJECT_ROOT, { withFileTypes: true }).forEach((e) => {
      if (!e.isDirectory()) return;
      const full = path.join(PROJECT_ROOT, e.name);
      if (rootIssue(full)) return;
      out.push(briefEntry(full));
    });
  } catch (e) {
    /* 忽略 */
  }
  return out;
}

/* ---------------- 预览与保存 ---------------- */

/** 预览：校验目标配置 + 计算迁移影响面（不落库） */
function preview(patch) {
  const prev = { root: files.getRoot(), srcDir: cfg.srcDir, outDir: cfg.outDir, thumbDir: cfg.thumbDir };
  const next = sanitize(patch);
  const nextAbs = rootAbsOf(next);

  assertNoNesting(prev.root, nextAbs);
  const w = tryWritable(nextAbs);

  const rootChanged = path.resolve(prev.root) !== path.resolve(nextAbs);
  const dirsChanged = next.srcDir !== prev.srcDir || next.outDir !== prev.outDir || next.thumbDir !== prev.thumbDir;
  const cur = scan(prev.root);

  return {
    next,
    current: Object.assign({}, prev, { rootAbs: prev.root }),
    rootInput: next.root,
    nextRoot: nextAbs,
    rootChanged,
    dirsChanged,
    changed: rootChanged || dirsChanged,
    targetWritable: w.ok,
    targetMessage: w.message,
    migrateSupported: loadedFromDb,
    pending: { files: cur.count, bytes: cur.bytes, truncated: cur.truncated },
    projectRoot: displayPath(PROJECT_ROOT),
    rootValue: next.root ? toStoredValue(nextAbs) : ''
  };
}

/** 把源目录内容并入目标目录（同名以目标已有的为准），随后尽力清理空壳目录 */
function moveInto(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  let ents = [];
  try {
    ents = fs.readdirSync(fromDir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of ents) {
    const src = path.join(fromDir, e.name);
    const dst = path.join(toDir, e.name);
    if (e.isDirectory()) {
      moveInto(src, dst);
    } else if (e.isFile()) {
      if (fs.existsSync(dst)) continue;
      try {
        fs.renameSync(src, dst);
      } catch (err) {
        /* 跨卷等场景降级为复制 */
        try {
          fs.copyFileSync(src, dst);
        } catch (err2) { /* 忽略 */ }
      }
    }
  }
  try {
    fs.rmdirSync(fromDir);
  } catch (e) {
    /* 非空则保留 */
  }
}

/** 改名子目录（两阶段：源→临时名→目标名，避免互换名时互相覆盖；目标已存在则合并） */
function renameDirs(root, pairs, out) {
  const staged = [];
  const tmpTag = '__wc_moving_' + Date.now() + '_';
  try {
    pairs.forEach(([a, b], i) => {
      const from = path.join(root, a);
      if (!fs.existsSync(from)) return;
      const tmp = path.join(root, tmpTag + i);
      fs.renameSync(from, tmp);
      staged.push([tmp, path.join(root, b), a, b]);
    });
  } catch (e) {
    staged.forEach(([tmp, , a]) => {
      try {
        fs.renameSync(tmp, path.join(root, a));
      } catch (err) {
        /* 回滚失败只记录，不掩盖原始异常 */
      }
    });
    throw e;
  }
  staged.forEach(([tmp, to, a, b]) => {
    if (fs.existsSync(to)) {
      moveInto(tmp, to);
    } else {
      fs.renameSync(tmp, to);
    }
    out.renamed.push(a + ' → ' + b);
  });
}

/** 同步 wc_jobs 里三个文件字段的目录前缀 */
async function remapDbPrefix(prev, next) {
  const map = [
    ['src_file', prev.srcDir, next.srcDir],
    ['out_file', prev.outDir, next.outDir],
    ['thumb_file', prev.thumbDir, next.thumbDir]
  ];
  let total = 0;
  for (const [col, a, b] of map) {
    if (a === b) continue;
    const oldP = a + '/';
    const newP = b + '/';
    const r = await db.exec(
      'UPDATE wc_jobs SET ' + col + ' = CONCAT(?, SUBSTRING(' + col + ', ?)) WHERE ' + col + ' LIKE ?',
      [newP, oldP.length + 1, oldP + '%']
    );
    total += r.affectedRows || 0;
  }
  return total;
}

/** 执行迁移：复制（可同时改名）→ 同根改名 → 同步数据库前缀（可选删源） */
async function migrate(prev, next, nextAbs, rootChanged, removeSource) {
  const out = { copied: 0, skipped: 0, failed: 0, bytes: 0, renamed: [], rows: 0, removedSource: false };

  const dirMap = {};
  if (prev.srcDir !== next.srcDir) dirMap[prev.srcDir] = next.srcDir;
  if (prev.outDir !== next.outDir) dirMap[prev.outDir] = next.outDir;
  if (prev.thumbDir !== next.thumbDir) dirMap[prev.thumbDir] = next.thumbDir;
  const pairs = Object.keys(dirMap).map((k) => [k, dirMap[k]]);

  if (rootChanged) {
    // 换根：复制时直接把顶层目录映射为目标名，避免在新根留下废弃目录
    const stat = { files: 0, skipped: 0, failed: 0, bytes: 0 };
    copyTopMapped(prev.root, nextAbs, dirMap, stat);
    out.copied = stat.files;
    out.skipped = stat.skipped;
    out.failed = stat.failed;
    out.bytes = stat.bytes;
    if (stat.failed > 0) {
      throw new BizError(500, '复制文件时有 ' + stat.failed + ' 个失败，已中止（原目录未改动）');
    }
    pairs.forEach(([a, b]) => out.renamed.push(a + ' → ' + b));
  } else if (pairs.length) {
    renameDirs(prev.root, pairs, out);
  }

  out.rows = await remapDbPrefix(prev, next);

  if (rootChanged && removeSource) {
    // 删除前复核：新目录文件数不能少于旧目录，否则保留源目录
    const oldStat = scan(prev.root);
    const newStat = scan(nextAbs);
    if (newStat.count >= oldStat.count) {
      fs.rmSync(prev.root, { recursive: true, force: true });
      out.removedSource = true;
    } else {
      out.removeSkipped = '新目录文件数（' + newStat.count + '）少于原目录（' + oldStat.count + '），已保留原目录';
    }
  }

  return out;
}

/**
 * 保存配置并立即生效
 * @param {object} patch { root, srcDir, outDir, thumbDir }
 * @param {object} [opts] { migrate:boolean 是否迁移已有文件, removeSource:boolean 迁移后是否删除原目录 }
 */
async function save(patch, opts) {
  const o = opts || {};
  const prev = { root: files.getRoot(), srcDir: cfg.srcDir, outDir: cfg.outDir, thumbDir: cfg.thumbDir };
  const next = sanitize(patch);
  const nextAbs = rootAbsOf(next);

  assertNoNesting(prev.root, nextAbs);
  ensureDirWritable(nextAbs, LABEL.root);

  const rootChanged = path.resolve(prev.root) !== path.resolve(nextAbs);
  const dirsChanged = next.srcDir !== prev.srcDir || next.outDir !== prev.outDir || next.thumbDir !== prev.thumbDir;

  const report = { rootChanged, dirsChanged, migrated: false };

  if ((rootChanged || dirsChanged) && o.migrate) {
    Object.assign(report, await migrate(prev, next, nextAbs, rootChanged, !!o.removeSource));
    report.migrated = true;
  }

  // 统一按「相对项目文件夹」的形式落库，项目整体搬走也不会失效
  const storedRoot = next.root ? toStoredValue(nextAbs) : '';
  await db.exec(
    'UPDATE wc_settings SET storage_root = ?, storage_src_dir = ?, storage_output_dir = ?, storage_thumb_dir = ? WHERE id = 1',
    [storedRoot, next.srcDir, next.outDir, next.thumbDir]
  );

  apply(Object.assign({}, next, { root: storedRoot }));
  return { config: describe(), report, previous: prev };
}

module.exports = {
  load,
  get,
  describe,
  preview,
  save,
  mapUploadDir,
  outVideoDir,
  thumbVideoDir,
  sanitize,
  listDirs,
  createDir,
  suggestDirs,
  toStoredValue,
  rootIssue,
  assertInsideProject,
  DEFAULTS,
  LABEL,
  PROJECT_ROOT,
  SERVER_DIR
};
