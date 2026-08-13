import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChromeSession } = require('../collector/chrome-session.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = process.env.CONTENTOPS_QA_PRODUCT === '1' ? resolve(root, '成品') : root;
const tempRoot = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-operator-ui-${process.pid}-${Date.now()}`);
const dataDir = resolve(tempRoot, 'data');
const collectorProfile = resolve(tempRoot, 'collector-profile');
const uiProfile = resolve(tempRoot, 'ui-profile');
const fixturePort = 20100 + (process.pid % 300);
const appPort = 20400 + (process.pid % 300);
const collectorChromePort = 20700 + (process.pid % 300);
const uiChromePort = 21000 + (process.pid % 300);
const chromePath = process.env.CONTENTOPS_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const fixtureHtml = await readFile(resolve(root, 'qa', 'fixtures', 'xhs-search.html'));

let app = null;
let appStderr = '';
let fixture = null;
let uiSession = null;
let uiClient = null;

function killTree(pid) {
  if (!pid) return;
  try { spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide:true, stdio:'ignore', timeout:8000 }); } catch {}
}

function killProfileChrome(profileDir) {
  const escaped = profileDir.replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('${escaped}', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide:true, stdio:'ignore', timeout:10000 }); } catch {}
}

async function waitForServer(url, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url, { signal:AbortSignal.timeout(1000) })).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error(`${label}未启动：${appStderr}`);
}

async function waitFor(check, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last; } catch (error) { last = error.message; }
    await sleep(150);
  }
  throw new Error(`${label}超时${last ? `：${JSON.stringify(last)}` : ''}`);
}

const post = (route, body = {}) => fetch(`http://127.0.0.1:${appPort}${route}`, {
  method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body), signal:AbortSignal.timeout(15000)
}).then((response) => response.json());
const getState = () => fetch(`http://127.0.0.1:${appPort}/api/state`, { signal:AbortSignal.timeout(5000) }).then((response) => response.json());

try {
  await rm(tempRoot, { recursive:true, force:true });
  fixture = createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${fixturePort}`);
    const noteId = url.pathname.match(/^\/(?:explore|search_result)\/(note-[^/?]+)/)?.[1];
    if (noteId) {
      response.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="zh-CN"><head><script type="application/ld+json">${JSON.stringify({ '@type':'Article', headline:noteId === 'note-alpha' ? '企业内容怎么稳定找到选题' : '低成本内容增长清单', articleBody:'公开笔记正文 #内容运营 #企业增长', datePublished:'2026-07-18T15:15:00+08:00', author:{ name:'测试作者' }, image:[`http://127.0.0.1:${fixturePort}/images/${noteId}.jpg`] })}</script></head><body><article><div class="like-wrapper"><span class="count">1.3万</span></div><div class="collect-wrapper"><span class="count">3400</span></div><div class="comment-wrapper"><span class="count">89</span></div></article></body></html>`);
      return;
    }
    response.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
    response.end(fixtureHtml);
  });
  await new Promise((done) => fixture.listen(fixturePort, '127.0.0.1', done));

  app = spawn(process.execPath, [resolve(appRoot, 'server.cjs')], {
    cwd:appRoot,
    windowsHide:true,
    stdio:['ignore', 'pipe', 'pipe'],
    env:{
      ...process.env,
      CONTENTOPS_PORT:String(appPort),
      CONTENTOPS_DATA_DIR:dataDir,
      CONTENTOPS_XHS_PROFILE_DIR:collectorProfile,
      CONTENTOPS_XHS_CHROME_PORT:String(collectorChromePort),
      CONTENTOPS_XHS_SEARCH_BASE_URL:`http://127.0.0.1:${fixturePort}/xhs-search.html`,
      CONTENTOPS_COLLECTOR_HEADLESS:'1',
      CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1'
    }
  });
  app.stderr.on('data', (chunk) => { appStderr += chunk; });
  await waitForServer(`http://127.0.0.1:${appPort}/health`, '测试后台');

  const saved = await post('/api/settings/save', {
    workflowAutoEnabled:false,
    xhsEnabled:true,
    douyinEnabled:false,
    xhsKeywords:['同事操作回归'],
    xhsMaxPerKeyword:10,
    xhsScrollRounds:0,
    xhsDelayMs:1600,
    manualRawLimit:30,
    automaticRawLimit:321,
    manualFinalLimit:10,
    automaticFinalLimit:9,
    dailyCandidateLimit:100,
    aiAnalysisLimit:20,
    analysisConcurrency:4,
    analysisAutoRetryCount:2,
    generationCount:5,
    scaleGenerationCount:3,
    performanceAutoEnabled:true,
    performanceSampleHours:[2, 24, 72],
    imageCount:5,
    imageSingleTimeoutSeconds:180,
    imageJobTimeoutMinutes:15,
    imageMaxConcurrentJobs:2,
    imageQualityReviewEnabled:true,
    imageQualityThreshold:80,
    imageAutoRetryCount:1,
    dailyBudget:30,
    visionDailyBudget:20,
    visionMaxImages:6,
    imageDailyBudget:40,
    imageCostPerImage:0
  });
  assert.equal(saved.ok, true, saved.message);

  uiSession = new ChromeSession({ chromePath, profileDir:uiProfile, port:uiChromePort, headless:true });
  const opened = await uiSession.openClient(`http://127.0.0.1:${appPort}/`, `127.0.0.1:${appPort}`);
  uiClient = opened.client;
  await uiSession.navigate(uiClient, `http://127.0.0.1:${appPort}/`, 400);
  await waitFor(() => uiClient.evaluate("Boolean(document.querySelector('#collectOnly') && document.querySelector('#settingsForm'))", 3000), '工作台脚本初始化');

  await uiClient.evaluate("document.querySelector('[data-view=\"settings\"]').click(); true");
  const hiddenDefaults = await uiClient.evaluate(`(() => {
    const form = document.querySelector('#settingsForm');
    return {
      advancedHidden: !form.classList.contains('show-advanced'),
      noValidate: form.noValidate,
      analysisConcurrency: form.elements.analysisConcurrency.value,
      automaticRawLimit: form.elements.automaticRawLimit.value,
      xhsDelayMs: form.elements.xhsDelayMs.value
    };
  })()`);
  assert.deepEqual(hiddenDefaults, { advancedHidden:true, noValidate:true, analysisConcurrency:'4', automaticRawLimit:'321', xhsDelayMs:'1600' });

  const dirtyNavigation = await uiClient.evaluate(`(() => {
    const form = document.querySelector('#settingsForm');
    form.elements.xhsKeywords.value = '尚未保存的关键词';
    form.elements.xhsKeywords.dispatchEvent(new Event('input', { bubbles:true }));
    window.confirm = () => false;
    document.querySelector('[data-view="dashboard"]').click();
    const result = { settingsStillActive:document.querySelector('#view-settings').classList.contains('active'), value:form.elements.xhsKeywords.value };
    window.confirm = () => true;
    return result;
  })()`);
  assert.deepEqual(dirtyNavigation, { settingsStillActive:true, value:'尚未保存的关键词' });

  await uiClient.evaluate(`(() => {
    const form = document.querySelector('#settingsForm');
    form.elements.xhsKeywords.value = '内容运营';
    form.elements.xhsKeywords.dispatchEvent(new Event('input', { bubbles:true }));
    form.requestSubmit();
    return true;
  })()`);
  const preservedState = await waitFor(async () => {
    const state = await getState();
    return state.settings.xhsKeywords?.[0] === '内容运营' ? state : null;
  }, '隐藏参数保存');
  assert.equal(preservedState.settings.analysisConcurrency, 4);
  assert.equal(preservedState.settings.automaticRawLimit, 321);
  assert.equal(preservedState.settings.xhsDelayMs, 1600);

  const toggled = await uiClient.evaluate(`(() => {
    document.querySelector('#toggleAdvancedSettings').click();
    const form = document.querySelector('#settingsForm');
    return { visible:form.classList.contains('show-advanced'), analysisConcurrency:form.elements.analysisConcurrency.value, automaticRawLimit:form.elements.automaticRawLimit.value };
  })()`);
  assert.deepEqual(toggled, { visible:true, analysisConcurrency:'4', automaticRawLimit:'321' });

  await uiClient.evaluate("document.querySelector('[data-view=\"dashboard\"]').click(); true");
  const before = await getState();
  assert.equal(before.settings.masterEnabled, false);
  const lockObserved = await uiClient.evaluate(`(() => {
    const collect = document.querySelector('#collectOnly');
    collect.click();
    const result = {
      collectDisabled:collect.disabled,
      workflowDisabled:document.querySelector('#startWorkflow').disabled,
      quickDisabled:document.querySelector('#quickCollect').disabled
    };
    collect.click();
    document.querySelector('#startWorkflow').click();
    return result;
  })()`);
  assert.deepEqual(lockObserved, { collectDisabled:true, workflowDisabled:true, quickDisabled:true });

  let completed;
  try {
    completed = await waitFor(async () => {
      const state = await getState();
      return state.settings.masterEnabled && !state.runtime.collectionRunning && state.candidates.length === 2 ? state : null;
    }, '人工点击抓取完整收敛', 45000);
  } catch (error) {
    const [debugState, debugUi] = await Promise.all([
      getState().catch((failure) => ({ error:failure.message })),
      uiClient.evaluate(`({ toast:[...document.querySelectorAll('.toast')].map((node) => node.textContent.trim()), count:document.querySelector('#candidateNavCount')?.textContent, collectDisabled:document.querySelector('#collectOnly')?.disabled, masterTitle:document.querySelector('#masterControlTitle')?.textContent })`).catch((failure) => ({ error:failure.message }))
    ]);
    console.error(JSON.stringify({ debugState:{ masterEnabled:debugState.settings?.masterEnabled, runtime:debugState.runtime, candidates:debugState.candidates?.length, collector:debugState.agents?.find((item) => item.id === 'xhs-collector'), recentActivity:debugState.activity?.slice(0, 5) }, debugUi }, null, 2));
    throw error;
  }
  assert.equal(completed.activity.filter((item) => item.title === '小红书开始采集').length, 1, '重复点击不应创建第二次采集');
  assert.equal(completed.runtime.activeCollectors, 0, '采集完成后不应残留活动采集器对象');
  await waitFor(async () => {
    const ui = await uiClient.evaluate(`({ count:document.querySelector('#candidateNavCount').textContent.trim(), collectDisabled:document.querySelector('#collectOnly').disabled, masterTitle:document.querySelector('#masterControlTitle').textContent.trim() })`);
    return ui.count === '2' && !ui.collectDisabled && ui.masterTitle.includes('允许') ? ui : null;
  }, '总控台状态同步');

  await uiClient.evaluate(`(() => { window.confirm = () => true; document.querySelector('[data-view="dashboard"]').click(); document.querySelector('#masterStop').click(); return true; })()`);
  await waitFor(async () => {
    const state = await getState();
    return !state.settings.masterEnabled && !state.settings.workflowAutoEnabled ? state : null;
  }, '人工总控停止同步');
  const stoppedUi = await waitFor(async () => {
    const ui = await uiClient.evaluate(`({ title:document.querySelector('#masterControlTitle').textContent.trim(), startDisabled:document.querySelector('#masterStart').disabled, stopDisabled:document.querySelector('#masterStop').disabled })`);
    return ui.title.includes('停止') && !ui.startDisabled && ui.stopDisabled ? ui : null;
  }, '停止后的按钮状态');

  await uiClient.evaluate("document.querySelector('#startWorkflow').click(); true");
  await waitFor(async () => {
    const state = await getState();
    return state.settings.masterEnabled && state.runtime.workflowRunning ? state : null;
  }, '完整工作流进入运行态');
  await uiClient.evaluate(`(() => { window.confirm = () => true; document.querySelector('#masterStop').click(); return true; })()`);
  const cancelling = await waitFor(async () => {
    const state = await getState();
    return !state.settings.masterEnabled && state.runtime.workflowRunning && state.runtime.workflowCancelling ? state : null;
  }, '在途工作流停止态');
  const cancellingUi = await waitFor(async () => {
    const ui = await uiClient.evaluate(`({ title:document.querySelector('#masterControlTitle').textContent.trim(), startDisabled:document.querySelector('#masterStart').disabled, workflowDisabled:document.querySelector('#startWorkflow').disabled, collectDisabled:document.querySelector('#collectOnly').disabled })`);
    return ui.title.includes('正在停止') && ui.startDisabled && ui.workflowDisabled && ui.collectDisabled ? ui : null;
  }, '在途停止界面同步');
  await waitFor(async () => {
    const state = await getState();
    return !state.runtime.workflowRunning && !state.runtime.collectionRunning ? state : null;
  }, '在途工作流最终退出', 45000);

  console.log(JSON.stringify({
    status:'PASS',
    realBrowserUi:true,
    productMode:process.env.CONTENTOPS_QA_PRODUCT === '1',
    advancedSettingsHiddenByDefault:hiddenDefaults.advancedHidden,
    hiddenValuesPreserved:true,
    duplicateClickBlocked:true,
    explicitCollectionStartedMaster:true,
    candidatesRendered:completed.candidates.length,
    activeCollectorsAfterSettle:completed.runtime.activeCollectors,
    unsavedSettingsProtected:true,
    stopStateSynchronized:stoppedUi,
    inflightStopVisible:{ workflowCancelling:cancelling.runtime.workflowCancelling, ui:cancellingUi }
  }, null, 2));
} finally {
  try { uiClient?.close(); } catch {}
  try { uiSession?.stop(); } catch {}
  if (app?.pid) killTree(app.pid);
  killProfileChrome(collectorProfile);
  killProfileChrome(uiProfile);
  if (fixture) await new Promise((done) => { try { fixture.close(() => done()); } catch { done(); } });
  await sleep(500);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await rm(tempRoot, { recursive:true, force:true }); break; }
    catch { await sleep(250); }
  }
  if (appStderr) process.stderr.write(appStderr);
}
