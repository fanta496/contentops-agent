#!/usr/bin/env node
'use strict';
/**
 * 一条命令跑完全部检查。改动前后各跑一遍，比单独记四个命令省事。
 * 顺序：语法 → 安全回归 → 接口行为快照 → 离线自检。
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const steps = [];
let failed = 0;

function run(label, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
    timeout: options.timeout || 300000
  });
  const ms = Date.now() - started;
  const ok = result.status === 0;
  if (!ok) {
    failed += 1;
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    console.error(`\n[FAIL] ${label} (${ms}ms)`);
    if (output) console.error(output.split('\n').slice(-25).join('\n'));
  } else {
    console.log(`[ok]   ${label} (${ms}ms)`);
  }
  steps.push({ label, ok, ms });
  return ok;
}

const sourceFiles = ['server.cjs', 'app.js'];
const fs = require('node:fs');
for (const dir of ['lib', 'collector', 'ai', 'tests']) {
  const base = path.join(ROOT, dir);
  if (!fs.existsSync(base)) continue;
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.cjs')) sourceFiles.push(path.join(dir, entry.name));
    if (entry.isDirectory()) {
      for (const nested of fs.readdirSync(path.join(base, entry.name), { withFileTypes: true })) {
        if (nested.isFile() && nested.name.endsWith('.cjs')) sourceFiles.push(path.join(dir, entry.name, nested.name));
      }
    }
  }
}

for (const file of sourceFiles) run(`语法检查 ${file}`, process.execPath, ['--check', path.join(ROOT, file)], { timeout: 60000 });

run('安全回归 tests/security-regression.cjs', process.execPath, [path.join(ROOT, 'tests', 'security-regression.cjs')]);
run('采集器契约 tests/collector-contract.cjs', process.execPath, [path.join(ROOT, 'tests', 'collector-contract.cjs')]);
run('节奏采样 tests/tempo.cjs', process.execPath, [path.join(ROOT, 'tests', 'tempo.cjs')]);
run('浏览器路径 tests/chrome-runtime.cjs', process.execPath, [path.join(ROOT, 'tests', 'chrome-runtime.cjs')]);
run('接口行为快照 tests/api-smoke.cjs', process.execPath, [path.join(ROOT, 'tests', 'api-smoke.cjs')]);
run('离线自检 server.cjs --self-test', process.execPath, [path.join(ROOT, 'server.cjs'), '--self-test'], {
  env: { CONTENTOPS_CARD_RENDERER: path.join(ROOT, 'launcher', 'bin', 'CardRenderer.exe') }
});

console.log(`\n汇总：${steps.length - failed}/${steps.length} 通过`);
if (failed) {
  console.error('失败项：' + steps.filter((step) => !step.ok).map((step) => step.label).join('、'));
  process.exitCode = 1;
}
