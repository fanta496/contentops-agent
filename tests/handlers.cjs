#!/usr/bin/env node
'use strict';
/**
 * 运行期处理器回归：直接把每个 API 处理器跑一遍，抓 ReferenceError 这类"接线错误"。
 *
 * 背景：静态检查只认 server.cjs 顶层声明过的名字，`trackOperation` 这种"对象里的内联属性"
 * 会漏过，结果 /api/model-profile/test 一点就 500。所以这里用真实 server 的 actionContext
 * 之外的**最小桩**做一次"能调用不炸"的冒烟：任何 ReferenceError 都会被抓出来。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(os.tmpdir(), 'ContentOpsAgentV2-QA', `handlers-${process.pid}`);
const PORT = 18700 + (process.pid % 100);

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    const client = http.request({ hostname: '127.0.0.1', port: PORT, path: urlPath, method, headers, timeout: 20000 }, (response) => {
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
      if (Date.now() > deadline) return reject(new Error('服务未就绪'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function main() {
  const problems = [];
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 模拟上次进程崩溃时留下的未结清票据：启动后必须按保守口径入账
  fs.writeFileSync(path.join(DATA_DIR, 'budget-holds.json'), JSON.stringify([
    { id: 'hold_crash_1', kind: 'text', amount: 0.5, purpose: '崩溃前未结清', state: 'held' }
  ]), 'utf8');

  const child = spawn(process.execPath, [path.join(ROOT, 'server.cjs')], {
    cwd: ROOT,
    env: { ...process.env, CONTENTOPS_DATA_DIR: DATA_DIR, CONTENTOPS_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.on('data', () => {});

  try {
    await waitForHealth(Date.now() + 30000);

    // 1. 建一个「一定能连到」的假档案：baseUrl 指向本机已关闭的端口，失败得快、不花钱。
    const saved = await request('POST', '/api/model-profile/save', {
      kind: 'text', name: '回归测试档案', baseUrl: 'http://127.0.0.1:9', model: 'test-model', maxOutputTokens: 100, requestTimeoutSeconds: 10
    });
    if (saved.status !== 200 || saved.body?.ok !== true) problems.push(`保存档案失败：${saved.status} ${JSON.stringify(saved.body).slice(0, 120)}`);
    const profileId = saved.body?.profile?.id;

    // 2. 存一个假 Key（Windows DPAPI 会真实加密）
    await request('POST', '/api/ai/credential/save', { apiKey: 'sk-handler-regression' });

    // 3. 点「测试连接」——这条路径曾经因为 trackOperation 没注入直接 500
    const tested = await request('POST', '/api/model-profile/test', { kind: 'text', id: profileId });
    if (tested.status >= 500) problems.push(`测试连接返回 ${tested.status}：${JSON.stringify(tested.body).slice(0, 160)}`);
    if (/is not defined|ReferenceError/.test(JSON.stringify(tested.body))) problems.push(`测试连接抛出未定义引用：${JSON.stringify(tested.body).slice(0, 160)}`);

    // 4. 图片预算 ¥1、单张 ¥1：连续两次连接测试，第二次必须被预算拦下
    await request('POST', '/api/settings/save', {
      xhsEnabled: true, douyinEnabled: false, xhsKeywords: ['内容运营'], douyinKeywords: ['壁纸'],
      imageDailyBudget: 1, imageCostPerImage: 1
    });
    const imageProfile = await request('POST', '/api/model-profile/save', {
      kind: 'image', name: '图片回归档案', baseUrl: 'http://127.0.0.1:9', model: 'img-test', maxOutputTokens: 100, requestTimeoutSeconds: 5, imageInputMode: 'text_only'
    });
    const imageProfileId = imageProfile.body?.profile?.id;
    await request('POST', '/api/ai/credential/save', { apiKey: 'sk-handler-regression' });
    const firstTest = await request('POST', '/api/model-profile/test', { kind: 'image', id: imageProfileId });
    if (firstTest.status >= 500) problems.push(`图片连接测试返回 ${firstTest.status}`);
    const afterFirst = await request('GET', '/api/state');
    const spentAfterFirst = Number(afterFirst.body?.settings?.imageSpentToday || 0);
    if (spentAfterFirst < 1) problems.push(`第一次图片测试后 imageSpentToday=${spentAfterFirst}，应至少按保守口径记 ¥1`);
    const secondTest = await request('POST', '/api/model-profile/test', { kind: 'image', id: imageProfileId });
    const secondJson = JSON.stringify(secondTest.body || {});
    if (secondTest.body?.ok === true) problems.push('预算已耗尽时第二次图片测试仍返回成功');
    if (!/BUDGET|预算/.test(secondJson)) problems.push(`第二次测试没有被预算拦下：${secondJson.slice(0, 160)}`);

    // 4. 其它带预算/注册表依赖的入口也点一下
    // 崩溃恢复：未结清票据要按保守口径计入当日消费
    const recoveredState = await request('GET', '/api/state');
    if (Number(recoveredState.body?.settings?.spentToday || 0) < 0.5) {
      problems.push(`崩溃恢复未生效：spentToday=${recoveredState.body?.settings?.spentToday}`);
    }

    for (const [label, path, body] of [
      ['连接测试(视觉)', '/api/model-profile/test', { kind: 'vision', id: profileId }],
      ['清理待审', '/api/variant/cleanup', {}],
      ['数据重置', '/api/data/reset', {}]
    ]) {
      const response = await request('POST', path, body);
      if (response.status >= 500) problems.push(`${label} 返回 ${response.status}`);
      if (/is not defined|ReferenceError/.test(JSON.stringify(response.body))) problems.push(`${label} 抛出未定义引用`);
    }
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
    });
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ ok: problems.length === 0, checks: 9, problems }, null, 2));
  if (problems.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
