import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-inflight-${process.pid}-${Date.now()}`);
const dataDir = resolve(tempRoot, 'data');
const profileDir = resolve(tempRoot, 'profile');
const port = 18200 + (process.pid % 400);
const chromePort = 18600 + (process.pid % 400);
const fixturePort = 19000 + (process.pid % 400);
const aiPort = 19400 + (process.pid % 400);
const delayMs = 900;
const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEILV/5zOFDzdoQCepz6aeExAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELi3cqoDfaKuZM4AAAAASUVORK5CYII=';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let app = null;
let appStderr = '';
let fixture = null;
let ai = null;
let pendingFixture = 0;
let pendingText = 0;
let pendingImage = 0;
let fixtureStartedResolve;
let textStartedResolve;
let imageStartedResolve;
let fixtureStarted = new Promise((resolveStarted) => { fixtureStartedResolve = resolveStarted; });
let textStarted = new Promise((resolveStarted) => { textStartedResolve = resolveStarted; });
let imageStarted = new Promise((resolveStarted) => { imageStartedResolve = resolveStarted; });

const waitFor = async (promise, label, timeoutMs = 5000) => Promise.race([
  promise,
  sleep(timeoutMs).then(() => { throw new Error(`${label}未在${timeoutMs}ms内进入服务端等待状态`); })
]);
const closeServer = (server) => !server ? Promise.resolve() : new Promise((done) => {
  try { server.close(() => done()); } catch { done(); }
});
const post = async (route, body = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  });
  return response.json();
};
const getState = () => fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(5000) }).then((response) => response.json());

function generatedVariants(count, prefix, assetId = '') {
  return Array.from({ length: count }, (_, index) => ({
    title: `${prefix}${index + 1}`,
    body: `这是${prefix}${index + 1}的原创正文`,
    tags: ['回归测试'],
    format: '清单型',
    audience: '企业内容运营',
    enterpriseGrounding: { productAngle:'以测试产品承接内容方向', factsUsed:['仅用于本地自动回归'], sellingPointsUsed:['可验证'], proofPointsUsed:[], assetIds:[assetId], assetUsage:[`${assetId}：第1页使用企业产品图，不改变主体`] },
    visualStrategy: { concept:'企业产品清单', coverHook:'结果前置', continuity:'统一产品主体与配色', palette:['测试色'], avoidGeneric:['不得使用无关图库图'] },
    imagePages: [1, 2].map((page) => ({ role:page === 1 ? 'cover' : 'action', purpose:page === 1 ? '建立停留' : '行动承接', copy: `第${page}页`, imagePrompt: `${prefix}${index + 1}第${page}页围绕真实测试产品的图片提示词` }))
  }));
}

async function stopDuring(startedPromise, requestPromise, label) {
  await waitFor(startedPromise, label);
  const stopped = await post('/api/master/stop');
  if (!stopped.ok) throw new Error(`${label}期间停止总控失败：${JSON.stringify(stopped)}`);
  const result = await requestPromise;
  if (result.code !== 'MASTER_STOPPED') throw new Error(`${label}返回值不是MASTER_STOPPED：${JSON.stringify(result)}`);
  return result;
}

async function startMaster() {
  const result = await post('/api/master/start');
  if (!result.ok) throw new Error(`重新开启总控失败：${JSON.stringify(result)}`);
}

async function killAppTree() {
  if (!app || app.exitCode !== null) return;
  try { spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 }); } catch {}
  if (app.exitCode === null) try { app.kill(); } catch {}
  await Promise.race([new Promise((done) => app.once('close', done)), sleep(1500)]).catch(() => {});
}

function killProfileChrome() {
  const listed = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  ], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  if (listed.status !== 0 || !listed.stdout.trim()) return;
  let processes = [];
  try { processes = JSON.parse(listed.stdout); } catch { return; }
  for (const processInfo of Array.isArray(processes) ? processes : [processes]) {
    if (!String(processInfo?.CommandLine || '').includes(profileDir)) continue;
    try { spawnSync('taskkill.exe', ['/PID', String(processInfo.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 }); } catch {}
  }
}

function assertNoProfileChrome() {
  const listed = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Select-Object -ExpandProperty CommandLine'
  ], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  if (listed.status === 0 && String(listed.stdout || '').includes(profileDir)) throw new Error('测试结束后仍残留本次专用 Chrome/Profile 进程');
}

await rm(dataDir, { recursive: true, force: true });
await rm(profileDir, { recursive: true, force: true });

try {
  fixture = createServer(async (request, response) => {
    pendingFixture += 1;
    fixtureStartedResolve?.(); fixtureStartedResolve = null;
    await sleep(delayMs);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="zh-CN"><body><main><p>延迟抓取夹具：本轮没有候选。</p></main></body></html>');
    pendingFixture -= 1;
  });
  ai = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    let body = {}; try { body = JSON.parse(raw); } catch {}
    if (request.url.endsWith('/images/generations')) {
      pendingImage += 1;
      imageStartedResolve?.(); imageStartedResolve = null;
      await sleep(delayMs);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: onePixelPng.split(',')[1] }] }));
      pendingImage -= 1;
      return;
    }
    pendingText += 1;
    textStartedResolve?.(); textStartedResolve = null;
    await sleep(delayMs);
    const prompt = body.messages?.at(-1)?.content || '';
    const countMatch = prompt.match(/创作\s*(\d+)\s*套/);
    const count = Number(countMatch?.[1] || 1);
    const assetId = prompt.match(/"id"\s*:\s*"(asset_[^"]+)"/)?.[1] || '';
    const isScale = prompt.includes('二次生产') || prompt.includes('胜出元素') || prompt.includes('已发布胜出版本');
    const payload = { variants: generatedVariants(count, isScale ? '延迟二做' : '延迟一做', assetId) };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    pendingText -= 1;
  });
  await Promise.all([
    new Promise((done) => fixture.listen(fixturePort, '127.0.0.1', done)),
    new Promise((done) => ai.listen(aiPort, '127.0.0.1', done))
  ]);

  app = spawn(process.execPath, [resolve(root, 'server.cjs')], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CONTENTOPS_PORT: String(port),
      CONTENTOPS_DATA_DIR: dataDir,
      CONTENTOPS_XHS_PROFILE_DIR: profileDir,
      CONTENTOPS_XHS_CHROME_PORT: String(chromePort),
      CONTENTOPS_XHS_SEARCH_BASE_URL: `http://127.0.0.1:${fixturePort}/xhs-search.html`,
      CONTENTOPS_COLLECTOR_HEADLESS: '1',
      CONTENTOPS_TEST_ALLOW_UNVERIFIED: '1'
    }
  });
  app.stderr.on('data', (chunk) => { appStderr += chunk; });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { healthy = true; break; } } catch {}
    await sleep(100);
  }
  if (!healthy) throw new Error(`测试后台未启动：${appStderr || port}`);

  const settings = await post('/api/settings/save', {
    workflowAutoEnabled: false,
    xhsEnabled: true,
    xhsKeywords: ['延迟回归'],
    xhsMaxPerKeyword: 1,
    xhsScrollRounds: 0,
    xhsDelayMs: 1000,
    manualRawLimit: 30,
    automaticRawLimit: 50,
    manualFinalLimit: 10,
    automaticFinalLimit: 10,
    generationCount: 1,
    scaleGenerationCount: 1,
    imageCount: 2,
    dailyBudget: 100,
    visionDailyBudget: 100,
    imageDailyBudget: 100,
    aiBaseUrl: `http://127.0.0.1:${aiPort}/v1`,
    aiModel: 'delayed-text',
    visionBaseUrl: `http://127.0.0.1:${aiPort}/v1`,
    visionModel: 'delayed-vision'
  });
  if (!settings.ok) throw new Error(settings.message);
  const credential = await post('/api/ai/credential/save', { apiKey: 'local-delayed-text-key' });
  if (!credential.ok) throw new Error(credential.message);
  const enterprise = await post('/api/enterprise-profile/save', {
    name: '中途停止回归资料库', brandName: '测试品牌', productName: '测试产品', productFacts: ['仅用于本地自动回归'], sellingPoints: ['可验证'], makeActive: true
  });
  if (!enterprise.ok) throw new Error(enterprise.message);
  const enterpriseImage = await post('/api/enterprise-image/upload', { profileId:enterprise.profile.id, mime:'image/png', data:onePixelPng, name:'中途停止测试企业图', kind:'product', description:'用于验证总控停止时不写入在途结果' });
  if (!enterpriseImage.ok) throw new Error(enterpriseImage.message);

  const savedImageProfile = await post('/api/model-profile/save', {
    kind: 'image', name: '延迟生图', provider: '本地测试', baseUrl: `http://127.0.0.1:${aiPort}/v1`, model: 'delayed-image', apiKey: 'local-delayed-image-key'
  });
  if (!savedImageProfile.ok) throw new Error(`生图测试档案保存失败：${JSON.stringify(savedImageProfile)}`);
  const imageProfileTestRequest = post('/api/model-profile/test', { kind: 'image', id: savedImageProfile.profile.id });
  await waitFor(imageStarted, '生图连接测试');
  const imageProfileTest = await imageProfileTestRequest;
  if (!imageProfileTest.ok) throw new Error(`生图连接测试失败：${JSON.stringify(imageProfileTest)}`);
  const imageProfileActivation = await post('/api/model-profile/activate', { kind: 'image', id: savedImageProfile.profile.id });
  if (!imageProfileActivation.ok) throw new Error(`生图测试档案启用失败：${JSON.stringify(imageProfileActivation)}`);

  const initial = await getState();
  initial.settings.masterEnabled = false;
  initial.candidates = [
    { id: 'candidate_inflight_create', platform: '小红书', title: '中途停止一做候选', author: 'QA', status: 'selected', analysisStatus: 'completed', analysis: { summary: '已分析', productionBlueprint: {} }, structure: ['钩子', '方法'], tags: ['回归测试'], imageUrls: [], metrics: { likes: 1000, saves: 500, comments: 20 }, source: 'QA夹具', discoveredAt: new Date().toISOString() },
    { id: 'candidate_inflight_existing', platform: '小红书', title: '中途停止既有候选', author: 'QA', status: 'generated', analysisStatus: 'completed', analysis: { summary: '已分析', productionBlueprint: {} }, structure: ['钩子', '方法'], tags: ['回归测试'], imageUrls: [], metrics: { likes: 1000, saves: 500, comments: 20 }, source: 'QA夹具', discoveredAt: new Date().toISOString() }
  ];
  initial.variants = [
    { id: 'variant_inflight_image', candidateId: 'candidate_inflight_existing', workflowRunId: '', platform: '小红书', account: 'QA', title: '中途停止生图版本', body: '正文', tags: ['回归测试'], status: 'draft', decision: null, parentVariantId: null, imageStatus: 'draft', imageRules: { imageCount: 2, imageAspectRatio: '3:4', imageSize: '1024x1536', imageTextMode: 'no_text', imageStyle: 'realistic' }, imagePages: [{ id: 'image_page_1', index: 1, copy: '封面', imagePrompt: '延迟生图测试第一页', asset: null }, { id: 'image_page_2', index: 2, copy: '正文', imagePrompt: '延迟生图测试第二页', asset: null }], pages: ['封面', '正文'], performanceSnapshots: [] },
    { id: 'variant_inflight_scale', candidateId: 'candidate_inflight_existing', workflowRunId: '', platform: '小红书', account: 'QA', title: '中途停止二做版本', body: '正文', tags: ['回归测试'], status: 'published', decision: 'scale', parentVariantId: null, imageStatus: 'ready', imagePages: [], pages: [], performanceSnapshots: [], performanceAnalysis: { winningElements: ['结果前置'], nextDirections: ['换角度'], confidence: 90 } }
  ];
  initial.publications = [];
  initial.materials = [];
  await killAppTree();
  await writeFile(resolve(dataDir, 'state.json'), JSON.stringify(initial, null, 2));
  app = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CONTENTOPS_PORT: String(port), CONTENTOPS_DATA_DIR: dataDir, CONTENTOPS_XHS_PROFILE_DIR: profileDir, CONTENTOPS_XHS_CHROME_PORT: String(chromePort), CONTENTOPS_XHS_SEARCH_BASE_URL: `http://127.0.0.1:${fixturePort}/xhs-search.html`, CONTENTOPS_COLLECTOR_HEADLESS: '1', CONTENTOPS_TEST_ALLOW_UNVERIFIED: '1' } });
  app.stderr.on('data', (chunk) => { appStderr += chunk; });
  let restarted = false;
  for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { restarted = true; break; } } catch {} await sleep(100); }
  if (!restarted) throw new Error(`测试后台重启失败：${appStderr || port}`);
  await startMaster();

  const beforeCollect = await getState();
  fixtureStarted = new Promise((resolveStarted) => { fixtureStartedResolve = resolveStarted; });
  const collectRequest = post('/api/collection/run', { platform: '小红书', manual: true });
  await stopDuring(fixtureStarted, collectRequest, '延迟抓取');
  const afterCollect = await getState();
  if (afterCollect.candidates.length !== beforeCollect.candidates.length || afterCollect.settings.candidatesToday !== beforeCollect.settings.candidatesToday) throw new Error('延迟抓取停止后仍新增候选或候选计数');
  const stoppedCollectorAgent = afterCollect.agents.find((item) => item.id === 'xhs-collector');
  if (stoppedCollectorAgent?.status === 'running' || !String(stoppedCollectorAgent?.detail || '').includes('人工总控已停止')) throw new Error(`延迟抓取的进度回调覆盖了停止状态：${JSON.stringify(stoppedCollectorAgent)}`);

  const douyinAgent = afterCollect.agents.find((item) => item.id === 'douyin-collector');
  douyinAgent.status = 'running'; douyinAgent.detail = '正在低频搜索公开抖音图文';
  await killAppTree();
  await writeFile(resolve(dataDir, 'state.json'), JSON.stringify(afterCollect, null, 2));
  app = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CONTENTOPS_PORT: String(port), CONTENTOPS_DATA_DIR: dataDir, CONTENTOPS_XHS_PROFILE_DIR: profileDir, CONTENTOPS_XHS_CHROME_PORT: String(chromePort), CONTENTOPS_XHS_SEARCH_BASE_URL: `http://127.0.0.1:${fixturePort}/xhs-search.html`, CONTENTOPS_COLLECTOR_HEADLESS: '1', CONTENTOPS_TEST_ALLOW_UNVERIFIED: '1' } });
  app.stderr.on('data', (chunk) => { appStderr += chunk; });
  let restartedAfterDouyin = false;
  for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { restartedAfterDouyin = true; break; } } catch {} await sleep(100); }
  if (!restartedAfterDouyin) throw new Error(`抖音停止状态测试后台重启失败：${appStderr || port}`);
  await startMaster();
  const douyinStop = await post('/api/master/stop');
  if (!douyinStop.ok) throw new Error(`抖音运行中停止总控失败：${JSON.stringify(douyinStop)}`);
  const afterDouyinStop = await getState(); const stoppedDouyinAgent = afterDouyinStop.agents.find((item) => item.id === 'douyin-collector');
  if (stoppedDouyinAgent?.status === 'running' || !String(stoppedDouyinAgent?.detail || '').includes('人工总控已停止')) throw new Error(`抖音运行中停止后状态未收敛：${JSON.stringify(stoppedDouyinAgent)}`);

  await startMaster();
  const beforeCreate = await getState();
  textStarted = new Promise((resolveStarted) => { textStartedResolve = resolveStarted; });
  const createRequest = post('/api/variant/generate', { candidateId: 'candidate_inflight_create' });
  await stopDuring(textStarted, createRequest, '延迟一做');
  const afterCreate = await getState();
  if (afterCreate.variants.length !== beforeCreate.variants.length || afterCreate.candidates.find((item) => item.id === 'candidate_inflight_create')?.status !== 'selected') throw new Error('延迟一做停止后仍新增版本或修改候选状态');

  await startMaster();
  const beforeImage = await getState();
  imageStarted = new Promise((resolveStarted) => { imageStartedResolve = resolveStarted; });
  const imageRequest = post('/api/variant/image/generate', { id: 'variant_inflight_image' });
  await waitFor(imageStarted, '延迟生图');
  const stoppedImage = await post('/api/master/stop');
  if (!stoppedImage.ok) throw new Error(`延迟生图期间停止总控失败：${JSON.stringify(stoppedImage)}`);
  const imageAccepted = await imageRequest;
  if (!imageAccepted.ok || !imageAccepted.accepted) throw new Error(`延迟生图未进入受控任务：${JSON.stringify(imageAccepted)}`);
  await sleep(delayMs + 150);
  const afterImage = await getState();
  const imageVariant = afterImage.variants.find((item) => item.id === 'variant_inflight_image');
  if (imageVariant.imageJob?.status !== 'cancelled') throw new Error(`延迟生图停止后任务没有持久化为取消状态：${JSON.stringify(imageVariant.imageJob)}`);
  if (imageVariant.imagePages.some((page) => page.asset?.file)) throw new Error('延迟生图停止后仍写入图片资产');
  const generatedRoot = resolve(dataDir, 'generated-images');
  let generatedEntries = [];
  try { generatedEntries = await readdir(generatedRoot, { recursive: true }); } catch {}
  if (generatedEntries.length) throw new Error(`延迟生图停止后仍落盘文件：${generatedEntries.join(',')}`);
  if (afterImage.settings.imageGenerationsToday !== beforeImage.settings.imageGenerationsToday || afterImage.settings.imageSpentToday !== beforeImage.settings.imageSpentToday) throw new Error('延迟生图停止后仍增加调用计数或费用');

  await startMaster();
  const beforeScale = await getState();
  textStarted = new Promise((resolveStarted) => { textStartedResolve = resolveStarted; });
  const scaleRequest = post('/api/variant/scale', { id: 'variant_inflight_scale' });
  await stopDuring(textStarted, scaleRequest, '延迟二做');
  const afterScale = await getState();
  if (afterScale.variants.length !== beforeScale.variants.length || afterScale.variants.some((item) => item.parentVariantId === 'variant_inflight_scale')) throw new Error('延迟二做停止后仍新增子版本');
  if (afterScale.variants.find((item) => item.id === 'variant_inflight_scale')?.decision !== 'scale') throw new Error('延迟二做停止后仍把母版标记为已放大');
  if (afterScale.materials.length !== beforeScale.materials.length) throw new Error('延迟二做停止后仍沉淀成功素材');

  console.log(JSON.stringify({
    status: 'PASS',
    stoppedInflight: ['collection', 'first_creation', 'image_generation', 'second_creation'],
    collectorProgressCannotOverrideStop: true,
    douyinCollectorStopConverges: true,
    candidatesUnchanged: true,
    variantsUnchanged: true,
    imagesNotPersisted: true,
    materialsUnchanged: true,
    cleanupVerified: true
  }, null, 2));
} finally {
  await killAppTree();
  killProfileChrome();
  assertNoProfileChrome();
  await closeServer(fixture);
  await closeServer(ai);
  for (let attempt = 0; attempt < 12 && (pendingFixture || pendingText || pendingImage); attempt += 1) await sleep(100);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try { await rm(dataDir, { recursive: true, force: true }); await rm(profileDir, { recursive: true, force: true }); break; }
    catch { await sleep(250); }
  }
  await rm(tempRoot, { recursive:true, force:true }).catch(() => {});
  if (appStderr) process.stderr.write(appStderr);
}
