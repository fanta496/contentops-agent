#!/usr/bin/env node
'use strict';
/**
 * 模块依赖审计：抓「拆分时漏注入」这一类 bug。
 *
 * 拆分后，lib/ 里的模块拿不到 server.cjs 的闭包，必须通过 env / ctx 注入。
 * 漏一个的后果是 ReferenceError —— 而且往往只在某条少见的代码路径上炸
 * （例如 state 里存在一条未发布的草稿），启动或运行才暴露。
 *
 * 这里用零依赖的方式做近似 no-undef 检查：找出「server.cjs 顶层有、模块里被引用、
 * 但既没注入也没本地声明」的名字。
 * 已知误报（注释/字符串里出现）：server、handleAction、json。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// budgetJournal 只在 lib/state.cjs 里以字符串键出现（公开状态剔除内部字段），不是依赖
const ALLOWED_FALSE_POSITIVES = new Set(['server', 'handleAction', 'json', 'budgetJournal']);

const serverText = fs.readFileSync(path.join(ROOT, 'server.cjs'), 'utf8').replace(/\r\n/g, '\n');
const topLevel = new Set();
for (const m of serverText.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\s*\(/gm)) topLevel.add(m[1]);
for (const m of serverText.matchAll(/^const ([A-Za-z0-9_]+) = /gm)) topLevel.add(m[1]);
for (const m of serverText.matchAll(/^let ([A-Za-z0-9_]+) = /gm)) topLevel.add(m[1]);
for (const m of serverText.matchAll(/^const \{ ([^}]*) \} = require\(/gm)) {
  for (const item of m[1].split(',')) {
    const name = item.split(':').pop().trim();
    if (name) topLevel.add(name);
  }
}

const JS_GLOBALS = new Set(['process', 'require', 'module', 'exports', 'console', 'Buffer', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Object', 'Array', 'Promise', 'Error', 'Set', 'Map', 'WeakSet', 'WeakMap', 'Symbol', 'RegExp', 'Intl', 'URL', 'URLSearchParams', 'structuredClone', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch', 'AbortSignal', 'location', 'window', 'document', 'globalThis', 'undefined', 'NaN', 'Infinity', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'TextEncoder', 'TextDecoder', '__dirname', '__filename', 'arguments', 'eval', 'Function']);

function declaredNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/(?:^|\s)(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const item of m[1].split(',')) {
      const name = item.split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of text.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    names.add(m[1]);
    for (const arg of m[2].split(',')) {
      const name = arg.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of text.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const arg of m[1].split(',')) {
      const name = arg.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

const targets = [{ file: 'lib/state.cjs', injected: /const \{([\s\S]*?)\} = env;/ }];
for (const name of ['profiles', 'enterprise', 'content', 'variants', 'workflow', 'system']) {
  targets.push({ file: `lib/actions/${name}.cjs`, injected: /const \{([\s\S]*?)\} = ctx;/ });
}
// util / media / tempo / platforms 是叶子模块，自己 require 需要的东西，没有注入契约，
// 不参与这个检查（它们的引用错误会直接在 node --check 或单测里暴露）。

const problems = [];
const checked = [];
for (const target of targets) {
  const file = path.join(ROOT, target.file);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const match = text.match(target.injected);
  const injected = new Set(match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : []);
  const locals = declaredNames(text);
  const required = new Set();
  for (const r of text.matchAll(/const \{ ([^}]*) \} = require\(/g)) {
    for (const item of r[1].split(',')) {
      const name = item.split(':').pop().trim();
      if (name) required.add(name);
    }
  }
  const missing = [];
  for (const word of new Set(text.match(/\b[A-Za-z_$][\w$]*\b/g) || [])) {
    if (!topLevel.has(word)) continue;
    if (injected.has(word) || locals.has(word) || required.has(word) || JS_GLOBALS.has(word) || ALLOWED_FALSE_POSITIVES.has(word)) continue;
    missing.push(word);
  }
  checked.push(target.file);
  if (missing.length) problems.push({ file: target.file, missing: missing.sort() });
}

console.log(JSON.stringify({ ok: problems.length === 0, files: checked.length, problems }, null, 2));
if (problems.length) process.exitCode = 1;
