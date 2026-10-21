/**
 * 小程序静态自检：
 *   1. 所有 require('相对路径') 是否能解析到文件
 *   2. app.json 声明的页面四件套是否齐全
 *   3. wxml 里 bind/catch 的事件处理函数是否在对应 js 中存在
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..', 'miniprogram');
const problems = [];
let jsCount = 0;
let wxmlCount = 0;

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') return;
      walk(p, out);
    } else {
      out.push(p);
    }
  });
  return out;
}

const files = walk(ROOT, []);

/* ---------- 1. require 解析 ---------- */
files
  .filter((f) => f.endsWith('.js'))
  .forEach((f) => {
    jsCount += 1;
    const src = fs.readFileSync(f, 'utf8');
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      if (spec.charAt(0) !== '.') continue; // 内置/第三方模块跳过
      const base = path.resolve(path.dirname(f), spec);
      const ok =
        fs.existsSync(base + '.js') ||
        fs.existsSync(base + '.json') ||
        fs.existsSync(path.join(base, 'index.js'));
      if (!ok) problems.push('[require] ' + path.relative(ROOT, f) + ' -> ' + spec);
    }
  });

/* ---------- 2. app.json 页面 ---------- */
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const pages = (app.pages || []).slice();
(app.subPackages || []).forEach((sp) => {
  (sp.pages || []).forEach((p) => pages.push(sp.root + '/' + p));
});

pages.forEach((p) => {
  ['.js', '.wxml', '.json'].forEach((ext) => {
    const f = path.join(ROOT, p + ext);
    if (!fs.existsSync(f)) problems.push('[page] 缺少 ' + p + ext);
  });
});

/* ---------- 3. 事件处理函数 ---------- */
files
  .filter((f) => f.endsWith('.wxml'))
  .forEach((f) => {
    wxmlCount += 1;
    const js = f.replace(/\.wxml$/, '.js');
    if (!fs.existsSync(js)) return;
    const jsSrc = fs.readFileSync(js, 'utf8');
    const wxmlSrc = fs.readFileSync(f, 'utf8');

    const re = /\b(?:bind|catch)([a-zA-Z]+)\s*=\s*"([a-zA-Z0-9_$]+)"/g;
    let m;
    const seen = {};
    while ((m = re.exec(wxmlSrc))) {
      const fn = m[2];
      if (seen[fn]) continue;
      seen[fn] = true;
      // 允许出现在 methods / Page({...}) 任意位置
      const reg = new RegExp('(^|[\\s{,])' + fn + '\\s*[:(]', 'm');
      if (!reg.test(jsSrc)) {
        problems.push('[event] ' + path.relative(ROOT, f) + ' -> ' + fn + '() 未定义');
      }
    }
  });

console.log('检查文件：js ' + jsCount + ' 个，wxml ' + wxmlCount + ' 个');
if (!problems.length) {
  console.log('全部通过 ✓');
  process.exit(0);
}
console.log('发现 ' + problems.length + ' 个问题：');
problems.forEach((p) => console.log('  - ' + p));
process.exit(1);
