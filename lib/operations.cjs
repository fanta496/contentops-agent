'use strict';
// 在途操作注册表：所有「可能长时间运行、可能收费」的操作都登记在这里。
//
// 目的（对应复审 P2-03）：reset 不再靠零散锁去猜有没有在跑，而是问这张表；
// 表里有东西就拒绝重置，并在提示里说清楚是什么在跑。
//
// 登记的是 Promise，操作结束时自动注销；同时带 kind / entityId / holdId 便于诊断。

function createOperationRegistry() {
  const operations = new Map();
  let seq = 0;

  function register({ kind, label = '', entityId = '', holdId = '' } = {}) {
    seq += 1;
    const id = `op_${seq}`;
    const startedAt = Date.now();
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    operations.set(id, { id, kind: String(kind || 'unknown'), label, entityId, holdId, startedAt, promise, done: false });

    const finish = () => {
      const record = operations.get(id);
      if (record) record.done = true;
      operations.delete(id);
      settle(id);
    };

    return {
      id,
      promise,
      done: finish,
      // 失败/成功都调用 done()，用 Promise 包装更省事
      track: async (task) => {
        try { return await task(); } finally { finish(); }
      }
    };
  }

  function list() {
    return [...operations.values()].map(({ id, kind, label, entityId, startedAt }) => ({ id, kind, label, entityId, startedAt }));
  }

  function busy() {
    const kinds = new Map();
    for (const operation of operations.values()) kinds.set(operation.kind, (kinds.get(operation.kind) || 0) + 1);
    return [...kinds.entries()].map(([kind, count]) => ({ kind, count }));
  }

  function size() { return operations.size; }

  // 等待全部结束（有上限，不做无限等待）
  async function drain(timeoutMs = 5000) {
    if (!operations.size) return { ok: true, pending: 0 };
    await Promise.race([
      Promise.all([...operations.values()].map((operation) => operation.promise)),
      new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(timeoutMs) || 0)))
    ]);
    return { ok: operations.size === 0, pending: operations.size };
  }

  function reset() { operations.clear(); }

  return { register, list, busy, size, drain, reset };
}

module.exports = { createOperationRegistry };
