#!/usr/bin/env node
'use strict';
/**
 * API 行为快照测试。
 *
 * 目的：重构（拆模块、挪文件）时锁定 HTTP 行为。做法是起一个隔离数据目录的
 * 服务进程，按固定顺序打一遍接口，把归一化后的响应存成基线 JSON。
 * 之后每次重构跑一遍，只要行为和基线不一致就报出来。
 *
 * 用法：
 *   node tests/api-smoke.cjs            # 和基线比对
 *   node tests/api-smoke.cjs --write    # 重新生成基线
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'baseline', 'api-smoke.json');
const WRITE = process.argv.includes('--write');
const PORT = 17800 + (process.pid % 150);
const DATA_DIR = path.join(os.tmpdir(), 'ContentOpsAgentV2-QA', `api-smoke-${process.pid}`);

// 顺序固定：先只读，再逐个 POST。真实采集和浏览器动作全部由“总控停止”挡在门口，
// 所以这里不需要真的开 Chrome。
const STEPS = [
  { name: 'index', method: 'GET', path: '/' },
  { name: 'health', method: 'GET', path: '/health' },
  { name: 'state:initial', method: 'GET', path: '/api/state' },
  { name: 'collector-status', method: 'GET', path: '/api/collector/status' },
  { name: 'index-404', method: 'GET', path: '/nope.html' },
  { name: 'bad-method', method: 'PUT', path: '/api/state' },
  { name: 'bad-host', method: 'GET', path: '/api/state', host: 'evil.test' },
  { name: 'bad-origin', method: 'POST', path: '/api/settings/save', origin: 'http://evil.test', body: {} },
  { name: 'action:unknown', method: 'POST', path: '/api/does-not-exist', body: {} },
  { name: 'settings-save', method: 'POST', path: '/api/settings/save', body: {} },
  { name: 'settings-save-bad-json', method: 'POST', path: '/api/settings/save', raw: '{not json' },
  { name: 'master-stop', method: 'POST', path: '/api/master/stop', body: {} },
  { name: 'master-start', method: 'POST', path: '/api/master/start', body: {} },
  { name: 'workflow-run', method: 'POST', path: '/api/workflow/run', body: {} },
  { name: 'workflow-resume', method: 'POST', path: '/api/workflow/resume', body: {} },
  { name: 'workflow-pause-auto', method: 'POST', path: '/api/workflow/pause-auto', body: {} },
  { name: 'workflow-cleanup', method: 'POST', path: '/api/workflow/cleanup', body: {} },
  { name: 'collection-run', method: 'POST', path: '/api/collection/run', body: { platform: '小红书', manual: true } },
  { name: 'collection-run-bad-platform', method: 'POST', path: '/api/collection/run', body: { platform: '不存在' } },
  // 抖音默认关闭：这条只会走到平台开关校验，不会启动浏览器。
  { name: 'douyin-probe-disabled', method: 'POST', path: '/api/collector/douyin/probe', body: {} },
  { name: 'performance-collect', method: 'POST', path: '/api/performance/collect', body: {} },
  { name: 'supervisor-inspect', method: 'POST', path: '/api/supervisor/inspect', body: {} },
  { name: 'profile-save-empty', method: 'POST', path: '/api/model-profile/save', body: {} },
  { name: 'profile-test-unknown', method: 'POST', path: '/api/model-profile/test', body: { id: 'nope' } },
  { name: 'profile-activate-unknown', method: 'POST', path: '/api/model-profile/activate', body: { id: 'nope' } },
  { name: 'credential-save-empty', method: 'POST', path: '/api/ai/credential/save', body: {} },
  { name: 'credential-clear', method: 'POST', path: '/api/ai/credential/clear', body: {} },
  { name: 'ai-test', method: 'POST', path: '/api/ai/test', body: {} },
  { name: 'vision-credential-save-empty', method: 'POST', path: '/api/vision/credential/save', body: {} },
  { name: 'vision-credential-clear', method: 'POST', path: '/api/vision/credential/clear', body: {} },
  { name: 'vision-test', method: 'POST', path: '/api/vision/test', body: {} },
  { name: 'feishu-test', method: 'POST', path: '/api/feishu/test', body: {} },
  { name: 'enterprise-save-empty', method: 'POST', path: '/api/enterprise-profile/save', body: {} },
  { name: 'enterprise-save-id-on-create', method: 'POST', path: '/api/enterprise-profile/save', body: { mode: 'create', id: 'x' } },
  { name: 'enterprise-save-edit-without-id', method: 'POST', path: '/api/enterprise-profile/save', body: { mode: 'edit' } },
  { name: 'enterprise-export-unknown', method: 'POST', path: '/api/enterprise-profile/export', body: { profileId: 'nope' } },
  { name: 'enterprise-activate-unknown', method: 'POST', path: '/api/enterprise-profile/activate', body: { id: 'nope' } },
  { name: 'enterprise-archive-unknown', method: 'POST', path: '/api/enterprise-profile/archive', body: { id: 'nope' } },
  { name: 'enterprise-restore-unknown', method: 'POST', path: '/api/enterprise-profile/restore', body: { id: 'nope' } },
  { name: 'enterprise-image-upload-no-profile', method: 'POST', path: '/api/enterprise-image/upload', body: {} },
  { name: 'enterprise-image-upload-bad-mime', method: 'POST', path: '/api/enterprise-image/upload', body: { profileId: 'nope', mime: 'text/plain' } },
  { name: 'enterprise-image-delete-unknown', method: 'POST', path: '/api/enterprise-image/delete', body: {} },
  { name: 'source-add-empty', method: 'POST', path: '/api/source/add', body: {} },
  { name: 'source-add-bad-url', method: 'POST', path: '/api/source/add', body: { url: 'not-a-url' } },
  { name: 'candidate-analyze-unknown', method: 'POST', path: '/api/candidate/analyze', body: { ids: ['nope'] } },
  { name: 'candidate-status-unknown', method: 'POST', path: '/api/candidate/status', body: { id: 'nope' } },
  { name: 'candidate-delete-unknown', method: 'POST', path: '/api/candidate/delete', body: { ids: ['nope'] } },
  { name: 'candidate-cleanup', method: 'POST', path: '/api/candidate/cleanup', body: {} },
  { name: 'variant-generate-unknown', method: 'POST', path: '/api/variant/generate', body: { candidateId: 'nope' } },
  { name: 'variant-status-unknown', method: 'POST', path: '/api/variant/status', body: { id: 'nope' } },
  { name: 'variant-update-unknown', method: 'POST', path: '/api/variant/update', body: { id: 'nope' } },
  { name: 'variant-image-generate-unknown', method: 'POST', path: '/api/variant/image/generate', body: { id: 'nope' } },
  { name: 'variant-export-directory-unknown', method: 'POST', path: '/api/variant/export-directory', body: { id: 'nope' } },
  { name: 'variant-export-unknown', method: 'POST', path: '/api/variant/export', body: { id: 'nope' } },
  { name: 'variant-delete-unknown', method: 'POST', path: '/api/variant/delete', body: { ids: ['nope'] } },
  { name: 'variant-cleanup', method: 'POST', path: '/api/variant/cleanup', body: {} },
  { name: 'variant-scale-unknown', method: 'POST', path: '/api/variant/scale', body: { id: 'nope' } },
  { name: 'metrics-save-unknown', method: 'POST', path: '/api/metrics/save', body: { id: 'nope' } },
  { name: 'agent-restart-unknown', method: 'POST', path: '/api/agent/restart', body: { id: 'nope' } },
  { name: 'data-reset', method: 'POST', path: '/api/data/reset', body: {} },
  { name: 'state:final', method: 'GET', path: '/api/state' }
];

function normalize(value) {
  return JSON.parse(JSON.stringify(value, (key, raw) => {
    if (typeof raw === 'string') {
      let text = raw;
      text = text.replace(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g, '<origin>');
      text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<ts>');
      text = text.replace(/\b[a-z][a-z0-9-]*_\d{10,}_[a-z0-9]{1,8}\b/gi, '<id>');
      text = text.replace(/\b[0-9a-f]{64}\b/g, '<sha256>');
      text = text.replace(/[A-Za-z]:\\\\?[^"']*/g, '<path>');
      text = text.replace(/\d{2}:\d{2}:\d{2}/g, '<clock>');
      return text;
    }
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 1e12) return '<epochms>';
    if (key === 'port' || key === 'pid') return '<' + key + '>';
    return raw;
  }));
}

function request(step) {
  return new Promise((resolve, reject) => {
    const payload = step.raw !== undefined ? step.raw : step.body === undefined ? undefined : JSON.stringify(step.body);
    const headers = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (step.host) headers.host = step.host;
    if (step.origin) headers.origin = step.origin;
    const client = http.request(
      { hostname: '127.0.0.1', port: PORT, path: step.path, method: step.method, headers, timeout: 15000 },
      (response) => {
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { buffer += chunk; });
        response.on('end', () => {
          let parsed = buffer;
          try { parsed = JSON.parse(buffer); } catch { /* 非 JSON（静态文件、纯文本）保留原文 */ }
          resolve({ status: response.statusCode, body: parsed });
        });
      }
    );
    client.on('timeout', () => client.destroy(new Error(`${step.name} 超时`)));
    client.on('error', reject);
    if (payload !== undefined) client.write(payload);
    client.end();
  });
}

function waitForHealth(deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const client = http.get({ hostname: '127.0.0.1', port: PORT, path: '/health', timeout: 1000 }, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve(true);
        else retry();
      });
      client.on('error', retry);
      client.on('timeout', () => { client.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('服务在限定时间内没有就绪'));
      setTimeout(tick, 120);
    };
    tick();
  });
}

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'server.cjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONTENTOPS_DATA_DIR: DATA_DIR,
      CONTENTOPS_PORT: String(PORT),
      CONTENTOPS_CARD_RENDERER: process.env.CONTENTOPS_CARD_RENDERER || path.join(ROOT, 'launcher', 'bin', 'CardRenderer.exe')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const result = { steps: {}, meta: {} };
  try {
    await waitForHealth(Date.now() + 30000);
    for (const step of STEPS) {
      const response = await request(step);
      result.steps[step.name] = normalize({ status: response.status, body: response.body });
    }
    result.meta.stepCount = STEPS.length;
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

  if (WRITE) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ ok: true, written: BASELINE, steps: Object.keys(result.steps).length }));
    return;
  }

  if (!fs.existsSync(BASELINE)) {
    console.log(JSON.stringify({ ok: false, message: '基线不存在，请先运行 node tests/api-smoke.cjs --write' }));
    process.exitCode = 1;
    return;
  }
  const expected = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const mismatches = [];
  for (const name of Object.keys(expected.steps)) {
    const want = JSON.stringify(expected.steps[name]);
    const got = JSON.stringify(result.steps[name]);
    if (want !== got) mismatches.push({ step: name, want: expected.steps[name], got: result.steps[name] });
  }
  if (mismatches.length) {
    console.log(JSON.stringify({ ok: false, mismatches: mismatches.slice(0, 8), count: mismatches.length }, null, 2));
    if (stderr.trim()) console.log(stderr.trim().split('\n').slice(-5).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, steps: Object.keys(expected.steps).length }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
