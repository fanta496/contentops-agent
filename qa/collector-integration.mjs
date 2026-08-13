import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const product = resolve(root, '成品');
const node = resolve(product, 'runtime', 'node.exe');
const serverFile = resolve(product, 'server.cjs');
const tempRoot = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-collector-${process.pid}-${Date.now()}`);
const dataDir = resolve(tempRoot, 'data');
const profileDir = resolve(tempRoot, 'profile');
const fixture = await readFile(resolve(root, 'qa', 'fixtures', 'xhs-search.html'));
const page = (text) => Buffer.from(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>采集状态测试</title></head><body>${text}</body></html>`);
await rm(dataDir, { recursive: true, force: true });
await rm(profileDir, { recursive: true, force: true });

const fixtureServer = createServer((request, response) => {
  const requestUrl = new URL(request.url, 'http://127.0.0.1:19999');
  if (requestUrl.pathname === '/short/note-alpha') { response.writeHead(302, { location:'/explore/note-alpha' }); return response.end(); }
  const noteId = requestUrl.pathname.match(/^\/(?:explore|search_result)\/(note-[^/?]+)/)?.[1];
  if (noteId) {
    response.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
    return response.end(`<!doctype html><html lang="zh-CN"><head><script type="application/ld+json">${JSON.stringify({ '@type':'Article', headline:noteId === 'note-alpha' ? '企业内容怎么稳定找到选题' : '低成本内容增长清单', articleBody:'公开笔记正文 #内容运营 #企业增长', datePublished:'2026-07-18T15:15:00+08:00', author:{name:'测试作者'}, image:[`http://127.0.0.1:19999/images/${noteId}-1.jpg`] })}</script></head><body><article><div class="like-wrapper"><span class="count">1.3万</span></div><div class="collect-wrapper"><span class="count">3400</span></div><div class="comment-wrapper"><span class="count">89</span></div></article></body></html>`);
  }
  const keyword = new URL(request.url, 'http://127.0.0.1:19999').searchParams.get('keyword') || '';
  const body = keyword === '需要登录' ? page('扫码登录 手机号登录') : keyword === '需要验证' ? page('安全验证 请完成验证 拖动滑块') : keyword === '空结果' ? page('这里没有图文结果') : fixture;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(body);
});
await new Promise((done) => fixtureServer.listen(19999, '127.0.0.1', done));

const port = 17833;
// Keep this test isolated from the operator's persistent XHS Chrome session
// (normally bound to 17841).  Otherwise an already-running production browser
// causes the fixture collector to attach to the wrong CDP target and hang.
const chromePort = 19833 + (process.pid % 300);
const env = { ...process.env, CONTENTOPS_PORT: String(port), CONTENTOPS_XHS_CHROME_PORT: String(chromePort), CONTENTOPS_DATA_DIR: dataDir, CONTENTOPS_XHS_PROFILE_DIR: profileDir, CONTENTOPS_XHS_SEARCH_BASE_URL: 'http://127.0.0.1:19999/xhs-search.html', CONTENTOPS_COLLECTOR_HEADLESS: '1', CONTENTOPS_TEST_ALLOW_UNVERIFIED: '1', CONTENTOPS_TEST_ALLOW_LOCAL_SOURCE:'1' };
const child = spawn(node, [serverFile], { cwd: product, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
try {
  for (let index = 0; index < 60; index += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  try { if (!(await fetch(`http://127.0.0.1:${port}/health`)).ok) throw new Error('后台未就绪'); } catch { throw new Error(`后台启动失败：${stderr || `${port}端口不可用`}`); }
  const post = async (route, payload = {}) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then((response) => response.json());
  const settings = await post('/api/settings/save', { collectionEnabled: false, xhsEnabled: true, xhsKeywords: ['内容运营'], xhsMaxPerKeyword: 10, xhsScrollRounds: 0, xhsDelayMs: 1000, intervalMinutes: 60, dailyCandidateLimit: 50, aiAnalysisLimit: 20, dailyBudget: 30, aiBaseUrl: '', aiModel: '', feishuWebhook: '' });
  if (!settings.ok) throw new Error(settings.message);
  const master = await post('/api/master/start');
  if (!master.ok) throw new Error(`测试总控未开启：${master.message}`);
  const probePromise = post('/api/collector/xhs/probe');
  await new Promise((done) => setTimeout(done, 100));
  const [collision, loginCollision, creatorCollision, sourceCollision, performanceCollision, supervisorCollision] = await Promise.all([
    post('/api/collection/run', { platform:'小红书', manual:true }),
    post('/api/collector/xhs/open-login'),
    post('/api/collector/xhs-creator/open-login'),
    post('/api/source/add', { platform:'小红书', url:'http://127.0.0.1:19999/explore/note-alpha' }),
    post('/api/performance/collect', { manual:true }),
    post('/api/agent/restart', { id:'data-agent' })
  ]);
  const probe = await probePromise;
  if (!probe.ok || !['READY', 'PAGE_REACHABLE'].includes(probe.code)) throw new Error(`小红书快速登录检查异常：${JSON.stringify(probe)}`);
  if (collision.code !== 'ALREADY_RUNNING') throw new Error(`小红书共用浏览器任务未严格串行：${JSON.stringify(collision)}`);
  for (const [name, result] of Object.entries({ loginCollision, creatorCollision, sourceCollision, performanceCollision, supervisorCollision })) {
    if (result.code !== 'ALREADY_RUNNING') throw new Error(`${name}未被小红书浏览器互斥锁拦截：${JSON.stringify(result)}`);
  }
  const first = await post('/api/collection/run', { platform: '小红书', manual: true });
  if (!first.ok || first.added !== 2) throw new Error(`首次采集异常：${JSON.stringify(first)}`);
  const second = await post('/api/collection/run', { platform: '小红书', manual: true });
  if (!second.ok || second.added !== 0 || second.updated !== 2) throw new Error(`重复采集未去重：${JSON.stringify(second)}`);
  const imported = await post('/api/source/add', { platform:'小红书', url:'http://127.0.0.1:19999/explore/note-alpha' });
  if (!imported.ok || !imported.candidate?.body || imported.candidate.detailStatus !== 'enriched' || !(imported.candidate.imageUrls || []).length) throw new Error(`小红书手动链接未读取详情：${JSON.stringify(imported)}`);
  const shortImported = await post('/api/source/add', { platform:'小红书', url:'http://127.0.0.1:19999/short/note-alpha' });
  if (!shortImported.ok || shortImported.added !== 0 || shortImported.updated !== 1 || shortImported.candidate?.sourceId !== 'note-alpha') throw new Error(`小红书短链跳转导入失败：${JSON.stringify(shortImported)}`);
  const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  const alpha = state.candidates.find((item) => item.sourceId === 'note-alpha');
  if (state.candidates.length !== 2 || state.candidates.some((item) => item.snapshots.length < 2 || item.source !== '真实浏览器采集') || !alpha || alpha.snapshots.length !== 4 || !alpha.body || !alpha.imageUrls.length || state.settings.candidatesToday !== 2) throw new Error('候选去重、链接幂等合并、每日计数或快照保存异常');
  await post('/api/settings/save', { collectionEnabled: false, xhsEnabled: true, xhsKeywords: ['需要登录'], xhsMaxPerKeyword: 10, xhsScrollRounds: 0, xhsDelayMs: 1000, intervalMinutes: 60, dailyCandidateLimit: 50, aiAnalysisLimit: 20, dailyBudget: 30, aiBaseUrl: '', aiModel: '', feishuWebhook: '' });
  const login = await post('/api/collection/run', { platform: '小红书', manual: true });
  if (login.code !== 'LOGIN_REQUIRED') throw new Error(`登录失效识别异常：${JSON.stringify(login)}`);
  await post('/api/settings/save', { collectionEnabled: false, xhsEnabled: true, xhsKeywords: ['需要验证'], xhsMaxPerKeyword: 10, xhsScrollRounds: 0, xhsDelayMs: 1000, intervalMinutes: 60, dailyCandidateLimit: 50, aiAnalysisLimit: 20, dailyBudget: 30, aiBaseUrl: '', aiModel: '', feishuWebhook: '' });
  const captcha = await post('/api/collection/run', { platform: '小红书', manual: true });
  if (captcha.code !== 'CAPTCHA') throw new Error(`验证码识别异常：${JSON.stringify(captcha)}`);
  await post('/api/settings/save', { collectionEnabled: false, xhsEnabled: true, xhsKeywords: ['空结果'], xhsMaxPerKeyword: 10, xhsScrollRounds: 0, xhsDelayMs: 1000, intervalMinutes: 60, dailyCandidateLimit: 50, aiAnalysisLimit: 20, dailyBudget: 30, aiBaseUrl: '', aiModel: '', feishuWebhook: '' });
  const empty = await post('/api/collection/run', { platform: '小红书', manual: true });
  if (!empty.ok || empty.added !== 0 || empty.updated !== 0 || empty.total !== 0) throw new Error(`空结果识别异常：${JSON.stringify(empty)}`);
  const settledState = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  if (settledState.runtime?.activeCollectors !== 0) throw new Error(`采集任务结束后仍残留活动采集器对象：${settledState.runtime?.activeCollectors}`);
  const douyin = await post('/api/collection/run', { platform: '抖音', manual: true });
  if (douyin.ok || douyin.message !== '抖音采集已关闭') throw new Error(`抖音默认关闭边界异常：${JSON.stringify(douyin)}`);
  console.log(JSON.stringify({ status: 'PASS', probe:{ ok:probe.ok, code:probe.code, recoveryStage:probe.recoveryStage }, xhsBrowserMutex:{ collection:collision.code, login:loginCollision.code, creator:creatorCollision.code, source:sourceCollision.code, performance:performanceCollision.code, supervisor:supervisorCollision.code }, activeCollectorsAfterSettle:settledState.runtime.activeCollectors, first, second, imported:{ detailStatus:imported.candidate.detailStatus, imageCount:imported.candidate.imageUrls.length, shortLinkRedirected:shortImported.ok }, candidates: state.candidates.length, candidatesToday:state.settings.candidatesToday, snapshots: state.candidates.map((item) => item.snapshots.length), login: login.code, captcha: captcha.code, empty: empty.code, douyin: douyin.code }, null, 2));
} finally {
  child.kill(); fixtureServer.close();
  await new Promise((done) => setTimeout(done, 1200));
  await rm(dataDir, { recursive: true, force: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await rm(profileDir, { recursive: true, force: true }); break; }
    catch { await new Promise((done) => setTimeout(done, 400)); }
  }
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
if (stderr) process.stderr.write(stderr);
