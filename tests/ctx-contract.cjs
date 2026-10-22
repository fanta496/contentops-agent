#!/usr/bin/env node
'use strict';
/**
 * ctx 契约检查（零依赖）：
 * A. lib/actions/*.cjs 里从 ctx 解构出来的每个名字，server.cjs 的 actionContext 里必须真的有这个键，
 *    否则运行时就是 undefined —— 典型的「漏注入」。
 * B. 引用了 state 的处理函数，必须自己写 `const state = ctx.state;`，
 *    否则拿到的是 undefined（模块里没有模块级 state）。
 *
 * 这两条正是外部审查发现的两个真实缺陷的类型，所以固化成测试。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const problems = [];

const serverText = fs.readFileSync(path.join(ROOT, 'server.cjs'), 'utf8').replace(/\r\n/g, '\n');

// --- server.cjs 里 actionContext 的键 ---
const ctxStart = serverText.indexOf('actionContext = {');
if (ctxStart < 0) throw new Error('找不到 actionContext 定义');
const ctxEnd = serverText.indexOf('actionRoutes = buildActionRoutes(actionContext);', ctxStart);
if (ctxEnd < 0) throw new Error('找不到 actionContext 结尾');
const ctxBlock = serverText.slice(ctxStart, ctxEnd);
const ctxKeys = new Set();
for (const line of ctxBlock.split('\n')) {
  const trimmed = line.trim().replace(/,$/, '');
  let match = trimmed.match(/^([A-Za-z_$][\w$]*)$/);          // 简写：NAME,
  if (match) ctxKeys.add(match[1]);
  match = trimmed.match(/^([A-Za-z_$][\w$]*)\s*:/);            // NAME: ...
  if (match) ctxKeys.add(match[1]);
  match = trimmed.match(/^get\s+([A-Za-z_$][\w$]*)\s*\(/);    // get state() { ... }
  if (match) ctxKeys.add(match[1]);
}
if (!ctxKeys.has('state')) problems.push('actionContext 里没有 state');

// --- 检查每个 actions 模块 ---
const actionFiles = fs.readdirSync(path.join(ROOT, 'lib', 'actions')).filter((name) => name.endsWith('.cjs'));
for (const name of actionFiles) {
  const rel = `lib/actions/${name}`;
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

  const destructure = text.match(/^ {2}const \{([^}]*)\} = ctx;$/m);
  if (destructure) {
    for (const raw of destructure[1].split(',')) {
      const key = raw.trim().split(':')[0].trim();
      if (!key) continue;
      if (!ctxKeys.has(key)) problems.push(`${rel}: 从 ctx 解构了 ${key}，但 actionContext 里没有这个键`);
    }
  }

  // B. 每个 handler 单独看
  const handlerStarts = [...text.matchAll(/^ {2}'(\/api\/[^']+)': async \(body\) => \{$/gm)];
  for (let i = 0; i < handlerStarts.length; i += 1) {
    const start = handlerStarts[i].index;
    const end = i + 1 < handlerStarts.length ? handlerStarts[i + 1].index : text.length;
    const body = text.slice(start, end);
    const route = handlerStarts[i][1];
    if (/\bstate\./.test(body) && !/const state = ctx\.state;/.test(body)) {
      problems.push(`${rel} ${route}: 用了 state 但没有 const state = ctx.state;`);
    }
  }
}

console.log(JSON.stringify({ ok: problems.length === 0, files: actionFiles.length, ctxKeys: ctxKeys.size, problems }, null, 2));
if (problems.length) process.exitCode = 1;
