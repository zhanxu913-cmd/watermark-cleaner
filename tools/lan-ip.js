#!/usr/bin/env node
/**
 * 局域网 IP 工具 —— 手机真机测试用
 *
 * 用法：
 *   node tools/lan-ip.js            查看本机局域网 IP + 当前小程序配置
 *   node tools/lan-ip.js --set      自动把小程序地址切到局域网 IP（真机模式）
 *   node tools/lan-ip.js --local    切回 127.0.0.1（模拟器模式）
 *   node tools/lan-ip.js --firewall 打印放行 3000 端口的命令（需管理员执行）
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONST_FILE = path.join(ROOT, 'miniprogram', 'utils', 'constants.js');
const PORT = Number(process.env.PORT) || 3000;

/** 取可用的局域网 IPv4，常见家用网段优先 */
function getLanIPv4() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    if (/vmware|virtualbox|vethernet|docker|wsl|loopback|hyper-v|蓝牙|bluetooth/i.test(name)) return;
    (ifaces[name] || []).forEach((it) => {
      if (it.family !== 'IPv4' || it.internal) return;
      if (it.address.startsWith('169.254.')) return;
      out.push({ name, ip: it.address });
    });
  });
  out.sort((a, b) => {
    const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
    return score(a.ip) - score(b.ip);
  });
  return out;
}

function readCurrent() {
  const src = fs.readFileSync(CONST_FILE, 'utf8');
  // 只匹配行首（可含空白）的赋值行，避开注释里的示例
  const m = src.match(/^\s*const API_BASE_URL = '([^']+)'/m);
  return m ? m[1] : '(未找到)';
}

function writeBaseUrl(url) {
  const src = fs.readFileSync(CONST_FILE, 'utf8');
  // 只替换行首赋值行，不动注释中的示例
  const re = /^(\s*const API_BASE_URL = ')[^']*(')/m;
  if (!re.test(src)) {
    console.log('✗ 未找到可替换的 API_BASE_URL 行，请手动修改 constants.js');
    process.exit(1);
  }
  const next = src.replace(re, `$1${url}$2`);
  fs.writeFileSync(CONST_FILE, next, 'utf8');
}

function main() {
  const arg = process.argv[2] || '';
  const ips = getLanIPv4();
  const current = readCurrent();

  if (arg === '--firewall') {
    const ip = ips[0] ? ips[0].ip : '192.168.x.x';
    console.log('以【管理员身份】打开 PowerShell / CMD，执行下面这条命令（只需一次）：');
    console.log('');
    console.log(`  netsh advfirewall firewall add rule name="WC-Backend-${PORT}" dir=in action=allow protocol=TCP localport=${PORT}`);
    console.log('');
    console.log('删除规则（不再需要时）：');
    console.log(`  netsh advfirewall firewall delete rule name="WC-Backend-${PORT}"`);
    console.log('');
    console.log('测试地址：http://' + ip + ':' + PORT + '/healthz');
    return;
  }

  if (arg === '--set') {
    if (!ips.length) {
      console.log('✗ 没检测到局域网 IP，请确认电脑已连上 WiFi / 网线');
      process.exit(1);
    }
    const target = `http://${ips[0].ip}:${PORT}`;
    writeBaseUrl(target);
    console.log('✓ 已切换到真机模式');
    console.log('  小程序地址 → ' + target);
    console.log('  （网卡：' + ips[0].name + '）');
    console.log('');
    console.log('接着做：');
    console.log('  1) 确认电脑防火墙放行 3000：node tools/lan-ip.js --firewall');
    console.log('  2) 手机和电脑连同一个 WiFi');
    console.log('  3) 开发者工具里点「预览」生成二维码，手机微信扫码');
    console.log('  4) 手机上打开后，在右上角「…」→ 打开调试，看是否有报错');
    return;
  }

  if (arg === '--local') {
    writeBaseUrl(`http://127.0.0.1:${PORT}`);
    console.log('✓ 已切回模拟器模式');
    console.log('  小程序地址 → http://127.0.0.1:' + PORT);
    return;
  }

  // 默认：只查看
  console.log('当前小程序 API 地址 : ' + current);
  console.log('后端端口            : ' + PORT);
  console.log('');
  console.log('本机局域网 IP：');
  if (!ips.length) {
    console.log('  (无 —— 请检查是否已连接 WiFi / 网线)');
  } else {
    ips.forEach((it) => {
      console.log('  ' + it.ip + '   [' + it.name + ']');
      console.log('    后端   http://' + it.ip + ':' + PORT);
      console.log('    后台   http://' + it.ip + ':' + PORT + '/admin/');
    });
  }
  console.log('');
  console.log('常用命令：');
  console.log('  node tools/lan-ip.js --set       切到真机模式（用上面第一个 IP）');
  console.log('  node tools/lan-ip.js --local     切回模拟器模式');
  console.log('  node tools/lan-ip.js --firewall  打印放行防火墙的命令');
}

main();
