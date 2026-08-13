import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { XiaohongshuCollector, detailExtractionScript } = require('../collector/xiaohongshu.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const searchFixture = await readFile(resolve(root, 'qa', 'fixtures', 'xhs-search.html'));
const detailFixture = await readFile(resolve(root, 'qa', 'fixtures', 'xhs-note-detail.html'));
const profileDir = resolve(root, 'qa', `.collector-detail-profile-${process.pid}-${Date.now()}`);
const errorDir = resolve(root, 'qa', `.collector-detail-errors-${process.pid}-${Date.now()}`);

const fixtureServer = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const body = url.pathname === '/explore/note-alpha' || url.pathname === '/search_result/note-alpha'
    ? detailFixture
    : url.pathname === '/login-detail'
      ? Buffer.from('<!doctype html><html><body><div class="login-dialog">扫码登录 手机号登录 请先登录</div></body></html>')
      : url.pathname === '/captcha-detail'
        ? Buffer.from('<!doctype html><html><body><div class="captcha-dialog">安全验证 请完成验证 拖动滑块</div></body></html>')
        : searchFixture;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
});
await new Promise((resolveListen) => fixtureServer.listen(0, '127.0.0.1', resolveListen));
const fixturePort = fixtureServer.address().port;

const reservePort = createServer();
await new Promise((resolveListen) => reservePort.listen(0, '127.0.0.1', resolveListen));
const chromePort = reservePort.address().port;
await new Promise((resolveClose) => reservePort.close(resolveClose));

const collector = new XiaohongshuCollector({
  chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  profileDir,
  errorDir,
  port: chromePort,
  headless: true,
  searchBaseUrl: `http://127.0.0.1:${fixturePort}/xhs-search.html`
});

try {
  const result = await collector.collect({ keywords: ['内容运营'], maxPerKeyword: 1, scrollRounds: 0, delayMs: 800 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.id, 'note-alpha');
  assert.equal(item.detailStatus, 'enriched');
  assert.equal(item.title, '企业内容怎么稳定找到选题');
  assert.equal(item.author, '运营研究所');
  assert.equal(item.body, '这是公开笔记正文。#内容运营 #企业增长');
  assert.deepEqual(item.tags, ['内容运营', '企业增长']);
  assert.equal(item.publishedAt, '2026-07-18T07:15:00.000Z');
  assert.deepEqual(item.imageUrls, [
    'https://img.example.test/note-alpha-1.jpg',
    'https://img.example.test/note-alpha-2.jpg'
  ]);
  assert.equal(item.likes, 13000);
  assert.equal(item.saves, 3400);
  assert.equal(item.comments, 89);
  assert.equal(item.contentType, 'image_text');

  const tab = await collector.session.getOrCreateTab(`http://127.0.0.1:${fixturePort}/login-detail`, '127.0.0.1');
  const client = await collector.session.connect(tab);
  try {
    await collector.session.navigate(client, `http://127.0.0.1:${fixturePort}/login-detail`, 100);
    const login = await client.evaluate(detailExtractionScript('login-note'));
    assert.equal(login.requiresLogin, true);
    assert.equal(login.captcha, false);
    await collector.session.navigate(client, `http://127.0.0.1:${fixturePort}/captcha-detail`, 100);
    const captcha = await client.evaluate(detailExtractionScript('captcha-note'));
    assert.equal(captcha.captcha, true);
    assert.equal(captcha.requiresLogin, false);
    await collector.session.navigate(client, `http://127.0.0.1:${fixturePort}/explore/note-alpha`, 100);
    const mismatch = await client.evaluate(detailExtractionScript('different-note'));
    assert.equal(mismatch.identityMatched, false);
    assert.equal(mismatch.meaningful, false);
  } finally {
    client.close();
  }
  console.log(JSON.stringify({ status: 'PASS', detailEnriched: true, identityMismatchRejected: true, loginDetected: true, captchaDetected: true, item }, null, 2));
} finally {
  collector.closeBrowser();
  await new Promise((resolveClose) => fixtureServer.close(resolveClose));
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  await rm(errorDir, { recursive: true, force: true }).catch(() => {});
}
