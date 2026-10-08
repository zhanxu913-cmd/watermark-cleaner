/**
 * 极简并发队列：限制同时在跑的任务数，避免容器 CPU 被多路转码打满
 */

'use strict';

function createQueue(limit) {
  const max = Math.max(1, Number(limit) || 1);
  const pending = [];
  let running = 0;

  function pump() {
    while (running < max && pending.length) {
      const item = pending.shift();
      running++;
      Promise.resolve()
        .then(item.fn)
        .then(item.resolve, item.reject)
        .then(() => {
          running--;
          pump();
        });
    }
  }

  return {
    push(fn) {
      return new Promise((resolve, reject) => {
        pending.push({ fn, resolve, reject });
        pump();
      });
    },
    stats() {
      return { limit: max, running, pending: pending.length };
    }
  };
}

module.exports = { createQueue };
