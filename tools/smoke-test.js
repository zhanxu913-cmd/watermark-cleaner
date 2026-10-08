#!/usr/bin/env node
/**
 * 全链路冒烟测试 —— 验证小程序端调用的每个动作在真实后端存在且可用
 *
 * 用法：node tools/smoke-test.js
 */
'use strict';

const http = require('http');

const HOST = process.env.SMOKE_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;

let pass = 0, fail = 0;
const failures = [];

function req(path, body, token) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ host: HOST, port: PORT, path, method: 'POST', headers, timeout: 6000 }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw: buf });
      });
    });
    r.on('error', (e) => resolve({ status: 0, json: null, raw: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: 'timeout' }); });
    r.write(data);
    r.end();
  });
}

function check(label, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + label); }
  else { fail++; failures.push(label + ' → ' + detail); console.log('  ✗ ' + label + '  ' + detail); }
}

async function main() {
  console.log('后端: http://' + HOST + ':' + PORT + '\n');

  // ---------- 0. 健康检查 ----------
  console.log('[0] 服务可用性');
  const health = await new Promise((resolve) => {
    http.get({ host: HOST, port: PORT, path: '/healthz', timeout: 4000 }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, raw: b }));
    }).on('error', (e) => resolve({ status: 0, raw: e.message }));
  });
  check('GET /healthz', health.status === 200 && /"ok"\s*:\s*true/.test(health.raw), 'status=' + health.status + ' ' + health.raw.slice(0, 80));
  if (health.status !== 200) { console.log('\n服务未启动，终止。'); process.exit(1); }

  // ---------- 1. 小程序用户侧 ----------
  console.log('\n[1] 用户侧 login/*');
  const signIn = await req('/api/login/signIn', { code: 'smoke_' + Date.now() });
  const utoken = signIn.json && signIn.json.data && signIn.json.data.token;
  check('login/signIn', signIn.status === 200 && !!utoken, 'status=' + signIn.status);
  if (!utoken) { console.log('\n登录失败，后续跳过。'); report(); return; }

  const userCases = [
    ['login/profile', {}],
    ['login/updateProfile', { nickName: '' }],
    ['login/quota', {}],
    ['login/stats', {}],
    ['login/consume', { type: 'image' }]
  ];
  for (const [p, b] of userCases) {
    const r = await req('/api/' + p, b, utoken);
    check(p, r.status === 200 && r.json && r.json.code === 0, 'status=' + r.status + ' code=' + (r.json ? r.json.code : 'n/a'));
  }

  // ---------- 2. 任务 ----------
  console.log('\n[2] 任务 job/*');
  const jobCases = [
    ['job/list', { page: 1, pageSize: 5 }],
    ['job/stats', {}]
  ];
  for (const [p, b] of jobCases) {
    const r = await req('/api/' + p, b, utoken);
    check(p, r.status === 200 && r.json && r.json.code === 0, 'status=' + r.status + ' code=' + (r.json ? r.json.code : 'n/a'));
  }
  // 需参数的任务接口：只验证「路由存在」（非 404）
  for (const p of ['job/detail', 'job/remove', 'job/removeAll', 'job/retry', 'job/markSaved']) {
    const r = await req('/api/' + p, {}, utoken);
    const exists = r.status !== 404;
    check(p + ' (路由存在)', exists, 'status=' + r.status);
  }

  // ---------- 3. 视频处理 ----------
  console.log('\n[3] 视频 videoProc/*');
  for (const p of ['videoProc/submit', 'videoProc/status', 'videoProc/service']) {
    const r = await req('/api/' + p, {}, utoken);
    check(p + ' (路由存在)', r.status !== 404, 'status=' + r.status);
  }

  // ---------- 4. 上传 ----------
  console.log('\n[4] 文件上传 upload');
  for (const p of ['upload', 'file/upload', 'file/remove']) {
    const r = await req('/api/' + p, {}, utoken);
    check('POST /api/' + p + ' (路由存在)', r.status !== 404, 'status=' + r.status);
  }

  // ---------- 5. 后台管理 ----------
  console.log('\n[5] 后台 admin/*');
  const aLogin = await req('/api/admin/accountLogin', { account: 'admin', password: 'admin123' });
  const atoken = aLogin.json && aLogin.json.data && aLogin.json.data.token;
  check('admin/accountLogin (admin/admin123)', aLogin.status === 200 && !!atoken, 'status=' + aLogin.status + ' msg=' + (aLogin.json ? aLogin.json.msg : 'n/a'));
  if (atoken) {
    const adminCases = [
      ['admin/me', {}],
      ['admin/overview', {}],
      ['admin/users', { page: 1, pageSize: 5 }],
      ['admin/jobs', { page: 1, pageSize: 5 }],
      ['admin/settings', {}],
      ['admin/logs', { page: 1, pageSize: 5 }],
      ['admin/accounts', {}],
      ['admin/admins', {}]
    ];
    for (const [p, b] of adminCases) {
      const r = await req('/api/' + p, b, atoken);
      check(p, r.status === 200 && r.json && r.json.code === 0, 'status=' + r.status + ' code=' + (r.json ? r.json.code : 'n/a'));
    }
    for (const p of ['admin/changePassword', 'admin/accountAdd', 'admin/accountUpdate', 'admin/accountRemove', 'admin/userDetail', 'admin/userUpdate', 'admin/jobUpdate', 'admin/settingsUpdate', 'admin/adminAdd', 'admin/adminRemove', 'admin/cleanData', 'admin/check', 'admin/login']) {
      const r = await req('/api/' + p, {}, atoken);
      check(p + ' (路由存在)', r.status !== 404, 'status=' + r.status);
    }
  }

  // ---------- 6. 静态托管 ----------
  console.log('\n[6] 静态资源');
  for (const p of ['/admin/', '/admin/index.html']) {
    const r = await new Promise((resolve) => {
      http.get({ host: HOST, port: PORT, path: p, timeout: 4000 }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, len: b.length }));
      }).on('error', (e) => resolve({ status: 0, len: 0, err: e.message }));
    });
    check('GET ' + p, r.status === 200 && r.len > 500, 'status=' + r.status + ' bytes=' + r.len);
  }

  report();
}

function report() {
  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach((f) => console.log('  · ' + f));
  } else {
    console.log('全部通过 ✓');
  }
  console.log('─'.repeat(52));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
