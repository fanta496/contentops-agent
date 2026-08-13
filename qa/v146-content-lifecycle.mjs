import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChromeSession } = require('../collector/chrome-session.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = process.env.CONTENTOPS_QA_PRODUCT === '1' ? resolve(root, '成品') : root;
const tempRoot = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-v146-${process.pid}-${Date.now()}`);
const dataDir = resolve(tempRoot, 'data');
const uiProfile = resolve(tempRoot, 'ui-profile');
const port = 21200 + (process.pid % 300);
const chromePort = 21500 + (process.pid % 300);
const chromePath = process.env.CONTENTOPS_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let app;
let stderr = '';
let session;
let client;

const candidate = (id, status, title) => ({ id, status, title, platform:'小红书', author:'测试作者', source:'测试', discoveredAt:new Date().toISOString(), tags:['测试'], metrics:{ likes:100, saves:20, comments:5 }, analysisStatus:'completed', structure:['钩子','价值'], detailStatus:'enriched' });
const variant = (id, candidateId, status, title, extra = {}) => ({ id, candidateId, status, title, platform:'小红书', account:'测试账号', format:'图文', body:`${title}正文`, tags:['测试'], pages:['第一页'], imagePages:[{ id:`${id}_p1`, index:1, copy:'第一页', imagePrompt:'测试提示词' }], ...extra });

async function waitFor(check, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch {}
    await sleep(120);
  }
  throw new Error(`${label}超时`);
}

try {
  await rm(tempRoot, { recursive:true, force:true });
  await mkdir(dataDir, { recursive:true });
  const publishedAt = new Date(Date.now() - 60 * 60000).toISOString();
  await writeFile(resolve(dataDir, 'state.json'), JSON.stringify({
    version:2,
    mode:'workflow-agent',
    settings:{ masterEnabled:true, workflowAutoEnabled:false, xhsEnabled:true, douyinEnabled:false, xhsKeywords:['测试'], performanceSampleHours:[2,24,72] },
    candidates:[
      candidate('candidate_new', 'new', '仍在候选的新内容'),
      candidate('candidate_selected', 'selected', '等待一做的已选内容'),
      candidate('candidate_generated', 'generated', '已经生产的爆款来源'),
      candidate('candidate_ignored', 'ignored', '已忽略的低质内容')
    ],
    variants:[
      variant('variant_draft', 'candidate_generated', 'draft', '一做制作中成品'),
      variant('variant_published', 'candidate_generated', 'published', '已发布等待数据成品', { publishedAt, publicationUrl:'https://www.xiaohongshu.com/explore/64f123456789abcdef123456', publicationNoteId:'64f123456789abcdef123456', performanceSnapshots:[] }),
      variant('variant_child', 'candidate_generated', 'draft', '二做子版本', { parentVariantId:'variant_published' })
    ],
    publications:[], materials:[], enterpriseProfiles:[], workflowRuns:[], agents:[], activity:[]
  }, null, 2));

  app = spawn(process.execPath, [resolve(appRoot, 'server.cjs')], { cwd:appRoot, windowsHide:true, stdio:['ignore','pipe','pipe'], env:{ ...process.env, CONTENTOPS_PORT:String(port), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_UI_PROFILE_DIR:uiProfile, CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1' } });
  app.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, '测试后台启动');

  session = new ChromeSession({ chromePath, profileDir:uiProfile, port:chromePort, headless:true });
  const opened = await session.openClient(`http://127.0.0.1:${port}/`, `127.0.0.1:${port}`);
  client = opened.client;
  await session.navigate(client, `http://127.0.0.1:${port}/`, 300);
  await waitFor(() => client.evaluate("Boolean(document.querySelector('#producedBoard') && document.querySelector('#candidateList'))", 3000), '1.4.6页面初始化');

  await client.evaluate("document.querySelector('[data-view=\"radar\"]').click(); true");
  const radar = await client.evaluate(`({ titles:[...document.querySelectorAll('#candidateList h3')].map((node) => node.textContent.trim()), count:document.querySelector('#candidateNavCount').textContent.trim() })`);
  assert.deepEqual(radar.titles.sort(), ['仍在候选的新内容','等待一做的已选内容'].sort());
  assert.equal(radar.count, '1');

  await client.evaluate("document.querySelector('[data-view=\"creation\"]').click(); true");
  const production = await client.evaluate(`[...document.querySelectorAll('#variantBoard h3')].map((node) => node.textContent.trim())`);
  assert.deepEqual(production, ['等待一做的已选内容']);

  await client.evaluate("document.querySelector('[data-view=\"produced\"]').click(); true");
  const library = await client.evaluate(`({ titles:[...document.querySelectorAll('#producedBoard h3')].map((node) => node.textContent.trim()), count:document.querySelector('#producedNavCount').textContent.trim() })`);
  assert.deepEqual(library.titles.sort(), ['一做制作中成品','已发布等待数据成品','二做子版本'].sort());
  assert.equal(library.count, '3');
  await client.evaluate("document.querySelector('#producedFilter [data-filter=\"scaled\"]').click(); true");
  const scaledOnly = await client.evaluate(`[...document.querySelectorAll('#producedBoard h3')].map((node) => node.textContent.trim())`);
  assert.deepEqual(scaledOnly, ['二做子版本']);

  await client.evaluate("document.querySelector('[data-view=\"loop\"]').click(); true");
  const loop = await client.evaluate(`({ text:document.querySelector('#loopGrid').textContent, refreshIds:[...document.querySelectorAll('.refresh-performance')].map((node) => node.dataset.id) })`);
  assert.match(loop.text, /已发布等待数据成品/);
  assert.match(loop.text, /等待创作后台首个数据快照/);
  assert.deepEqual(loop.refreshIds, ['variant_published']);

  await client.evaluate(`(() => { const original = window.fetch.bind(window); window.__v146Request = null; window.fetch = (input, init) => { if (String(input) === '/api/performance/collect') { window.__v146Request = JSON.parse(init.body); return Promise.resolve(new Response(JSON.stringify({ ok:true, sampled:0, message:'测试已拦截' }), { status:200, headers:{ 'content-type':'application/json' } })); } return original(input, init); }; document.querySelector('.refresh-performance').click(); return true; })()`);
  const request = await waitFor(() => client.evaluate('window.__v146Request'), '单条读取请求');
  assert.deepEqual(request.variantIds, ['variant_published']);
  assert.equal(request.manual, true);

  console.log(JSON.stringify({ status:'PASS', productMode:process.env.CONTENTOPS_QA_PRODUCT === '1', candidatePoolHidesGenerated:true, productionQueueSeparated:true, producedLibrary:true, publishedWithoutMetricsVisible:true, targetedPerformanceRefresh:true }, null, 2));
} finally {
  try { client?.close(); } catch {}
  try { session?.stop(); } catch {}
  if (app?.pid) try { spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide:true, stdio:'ignore', timeout:8000 }); } catch {}
  await sleep(300);
  await rm(tempRoot, { recursive:true, force:true }).catch(() => {});
  if (stderr) process.stderr.write(stderr);
}
