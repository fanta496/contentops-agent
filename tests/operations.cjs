'use strict';
/**
 * 在途操作注册表的契约（零依赖）。
 * 复审 P2-03 要求：reset 不再靠零散锁猜，而是问一张统一的表。
 */

const path = require('node:path');
const { createOperationRegistry } = require(path.resolve(__dirname, '..', 'lib', 'operations.cjs'));

const problems = [];
function check(condition, message) { if (!condition) problems.push(message); }

async function main() {
  const registry = createOperationRegistry();

  // 1. 空表
  check(registry.size() === 0, '初始应为空');
  check(registry.busy().length === 0, '初始不应有忙碌类型');

  // 2. 登记后可见，结束后自动注销
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const operation = registry.register({ kind: 'image', label: '第1页生图', entityId: 'variant_1' });
  const task = operation.track(async () => { await gate; return 'done'; });
  await Promise.resolve();
  check(registry.size() === 1, '登记后应有 1 个在途操作');
  check(registry.busy()[0]?.kind === 'image', '忙碌类型应为 image');
  check(registry.list()[0]?.entityId === 'variant_1', '应能查到实体 id');

  release();
  await task;
  await new Promise((resolve) => setTimeout(resolve, 10));
  check(registry.size() === 0, '操作结束后应自动注销');

  // 3. 异常也必须注销（不能因为抛错把表堵死）
  const failing = registry.register({ kind: 'text', label: '会失败' });
  await failing.track(async () => { throw new Error('boom'); }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  check(registry.size() === 0, '抛错的操作也必须注销');

  // 4. drain：全部结束则 ok
  const quick = registry.register({ kind: 'vision' });
  quick.track(async () => {});
  const drained = await registry.drain(1000);
  check(drained.ok === true && drained.pending === 0, 'drain 应等待全部结束');

  // 5. drain：超时则回报 pending
  const slow = registry.register({ kind: 'image', label: '慢任务' });
  const slowTask = slow.track(() => new Promise((resolve) => setTimeout(resolve, 300)));
  const timedOut = await registry.drain(50);
  check(timedOut.ok === false && timedOut.pending >= 1, 'drain 超时应回报仍有 pending');
  await slowTask;

  // 6. 多类型计数
  const a = registry.register({ kind: 'image' });
  const b = registry.register({ kind: 'image' });
  const c = registry.register({ kind: 'collection' });
  const busy = registry.busy();
  check(busy.find((item) => item.kind === 'image')?.count === 2, 'image 应计 2 个');
  check(busy.find((item) => item.kind === 'collection')?.count === 1, 'collection 应计 1 个');
  a.done(); b.done(); c.done();
  check(registry.size() === 0, '全部结束后应为空');

  console.log(JSON.stringify({ ok: problems.length === 0, scenarios: 6, problems }, null, 2));
  if (problems.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
