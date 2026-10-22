'use strict';
// 带预算的重试执行器。
//
// 复审第五轮的核心要求：**每一次付费尝试都必须独立开票、独立终结、失败按不确定口径计费，
// 且下一次尝试前重新过预算闸门**。把这条规则写进函数本身，调用方就不可能"忘了传参数"。
//
// 依赖全部注入，便于单测（不碰网络、不碰状态文件）。

async function retryWithBudget({
  maxAttempts = 2,
  openAttempt,          // (attempt) => { ok:true, id } | { ok:false, message }
  closeAttempt,         // (id, outcome) => void   outcome: 'settled' | 'uncertain'
  action,               // (attempt) => Promise<result>
  isTransient = () => false,
  onFailure = () => {}, // (attempt, error, { willRetry }) => void
  sleep = async () => {},
  beforeRetry = () => true // () => boolean  可返回 false 表示预算不足，禁止继续重试
} = {}) {
  let attempt = 0;
  while (true) {
    attempt += 1;
    const hold = openAttempt(attempt);
    if (hold && hold.ok === false) return { ok: false, code: hold.code || 'BUDGET_LIMIT', message: hold.message || '预算不足', attempts: attempt - 1 };
    try {
      const value = await action(attempt);
      if (hold?.id) closeAttempt(hold.id, 'settled');
      return { ok: true, value, holdId: hold?.id || '', attempts: attempt };
    } catch (error) {
      if (hold?.id) closeAttempt(hold.id, 'uncertain');
      const willRetry = attempt <= maxAttempts && Boolean(isTransient(error));
      onFailure(attempt, error, { willRetry });
      if (!willRetry) throw error;
      if (!beforeRetry(attempt)) throw error;
      await sleep(attempt);
    }
  }
}

module.exports = { retryWithBudget };
