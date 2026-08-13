import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-first-creation-${process.pid}`);
const port = 17857;
const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEILV/5zOFDzdoQCepz6aeExAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELi3cqoDfaKuZM4AAAAASUVORK5CYII=';
await rm(dataDir, { recursive: true, force: true });
const ai = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  if (req.url.endsWith('/images/generations')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (body.model === 'url-only-test') return res.end(JSON.stringify({ data: [{ url: 'https://example.invalid/temporary-image.png' }] }));
    if (body.model === 'invalid-b64-test') return res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('not-an-image').toString('base64') }] }));
    return res.end(JSON.stringify({ data: [{ b64_json: onePixelPng.split(',')[1], revised_prompt: '已校正提示词' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  }
  const prompt = body.messages?.at(-1)?.content || '';
  const count = Number(prompt.match(/创作\s+(\d+)\s+套/)?.[1] || 1);
  const imageCount = Number(prompt.match(/恰好有\s+(\d+)\s+个 imagePages/)?.[1] || 2);
  const assetId = prompt.match(/"id"\s*:\s*"(asset_[^"]+)"/)?.[1] || '';
  const variants = Array.from({ length: count }, (_, index) => ({
    title: `原创标题${index + 1}`,
    body: `围绕可核实事实和清晰卖点展开的原创正文${index + 1}`,
    tags: ['企业内容'],
    format: '清单型',
    audience: '目标客户',
    enterpriseGrounding: { productAngle:'用企业真实产品解决用户问题', factsUsed:['可核实事实'], sellingPointsUsed:['清晰卖点'], proofPointsUsed:[], assetIds:[assetId], assetUsage:[`${assetId}：第1页使用产品参考图，包装与标识不可改动`] },
    visualStrategy: { concept:'真实产品问题清单', coverHook:'产品主体加问题钩子', continuity:'统一品牌蓝与产品主体', palette:['品牌蓝'], avoidGeneric:['不得使用无关图库素材'] },
    imagePages: Array.from({ length: imageCount }, (_, pageIndex) => ({ role:pageIndex === 0 ? 'cover' : 'action', purpose:pageIndex === 0 ? '建立停留钩子' : '承接企业事实', copy: `第${pageIndex + 1}页文案`, imagePrompt: `第${pageIndex + 1}页围绕真实产品的原创中文生图提示词` }))
  }));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ variants }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
});
await new Promise((done) => ai.listen(19993, '127.0.0.1', done));
const child = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd: root, env: { ...process.env, CONTENTOPS_PORT: String(port), CONTENTOPS_DATA_DIR: dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const post = (route, body = {}) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.json());
const state = () => fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
let child2;
try {
  for (let index = 0; index < 80; index += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise((done) => setTimeout(done, 100)); }
  await post('/api/settings/save', { workflowAutoEnabled: false, xhsEnabled: true, xhsKeywords: ['测试'], manualRawLimit: 30, automaticRawLimit: 50, manualFinalLimit: 10, automaticFinalLimit: 10, dailyCandidateLimit: 20, aiAnalysisLimit: 5, generationCount: 1, scaleGenerationCount: 1, imageCount: 2, imageDailyBudget: 20, imageCostPerImage: 1, dailyBudget: 20, visionDailyBudget: 20, visionMaxImages: 2, aiBaseUrl: 'http://127.0.0.1:19993/v1', aiModel: 'text-test', visionBaseUrl: 'http://127.0.0.1:19993/v1', visionModel: 'vision-test' });
  await post('/api/ai/credential/save', { apiKey: 'text-key' });
  const enterprise = await post('/api/enterprise-profile/save', { name: '企业资料', brandName: '测试品牌', productName: '测试产品', productFacts: ['可核实事实'], sellingPoints: ['清晰卖点'], forbiddenClaims: ['禁止夸大'], visualRules: ['品牌蓝'], makeActive: true });
  if (!enterprise.ok) throw new Error(enterprise.message);
  const urlOnly = await post('/api/model-profile/save', { kind: 'image', name: '仅URL生图', provider: 'test', baseUrl: 'http://127.0.0.1:19993/v1', model: 'url-only-test', apiKey: 'url-key', inputPricePerMillion: 0, outputPricePerMillion: 0 });
  const urlOnlyTest = await post('/api/model-profile/test', { kind: 'image', id: urlOnly.profile.id }); if (urlOnlyTest.ok) throw new Error('不可下载的 URL 生图档案不应测试通过');
  const invalidB64 = await post('/api/model-profile/save', { kind: 'image', name: '伪图片Base64', provider: 'test', baseUrl: 'http://127.0.0.1:19993/v1', model: 'invalid-b64-test', apiKey: 'invalid-key', inputPricePerMillion: 0, outputPricePerMillion: 0 });
  const invalidB64Test = await post('/api/model-profile/test', { kind:'image', id:invalidB64.profile.id }); if (invalidB64Test.ok) throw new Error('非图片 Base64 生图档案不应测试通过');
  const savedImage = await post('/api/model-profile/save', { kind: 'image', name: '本地生图', provider: 'test', baseUrl: 'http://127.0.0.1:19993/v1', model: 'image-test', apiKey: 'image-key', inputPricePerMillion: 0, outputPricePerMillion: 0 });
  const tested = await post('/api/model-profile/test', { kind: 'image', id: savedImage.profile.id }); if (!tested.ok) throw new Error(tested.message);
  const active = await post('/api/model-profile/activate', { kind: 'image', id: savedImage.profile.id }); if (!active.ok) throw new Error(active.message);
  const file = resolve(dataDir, 'state.json'); const current = await state(); current.candidates = [{ id: 'candidate_first', platform: '小红书', title: '爆款参考', body: '来源正文，只可借鉴结构', tags: ['参考'], metrics: {}, status: 'selected', analysisStatus: 'completed', analysis: { summary: '分析摘要', hooks: ['结果前置'], valuePoints: ['实用'], concerns: ['适用范围'], productionBlueprint: {} }, structure: ['钩子', '方法'], imageUrls: [] }];
  current.workflowRuns = [{ id:'run_blocked_creation_retry', trigger:'manual', status:'blocked', currentStep:'create', startedAt:new Date().toISOString(), finishedAt:new Date().toISOString(), candidateIds:['candidate_first'], error:'旧的企业素材库资料不足', counts:{ generated:0, approved:0 }, actualCost:0, steps:[{id:'create',status:'blocked',detail:'旧错误'},{id:'publish',status:'pending',detail:''}] }];
  await (await import('node:fs/promises')).writeFile(file, JSON.stringify(current, null, 2));
  child.kill();
  await new Promise((done) => {
    if (child.exitCode !== null) return done();
    child.once('exit', done);
    setTimeout(done, 5000);
  });
  child2 = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd: root, env: { ...process.env, CONTENTOPS_PORT: String(port), CONTENTOPS_DATA_DIR: dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let child2Output = '';
  child2.stdout.on('data', (chunk) => { child2Output += chunk; });
  child2.stderr.on('data', (chunk) => { child2Output += chunk; });
  let child2Ready = false;
  for (let index = 0; index < 80; index += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { child2Ready = true; break; } } catch {} await new Promise((done) => setTimeout(done, 100)); }
  if (!child2Ready) throw new Error(`Server restart failed: ${child2Output.trim() || `exit=${child2.exitCode}`}`);
  const master = await post('/api/master/start'); if (!master.ok) throw new Error(master.message);
  const generated = await post('/api/variant/generate', { candidateId: 'candidate_first' }); if (!generated.ok || generated.count !== 1) throw new Error(`策划失败：${JSON.stringify(generated)}`);
  let after = await state(); const variant = after.variants[0]; const recoveredRun = after.workflowRuns.find((item) => item.id === 'run_blocked_creation_retry'); if (variant.status !== 'draft' || variant.workflowRunId !== recoveredRun.id || recoveredRun.status !== 'waiting_human' || recoveredRun.error || variant.imagePages.length !== 2 || !variant.imagePages.every((page) => page.imagePrompt)) throw new Error('没有正确恢复受阻的一做任务或保存可编辑图片提示词草稿');
  const gated = await post('/api/variant/status', { id: variant.id, status: 'pending' }); if (gated.ok) throw new Error('没有图片时不应能提交审核');
  const made = await post('/api/variant/image/generate', { id: variant.id }); if (!made.ok || made.count !== 2 || !made.accepted) throw new Error(`生图任务未接单：${JSON.stringify(made)}`);
  for (let index = 0; index < 80; index += 1) { after = await state(); if (!['queued', 'running'].includes(after.variants[0].imageJob?.status)) break; await new Promise((done) => setTimeout(done, 100)); }
  const ready = after.variants[0]; if (ready.imageStatus !== 'ready' || !ready.imagePages.every((page) => page.asset?.file)) throw new Error('生图资产未落盘');
  const image = await fetch(`http://127.0.0.1:${port}/api/image/${ready.id}/1`); if (!image.ok) throw new Error('本地图片预览接口不可用');
  const unchangedPages = ready.imagePages.map((page) => ({ id:page.id, index:page.index, copy:page.copy, imagePrompt:page.imagePrompt }));
  const unchangedSave = await post('/api/variant/update', { id:ready.id, imageReferencePolicy:ready.imageReferencePolicy, title:ready.title, body:ready.body, tags:ready.tags, imagePages:unchangedPages });
  after = await state(); if (!unchangedSave.ok || unchangedSave.invalidated !== 0 || !after.variants[0].imagePages.every((page) => page.asset?.file)) throw new Error('工作台无改动保存不应废弃已生成图片');
  const changedPages = ready.imagePages.map((page, index) => ({ id: page.id, index: page.index, copy: page.copy, imagePrompt: index === 0 ? `${page.imagePrompt}（已改）` : page.imagePrompt }));
  const edited = await post('/api/variant/update', { id: ready.id, title: ready.title, body: ready.body, tags: ready.tags, imagePages: changedPages }); if (!edited.ok || edited.invalidated !== 1) throw new Error('改提示词后没有正确废弃旧图片');
  after = await state(); if (after.variants[0].imagePages[0].asset || !after.variants[0].imagePages[1].asset) throw new Error('图片废弃范围错误');
  const gatedAgain = await post('/api/variant/status', { id: ready.id, status: 'pending' }); if (gatedAgain.ok) throw new Error('改提示词后应重新触发图片审核门禁');
  const remade = await post('/api/variant/image/generate', { id: ready.id, pageIds: [changedPages[0].id] }); if (!remade.ok || remade.count !== 1 || !remade.accepted) throw new Error('废弃图片任务未启动');
  for (let index = 0; index < 80; index += 1) { after = await state(); if (!['queued', 'running'].includes(after.variants[0].imageJob?.status)) break; await new Promise((done) => setTimeout(done, 100)); }
  const pending = await post('/api/variant/status', { id: ready.id, status: 'pending' });
  const activityAfterPending = (await state()).activity.length;
  const duplicatePending = await post('/api/variant/status', { id: ready.id, status: 'pending' });
  const activityAfterDuplicate = (await state()).activity.length;
  const approved = await post('/api/variant/status', { id: ready.id, status: 'approved' });
  if (!pending.ok || !approved.ok || !duplicatePending.existing || activityAfterDuplicate !== activityAfterPending) throw new Error('图片审核流或重复提交幂等异常');
  const exportDir = resolve(dataDir, 'chosen-export'); await post('/api/variant/export-directory', { id: ready.id, directory: exportDir }); const exported = await post('/api/variant/export', { id: ready.id }); if (!exported.ok) throw new Error(exported.message);
  const names = await (await import('node:fs/promises')).readdir(exported.path); if (!['标题.txt', '正文.txt', '标签.txt', '图片提示词.txt', '01.png', '02.png'].every((name) => names.includes(name))) throw new Error(`导出发布包不完整：${names.join(',')}`);
  child2.kill(); console.log(JSON.stringify({ status: 'PASS', imagePages: ready.imagePages.length, exportPath: exported.path, gatedBeforeImages: !gated.ok, unchangedSavePreservedImages:true, promptEditInvalidated: edited.invalidated, urlOnlyRejected: !urlOnlyTest.ok, invalidBase64Rejected:!invalidB64Test.ok, textOnlyEnterpriseLibraryAllowed:true }, null, 2));
} finally { child.kill(); child2?.kill(); ai.close(); await new Promise((done) => setTimeout(done, 300)); await rm(dataDir, { recursive: true, force: true }); }
