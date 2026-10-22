#!/usr/bin/env node
'use strict';
/**
 * 调用点检查：actions 模块里「被调用但没定义」的标识符必须能在 ctx 里找到。
 *
 * 为什么单独一个文件：上一版把它塞进 ctx-contract 后因正则顺序问题失效过，
 * 独立出来更好验证 —— 临时删掉 actionContext 里的 trackOperation，这个测试必须报红。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const serverText = fs.readFileSync(path.join(ROOT, 'server.cjs'), 'utf8').replace(/\r\n/g, '\n');

const ctxStart = serverText.indexOf('actionContext = {');
const ctxEnd = serverText.indexOf('actionRoutes = buildActionRoutes', ctxStart);
if (ctxStart < 0 || ctxEnd < 0) throw new Error('找不到 actionContext');
const ctxKeys = new Set();
for (const line of serverText.slice(ctxStart, ctxEnd).split('\n')) {
  const trimmed = line.trim().replace(/,$/, '');
  for (const pattern of [/^([A-Za-z_$][\w$]*)$/, /^([A-Za-z_$][\w$]*)\s*:/, /^get\s+([A-Za-z_$][\w$]*)\s*\(/]) {
    const match = trimmed.match(pattern);
    if (match) ctxKeys.add(match[1]);
  }
}

const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof', 'new', 'function', 'await', 'async', 'do', 'else', 'delete', 'void', 'in', 'of', 'yield', 'super', 'this', 'case', 'throw', 'try', 'finally', 'break', 'continue']);
const GLOBALS = new Set(['process', 'require', 'module', 'exports', 'console', 'Buffer', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Object', 'Array', 'Promise', 'Error', 'Set', 'Map', 'WeakSet', 'WeakMap', 'Symbol', 'RegExp', 'Intl', 'URL', 'URLSearchParams', 'structuredClone', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch', 'AbortSignal', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'TextEncoder', 'TextDecoder', 'queueMicrotask']);

function locallyDeclared(text) {
  const names = new Set();
  const patterns = [
    /(?:^|[^.\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /(?:const|let|var)\s*\{([^}]*)\}/g,
    /function\s+([A-Za-z_$][\w$]*)/g,
    /\(([^()]*)\)\s*=>/g,
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

const problems = [];
const files = fs.readdirSync(path.join(ROOT, 'lib', 'actions')).filter((name) => name.endsWith('.cjs'));

for (const name of files) {
  const rel = `lib/actions/${name}`;
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  // 先把 ctx 解构出来的名字从「本地声明」里剔除：它们是注入的，必须去 ctxKeys 核对。
  const ctxDestructure = text.match(/^\s*const \{([^}]*)\} = ctx;$/m);
  const locals = locallyDeclared(ctxDestructure ? text.replace(ctxDestructure[0], '') : text);
  const missing = new Set();
  for (const match of text.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const called = match[1];
    if (JS_KEYWORDS.has(called) || GLOBALS.has(called)) continue;
    if (locals.has(called)) continue;
    if (!ctxKeys.has(called)) missing.add(called);
  }
  if (missing.size) problems.push({ file: rel, missing: [...missing].sort() });
}

console.log(JSON.stringify({ ok: problems.length === 0, files: files.length, ctxKeys: ctxKeys.size, problems }, null, 2));
if (problems.length) process.exitCode = 1;
