#!/usr/bin/env node
'use strict';
/**
 * 带预算重试的契约（零依赖）。
 * 对应第五轮复审的 P1-01 / P1-02：每次尝试一张票、失败保守计费、重试前重新过闸门。
 */

const path = require('node:path');
const { retryWithBudget } = require(path.resolve(__dirname, '..', 'lib', 'retry.cjs'));

const problems = [];
function check(condition, message) { if (!condition) problems.push(message); }

async function scenario(label, fn) {
  try { await fn(); } catch (error) { problems.push(`${label} 抛错：${error.message}`); }
}

async function main() {
  // 场景 1：503 → 200，两次尝试、两张票、一次失败保守计费
  await scenario('503→200', async () => {
    const opened = [];
    let failures = 0;
    let calls = 0;
    const result = await retryWithBudget({
      maxAttempts: 2,
      openAttempt: (attempt) => { opened.push(attempt); return { ok: true, id: `h${attempt}` }; },
      closeAttempt: (id, outcome) => { if (outcome === 'uncertain') failures += 1; },
      action: async () => { calls += 1; if (calls === 1) { const error = new Error('503'); error.status = 503; throw error; } return 'ok'; },
      isTransient: (error) => error.status === 503,
      sleep: async () => {}
    });
    check(result.ok === true && result.value === 'ok', '503→200 应最终成功');
    check(opened.length === 2, `应开两张票，实际 ${opened.length}`);
    check(calls === 2, `应发出两次请求，实际 ${calls}`);
    check(failures === 1, `失败尝试应保守计费一次，实际 ${failures}`);
  });

  // 场景 2：503 → 503 → 200，三次尝试三张票
  await scenario('503→503→200', async () => {
    let calls = 0;
    let opened = 0;
    let uncertain = 0;
    const result = await retryWithBudget({
      maxAttempts: 2,
      openAttempt: () => { opened += 1; return { ok: true, id: `h${opened}` }; },
      closeAttempt: (id, outcome) => { if (outcome === 'uncertain') uncertain += 1; },
      action: async () => { calls += 1; if (calls < 3) { const error = new Error('503'); error.status = 503; throw error; } return 'ok'; },
      isTransient: (error) => error.status === 503,
      sleep: async () => {}
    });
    check(result.ok === true, '三次尝试后应成功');
    check(calls === 3, `应发出三次请求，实际 ${calls}`);
    check(opened === 3, `应开三张票，实际 ${opened}`);
    check(uncertain === 2, `前两次失败各保守计费，实际 ${uncertain}`);
  });

  // 场景 3：预算刚好耗尽 → 第二次尝试不得发出请求
  await scenario('预算耗尽阻止重试', async () => {
    let calls = 0;
    let opened = 0;
    let threw = false;
    try {
      await retryWithBudget({
        maxAttempts: 3,
        openAttempt: () => { opened += 1; return { ok: true, id: `h${opened}` }; },
        closeAttempt: () => {},
        action: async () => { calls += 1; const error = new Error('503'); error.status = 503; throw error; },
        isTransient: () => true,
        beforeRetry: () => false, // 预算不足，禁止继续
        sleep: async () => {}
      });
    } catch { threw = true; }
    check(threw, '预算不足时应直接抛错终止');
    check(calls === 1, `预算不足时不应发出第二次请求，实际 ${calls}`);
  });

  // 场景 4：闸门拒绝时根本不发请求
  await scenario('闸门拒绝', async () => {
    let calls = 0;
    const result = await retryWithBudget({
      openAttempt: () => ({ ok: false, code: 'IMAGE_BUDGET_LIMIT', message: '预算不足' }),
      closeAttempt: () => {},
      action: async () => { calls += 1; return 'ok'; },
      isTransient: () => false
    });
    check(result.ok === false && result.code === 'IMAGE_BUDGET_LIMIT', '闸门拒绝应返回预算错误');
    check(calls === 0, `闸门拒绝时不应发出请求，实际 ${calls}`);
  });

  // 场景 5：成功时执行器不得预先结票（否则业务方再记账会命中 alreadyHandled，费用被吞）
  await scenario('一次成功不预先结票', async () => {
    let closes = 0;
    const outcome = await retryWithBudget({
      openAttempt: () => ({ ok: true, id: 'h1' }),
      closeAttempt: () => { closes += 1; },
      action: async () => 'ok'
    });
    check(outcome.ok === true && outcome.holdId === 'h1', '成功应返回持有票据的 id');
    check(closes === 0, `成功时不应由执行器结票，实际结票 ${closes} 次`);
  });

  // 场景 6：失败仍按不确定口径结票（可能已扣费）
  await scenario('失败按不确定结票', async () => {
    let uncertain = 0;
    try {
      await retryWithBudget({
        maxAttempts: 0,
        openAttempt: () => ({ ok: true, id: 'h2' }),
        closeAttempt: (id, kind) => { if (kind === 'uncertain') uncertain += 1; },
        action: async () => { throw new Error('boom'); },
        isTransient: () => false
      });
    } catch {}
    check(uncertain === 1, '失败时应按 uncertain 结票一次');
  });

  console.log(JSON.stringify({ ok: problems.length === 0, scenarios: 6, problems }, null, 2));
  if (problems.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
