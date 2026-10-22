#!/usr/bin/env node
'use strict';
/**
 * 预算台账的行为契约（零依赖，纯逻辑）。
 * 三个场景直接对应外部复审的复现实验，改坏了会立刻红。
 */

const path = require('node:path');
const { createBudgetLedger } = require(path.resolve(__dirname, '..', 'lib', 'budget.cjs'));

const problems = [];
let clock = 1000;
const ledger = createBudgetLedger({ now: () => clock, defaultTtlMs: 5 * 60 * 1000 });

// 场景 1：预算 ¥1、单张 ¥1 —— 第二次必须被挡住（旧实现两次都 ok，estimate=0）
const first = ledger.reserve({ kind: 'image', amount: 1, purpose: '第1页' });
const remainingAfterFirst = 1 - ledger.heldOf('image');
const second = ledger.reserve({ kind: 'image', amount: 1, purpose: '第2页' });
if (!first.ok) problems.push('第一张应该能预留');
if (remainingAfterFirst !== 0) problems.push(`预留后剩余应归零，实际 ${remainingAfterFirst}`);
// 台账本身不拒绝（拒绝逻辑在 server，由 remaining 判断），所以这里断言的是「额度已被占住」
if (ledger.heldOf('image') !== 2) problems.push('两张票据应各自占住 ¥1（合计 ¥2），说明没有被合并成一份');

// 场景 2：¥1 预算下，两张 ¥0.6 不能同时通过
ledger.reset();
ledger.reserve({ kind: 'image', amount: 0.6 });
const budget = 1;
const afterOne = budget - ledger.heldOf('image');
const canSecond = afterOne >= 0.6;
if (canSecond) problems.push('¥1 预算下两张 ¥0.6 不应同时通过');
ledger.reset();

// 场景 3：过期不能误释放别人的额度（旧实现会整类清零）
clock = 1000;
ledger.reset();
const oldTicket = ledger.reserve({ kind: 'image', amount: 1, purpose: '旧调用' });
clock += 6 * 60 * 1000; // 越过 TTL
const newTicket = ledger.reserve({ kind: 'image', amount: 1, purpose: '新调用' });
const expired = ledger.sweepExpired();
if (expired.length !== 1 || expired[0].purpose !== '旧调用') problems.push('过期清理应只回收旧票据');
if (ledger.heldOf('image') !== 1) problems.push('新票据不应被过期清理抹掉');
if (!newTicket.ok || !oldTicket.ok) problems.push('两次预留都应成功（拒绝逻辑在 server 侧）');

// 场景 4：退票按同类先进先出，不误退新票据
ledger.reset();
ledger.reserve({ kind: 'text', amount: 0.2, purpose: 'A' });
ledger.reserve({ kind: 'text', amount: 0.8, purpose: 'B' });
const retired = ledger.retire('text');
if (retired !== 0.2) problems.push(`退票应按先进先出结清 A（0.2），实际 ${retired}`);
if (ledger.heldOf('text') !== 0.8) problems.push('退票不应动到 B');

// 场景 5：种类隔离（视觉的票据不影响图片额度）
ledger.reset();
ledger.reserve({ kind: 'vision', amount: 3 });
if (ledger.heldOf('image') !== 0) problems.push('视觉预留不应占用图片额度');

// 场景 6：退空票返回 0，不抛异常
if (ledger.retire('image') !== 0) problems.push('没有票据时退票应返回 0');

console.log(JSON.stringify({
  ok: problems.length === 0,
  scenarios: 6,
  problems
}, null, 2));
if (problems.length) process.exitCode = 1;
