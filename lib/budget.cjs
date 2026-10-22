'use strict';
// 计费额度台账（纯逻辑，不碰网络与状态文件，方便单测）。
//
// 设计要点（对应外部复审的三条批评）：
// 1. 每次调用开一张票据（id + 金额 + 种类），不是按种类汇总一个数字 —— 否则并发时互相看不出来。
// 2. 退票按「先进先出」结清同一种类的票据，绝不按金额随意扣减 —— 避免旧调用的 release 扣掉新调用的额度。
// 3. 票据过期不静默释放：过期视为「这笔钱可能已经花了」，由调用方按保守方式记账（sweepExpired 回传金额）。
//    这样即使某条路径忘了结清，也不会让预算凭空变大。
//
// 用法：
//   const ledger = createBudgetLedger();
//   const hold = ledger.reserve({ kind:'image', amount:1.2, purpose:'第1页生图' });
//   if (!hold.ok) { ...拒绝... }
//   ...调用中...
//   ledger.retire('image');            // 调用完成（成功或失败）后结清一张
//   const charged = ledger.sweepExpired();  // 定时调用：返回 [{kind, amount, purpose}]，调用方保守入账

function createBudgetLedger({ now = () => Date.now(), defaultTtlMs = 5 * 60 * 1000 } = {}) {
  let seq = 0;
  let tickets = [];

  function heldOf(kind) {
    return tickets
      .filter((ticket) => ticket.kind === kind)
      .reduce((sum, ticket) => sum + ticket.amount, 0);
  }

  function reserve({ kind, amount, purpose = '', ttlMs = defaultTtlMs }) {
    const value = Math.max(0, Number(amount) || 0);
    seq += 1;
    const ticket = { id: `hold_${seq}`, kind, amount: value, purpose, expiresAt: now() + Math.max(1000, Number(ttlMs) || defaultTtlMs) };
    tickets.push(ticket);
    return { ok: true, id: ticket.id, amount: value };
  }

  // 先进先出结清一张同类票据；返回被结清的金额（0 表示没有未结票据）
  function retire(kind) {
    const index = tickets.findIndex((ticket) => ticket.kind === kind);
    if (index < 0) return 0;
    const [ticket] = tickets.splice(index, 1);
    return ticket.amount;
  }

  // 过期的票据不算「已释放」，而是交给调用方按保守方式记账
  function sweepExpired() {
    const expired = [];
    const alive = [];
    for (const ticket of tickets) {
      if (ticket.expiresAt <= now()) expired.push({ kind: ticket.kind, amount: ticket.amount, purpose: ticket.purpose });
      else alive.push(ticket);
    }
    tickets = alive;
    return expired;
  }

  function snapshot() {
    return {
      held: {
        text: heldOf('text'),
        vision: heldOf('vision'),
        image: heldOf('image')
      },
      tickets: tickets.map((ticket) => ({ ...ticket }))
    };
  }

  function reset() { tickets = []; }

  return { reserve, retire, sweepExpired, snapshot, reset, heldOf };
}

module.exports = { createBudgetLedger };
