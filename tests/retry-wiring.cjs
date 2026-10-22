#!/usr/bin/env node
'use strict';
/**
 * 重试接线检查：`withApiRetry` 的每个调用点都必须带预算上下文（kind/inputChars/maxOutputTokens）。
 *
 * 背景：第五轮复审证明"参数加了但调用点没传"会让失败重试静默免费。
 * 现在 withApiRetry 缺上下文会在运行时抛错，这里再加一道静态兜底。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const text = fs.readFileSync(path.join(ROOT, 'server.cjs'), 'utf8').replace(/\r\n/g, '\n');
const lines = text.split('\n');

const problems = [];
const callSites = [];
lines.forEach((line, index) => {
  if (!/await withApiRetry\(/.test(line)) return;
  const statement = [line, lines[index + 1] || '', lines[index + 2] || ''].join(' ');
  callSites.push({ line: index + 1, hasBudget: /kind:\s*['"]/.test(statement) });
});

if (!callSites.length) problems.push('没有找到任何 withApiRetry 调用点（是否改名了？）');
for (const site of callSites) {
  if (!site.hasBudget) problems.push(`第 ${site.line} 行的 withApiRetry 没有传预算上下文`);
}

// 图文策划的重试也必须走 retryWithBudget（每轮独立开票）
if (!/retryWithBudget\(\{/.test(text)) problems.push('server.cjs 里没有使用 retryWithBudget（重试未与票据绑定）');

console.log(JSON.stringify({ ok: problems.length === 0, callSites: callSites.length, problems }, null, 2));
if (problems.length) process.exitCode = 1;
