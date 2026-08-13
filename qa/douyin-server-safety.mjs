import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-douyin-server-${process.pid}-${Date.now()}`);
const dataDir = resolve(tempRoot, 'data');
const controlFile = resolve(tempRoot, 'control.json');
const logFile = resolve(tempRoot, 'mock-events.jsonl');
const mockFile = resolve(root, 'qa', 'douyin-server-mock.cjs');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const reserve = createServer();
await new Promise((done) => reserve.listen(0, '127.0.0.1', done));
const port = reserve.address().port;
await new Promise((done) => reserve.close(done));

let child = null;
let stderr = '';

async function events() {
  try { return String(await readFile(logFile, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}

async function eventCount(name) { return (await events()).filter((item) => item.event === name).length; }

async function waitForEvent(name, previousCount = 0, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await eventCount(name);
    if (count > previousCount) return count;
    await sleep(25);
  }
  throw new Error(`未在${timeoutMs}ms内观察到事件 ${name}`);
}

async function setControl(patch = {}) {
  let current = {};
  try { current = JSON.parse(await readFile(controlFile, 'utf8')); } catch {}
  await writeFile(controlFile, JSON.stringify({ ...current, ...patch }, null, 2));
}

async function post(route, body = {}, timeoutMs = 10000) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body), signal:AbortSignal.timeout(timeoutMs)
  });
  return response.json();
}

const getState = () => fetch(`http://127.0.0.1:${port}/api/state`, { signal:AbortSignal.timeout(5000) }).then((response) => response.json());

async function startApp() {
  stderr = '';
  child = spawn(process.execPath, ['--require', mockFile, resolve(root, 'server.cjs')], {
    cwd:root,
    windowsHide:true,
    stdio:['ignore','ignore','pipe'],
    env:{
      ...process.env,
      CONTENTOPS_PORT:String(port),
      CONTENTOPS_DATA_DIR:dataDir,
      CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1',
      CONTENTOPS_TEST_DOUYIN_CONTROL_FILE:controlFile,
      CONTENTOPS_TEST_DOUYIN_LOG_FILE:logFile
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal:AbortSignal.timeout(500) })).ok) return; } catch {}
    if (child.exitCode !== null) break;
    await sleep(50);
  }
  throw new Error(`离线测试服务未启动：${stderr || `exit=${child?.exitCode}`}`);
}

async function stopApp() {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise((done) => child.once('close', done));
  child.kill();
  await Promise.race([closed, sleep(2000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  child = null;
}

function expectBusy(result, label) {
  assert.equal(result.ok, false, `${label}不应成功：${JSON.stringify(result)}`);
  assert.equal(result.code, 'ALREADY_RUNNING', `${label}未被互斥锁拦截：${JSON.stringify(result)}`);
}

async function writeState(mutator) {
  await stopApp();
  const statePath = resolve(dataDir, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  await mutator(state);
  await writeFile(statePath, JSON.stringify(state, null, 2));
  await startApp();
}

await rm(tempRoot, { recursive:true, force:true });
await mkdir(dataDir, { recursive:true });
await setControl({ delayMs:650, xhsCollectResult:'fail', douyinCollectResult:'success', douyinCollectItems:'none', importVersion:1, imageToken:'initial-token', imageHost:'p3.douyinpic.com' });

try {
  await startApp();
  const settings = await post('/api/settings/save', {
    workflowAutoEnabled:false,
    xhsEnabled:true,
    douyinEnabled:true,
    xhsKeywords:['离线小红书'],
    douyinKeywords:['离线抖音'],
    manualRawLimit:30,
    automaticRawLimit:50,
    manualFinalLimit:10,
    automaticFinalLimit:10
  });
  assert.equal(settings.ok, true, JSON.stringify(settings));
  assert.equal((await post('/api/master/start')).ok, true);

  // 搜索持锁：链接导入、登录、restart 均不得启动。
  let marker = await eventCount('douyin.collect:start');
  const searchRequest = post('/api/collection/run', { platform:'抖音', manual:true });
  await waitForEvent('douyin.collect:start', marker);
  const [linkDuringSearch, loginDuringSearch, restartDuringSearch] = await Promise.all([
    post('/api/source/add', { platform:'抖音', url:'https://www.douyin.com/note/930001' }),
    post('/api/collector/douyin/open-login'),
    post('/api/agent/restart', { id:'douyin-collector' })
  ]);
  expectBusy(linkDuringSearch, '搜索期间链接导入');
  expectBusy(loginDuringSearch, '搜索期间登录');
  expectBusy(restartDuringSearch, '搜索期间restart');
  assert.equal((await searchRequest).ok, true);

  // 链接导入持锁：搜索、登录、restart 均不得启动。
  marker = await eventCount('douyin.importLink:start');
  const linkRequest = post('/api/source/add', { platform:'抖音', url:'https://www.douyin.com/note/930010' });
  await waitForEvent('douyin.importLink:start', marker);
  const [searchDuringLink, loginDuringLink, restartDuringLink] = await Promise.all([
    post('/api/collection/run', { platform:'抖音', manual:true }),
    post('/api/collector/douyin/open-login'),
    post('/api/agent/restart', { id:'douyin-collector' })
  ]);
  expectBusy(searchDuringLink, '链接导入期间搜索');
  expectBusy(loginDuringLink, '链接导入期间登录');
  expectBusy(restartDuringLink, '链接导入期间restart');
  const firstImport = await linkRequest;
  assert.equal(firstImport.ok, true, JSON.stringify(firstImport));

  // 登录持锁：搜索、链接导入、restart 均不得启动。
  marker = await eventCount('douyin.openLogin:start');
  const loginRequest = post('/api/collector/douyin/open-login');
  await waitForEvent('douyin.openLogin:start', marker);
  const [searchDuringLogin, linkDuringLogin, restartDuringLogin] = await Promise.all([
    post('/api/collection/run', { platform:'抖音', manual:true }),
    post('/api/source/add', { platform:'抖音', url:'https://www.douyin.com/note/930011' }),
    post('/api/agent/restart', { id:'douyin-collector' })
  ]);
  expectBusy(searchDuringLogin, '登录期间搜索');
  expectBusy(linkDuringLogin, '登录期间链接导入');
  expectBusy(restartDuringLogin, '登录期间restart');
  assert.equal((await loginRequest).ok, true);

  // restart 本身也必须持有同一把抖音浏览器锁。
  marker = await eventCount('douyin.openLogin:start');
  const restartRequest = post('/api/agent/restart', { id:'douyin-collector' });
  await waitForEvent('douyin.openLogin:start', marker);
  const [searchDuringRestart, linkDuringRestart, loginDuringRestart] = await Promise.all([
    post('/api/collection/run', { platform:'抖音', manual:true }),
    post('/api/source/add', { platform:'抖音', url:'https://www.douyin.com/note/930012' }),
    post('/api/collector/douyin/open-login')
  ]);
  expectBusy(searchDuringRestart, 'restart期间搜索');
  expectBusy(linkDuringRestart, 'restart期间链接导入');
  expectBusy(loginDuringRestart, 'restart期间登录');
  assert.equal((await restartRequest).ok, true);

  // 在途链接读取遇人工停止：返回可以结束，但候选和计数绝不能写入。
  const beforeStop = await getState();
  marker = await eventCount('douyin.importLink:start');
  const inflight = post('/api/source/add', { platform:'抖音', url:'https://www.douyin.com/note/930099' });
  await waitForEvent('douyin.importLink:start', marker);
  assert.equal((await post('/api/master/stop')).ok, true);
  const stoppedImport = await inflight;
  assert.equal(stoppedImport.code, 'MASTER_STOPPED', JSON.stringify(stoppedImport));
  const afterStop = await getState();
  assert.equal(afterStop.candidates.some((item) => item.sourceId === '930099'), false, '人工停止后仍写入了在途抖音链接候选');
  assert.equal(afterStop.candidates.length, beforeStop.candidates.length, '人工停止后候选总数发生变化');
  assert.equal(afterStop.settings.candidatesToday, beforeStop.settings.candidatesToday, '人工停止后候选日计数发生变化');
  assert.notEqual(afterStop.agents.find((item) => item.id === 'douyin-collector')?.status, 'running');

  // 注入已分析旧版本与抖音发布版本，验证更新失效和二次分析平台门禁。
  await writeState(async (state) => {
    const candidate = state.candidates.find((item) => item.sourceId === '930010');
    assert.ok(candidate, '互斥测试的首个抖音候选未保存');
    Object.assign(candidate, {
      score:91,
      analysis:{ summary:'旧综合分析' },
      textAnalysis:{ summary:'旧文本分析' },
      visionAnalysis:{ summary:'旧视觉分析' },
      analysisStatus:'completed',
      visionImageCount:9,
      textFingerprint:'old-text',
      visionFingerprint:'old-vision',
      textAnalyzedAt:'2026-07-27T01:00:00.000Z',
      visionAnalyzedAt:'2026-07-27T01:00:01.000Z',
      analyzedAt:'2026-07-27T01:00:02.000Z',
      analysisTask:{ text:{ status:'completed' }, vision:{ status:'completed' }, lastFailure:{ lastError:'旧错误' } },
      structure:['旧结构']
    });
    state.variants.unshift({ id:'douyin_variant_guard', candidateId:candidate.id, platform:'抖音', account:'离线QA', title:'抖音发布门禁', body:'正文', tags:[], status:'approved', decision:null, imagePages:[], pages:[], performanceSnapshots:[] });
    state.settings.masterEnabled = false;
  });
  assert.equal((await post('/api/master/start')).ok, true);

  const creatorCallsBefore = (await events()).filter((item) => item.event.startsWith('creator.')).length;
  const metricsBlocked = await post('/api/metrics/save', { variantId:'douyin_variant_guard', link:'https://www.douyin.com/note/930010' });
  assert.equal(metricsBlocked.code, 'PLATFORM_PERFORMANCE_NOT_IMPLEMENTED', JSON.stringify(metricsBlocked));
  const directCollectBlocked = await post('/api/performance/collect', { variantIds:['douyin_variant_guard'], manual:true });
  assert.equal(directCollectBlocked.code, 'PLATFORM_PERFORMANCE_NOT_IMPLEMENTED', JSON.stringify(directCollectBlocked));
  const creatorCallsAfter = (await events()).filter((item) => item.event.startsWith('creator.')).length;
  assert.equal(creatorCallsAfter, creatorCallsBefore, '抖音二次分析请求错误进入了小红书创作后台适配器');

  await setControl({ importVersion:2, imageToken:'version-two-token-a', imageHost:'p3.douyinpic.com', delayMs:80 });
  const updated = await post('/api/source/add', { platform:'抖音', url:'https://www.douyin.com/note/930010' });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  const afterUpdate = await getState();
  const refreshed = afterUpdate.candidates.find((item) => item.sourceId === '930010');
  assert.equal(refreshed.title, '抖音测试图文 v2');
  assert.equal(refreshed.analysisStatus, 'pending');
  for (const field of ['score','analysis','textAnalysis','visionAnalysis']) assert.equal(refreshed[field], null, `内容更新后 ${field} 未清空`);
  for (const field of ['textFingerprint','visionFingerprint','textAnalyzedAt','visionAnalyzedAt','analyzedAt']) assert.equal(refreshed[field], '', `内容更新后 ${field} 未失效`);
  assert.deepEqual(refreshed.analysisTask, {});
  assert.deepEqual(refreshed.structure, []);
  assert.equal(refreshed.visionImageCount, 0);

  // CDN 域名或签名 token 轮换不等于内容被编辑，不得让已经完成的分析反复失效。
  await writeState(async (state) => {
    const candidate = state.candidates.find((item) => item.sourceId === '930010');
    Object.assign(candidate, {
      score:88,
      analysis:{ summary:'第二版综合分析' },
      textAnalysis:{ summary:'第二版文本分析' },
      visionAnalysis:{ summary:'第二版视觉分析' },
      analysisStatus:'completed',
      visionImageCount:1,
      textFingerprint:'v2-text',
      visionFingerprint:'v2-vision',
      textAnalyzedAt:'2026-07-28T01:00:00.000Z',
      visionAnalyzedAt:'2026-07-28T01:00:01.000Z',
      analyzedAt:'2026-07-28T01:00:02.000Z',
      analysisTask:{ text:{ status:'completed' }, vision:{ status:'completed' } },
      structure:['第二版结构']
    });
    state.settings.masterEnabled = false;
  });
  assert.equal((await post('/api/master/start')).ok, true);
  await setControl({ importVersion:2, imageToken:'rotated-token-b', imageHost:'p6.douyinpic.com', delayMs:80 });
  const tokenOnlyRefresh = await post('/api/source/add', { platform:'抖音', url:'https://www.douyin.com/note/930010' });
  assert.equal(tokenOnlyRefresh.ok, true, JSON.stringify(tokenOnlyRefresh));
  const afterTokenRotation = await getState();
  const stableCandidate = afterTokenRotation.candidates.find((item) => item.sourceId === '930010');
  assert.equal(stableCandidate.analysisStatus, 'completed', '仅 CDN token/域名变化却错误清空了分析');
  assert.equal(stableCandidate.score, 88);
  assert.deepEqual(stableCandidate.structure, ['第二版结构']);

  // 恢复多平台任务：一个平台失败时继续另一个；所有平台失败时仍必须受阻。
  await writeState(async (state) => {
    const steps = () => ['collect','analyze','select','create','publish','performance','scale'].map((id) => ({ id, name:id, status:id === 'collect' ? 'blocked' : 'pending', detail:'' }));
    // 模拟 1.3 以前的历史运行记录：没有 raw/filtered 字段，也可能没有 actualCost。
    const counts = () => ({ collected:0, analyzed:0, selected:0, generated:0, approved:0, published:0, performanceAnalyzed:0, scaled:0 });
    const targets = { platform:'小红书、抖音', platforms:[{ platform:'小红书', keywords:['离线小红书'] }, { platform:'抖音', keywords:['离线抖音'] }], contentType:'公开图文', keywords:['离线小红书','离线抖音'], rawLimit:30, finalLimit:10, filterMode:'标准' };
    state.workflowRuns = [
      { id:'run_resume_partial', trigger:'manual', status:'blocked', currentStep:'collect', startedAt:new Date().toISOString(), finishedAt:new Date().toISOString(), targets, steps:steps(), counts:counts(), candidateIds:[], error:'旧平台失败' },
      { id:'run_resume_all_failed', trigger:'manual', status:'blocked', currentStep:'collect', startedAt:new Date().toISOString(), finishedAt:new Date().toISOString(), targets, steps:steps(), counts:counts(), candidateIds:[], actualCost:0, error:'全部失败' }
    ];
    state.settings.masterEnabled = false;
  });
  assert.equal((await post('/api/master/start')).ok, true);
  await setControl({ delayMs:60, xhsCollectResult:'fail', douyinCollectResult:'success', douyinCollectItems:'none' });
  const partialResume = await post('/api/workflow/resume');
  assert.equal(partialResume.ok, true, JSON.stringify(partialResume));
  assert.equal(partialResume.run.id, 'run_resume_partial');
  assert.equal(partialResume.run.status, 'completed');
  assert.equal(partialResume.run.steps.find((item) => item.id === 'collect')?.status, 'partial');
  assert.equal(partialResume.run.steps.find((item) => item.id === 'select')?.status, 'skipped');
  assert.equal(Number.isFinite(partialResume.run.counts.raw), true, '旧运行记录恢复后 raw 计数不是有限数');
  assert.equal(Number.isFinite(partialResume.run.counts.filtered), true, '旧运行记录恢复后 filtered 计数不是有限数');
  assert.equal(Number.isFinite(partialResume.run.actualCost), true, '旧运行记录恢复后 actualCost 不是有限数');

  await setControl({ xhsCollectResult:'fail', douyinCollectResult:'fail' });
  const allFailedResume = await post('/api/workflow/resume');
  assert.equal(allFailedResume.ok, false, JSON.stringify(allFailedResume));
  assert.equal(allFailedResume.run.id, 'run_resume_all_failed');
  assert.equal(allFailedResume.run.status, 'blocked');
  assert.equal(allFailedResume.run.steps.find((item) => item.id === 'collect')?.status, 'blocked');
  const afterAllFailed = await getState();
  assert.equal(afterAllFailed.agents.find((item) => item.id === 'orchestrator')?.status, 'warning', '全部平台失败后总管 Agent 仍显示运行中');

  const finalEvents = await events();
  assert.ok(finalEvents.some((item) => item.event === 'xhs.collect:start'), '恢复任务未尝试小红书平台');
  assert.ok(finalEvents.filter((item) => item.event === 'douyin.collect:start').length >= 3, '恢复任务未在首个平台失败后继续尝试抖音');

  console.log(JSON.stringify({
    status:'PASS',
    mutualExclusion:{ search:true, linkImport:true, login:true, restart:true },
    masterStopNoWrite:true,
    douyinPerformanceBlockedBeforeCreatorCenter:true,
    changedContentInvalidatesAnalysis:true,
    cdnTokenRotationPreservesAnalysis:true,
    resumePartialPlatformSuccess:true,
    resumeAllPlatformsFailedStillBlocked:true,
    realPlatformAccess:false
  }, null, 2));
} finally {
  await stopApp();
  await rm(tempRoot, { recursive:true, force:true, maxRetries:5, retryDelay:150 });
  if (stderr) process.stderr.write(stderr);
}
