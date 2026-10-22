#!/usr/bin/env node
'use strict';
/**
 * 计费端到端：本地假供应商 + 真实服务路由。
 *
 * 对应第六轮复审的要求：不能只测 200/500，要断言**供应商收到的请求次数**、
 * 当日消费金额、以及预算耗尽后是否**根本不发请求**。
 *
 * 场景：
 *   A. 预算 ¥1、单次约 ¥1：第一次成功并入账，第二次必须被拒且供应商只收到 1 次请求
 *   B. 落盘故障（环境变量注入）：请求必须被拒，供应商收到 0 次请求
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function startMockProvider() {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = {
        id: 'mock-1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true,"message":"连接成功"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 }
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    const client = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers, timeout: 30000 }, (response) => {
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

function waitForHealth(port, deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const client = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 1000 }, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve(true); else retry();
      });
      client.on('error', retry);
      client.on('timeout', () => { client.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('服务未就绪'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

function startServer(dataDir, port, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.cjs')], {
    cwd: ROOT,
    env: { ...process.env, CONTENTOPS_DATA_DIR: dataDir, CONTENTOPS_PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.on('data', () => {});
  return child;
}

async function stop(child) {
  child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
  });
}

async function main() {
  const problems = [];

  // ---------- 场景 A ----------
  const provider = await startMockProvider();
  const dataA = path.join(os.tmpdir(), 'ContentOpsAgentV2-QA', `billing-a-${process.pid}`);
  fs.rmSync(dataA, { recursive: true, force: true });
  fs.mkdirSync(dataA, { recursive: true });
  const portA = 18800 + (process.pid % 80);
  const serverA = startServer(dataA, portA);
  try {
    await waitForHealth(portA, Date.now() + 30000);
    // 单价拉高：1000 输入 + 1000 输出 ≈ ¥1（每百万 500000）
    const saved = await request(portA, 'POST', '/api/model-profile/save', {
      kind: 'text', name: '假供应商档案', apiKey: 'sk-mock-key', baseUrl: `http://127.0.0.1:${provider.port}`, model: 'mock-model',
      inputPricePerMillion: 500, outputPricePerMillion: 500, maxOutputTokens: 200, requestTimeoutSeconds: 10
    });
    const profileId = saved.body?.profile?.id;
    await request(portA, 'POST', '/api/ai/credential/save', { apiKey: 'sk-mock-key' });
    await request(portA, 'POST', '/api/settings/save', {
      xhsEnabled: true, douyinEnabled: false, xhsKeywords: ['内容运营'], douyinKeywords: ['壁纸'], dailyBudget: 1
    });

    const first = await request(portA, 'POST', '/api/model-profile/test', { kind: 'text', id: profileId });
    const afterFirst = await request(portA, 'GET', '/api/state');
    const spent = Number(afterFirst.body?.settings?.spentToday || 0);

    if (first.body?.ok !== true) problems.push(`第一次测试应成功：${JSON.stringify(first.body).slice(0, 120)}`);
    if (spent < 0.5) problems.push(`第一次成功调用后 spentToday=${spent}，应至少记 ¥0.5（票据估算）`);
    if (provider.state.requests !== 1) problems.push(`第一次测试后供应商应收到 1 次请求，实际 ${provider.state.requests}`);

    const second = await request(portA, 'POST', '/api/model-profile/test', { kind: 'text', id: profileId });
    if (second.body?.ok === true) problems.push('预算耗尽后第二次测试仍成功');
    if (provider.state.requests !== 1) problems.push(`预算耗尽时不应再请求供应商，实际收到 ${provider.state.requests} 次`);
  } finally {
    await stop(serverA);
    provider.server.close();
    fs.rmSync(dataA, { recursive: true, force: true });
  }

  // ---------- 场景 B：落盘故障 ----------
  const providerB = await startMockProvider();
  const dataB = path.join(os.tmpdir(), 'ContentOpsAgentV2-QA', `billing-b-${process.pid}`);
  fs.rmSync(dataB, { recursive: true, force: true });
  fs.mkdirSync(dataB, { recursive: true });
  const portB = 18900 + (process.pid % 80);
  const serverB = startServer(dataB, portB, { CONTENTOPS_SIMULATE_BUDGET_PERSIST_FAILURE: '1' });
  try {
    await waitForHealth(portB, Date.now() + 30000);
    const saved = await request(portB, 'POST', '/api/model-profile/save', {
      kind: 'text', name: '落盘故障档案', apiKey: 'sk-mock-key', baseUrl: `http://127.0.0.1:${providerB.port}`, model: 'mock-model',
      inputPricePerMillion: 10, outputPricePerMillion: 10, maxOutputTokens: 100, requestTimeoutSeconds: 5
    });
    const profileId = saved.body?.profile?.id;
    await request(portB, 'POST', '/api/ai/credential/save', { apiKey: 'sk-mock-key' });
    const tested = await request(portB, 'POST', '/api/model-profile/test', { kind: 'text', id: profileId });
    if (tested.body?.ok === true) problems.push('落盘故障时测试仍返回成功');
    if (!/BUDGET_LEDGER_UNAVAILABLE|落盘/.test(JSON.stringify(tested.body || {}))) problems.push(`落盘故障时没有明确拒绝：${JSON.stringify(tested.body).slice(0, 140)}`);
    if (providerB.state.requests !== 0) problems.push(`落盘故障时不应请求供应商，实际 ${providerB.state.requests} 次`);
  } finally {
    await stop(serverB);
    providerB.server.close();
    fs.rmSync(dataB, { recursive: true, force: true });
  }

  // ---------- 场景 C：未保存 Key ----------
  const providerC = await startMockProvider();
  const dataC = path.join(os.tmpdir(), 'ContentOpsAgentV2-QA', `billing-c-${process.pid}`);
  fs.rmSync(dataC, { recursive: true, force: true });
  fs.mkdirSync(dataC, { recursive: true });
  const portC = 19000 + (process.pid % 80);
  const serverC = startServer(dataC, portC);
  try {
    await waitForHealth(portC, Date.now() + 30000);
    const saved = await request(portC, 'POST', '/api/model-profile/save', {
      kind: 'text', name: '无 Key 档案', baseUrl: `http://127.0.0.1:${providerC.port}`, model: 'mock-model',
      inputPricePerMillion: 500, outputPricePerMillion: 500, maxOutputTokens: 100, requestTimeoutSeconds: 5
    });
    const profileId = saved.body?.profile?.id;
    const tested = await request(portC, 'POST', '/api/model-profile/test', { kind: 'text', id: profileId });
    const after = await request(portC, 'GET', '/api/state');
    const spent = Number(after.body?.settings?.spentToday || 0);
    if (tested.body?.ok === true) problems.push('没有 Key 时测试不应成功');
    if (spent !== 0) problems.push(`没有 Key 却扣了 ¥${spent}（未发出请求不应计费）`);
    if (providerC.state.requests !== 0) problems.push(`没有 Key 却请求了供应商 ${providerC.state.requests} 次`);
  } finally {
    await stop(serverC);
    providerC.server.close();
    fs.rmSync(dataC, { recursive: true, force: true });
  }

  // ---------- 场景 D：崩溃恢复（journal 里的 held 票据要补账，settled 不重复计） ----------
  const dataD = path.join(os.tmpdir(), 'ContentOpsAgentV2-QA', `billing-d-${process.pid}`);
  fs.rmSync(dataD, { recursive: true, force: true });
  fs.mkdirSync(dataD, { recursive: true });
  // 手工写一个「上次崩在落盘前」的状态：一张 held、一张已 settled
  const seed = {
    version: 2,
    mode: 'workflow-agent',
    settings: {
      budgetJournal: [
        { id: 'hold_crash_held', kind: 'text', amount: 0.6, purpose: '崩溃前未结清', status: 'held', createdAt: new Date().toISOString() },
        { id: 'hold_crash_settled', kind: 'text', amount: 0.9, purpose: '已结算', status: 'settled', actualCost: 0.9, createdAt: new Date().toISOString() }
      ]
    }
  };
  fs.writeFileSync(path.join(dataD, 'state.json'), JSON.stringify(seed, null, 2), 'utf8');
  const portD = 19100 + (process.pid % 80);
  const serverD = startServer(dataD, portD);
  try {
    await waitForHealth(portD, Date.now() + 30000);
    const after = await request(portD, 'GET', '/api/state');
    const spent = Number(after.body?.settings?.spentToday || 0);
    if (Math.abs(spent - 0.6) > 0.001) problems.push(`崩溃恢复应只补 held 的 ¥0.6，实际 ¥${spent}`);
  } finally {
    await stop(serverD);
    fs.rmSync(dataD, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ ok: problems.length === 0, scenarios: 4, problems }, null, 2));
  if (problems.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
