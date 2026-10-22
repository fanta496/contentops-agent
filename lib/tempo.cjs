'use strict';
// 拟人节奏采样。
//
// 固定间隔（每轮 sleep(2500)）是自动化行为里最好识别的特征之一：真实用户的操作间隔
// 是长尾分布，不是常量。这里把「等多久」从常量换成对数正态采样，同时保持参数语义：
// base 仍然是原来配置里的毫秒数，只在它周围抖动，不会把节奏整体放大或缩小。
//
// 采样用 Box-Muller 取正态样本，再乘 exp(-sigma²/2) 让期望值落在 base 上，
// 否则取指数会把平均值抬高，长时间跑下来等于变相拖慢/拉长节奏。

const ACTIONS = {
  afterNavigate: { sigma: 0.40, min: 0.5, max: 2.2 },
  betweenScroll: { sigma: 0.35, min: 0.6, max: 1.8 },
  beforeClick: { sigma: 0.45, min: 0.4, max: 2.5 },
  afterClick: { sigma: 0.35, min: 0.5, max: 2.0 },
  reading: { sigma: 0.40, min: 0.5, max: 2.0 },
  beforeSubmit: { sigma: 0.30, min: 0.6, max: 1.8 },
  keystroke: { sigma: 0.50, min: 0.4, max: 2.2 }
};

// 可复现随机源（测试用）；不传就用 Math.random。
function makeRandom(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jitter(baseMs, options = {}, random = Math.random) {
  const base = Math.max(0, Number(baseMs) || 0);
  if (!base) return 0;
  const sigma = Number.isFinite(options.sigma) ? options.sigma : 0.35;
  const min = Number.isFinite(options.min) ? options.min : 0.5;
  const max = Number.isFinite(options.max) ? options.max : 2;
  const u1 = Math.max(Number(random()) || 0, 1e-9);
  const u2 = Number(random()) || 0;
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const value = base * Math.exp(sigma * normal - (sigma * sigma) / 2);
  return Math.round(Math.min(base * max, Math.max(base * min, value)));
}

function actionDelay(action, baseMs, options = {}) {
  const profile = ACTIONS[action] || ACTIONS.betweenScroll;
  return jitter(baseMs, { ...profile, ...options }, options.random || Math.random);
}

module.exports = { ACTIONS, jitter, actionDelay, makeRandom };
