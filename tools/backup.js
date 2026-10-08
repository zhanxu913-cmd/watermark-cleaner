#!/usr/bin/env node
/**
 * 一键备份 —— 把 Git 管不到的东西打包出来
 *
 * 用法：
 *   node tools/backup.js                     备份到 backup/<时间戳>/
 *   node tools/backup.js --out D:/我的备份    备份到指定目录
 *   node tools/backup.js --no-uploads        只备数据库与配置（跳过上传文件）
 *   node tools/backup.js --keep-dumps 5      只保留最近 5 份自动备份
 *
 * 为什么需要它：
 *   .gitignore 排除的三样东西（数据库、server/uploads、server/.env）恰恰是换电脑时
 *   最不能丢的。代码可以从仓库重新 clone，这三样不行。所以换机器前跑一次这个脚本，
 *   把生成的目录整个拷到云盘或 U 盘即可。
 *
 * 产出结构：
 *   backup/20261008-1430/
 *     ├─ db/wc_watermark.sql      mysqldump 全量导出
 *     ├─ uploads/                 用户上传与去水印产物
 *     ├─ server.env.txt           运行时配置（含密钥，注意保管）
 *     └─ 恢复说明.md              新电脑上的操作步骤
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const ENV_FILE = path.join(SERVER, '.env');
const UPLOADS = path.join(SERVER, 'uploads');

/* ---------------- 输出小工具 ---------------- */

const C = {
  ok: (t) => console.log('  ✓ ' + t),
  bad: (t) => console.log('  ✗ ' + t),
  warn: (t) => console.log('  ! ' + t),
  info: (t) => console.log('    ' + t)
};
let problems = [];

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function countFiles(dir) {
  let n = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents = [];
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        n++;
        try {
          bytes += fs.statSync(p).size;
        } catch (err) { /* 忽略 */ }
      }
    }
  }
  return { files: n, bytes };
}

function stamp(d) {
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const out = { out: '', uploads: true, keepDumps: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i] || '';
    else if (a === '--no-uploads') out.uploads = false;
    else if (a === '--keep-dumps') out.keepDumps = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/* ---------------- 读配置 ---------------- */

function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach((l) => {
    const t = l.trim();
    if (!t || t[0] === '#') return;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  });
  return out;
}

/* ---------------- 找 mysqldump ---------------- */

function findMysqldump() {
  const exe = process.platform === 'win32' ? 'mysqldump.exe' : 'mysqldump';

  // 1) 常见安装位置（Windows 上一般不在 PATH 里）
  const guesses = [
    'C:/Program Files/MySQL/MySQL Server 8.0/bin/' + exe,
    'C:/Program Files/MySQL/MySQL Server 8.4/bin/' + exe,
    'C:/Program Files/MySQL/MySQL Server 5.7/bin/' + exe,
    '/usr/bin/' + exe,
    '/usr/local/bin/' + exe,
    '/usr/local/mysql/bin/' + exe
  ];
  for (const g of guesses) {
    if (fs.existsSync(g)) return g;
  }

  // 2) 系统 PATH
  const probe = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) return exe;

  return '';
}

/* ---------------- 内置导出器（mysqldump 不可用时的兜底） ---------------- */

/** 载入 server 里那份 mysql2（tools 目录本身不装依赖） */
function loadMysql() {
  const p = require.resolve('mysql2/promise', { paths: [SERVER] });
  return require(p);
}

/** 把 JS 值转成 SQL 字面量 */
function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return '0x' + v.toString('hex');
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  return "'" + String(v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0')
    .replace(/\u001a/g, '\\Z') + "'";
}

/** 一批行 → 若干条 INSERT（每 100 行一条，便于阅读与排查） */
function buildInserts(table, rows) {
  const cols = Object.keys(rows[0]);
  const head = 'INSERT INTO `' + table + '` (`' + cols.join('`, `') + '`) VALUES\n';
  const out = [];
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100).map(
      (r) => '(' + cols.map((c) => sqlValue(r[c])).join(', ') + ')'
    );
    out.push(head + chunk.join(',\n') + ';\n');
  }
  return out.join('');
}

/**
 * 纯 Node 导出整库：不依赖 mysqldump
 * 关键点：连接用 dateStrings:true，日期按库里存的字符串原样取出，
 * 不做任何时区换算，导入后时间与原来完全一致。
 */
async function dumpViaNode(env, dbName, sqlFile) {
  const mysql = loadMysql();
  const conn = await mysql.createConnection({
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    database: dbName,
    dateStrings: true,
    multipleStatements: true
  });

  try {
    const head = [
      '-- 水印清理 · 数据库备份（由 tools/backup.js 内置导出器生成，无需 mysqldump）',
      '-- 备份时间：' + new Date().toLocaleString('zh-CN'),
      '-- 恢复：mysql -u root -p < ' + path.basename(sqlFile),
      '',
      'SET NAMES utf8mb4;',
      'SET FOREIGN_KEY_CHECKS = 0;',
      'CREATE DATABASE IF NOT EXISTS `' + dbName + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;',
      'USE `' + dbName + '`;',
      ''
    ];
    const parts = [head.join('\n')];

    const [tableRows] = await conn.query('SHOW FULL TABLES');
    const nameKey = 'Tables_in_' + dbName;
    const tables = tableRows.map((r) => r[nameKey] || Object.values(r)[0]).filter(Boolean);

    let totalRows = 0;
    const detail = [];

    for (const t of tables) {
      const [[create]] = await conn.query('SHOW CREATE TABLE `' + t + '`');
      parts.push('-- ---------- ' + t + ' ----------');
      parts.push('DROP TABLE IF EXISTS `' + t + '`;');
      parts.push(create['Create Table'] + ';');
      parts.push('');

      let rows = 0;
      const PAGE = 500;
      let offset = 0;
      for (;;) {
        const [batch] = await conn.query('SELECT * FROM `' + t + '` LIMIT ? OFFSET ?', [PAGE, offset]);
        if (!batch.length) break;
        parts.push(buildInserts(t, batch));
        rows += batch.length;
        if (batch.length < PAGE) break;
        offset += PAGE;
      }
      parts.push('');
      totalRows += rows;
      detail.push(t + '(' + rows + ')');
    }

    parts.push('SET FOREIGN_KEY_CHECKS = 1;');
    parts.push('');

    fs.writeFileSync(sqlFile, parts.join('\n'), 'utf8');
    return { tables: tables.length, rows: totalRows, detail };
  } finally {
    try {
      await conn.end();
    } catch (e) { /* 忽略 */ }
  }
}

/** mysqldump 优先；不可用或失败则自动落到内置导出器 */
async function dumpDatabase(env, dbName, sqlFile) {
  const dump = findMysqldump();

  if (dump) {
    const r = spawnSync(dump, [
      '-h', env.DB_HOST || '127.0.0.1',
      '-P', String(env.DB_PORT || 3306),
      '-u', env.DB_USER || 'root',
      '--single-transaction',
      '--routines',
      '--triggers',
      '--default-character-set=utf8mb4',
      '--databases', dbName,
      '--result-file=' + sqlFile
    ], {
      encoding: 'utf8',
      // 用环境变量传密码，避免出现在命令行里被别的进程看到
      env: Object.assign({}, process.env, { MYSQL_PWD: env.DB_PASSWORD || '' })
    });

    if (r.status === 0 && fs.existsSync(sqlFile) && fs.statSync(sqlFile).size > 0) {
      return { method: 'mysqldump', size: fs.statSync(sqlFile).size, tables: 0, rows: 0, detail: [] };
    }

    const reason = String(r.stderr || (r.error && r.error.message) || '').trim().split('\n')[0];
    C.warn('mysqldump 未成功（' + (reason || '未知原因') + '），自动改用内置导出器');
    try { fs.unlinkSync(sqlFile); } catch (e) { /* 忽略 */ }
  } else {
    C.warn('未找到 mysqldump，改用内置导出器（导出结果同样可用于恢复）');
  }

  const info = await dumpViaNode(env, dbName, sqlFile);
  return { method: '内置导出器', size: fs.statSync(sqlFile).size, tables: info.tables, rows: info.rows, detail: info.detail };
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log([
      '',
      '用法：node tools/backup.js [选项]',
      '',
      '  （无参数）          备份到 backup/<时间戳>/',
      '  --out <目录>        备份到指定目录，例如 --out D:/我的备份',
      '  --no-uploads        只备数据库与配置，跳过上传文件',
      '  --keep-dumps <N>    备份后只保留最近 N 份自动备份',
      ''
    ].join('\n'));
    return;
  }

  console.log('\n══════════════════════════════════════════════');
  console.log('  项目一键备份');
  console.log('══════════════════════════════════════════════');

  const env = readEnv();
  const dbName = env.DB_NAME || 'wc_watermark';
  const ts = stamp(new Date());
  const dest = args.out ? path.resolve(args.out) : path.join(ROOT, 'backup', ts);

  console.log('\n[1] 目标目录');
  fs.mkdirSync(dest, { recursive: true });
  C.ok(dest);

  // ---- 数据库 ----
  console.log('\n[2] 数据库导出（' + dbName + '）');
  if (!fs.existsSync(ENV_FILE)) {
    C.bad('缺少 server/.env，无法读取数据库连接信息');
    problems.push('数据库未导出');
  } else {
    const dbDir = path.join(dest, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const sqlFile = path.join(dbDir, dbName + '.sql');
    try {
      const info = await dumpDatabase(env, dbName, sqlFile);
      C.ok('已导出 ' + dbName + '.sql（' + fmtSize(info.size) + ' · ' + info.method + '）');
      if (info.detail && info.detail.length) {
        C.info(info.tables + ' 张表 · ' + info.rows + ' 行：' + info.detail.join('  '));
      }
    } catch (e) {
      C.bad('导出失败：' + e.message);
      C.info('常见原因：MySQL 未启动、密码不对、' + dbName + ' 库不存在');
      problems.push('数据库未导出');
    }
  }

  // ---- 上传文件 ----
  console.log('\n[3] 用户上传与产物（server/uploads）');
  if (!args.uploads) {
    C.warn('按参数跳过');
  } else if (!fs.existsSync(UPLOADS)) {
    C.warn('目录不存在，跳过');
  } else {
    const st = countFiles(UPLOADS);
    if (st.files === 0) {
      C.ok('目录为空，无需复制');
    } else {
      const dst = path.join(dest, 'uploads');
      try {
        fs.cpSync(UPLOADS, dst, { recursive: true });
        C.ok('已复制 ' + st.files + ' 个文件（' + fmtSize(st.bytes) + '）');
      } catch (e) {
        C.bad('复制失败：' + e.message);
        problems.push('上传文件未复制');
      }
    }
  }

  // ---- 配置 ----
  console.log('\n[4] 运行时配置（server/.env）');
  if (!fs.existsSync(ENV_FILE)) {
    C.bad('server/.env 不存在');
    problems.push('配置未复制');
  } else {
    const dst = path.join(dest, 'server.env.txt');
    fs.copyFileSync(ENV_FILE, dst);
    C.ok('已复制为 server.env.txt');
    C.info('⚠ 里面含数据库密码与密钥，别把备份目录公开分享');
  }

  // ---- 恢复说明 ----
  console.log('\n[5] 生成恢复说明');
  const readme = buildRestoreReadme({ dbName, ts });
  fs.writeFileSync(path.join(dest, '恢复说明.md'), readme, 'utf8');
  C.ok('恢复说明.md');

  // ---- 汇总 ----
  const total = countFiles(dest);
  console.log('\n══════════════════════════════════════════════');
  if (problems.length) {
    console.log('  备份完成，但有 ' + problems.length + ' 项未成功：');
    problems.forEach((p) => console.log('    · ' + p));
  } else {
    console.log('  备份完成 ✓');
  }
  console.log('  位置：' + dest);
  console.log('  内容：' + total.files + ' 个文件 · ' + fmtSize(total.bytes));
  console.log('  下一步：把整个目录拷到云盘 / U 盘，新电脑按「恢复说明.md」操作');
  console.log('══════════════════════════════════════════════\n');

  if (args.keepDumps > 0) trimOld(dest, args.keepDumps);

  process.exit(problems.length ? 1 : 0);
}

/** 只保留最近 N 份自动备份（放在项目 backup/ 下的） */
function trimOld(currentDest, keep) {
  const base = path.join(ROOT, 'backup');
  if (path.dirname(currentDest) !== base) return;
  let list = [];
  try {
    list = fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch (e) {
    return;
  }
  const drop = list.slice(keep);
  if (!drop.length) return;
  console.log('[清理] 保留最近 ' + keep + ' 份，删除：' + drop.join('、'));
  drop.forEach((d) => {
    try {
      fs.rmSync(path.join(base, d), { recursive: true, force: true });
    } catch (e) { /* 忽略 */ }
  });
}

function buildRestoreReadme(o) {
  const nodeVer = process.version;
  return [
    '# 在新电脑上恢复项目',
    '',
    '> 备份时间：' + o.ts + '　备份时的 Node 版本：' + nodeVer,
    '',
    '本目录含三样 **Git 仓库里没有** 的东西：',
    '',
    '| 内容 | 文件 | 说明 |',
    '|---|---|---|',
    '| 数据库 | `db/' + o.dbName + '.sql` | 用户、任务、日志、配置、定时任务 |',
    '| 上传文件 | `uploads/` | 用户上传的原文件与去水印产物 |',
    '| 运行时配置 | `server.env.txt` | 数据库连接、JWT 密钥、后台密钥等 |',
    '',
    '---',
    '',
    '## 一、新电脑装环境',
    '',
    '1. **Node.js** 18 或以上（推荐 20 / 22）',
    '2. **MySQL 8**，安装时记住 root 密码，并勾选 MySQL Client（提供 mysqldump）',
    '3. **Git**',
    '',
    '## 二、取代码',
    '',
    '```bash',
    'git clone <你的仓库地址> watermark-cleaner',
    'cd watermark-cleaner/server',
    'npm install',
    '```',
    '',
    '## 三、还原配置',
    '',
    '把 `server.env.txt` 复制成 `server/.env`：',
    '',
    '```bash',
    '# Windows',
    'copy ..\\server.env.txt .env',
    '# macOS / Linux',
    'cp ../server.env.txt .env',
    '```',
    '',
    '如果新电脑的 MySQL 密码 / 端口与本机不同，改一下 `.env` 里的 `DB_PASSWORD`、`DB_PORT`。',
    '若那台机器上 MySQL 不是 `127.0.0.1:3306`，也一并改。',
    '',
    '## 四、还原数据库',
    '',
    '```bash',
    'mysql -u root -p < db/' + o.dbName + '.sql',
    '```',
    '',
    '导入后确认一下行数（下面数字是备份时的规模）：',
    '',
    '```bash',
    'mysql -u root -p -e "USE ' + o.dbName + '; SELECT COUNT(*) FROM wc_users;"',
    '```',
    '',
    '## 五、还原上传文件',
    '',
    '把备份目录里的 `uploads/` 整个复制到 `server/uploads/`：',
    '',
    '```bash',
    '# 在项目根目录执行',
    'xcopy /E /I "<备份目录>\\uploads" "server\\uploads"        # Windows',
    'cp -r "<备份目录>/uploads" server/uploads                  # macOS / Linux',
    '```',
    '',
    '> 文件路径是相对存储根目录的，所以只要文件在原位，历史记录里的图片/视频就能正常打开。',
    '> 若之前在后台改过「存储路径」，记得在新电脑上改成同样的设置。',
    '',
    '## 六、下载 FFmpeg 并自检',
    '',
    '内置的 FFmpeg 二进制没进仓库（140MB），重新下载一次：',
    '',
    '```bash',
    'cd <项目根目录>',
    'node tools/get-ffmpeg.js',
    'node tools/doctor.js      # 逐项自检：Node / MySQL / 表 / FFmpeg / 端口 / 小程序配置',
    '```',
    '',
    '自检全绿就可以启动了：',
    '',
    '```bash',
    'cd server && node server.js',
    '```',
    '',
    '浏览器打开 `http://127.0.0.1:3000/admin/`（后台密钥见 `.env` 的 `INIT_ADMIN_KEY`，或数据库里的现有账号）。',
    '',
    '## 七、小程序端要改的地方',
    '',
    '如果新电脑的局域网 IP 变了，改 `miniprogram/utils/constants.js` 里的 `API_BASE_URL`，',
    '或者跑 `node tools/lan-ip.js` 看当前机器 IP。用微信开发者工具重新编译即可。',
    '',
    '---',
    '',
    '## 常见问题',
    '',
    '- **`mysqldump: command not found`** → 把 MySQL 的 `bin` 目录加进 PATH，或重装时勾选 Client。',
    '- **视频功能报「无法启动 ffmpeg」** → 跑一次 `node tools/get-ffmpeg.js`。项目会自动在',
    '  `.env` 配置、项目内置 `tools/bin`、系统 PATH 三者中找可用的那个，无需手改路径。',
    '- **图片能看、视频是空白** → 多半是 `uploads/` 没还原全，或后台的存储路径设置和原来不一致。',
    ''
  ].join('\n');
}

main().catch((e) => {
  console.error('\n备份中断：' + (e && e.message ? e.message : e));
  process.exit(2);
});
