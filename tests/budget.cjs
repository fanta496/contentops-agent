#!/usr/bin/env node
'use strict';
/**
 * 计费票据的并发契约（零依赖）。
 *
 * 上一版单测被外部复审指出「只测了台账加减法、没测真实准入、场景假设按启动顺序完成」，
 * 这一版补齐：乱序完成、重复结算、过期后迟到回调、真实准入拒绝、失败保守计费。
 */

const path = require('node:path');
const { createBudgetLedger, createSpendGuard } = require(path.resolve(__dirname, '..', 'lib', 'budget.cjs'));

const problems = [];
function check(condition, message) { if (!condition) problems.push(message); }

// 场景 1：乱序完成 —— B 先完成，只能结算 B 自己那张
{
  const clock = { t: 0 };
  const ledger = createBudgetLedger({ now: () => clock.t });
  const a = ledger.reserve({ kind: 'image', amount: 0.5, purpose: 'A' });
  const b = ledger.reserve({ kind: 'image', amount: 0.5, purpose: 'B' });
  const settledB = ledger.settle(b.id);
  check(settledB.ok && settledB.id === b.id, 'B 的结算应命中 B');
  const left = ledger.snapshot().tickets.map((ticket) => ticket.purpose);
  check(left.length === 1 && left[0] === 'A', `B 完成后台账应只剩 A，实际 ${left.join(',') || '(空)'}`);
  check(ledger.heldOf('image') === 0.5, `B 完成后应仍占住 A 的 0.5，实际 ${ledger.heldOf('image')}`);
  ledger.settle(a.id);
  check(ledger.heldOf('image') === 0, 'A 完成后应释放');
}

// 场景 2：重复结算幂等，不二次扣减、不误伤别人
{
  const ledger = createBudgetLedger({ now: () => 0 });
  const a = ledger.reserve({ kind: 'image', amount: 0.5 });
  const b = ledger.reserve({ kind: 'image', amount: 0.5 });
  ledger.settle(a.id);
  const again = ledger.settle(a.id);
  check(again.ok && again.alreadyHandled === true, '重复结算应返回 alreadyHandled，而不是再删一张');
  check(ledger.heldOf('image') === 0.5, `重复结算不应影响 B，实际 ${ledger.heldOf('image')}`);
  ledger.settle(b.id);
}

// 场景 3：到期 + 迟到回调，不能误删新票据
{
  const clock = { t: 0 };
  const ledger = createBudgetLedger({ now: () => clock.t, defaultTtlMs: 1000 });
  const a = ledger.reserve({ kind: 'image', amount: 0.5, purpose: 'A' });
  clock.t = 2000;
  const expired = ledger.sweepExpired();
  check(expired.length === 1 && expired[0].purpose === 'A', '到期清扫应只回收 A');
  const c = ledger.reserve({ kind: 'image', amount: 0.5, purpose: 'C' });
  const late = ledger.settle(a.id); // A 迟到的回调
  // 迟到回调只能命中「已经被处理过」的票据：幂等返回，绝不触碰 C。
  check(late.alreadyHandled === true || (late.ok === false && late.code === 'UNKNOWN_TICKET'), '迟到结算应被识别为已处理或未知票据');
  check(ledger.heldOf('image') === 0.5, `迟到回调后 C 应仍占住 0.5，实际 ${ledger.heldOf('image')}`);
  ledger.settle(c.id);
}

// 场景 4：真实准入 —— 预算 ¥1、单张 ¥1，第二张必须被拒（走 guard，不是手算）
{
  const clock = { t: 0 };
  const ledger = createBudgetLedger({ now: () => clock.t });
  const spent = { image: 0 };
  const guard = createSpendGuard({ ledger, budgetOf: () => 1, spentOf: (kind) => spent[kind] || 0 });
  const first = guard.reserve({ kind: 'image', amount: 1, purpose: '第1张' });
  check(first.ok, '第一张应被准入');
  const second = guard.reserve({ kind: 'image', amount: 1, purpose: '第2张' });
  check(second.ok === false && second.code === 'IMAGE_BUDGET_LIMIT', '预算耗尽后第二张应被拒绝');
  ledger.settle(first.id);
  spent.image = 1;
  const third = guard.reserve({ kind: 'image', amount: 0.1, purpose: '第3张' });
  check(third.ok === false, '已消费满额时第三张也必须被拒绝');
}

// 场景 5：两张小额也不能同时挤进同一预算
{
  const ledger = createBudgetLedger({ now: () => 0 });
  const guard = createSpendGuard({ ledger, budgetOf: () => 1, spentOf: () => 0 });
  check(guard.reserve({ kind: 'image', amount: 0.6 }).ok, '¥0.6 应能进');
  check(guard.reserve({ kind: 'image', amount: 0.6 }).ok === false, '剩余 ¥0.4 时第二笔 ¥0.6 必须被拒');
}

// 场景 6：失败保守计费（abandon），不算免费
{
  const ledger = createBudgetLedger({ now: () => 0 });
  const hold = ledger.reserve({ kind: 'image', amount: 0.8, purpose: '可能失败' });
  const abandoned = ledger.abandon(hold.id);
  check(abandoned.ok && abandoned.uncertain === true && abandoned.amount === 0.8, 'abandon 应标记不确定并回传金额');
  check(ledger.heldOf('image') === 0, 'abandon 后不再占住额度');
}

// 场景 7：调用没发出去 → cancel 不计费
{
  const ledger = createBudgetLedger({ now: () => 0 });
  const hold = ledger.reserve({ kind: 'text', amount: 0.2 });
  const cancelled = ledger.cancel(hold.id);
  check(cancelled.ok && cancelled.released === 0.2, 'cancel 应释放且不计费');
  check(ledger.heldOf('text') === 0, 'cancel 后额度应释放');
}

// 场景 8：种类隔离
{
  const ledger = createBudgetLedger({ now: () => 0 });
  ledger.reserve({ kind: 'vision', amount: 3 });
  check(ledger.heldOf('image') === 0, '视觉票据不应占图片额度');
}

console.log(JSON.stringify({ ok: problems.length === 0, scenarios: 8, problems }, null, 2));
if (problems.length) process.exitCode = 1;
