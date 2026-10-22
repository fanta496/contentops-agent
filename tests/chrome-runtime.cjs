#!/usr/bin/env node
'use strict';
/**
 * 浏览器路径解析的回归检查（纯函数，不启动浏览器）。
 *
 * 这两个 bug 曾经让采集直接跑不起来：
 * 1) 启动器把 Edge 写进配置，但校验写死文件名必须是 chrome.exe；
 * 2) 配置文件带 UTF-8 BOM，Node 读出来 JSON.parse 抛错，配置被静默丢弃。
 */

const path = require('node:path');
const { resolveChromeRuntime, savedChromePath } = require(path.resolve(__dirname, '..', 'collector', 'chrome-runtime.cjs'));

const problems = [];
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function configFile(content) {
  return () => content;
}

// 1. 带 BOM 的配置要能读出来
const withBom = '\uFEFF{"chromePath":"' + EDGE.replace(/\\/g, '\\\\') + '"}';
const saved = savedChromePath('ignored.json', configFile(withBom));
if (saved !== EDGE) problems.push(`BOM 配置读取失败：${JSON.stringify(saved)}`);

// 2. 配置里是 Edge，且文件存在 → 应当被接受
const edgeRun = resolveChromeRuntime({
  dataDir: 'X:\\data',
  env: {},
  exists: (candidate) => candidate === EDGE,
  readFile: configFile(withBom)
});
if (!edgeRun.found) problems.push('Edge 未被接受（found=false）');
if (edgeRun.path !== EDGE) problems.push(`Edge 路径没被采用：${edgeRun.path}`);

// 3. 没有配置，但标准路径有 chrome.exe → 接受
const chromeRun = resolveChromeRuntime({
  dataDir: 'X:\\data',
  env: {},
  exists: (candidate) => candidate === CHROME,
  readFile: () => '{}'
});
if (!chromeRun.found || chromeRun.path !== CHROME) problems.push('标准路径 chrome.exe 未被采用');

// 4. 环境变量优先于配置文件
const envRun = resolveChromeRuntime({
  dataDir: 'X:\\data',
  env: { CONTENTOPS_CHROME_PATH: EDGE },
  exists: (candidate) => candidate === EDGE,
  readFile: () => '{}'
});
if (!envRun.found || envRun.path !== EDGE) problems.push('CONTENTOPS_CHROME_PATH 没有优先');

// 5. 全都不存在 → found=false 且给出诊断
const noneRun = resolveChromeRuntime({ dataDir: 'X:\\data', env: {}, exists: () => false, readFile: () => '{}' });
if (noneRun.found) problems.push('不存在时不应报 found=true');
if (!String(noneRun.diagnostic).includes('chrome.exe')) problems.push('诊断信息缺少提示');

// 6. 没有配置、也没装 Chrome，但装了 Edge → 应当自动找到
const edgeOnly = resolveChromeRuntime({
  dataDir: 'X:\\data',
  env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
  exists: (candidate) => candidate === EDGE,
  readFile: () => '{}'
});
if (!edgeOnly.found || edgeOnly.path !== EDGE) problems.push('标准路径里的 Edge 未被自动发现');

// 7. 配置里写的是 chrome.exe（老用户）→ 仍然有效
const legacyConfig = '{"chromePath":"' + CHROME.replace(/\\/g, '\\\\') + '"}';
const legacyRun = resolveChromeRuntime({
  dataDir: 'X:\\data',
  env: {},
  exists: (candidate) => candidate === CHROME,
  readFile: () => legacyConfig
});
if (!legacyRun.found || legacyRun.path !== CHROME) problems.push('老配置（chrome.exe）被破坏');

console.log(JSON.stringify({
  ok: problems.length === 0,
  cases: 5,
  problems
}, null, 2));
if (problems.length) process.exitCode = 1;
