#!/usr/bin/env node
'use strict';
/**
 * 零依赖的「容器引用」检查：抓 `xxx.push(...)` / `xxx.size` 这类集合用法，
 * 但 xxx 在文件里根本没声明的情况 —— 就是 `warnings.push` 那个 bug 的类型。
 *
 * 为什么只查容器用法：这类变量通常是模块级集合（warnings / locks / ids），
 * 拆分代码时最容易「用着用着忘了传」，而普通局部变量的漏声明通常会在语法或首次运行时暴露。
 *
 * 已知局限：这是近似检查，不是完整的作用域分析。宁可少报，不误报。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const GLOBALS = new Set([
  'process', 'require', 'module', 'exports', 'console', 'Buffer', 'JSON', 'Math', 'Date', 'Number', 'String',
  'Boolean', 'Object', 'Array', 'Promise', 'Error', 'Set', 'Map', 'WeakSet', 'WeakMap', 'Symbol', 'RegExp',
  'Intl', 'URL', 'URLSearchParams', 'structuredClone', 'setTimeout', 'setInterval', 'clearTimeout',
  'clearInterval', 'fetch', 'AbortSignal', 'globalThis', 'global', 'window', 'document', 'location',
  'localStorage', 'navigator', 'performance', 'TextEncoder', 'TextDecoder', 'undefined', 'NaN', 'Infinity',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'arguments',
  'eval', 'Function', 'Reflect', 'Proxy', 'BigInt', 'Atomics', 'DataView', 'ArrayBuffer', 'Uint8Array',
  'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'crypto', 'atob', 'btoa', 'self', 'frameElement', 'parent', 'top', 'customElements', 'MutationObserver',
  'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'alert', 'confirm', 'prompt',
  '__dirname', '__filename', 'this', 'super', 'arguments', 'id', 'name', 'value', 'key', 'item', 'index', 'data', 'result', 'error'
]);

const CONTAINER_METHODS = 'push|pop|shift|unshift|splice|slice|concat|has|get|set|add|delete|clear|size|length|entries|values|keys|find|filter|map|forEach|some|every|includes|join|sort';

function declaredNames(text) {
  const names = new Set();
  const patterns = [
    /(?:^|[^.\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /(?:const|let|var)\s+([^;\n]+?)=/g,
    /(?:^|[^.\w$])(?:const|let|var)\s*\{([^}]*)\}/g,
    /(?:^|[^.\w$])(?:const|let|var)\s*\[([^\]]*)\]/g,
    /function\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g,
    /\(([^()]*)\)\s*(?:=>|\{)/g,
    /([A-Za-z_$][\w$]*)\s*=>/g,
    /class\s+([A-Za-z_$][\w$]*)/g,
    /for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /catch\s*\(\s*([A-Za-z_$][\w$]*)/g,
    /import\s*\{([^}]*)\}/g
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

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.cjs')) files.push(full);
  }
  return files;
}

const problems = [];
const files = walk(ROOT).filter((file) => !file.endsWith(path.join('tests', 'container-refs.cjs')));

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const declared = declaredNames(text);
  const reported = new Set();
  const pattern = new RegExp(`(?:^|[^.\\w$])([A-Za-z_$][\\w$]*)\\.(${CONTAINER_METHODS})\\b`, 'g');
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    if (GLOBALS.has(name) || declared.has(name) || reported.has(name)) continue;
    // 排除 this / 属性链：前面是 . 的情况已由正则排除；再排一次字符串里的误报靠 declared/globals
    reported.add(name);
  }
  if (reported.size) problems.push({ file: rel, names: [...reported].sort() });
}

console.log(JSON.stringify({ ok: problems.length === 0, files: files.length, problems }, null, 2));
if (problems.length) process.exitCode = 1;
