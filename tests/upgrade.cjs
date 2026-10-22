#!/usr/bin/env node
'use strict';
/**
 * 升级兼容测试：用 1.4.6（v1）真实写出的 state.json 启动 2.0.0（v2），
 * 确认老数据能被读进来、迁移结果会落盘、关键内容不丢。
 *
 * fixture 是 v1 代码在隔离目录里跑出来的真实文件（开过小红书关键词、建过一个资料库），
 * 不含任何账号、密钥或本机路径。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'state-v1.json');
const DATA_DIR = path.join(os.tmpdir(), 'ContentOpsAgentV2-QA', `upgrade-${process.pid}`);
const PORT = 17800 + ((process.pid + 7) % 150);

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    const client = http.request({ hostname: '127.0.0.1', port: PORT, path: urlPath, method, headers, timeout: 15000 }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    client.on('timeout', () => client.destroy(new Error('请求超时')));
    client.on('error', reject);
    if (payload) client.write(payload);
    client.end();
  });
}

function waitForHealth(deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const client = http.get({ hostname: '127.0.0.1', port: PORT, path: '/health', timeout: 1000 }, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve(true); else retry();
      });
      client.on('error', retry);
      client.on('timeout', () => { client.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('v2 服务没有在限定时间内就绪（可能是升级后启动失败）'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function main() {
  const problems = [];
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(DATA_DIR, 'state.json'));

  const v1 = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

  const child = spawn(process.execPath, [path.join(ROOT, 'server.cjs')], {
    cwd: ROOT,
    env: { ...process.env, CONTENTOPS_DATA_DIR: DATA_DIR, CONTENTOPS_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    await waitForHealth(Date.now() + 30000);
    const state = await request('GET', '/api/state');
    if (state.status !== 200) problems.push(`/api/state 返回 ${state.status}`);

    const body = state.body || {};
    // 1. 老数据里的内容要还在
    if (!Array.isArray(body.enterpriseProfiles) || body.enterpriseProfiles.length !== v1.enterpriseProfiles.length) {
      problems.push(`资料库数量变了：${v1.enterpriseProfiles.length} -> ${(body.enterpriseProfiles || []).length}`);
    }
    const oldKeywords = v1.settings.xhsKeywords || [];
    const newKeywords = body.settings?.xhsKeywords || [];
    for (const keyword of oldKeywords) {
      if (!newKeywords.includes(keyword)) problems.push(`关键词丢了：${keyword}`);
    }
    if (body.settings?.xhsEnabled !== true) problems.push('小红书开关没有保留');

    // 2. 迁移要落盘：v2 才有的字段必须写进文件，否则下次重启又回到旧结构
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8'));
    if (onDisk.settings?.imagePipelineVersion !== 3) problems.push('迁移结果没有落盘（imagePipelineVersion）');
    if (!Array.isArray(onDisk.agents) || onDisk.agents.length < 7) problems.push('agents 结构不完整');

    // 3. 旧文件里的时间戳不应被清空
    if (!onDisk.createdAt || onDisk.createdAt !== v1.createdAt) problems.push('createdAt 被改动');
  } finally {
    child.kill();
    await new Promise((resolve) => child.on('exit', resolve));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (stderr.trim()) problems.push('启动期有 stderr 输出：' + stderr.trim().split('\n')[0]);
  console.log(JSON.stringify({ ok: problems.length === 0, from: '1.4.6 fixture', to: '2.0.0', problems }, null, 2));
  if (problems.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
