#!/usr/bin/env node
'use strict';
/**
 * 隐私检查：保存的模型 Key 不能出现在接口响应里，也不能以明文落在状态文件中。
 *
 * 做法：用一个可识别的假 Key 走完整流程（保存 → 读取状态 → 读磁盘文件），
 * 再检查它有没有出现在任何一处不该出现的地方。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(os.tmpdir(), 'ContentOpsAgentV2-QA', `privacy-${process.pid}`);
const PORT = 18000 + ((process.pid + 13) % 120);
const TEXT_KEY = 'sk-privacy-text-abc123';
const VISION_KEY = 'sk-privacy-vision-def456';
const FEISHU = 'https://open.feishu.cn/open-apis/bot/v2/hook/privacy-test-hook';

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
        resolve({ status: response.statusCode, body: parsed, raw });
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
      if (Date.now() > deadline) return reject(new Error('服务没有在限定时间内就绪'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function main() {
  const problems = [];
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const child = spawn(process.execPath, [path.join(ROOT, 'server.cjs')], {
    cwd: ROOT,
    env: { ...process.env, CONTENTOPS_DATA_DIR: DATA_DIR, CONTENTOPS_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.on('data', () => {});

  try {
    await waitForHealth(Date.now() + 30000);
    // 1. 保存凭据（正常流程）
    await request('POST', '/api/ai/credential/save', { apiKey: TEXT_KEY });
    await request('POST', '/api/vision/credential/save', { apiKey: VISION_KEY });
    await request('POST', '/api/settings/save', {
      xhsEnabled: true, douyinEnabled: false, xhsKeywords: ['内容运营'], douyinKeywords: ['壁纸'], feishuWebhook: FEISHU
    });

    // 2. 接口响应里不能出现明文 Key / Webhook
    const state = await request('GET', '/api/state');
    if (state.status !== 200) problems.push(`/api/state 返回 ${state.status}`);
    for (const [label, secret] of [['文本 Key', TEXT_KEY], ['视觉 Key', VISION_KEY], ['飞书 Webhook', FEISHU]]) {
      if (String(state.raw).includes(secret)) problems.push(`${label} 出现在 /api/state 响应里`);
    }
    if (/"(apiKey|aiApiKey|feishuWebhook)"\s*:/.test(String(state.raw))) problems.push('/api/state 出现了凭据字段');
    if (/set-cookie/i.test(String(state.raw))) problems.push('/api/state 响应包含 Set-Cookie');

    // 3. 磁盘状态文件里不能有明文
    const onDisk = fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8');
    for (const secret of [TEXT_KEY, VISION_KEY]) {
      if (onDisk.includes(secret)) problems.push('状态文件里出现了明文 Key');
    }

    // 4. 但界面要能看到「已配置」的状态，不能因为隐藏而丢功能
    if (state.body?.settings?.aiCredentialConfigured !== true) problems.push('aiCredentialConfigured 没有置为 true');
    if (state.body?.settings?.visionCredentialConfigured !== true) problems.push('visionCredentialConfigured 没有置为 true');

    // 5. 凭据文件本身应当存在且不是明文（存放在 secrets/ 子目录）
    const secretsDir = path.join(DATA_DIR, 'secrets');
    const dpapi = fs.existsSync(secretsDir) ? fs.readdirSync(secretsDir).filter((name) => /\.dpapi$/.test(name)) : [];
    if (!dpapi.length) problems.push('没有找到 DPAPI 加密的凭据文件');
    for (const name of dpapi) {
      const content = fs.readFileSync(path.join(secretsDir, name));
      if (content.includes(TEXT_KEY) || content.includes(VISION_KEY)) problems.push(`${name} 里是明文`);
    }
  } finally {
    child.kill();
    // 子进程可能在我们挂监听之前就已经退出（启动失败时就是这样）。
    // 此时再等 'exit' 事件会永远等不到，事件循环排空后 node 静默退出 0 —— 测试就成了假通过。
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
    });
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ ok: problems.length === 0, checks: 5, problems }, null, 2));
  if (problems.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
