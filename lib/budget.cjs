'use strict';
// 计费票据台账。
//
// 一条铁律（外部复审给的最有价值的一句）：**一次真实收费调用 = 一张唯一票据 + 一次幂等结算**。
//
// 语义：
// - reserve() 生成票据（id + 种类 + 金额 + 目的 + 过期时间），返回 id；
// - settle(id, actualCost) 只结算这一张，幂等：重复调用不会二次扣减，也不会影响别的票；
// - abandon(id) 用于「调用失败、供应商可能已计费」：票据转 uncertain 并保守计入消费；
// - cancel(id) 用于「调用没有发出去」：不计费；
// - sweepExpired() 把超时仍持有的票转 uncertain（保守计费），返回需要入账的明细。
// - 没有按种类批量结算的接口：上一版 retire(kind) 会误删别人的票，这是被复审抓到的真 bug。

function createBudgetLedger({ now = () => Date.now(), defaultTtlMs = 5 * 60 * 1000 } = {}) {
  const tickets = new Map();
  const handled = new Set(); // 已结算/已放弃/已取消的票据 id，用于幂等返回
  let seq = 0;

  function makeTicket(kind, amount, purpose, ttlMs) {
    seq += 1;
    return {
      id: `hold_${seq}`,
      kind,
      amount: Math.max(0, Number(amount) || 0),
      purpose: String(purpose || ''),
      state: 'held',
      createdAt: now(),
      expiresAt: now() + Math.max(1000, Number(ttlMs) || defaultTtlMs)
    };
  }

  function reserve({ kind, amount, purpose = '', ttlMs = defaultTtlMs }) {
    const ticket = makeTicket(kind, amount, purpose, ttlMs);
    tickets.set(ticket.id, ticket);
    return { ok: true, id: ticket.id, amount: ticket.amount, expiresAt: ticket.expiresAt };
  }

  // 只结算这一张；幂等：已结算/已取消的票返回 alreadyHandled
  function settle(id, { actualCost } = {}) {
    const key = String(id || '');
    const ticket = tickets.get(key);
    if (!ticket) {
      if (handled.has(key)) return { ok: true, alreadyHandled: true, id: key, state: 'settled' };
      return { ok: false, code: 'UNKNOWN_TICKET', id: key };
    }
    ticket.state = 'settled';
    ticket.settledAt = now();
    ticket.actualCost = Number.isFinite(Number(actualCost)) ? Number(actualCost) : ticket.amount;
    tickets.delete(ticket.id);
    handled.add(ticket.id);
    return { ok: true, alreadyHandled: false, id: ticket.id, reserved: ticket.amount, actualCost: ticket.actualCost };
  }

  // 失败但可能已计费：转 uncertain，金额计入消费
  function abandon(id) {
    const key = String(id || '');
    const ticket = tickets.get(key);
    if (!ticket) {
      if (handled.has(key)) return { ok: true, alreadyHandled: true, id: key, state: 'handled' };
      return { ok: false, code: 'UNKNOWN_TICKET', id: key };
    }
    tickets.delete(ticket.id);
    handled.add(ticket.id);
    return { ok: true, alreadyHandled: false, id: ticket.id, kind: ticket.kind, amount: ticket.amount, purpose: ticket.purpose, uncertain: true };
  }

  // 调用根本没发出去：不计费
  function cancel(id) {
    const key = String(id || '');
    const ticket = tickets.get(key);
    if (!ticket) {
      if (handled.has(key)) return { ok: true, alreadyHandled: true, id: key };
      return { ok: false, code: 'UNKNOWN_TICKET', id: key };
    }
    tickets.delete(ticket.id);
    handled.add(ticket.id);
    return { ok: true, id: ticket.id, released: ticket.amount };
  }

  function heldOf(kind) {
    let sum = 0;
    for (const ticket of tickets.values()) if (ticket.kind === kind) sum += ticket.amount;
    return Number(sum.toFixed(6));
  }

  // 过期票：转不确定并交由调用方保守入账（返回 {kind, amount, purpose, id}）
  function sweepExpired() {
    const expired = [];
    for (const [id, ticket] of [...tickets.entries()]) {
      if (ticket.expiresAt > now()) continue;
      tickets.delete(id);
      handled.add(id);
      expired.push({ id, kind: ticket.kind, amount: ticket.amount, purpose: ticket.purpose, uncertain: true });
    }
    return expired;
  }

  function snapshot() {
    return {
      held: { text: heldOf('text'), vision: heldOf('vision'), image: heldOf('image') },
      tickets: [...tickets.values()].map((ticket) => ({ ...ticket }))
    };
  }

  function reset() { tickets.clear(); handled.clear(); }

  return { reserve, settle, abandon, cancel, heldOf, sweepExpired, snapshot, reset };
}

// 准入判断：把「剩余预算」和「本次预计金额」的判定单独抽出来，便于对真实准入做测试，
// 而不是只测台账的加减法（上一版单测被复审指出没测到准入，这里补上）。
function createSpendGuard({ ledger, budgetOf, spentOf }) {
  function remainingOf(kind) {
    const base = Number(budgetOf(kind)) - Number(spentOf(kind));
    return Number(Math.max(0, base - ledger.heldOf(kind)).toFixed(6));
  }
  function reserve({ kind, amount, purpose, ttlMs }) {
    const estimate = Number(Math.max(0, Number(amount) || 0).toFixed(6));
    const remaining = remainingOf(kind);
    if (estimate > remaining) {
      return { ok: false, code: `${String(kind).toUpperCase()}_BUDGET_LIMIT`, message: `${purpose || '本次调用'}预计最高费用 ¥${estimate.toFixed(4)}，超过剩余预算 ¥${remaining.toFixed(4)}`, estimate, remaining };
    }
    const hold = ledger.reserve({ kind, amount: estimate, purpose, ttlMs });
    return { ok: true, id: hold.id, estimate, remaining };
  }
  return { reserve, remainingOf };
}

module.exports = { createBudgetLedger, createSpendGuard };
