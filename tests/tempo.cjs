#!/usr/bin/env node
'use strict';
/**
 * 拟人节奏采样器的纯函数检查：不联网、不开浏览器。
 * 关注三件事：落在范围内、均值不漂、可复现。
 */

const path = require('node:path');
const { jitter, actionDelay, makeRandom, ACTIONS } = require(path.resolve(__dirname, '..', 'lib', 'tempo.cjs'));

const problems = [];
const BASE = 2000;
const random = makeRandom(20261022);

let sum = 0;
let min = Infinity;
let max = -Infinity;
const samples = 4000;
for (let i = 0; i < samples; i += 1) {
  const value = actionDelay('betweenScroll', BASE, { random });
  if (!Number.isInteger(value)) problems.push(`采样不是整数：${value}`);
  if (value < BASE * ACTIONS.betweenScroll.min - 1) problems.push(`低于下限：${value}`);
  if (value > BASE * ACTIONS.betweenScroll.max + 1) problems.push(`高于上限：${value}`);
  sum += value; min = Math.min(min, value); max = Math.max(max, value);
}
const mean = sum / samples;
if (Math.abs(mean - BASE) / BASE > 0.08) problems.push(`均值偏离过大：${Math.round(mean)} vs ${BASE}`);

// 同种子必须复现
const a = [1, 2, 3].map(() => jitter(BASE, {}, makeRandom(7)));
const b = [1, 2, 3].map(() => jitter(BASE, {}, makeRandom(7)));
if (JSON.stringify(a) !== JSON.stringify(b)) problems.push('同种子结果不一致');

// 边界：0 与非法值
if (jitter(0) !== 0) problems.push('base=0 应返回 0');
if (jitter('abc') !== 0) problems.push('base 非数字应返回 0');

// 每个动作都有配置且比例合法
for (const [name, profile] of Object.entries(ACTIONS)) {
  if (!(profile.min > 0 && profile.max > profile.min && profile.sigma > 0)) problems.push(`动作 ${name} 参数不合法`);
}

console.log(JSON.stringify({
  ok: problems.length === 0,
  base: BASE,
  samples,
  mean: Math.round(mean),
  min,
  max,
  actions: Object.keys(ACTIONS).length,
  problems: problems.slice(0, 5)
}, null, 2));
if (problems.length) process.exitCode = 1;
