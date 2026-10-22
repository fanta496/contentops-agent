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

  const destructure = text.match(/^\s*const \{([^}]*)\} = ctx;$/m);
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

// --- C. 被调用的标识符必须在 ctx 里（或本地/全局） ---
// 静态检查只认 server.cjs 顶层名字，像 trackOperation 这种对象内联属性会漏；这里按"调用点"扫。
const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof', 'new', 'function', 'await', 'async', 'do', 'else', 'delete', 'void', 'in', 'of', 'yield', 'super', 'this']);
const JS_GLOBALS = new Set(['process', 'require', 'module', 'exports', 'console', 'Buffer', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Object', 'Array', 'Promise', 'Error', 'Set', 'Map', 'WeakSet', 'WeakMap', 'Symbol', 'RegExp', 'Intl', 'URL', 'URLSearchParams', 'structuredClone', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch', 'AbortSignal', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'Array', 'Object', 'String', 'Number', 'Boolean']);

function declaredNames(text) {
  const names = new Set();
  const patterns = [
    /(?:^|[^.\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /(?:const|let|var)\s+([^;\n]+?)=/g,
    /function\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g,
    /\(([^()]*)\)\s*(?:=>|\{)/g,
    /([A-Za-z_$][\w$]*)\s*=>/g,
    /for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /catch\s*\(\s*([A-Za-z_$][\w$]*)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      for (const group of match.slice(1)) {
        if (!group) continue;
        for (const piece of String(group).split(',')) {
          const name = piece.split('=')[0].split(':').pop().trim().replace(/^\.\.\./, '');
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
      }
    }
  }
  return names;
}

for (const name of actionFiles) {
  const rel = `lib/actions/${name}`;
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const locals = declaredNames(text);
  const requiredNames = new Set();
  for (const r of text.matchAll(/const \{ ([^}]*) \} = require\(/g)) {
    for (const item of r[1].split(',')) {
      const key = item.split(':').pop().trim();
      if (key) requiredNames.add(key);
    }
  }
  const reported = new Set();
  for (const match of text.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const called = match[1];
    if (JS_KEYWORDS.has(called) || JS_GLOBALS.has(called)) continue;
    if (locals.has(called) || requiredNames.has(called)) continue;
    if (!ctxKeys.has(called)) reported.add(called);
  }
  if (reported.size) problems.push(`${rel}: 调用了未注入的 ${[...reported].sort().join(', ')}`);
}

console.log(JSON.stringify({ ok: problems.length === 0, files: actionFiles.length, ctxKeys: ctxKeys.size, problems }, null, 2));
if (problems.length) process.exitCode = 1;
