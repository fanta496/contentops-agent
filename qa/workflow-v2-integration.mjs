import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-workflow-${process.pid}-${Date.now()}`);
const dataDir = resolve(tempRoot, 'data');
const profileDir = resolve(tempRoot, 'profile');
const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEILV/5zOFDzdoQCepz6aeExAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELi3cqoDfaKuZM4AAAAASUVORK5CYII=';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const allocatePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.unref();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});
let chromePort = await allocatePort();
while (chromePort === 17841) chromePort = await allocatePort();
const fixture = await readFile(resolve(root, 'qa', 'fixtures', 'xhs-search.html'));
await rm(dataDir, { recursive: true, force: true });
await rm(profileDir, { recursive: true, force: true });

const xhs = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:19996');
  const id = url.pathname.match(/^\/(?:explore|search_result)\/(.+)$/)?.[1];
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (!id) return response.end(fixture);
  response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><script type="application/ld+json">${JSON.stringify({ '@type':'Article', headline: id === 'note-alpha' ? '企业内容怎么稳定找到选题' : '低成本内容增长清单', articleBody: `这是${id}的公开正文 #内容运营 #企业增长`, datePublished:'2026-07-18T15:15:00+08:00', author:{ name:id === 'note-alpha' ? '运营研究所' : '增长笔记' }, image:[`http://127.0.0.1:19996/images/${id}-1.jpg`,`http://127.0.0.1:19996/images/${id}-2.jpg`] })}</script></head><body><article class="note-detail"><h1>${id}</h1><div class="like-wrapper"><span class="count">1.3万</span></div><div class="collect-wrapper"><span class="count">3400</span></div><div class="comment-wrapper"><span class="count">89</span></div></article></body></html>`);
});

let aiCalls = 0;
const ai = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const payload = JSON.parse(raw);
  const rawPrompt = payload.messages?.at(-1)?.content || payload.input?.[0]?.content?.find((item) => item.type === 'input_text')?.text || '';
  const prompt = typeof rawPrompt === 'string' ? rawPrompt : Array.isArray(rawPrompt) ? rawPrompt.map((item) => item?.text || item?.content || '').join('\n') : '';
  aiCalls += 1;
  let data;
  const assetId = prompt.match(/"id"\s*:\s*"(asset_[^"]+)"/)?.[1] || '';
  const groundedVariant = (title, body, format, pageCopies) => ({
    title, body:`这是可核实的真实事实，也是可用卖点。${body}`, tags:['测试'], format, audience:'企业运营',
    enterpriseGrounding:{ productAngle:'以测试服务解决企业内容问题', factsUsed:['这是可核实的真实事实'], sellingPointsUsed:['这是可用卖点'], proofPointsUsed:[], assetIds:[assetId], assetUsage:[`${assetId}：第1页使用企业参考图，不改动主体`] },
    visualStrategy:{ concept:'企业服务方法清单', coverHook:'结果前置', continuity:'统一蓝白配色和企业主体', palette:['蓝白'], avoidGeneric:['不得使用无关图库图'] },
    imagePages:pageCopies.map((copy, pageIndex) => ({ role:pageIndex === 0 ? 'cover' : 'process', purpose:`承接第${pageIndex + 1}步信息`, copy, imagePrompt:`第${pageIndex + 1}页围绕企业服务的原创图片提示词` }))
  });
  const isVision = request.url.endsWith('/responses') || Array.isArray(payload.messages?.at(-1)?.content) && payload.messages.at(-1).content.some((item) => item.type === 'image_url');
  if (isVision) data = { visualScore:88, coverHook:'大字结果封面', visualSummary:'清单型图组', pages:[{index:1,visibleText:'稳定选题',scene:'信息图',layout:'标题居中',colors:'蓝白',role:'封面'}], sequence:['封面','方法','行动'], visualHooks:['大字标题'], generationHints:['蓝白信息图'], risks:['不要复制原图'], lowConfidencePages:[] };
  if (prompt.includes('创作 10 套')) data = { variants: Array.from({ length: 10 }, (_, index) => groundedVariant(`首次生产${index + 1}`, `原创正文${index + 1}`, '清单型', ['封面','问题','方法','行动'])) };
  else if (prompt.includes('创作 5 套')) data = { variants: Array.from({ length: 5 }, (_, index) => groundedVariant(`二做版本${index + 1}`, `二做原创正文${index + 1}`, '复盘型', ['封面','胜出元素','新角度','行动'])) };
  else if (prompt.includes('已发布图文')) data = { decision:'scale', reason:'收藏与互动达到放大阈值', winningElements:['结果前置','清单结构'], nextDirections:['更具体案例','更强首图'], confidence:92 };
  else if (!data && prompt.includes('第一阶段文本分析')) data = { textScore:90, summary:'文本高潜', tags:['方法型'], structure:['结果前置','步骤清单'], hooks:['结果钩子'], valuePoints:['可执行'], concerns:['适用范围'], risks:['事实核对'], textStrengths:['清晰'], textWeaknesses:['案例不足'], recommended:true };
  else if (!data) data = { score:91, summary:'高潜方法型公开图文', tags:['方法型','高收藏'], structure:['结果前置','问题拆解','步骤清单','行动建议'], hooks:['结果钩子'], valuePoints:['可执行'], concerns:['适用范围'], risks:['事实需人工核对'], recommended:true, productionBlueprint:{topic:'原创选题方法',audience:'企业运营',tone:'专业',textPlan:['问题','方法'],imagePlan:[{index:1,purpose:'封面',copy:'稳定选题',visualPrompt:'蓝白信息图',avoid:['来源图形']}],mustVerify:['案例数据']} };
  response.writeHead(200, { 'content-type':'application/json' });
  response.end(request.url.endsWith('/responses') ? JSON.stringify({ status:'completed', output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(data)}]}], usage:{input_tokens:120,output_tokens:60,total_tokens:180} }) : JSON.stringify({ choices:[{ message:{ content:JSON.stringify(data) } }], usage:{ prompt_tokens:100, completion_tokens:50, total_tokens:150 } }));
});

await Promise.all([
  new Promise((done) => xhs.listen(19996, '127.0.0.1', done)),
  new Promise((done) => ai.listen(19995, '127.0.0.1', done))
]);

const port = 17836;
const child = spawn(process.execPath, [resolve(root, 'server.cjs')], {
  cwd: root,
  env: { ...process.env, CONTENTOPS_PORT:String(port), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_XHS_PROFILE_DIR:profileDir, CONTENTOPS_XHS_CHROME_PORT:String(chromePort), CONTENTOPS_XHS_SEARCH_BASE_URL:'http://127.0.0.1:19996/xhs-search.html', CONTENTOPS_COLLECTOR_HEADLESS:'1', CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1', CONTENTOPS_TEST_BYPASS_IMAGE_GATE:'1' },
  windowsHide:true, stdio:['ignore','pipe','pipe']
});
let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
const post = (route, body = {}) => fetch(`http://127.0.0.1:${port}${route}`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) }).then((response) => response.json());
const getState = () => fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());

async function stopAppTree() {
  if (child.exitCode !== null) return;
  try { spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide:true, stdio:'ignore', timeout:8000 }); } catch {}
  if (child.exitCode === null) try { child.kill(); } catch {}
  await Promise.race([new Promise((done) => child.once('close', done)), sleep(1500)]).catch(() => {});
}

function profileChromeProcesses() {
  const listed = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  ], { windowsHide:true, encoding:'utf8', timeout:10000 });
  if (listed.status !== 0 || !listed.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(listed.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => {
      const commandLine = String(item?.CommandLine || '');
      return commandLine.includes(profileDir);
    });
  } catch { return []; }
}

function stopProfileChrome() {
  for (const processInfo of profileChromeProcesses()) {
    try { spawnSync('taskkill.exe', ['/PID', String(processInfo.ProcessId), '/T', '/F'], { windowsHide:true, stdio:'ignore', timeout:8000 }); } catch {}
  }
}

function assertNoProfileChrome() {
  const remaining = profileChromeProcesses();
  if (remaining.length) throw new Error(`测试结束后仍残留本次专用 Chrome/Profile 进程：${remaining.map((item) => item.ProcessId).join(',')}`);
}

try {
  for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise((done) => setTimeout(done, 100)); }
  const settings = await post('/api/settings/save', { workflowAutoEnabled:false, xhsEnabled:true, xhsKeywords:['内容运营'], xhsMaxPerKeyword:2, xhsScrollRounds:0, xhsDelayMs:1000, dailyCandidateLimit:50, aiAnalysisLimit:10, generationCount:10, imageCount:4, dailyBudget:100, aiBaseUrl:'http://127.0.0.1:19995/v1', aiModel:'local-model', aiInputPricePerMillion:1, aiOutputPricePerMillion:2, visionDailyBudget:100, visionBaseUrl:'http://127.0.0.1:19995/v1', visionModel:'local-vision', visionInputPricePerMillion:2, visionOutputPricePerMillion:3, visionMaxImages:12, feishuWebhook:'' });
  if (!settings.ok) throw new Error(settings.message);
  const credential = await post('/api/ai/credential/save', { apiKey:'local-test-key' }); if (!credential.ok) throw new Error(credential.message);
  const visionCredential = await post('/api/vision/credential/save', { apiKey:'local-vision-key' }); if (!visionCredential.ok) throw new Error(visionCredential.message);
  const enterprise = await post('/api/enterprise-profile/save', { name:'测试企业资料库', brandName:'测试品牌', productName:'测试服务', productFacts:['这是可核实的真实事实'], sellingPoints:['这是可用卖点'], makeActive:true }); if (!enterprise.ok) throw new Error(enterprise.message);
  const enterpriseImage = await post('/api/enterprise-image/upload', { profileId:enterprise.profile.id, mime:'image/png', data:onePixelPng, name:'工作流测试企业图', kind:'product', description:'用于完整工作流回归的企业服务参考图' }); if (!enterpriseImage.ok) throw new Error(enterpriseImage.message);
  const master = await post('/api/master/start'); if (!master.ok) throw new Error(master.message);
  const runResult = await post('/api/workflow/run'); if (!runResult.ok) throw new Error(`工作流未接单：${JSON.stringify(runResult)}`);
  let state; for (let attempt = 0; attempt < 160; attempt += 1) { state = await getState(); if (state.workflowRuns[0]?.status === 'waiting_human') break; await sleep(100); } const run = state.workflowRuns[0];
  if (run.status !== 'waiting_human' || run.currentStep !== 'select' || state.candidates.length !== 2 || state.candidates.some((item) => item.detailStatus !== 'enriched' || !item.body || item.metrics.saves !== 3400 || !item.textAnalysis || !item.visionAnalysis || !item.analysis?.productionBlueprint)) throw new Error('抓取、文本、视觉或综合复审阶段异常');
  const candidate = state.candidates[0]; const selected = await post('/api/candidate/status', { id:candidate.id, status:'selected' }); if (!selected.ok) throw new Error(selected.message);
  const generated = await post('/api/variant/generate', { candidateId:candidate.id }); if (!generated.ok) throw new Error(generated.message);
  state = await getState(); const variants = state.variants.filter((item) => item.candidateId === candidate.id && !item.parentVariantId); if (variants.length !== 10) throw new Error(`首次生产数量异常：${variants.length}`);
  const variant = variants[0]; await post('/api/variant/status', { id:variant.id, status:'pending' }); await post('/api/variant/status', { id:variant.id, status:'approved' });
  const metrics = await post('/api/metrics/save', { variantId:variant.id, publishedAt:'2026-07-18T15:15:00+08:00', exposure:10000, likes:900, saves:700, comments:180, link:'https://www.xiaohongshu.com/explore/result' }); if (!metrics.ok || metrics.decision !== 'test' || metrics.final) throw new Error(`人工登记门禁异常：${JSON.stringify(metrics)}`);
  state = await getState(); const finalRun = state.workflowRuns.find((item) => item.id === run.id);
  if (finalRun.status !== 'waiting_human' || finalRun.steps.find((step) => step.id === 'performance')?.status !== 'waiting_human' || finalRun.steps.find((step) => step.id === 'scale')?.status === 'completed') throw new Error('人工登记后不应绕过后台采样进入二做');
  console.log(JSON.stringify({ status:'PASS', runId:run.id, candidates:state.candidates.length, firstVariants:variants.length, runStatus:finalRun.status, actualCost:finalRun.actualCost, aiCalls, manualPublishGate:true, isolatedChromePort:chromePort, isolatedProfile:true }, null, 2));
} finally {
  await stopAppTree();
  stopProfileChrome();
  await sleep(300);
  assertNoProfileChrome();
  await Promise.all([
    new Promise((done) => xhs.close(() => done())),
    new Promise((done) => ai.close(() => done()))
  ]);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { await rm(dataDir, { recursive:true, force:true }); await rm(profileDir, { recursive:true, force:true }); break; }
    catch { await sleep(250); }
  }
  await rm(tempRoot, { recursive:true, force:true }).catch(() => {});
  if (stderr) process.stderr.write(stderr);
}

