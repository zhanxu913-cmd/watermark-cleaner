/**
 * 点击链路追踪（临时排查用）
 *
 * 真机上没有 console，光靠 console.log 无法判断「点击到底有没有到达 JS」。
 * 这里把每一步同时写进本机存储，可在「关于 → 点击追踪」里逐条查看。
 *
 * 关键点：按钮上同时挂 bindtouchstart 与 bindtap
 *   - touchstart 有、tap 没有 → 手指按到了，但事件被上层元素 / 原生组件拦掉
 *   - touchstart 也没有       → 元素被原生组件（<ad>、video）或浮层盖住，事件根本没进 WebView
 *   - 两个都有、后续步骤断  → 问题在业务逻辑，按断点那条继续查
 *
 * 上线前可把 TRACE_ON 改为 false 关闭写存储（console 仍会打印）。
 */

'use strict';

const TRACE_KEY = 'wc_trace_v1';
const TRACE_MAX = 80;

// 总开关：生产环境想彻底关掉就改成 false
const TRACE_ON = true;

function pad(n, w) {
  const s = String(n);
  return s.length >= w ? s : '0'.repeat(w - s.length) + s;
}

function stamp() {
  const d = new Date();
  return (
    pad(d.getHours(), 2) +
    ':' +
    pad(d.getMinutes(), 2) +
    ':' +
    pad(d.getSeconds(), 2) +
    '.' +
    pad(d.getMilliseconds(), 3)
  );
}

/**
 * 记一条追踪
 * @param {string} tag  分组：tap / touch / save / ad …
 * @param {string} msg  内容
 * @returns {string} 格式化后的整行，页面可直接 setData 显示
 */
function trace(tag, msg) {
  const line = stamp() + ' [' + tag + '] ' + msg;
  try {
    console.log('[TRACE] ' + line);
  } catch (e) {
    /* 忽略 */
  }
  if (TRACE_ON) {
    try {
      const arr = wx.getStorageSync(TRACE_KEY) || [];
      arr.push(line);
      while (arr.length > TRACE_MAX) arr.shift();
      wx.setStorageSync(TRACE_KEY, arr);
    } catch (e) {
      /* 忽略 */
    }
  }
  return line;
}

/** 读取最近的追踪（默认全部，最多 TRACE_MAX 条） */
function lines(n) {
  let arr = [];
  try {
    arr = wx.getStorageSync(TRACE_KEY) || [];
  } catch (e) {
    arr = [];
  }
  return n > 0 ? arr.slice(-n) : arr.slice();
}

function clear() {
  try {
    wx.removeStorageSync(TRACE_KEY);
  } catch (e) {
    /* 忽略 */
  }
}

module.exports = { trace, lines, clear };
