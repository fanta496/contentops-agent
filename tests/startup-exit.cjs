#!/usr/bin/env node
'use strict';
/**
 * 启动失败必须返回非 0 退出码。
 *
 * 之前的写法在「进程锁已存在」时 process.exit(0)，端口占用时也退 0 —— 守护进程/看门狗
 * 会把它当成"正常结束"，静默地不重启。这个测试把两种启动失败都跑一遍。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(os.tmpdir(), 'ContentOpsAgentV2-QA', `exitcode-${process.pid}`);

function runServer(env, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.cjs')], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

function occupyPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const problems = [];
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 1. 端口被占用：必须非 0
  const { server, port } = await occupyPort();
  const occupied = await runServer({ CONTENTOPS_DATA_DIR: DATA_DIR, CONTENTOPS_PORT: String(port) });
  server.close();
  if (occupied.code === 0) problems.push('端口被占用时退出码是 0（看门狗会误判为正常退出）');
  if (!/SERVER_START_FAILED|EADDRINUSE/.test(occupied.stderr)) problems.push('端口占用时没有输出可诊断的 stderr');

  // 2. 进程锁已存在：必须非 0
  const lockDir = path.join(DATA_DIR, 'lockcase');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'server.lock.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), root: ROOT }), 'utf8');
  const locked = await runServer({ CONTENTOPS_DATA_DIR: lockDir, CONTENTOPS_PORT: String(port + 1) });
  if (locked.code === 0) problems.push('存在运行中进程锁时退出码是 0');
  if (!/已有后台进程/.test(locked.stderr)) problems.push('进程锁冲突时没有输出原因');

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: problems.length === 0, cases: 2, problems }, null, 2));
  if (problems.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
