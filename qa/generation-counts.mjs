import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-generation-counts-${process.pid}`);
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

await rm(dataDir, { recursive:true, force:true });
const appPort = await allocatePort();
const aiPort = await allocatePort();
const ai = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw || '{}');
  const prompt = body.messages?.at(-1)?.content || '';
  const match = prompt.match(/创作\s+(\d+)\s+套/);
  let data = { ok:true };
  if (match) {
    const count = Number(match[1]);
    const assetId = prompt.match(/"id"\s*:\s*"(asset_[^"]+)"/)?.[1] || '';
    data = {
      variants:Array.from({ length:count }, (_, index) => ({
        title:`版本${index + 1}`,
        body:`真实事实与真实卖点对应的正文${index + 1}`,
        tags:['测试'],
        format:'测试',
        audience:'测试',
        enterpriseGrounding:{ productAngle:'以测试产品承接内容', factsUsed:['真实事实'], sellingPointsUsed:['真实卖点'], proofPointsUsed:[], assetIds:[assetId], assetUsage:[`${assetId}：第1页使用产品图，主体不可改动`] },
        visualStrategy:{ concept:'真实产品双页清单', coverHook:'产品结果前置', continuity:'统一产品主体与品牌色', palette:['品牌色'], avoidGeneric:['不得使用无关图库图'] },
        imagePages:[
          { role:'cover', purpose:'建立停留钩子', copy:'封面', imagePrompt:'围绕真实测试产品的原创封面底图提示词' },
          { role:'action', purpose:'承接行动建议', copy:'内容', imagePrompt:'围绕真实测试产品的原创内容底图提示词' }
        ]
      }))
    };
  }
  response.writeHead(200, { 'content-type':'application/json' });
  response.end(JSON.stringify({ choices:[{ message:{ content:JSON.stringify(data) } }], usage:{ prompt_tokens:10, completion_tokens:10, total_tokens:20 } }));
});
await new Promise((done) => ai.listen(aiPort, '127.0.0.1', done));

const env = { ...process.env, CONTENTOPS_PORT:String(appPort), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1' };
let child = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, env, windowsHide:true, stdio:['ignore','pipe','pipe'] });
let child2 = null;
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
const post = (route, body = {}) => fetch(`http://127.0.0.1:${appPort}${route}`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) }).then((response) => response.json());
const getState = () => fetch(`http://127.0.0.1:${appPort}/api/state`).then((response) => response.json());
const waitUntilReady = async () => {
  for (let index = 0; index < 80; index += 1) {
    try { if ((await fetch(`http://127.0.0.1:${appPort}/health`)).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error(`测试后台未启动：${stderr || appPort}`);
};
const stopChild = async (processHandle) => {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill();
  await Promise.race([new Promise((done) => processHandle.once('exit', done)), sleep(2000)]);
};

try {
  await waitUntilReady();
  const settings = await post('/api/settings/save', { workflowAutoEnabled:false, xhsEnabled:true, xhsKeywords:['测试'], manualRawLimit:30, automaticRawLimit:50, manualFinalLimit:10, automaticFinalLimit:10, aiAnalysisLimit:10, generationCount:3, scaleGenerationCount:2, imageCount:2, dailyBudget:100, aiBaseUrl:`http://127.0.0.1:${aiPort}/v1`, aiModel:'test', aiInputPricePerMillion:1, aiOutputPricePerMillion:1, visionDailyBudget:1, visionBaseUrl:`http://127.0.0.1:${aiPort}/v1`, visionModel:'test', visionInputPricePerMillion:1, visionOutputPricePerMillion:1, visionMaxImages:2 });
  if (!settings.ok) throw new Error(settings.message);
  const credential = await post('/api/ai/credential/save', { apiKey:'test' });
  if (!credential.ok) throw new Error(credential.message);
  const enterprise = await post('/api/enterprise-profile/save', { name:'测试资料库', brandName:'测试品牌', productName:'测试产品', productFacts:['真实事实'], sellingPoints:['真实卖点'], makeActive:true });
  if (!enterprise.ok) throw new Error(enterprise.message);
  const enterpriseImage = await post('/api/enterprise-image/upload', { profileId:enterprise.profile.id, mime:'image/png', data:onePixelPng, name:'数量测试产品图', kind:'product', description:'用于验证一做数量设置的企业产品参考图' });
  if (!enterpriseImage.ok) throw new Error(enterpriseImage.message);
  const statePath = resolve(dataDir, 'state.json');
  let current = await getState();
  current.candidates = [{ id:'candidate_1', platform:'小红书', title:'母版', status:'selected', analysisStatus:'completed', analysis:{ summary:'测试', hooks:[], valuePoints:[], concerns:[], productionBlueprint:{} }, structure:[], metrics:{}, imageUrls:[] }];
  await writeFile(statePath, JSON.stringify(current, null, 2));
  await stopChild(child);
  child2 = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, env, windowsHide:true, stdio:['ignore','pipe','pipe'] });
  child2.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitUntilReady();
  const master = await post('/api/master/start');
  if (!master.ok) throw new Error(`总控未开启:${JSON.stringify(master)}`);
  const generated = await post('/api/variant/generate', { candidateId:'candidate_1' });
  if (!generated.ok || generated.count !== 3) throw new Error(`一做数量未生效:${JSON.stringify(generated)}`);
  current = await getState();
  if (current.variants.filter((variant) => variant.candidateId === 'candidate_1').length !== 3) throw new Error('一做实际版本数不是3');
  console.log(JSON.stringify({ status:'PASS', generationCount:3, scaleGenerationCountSaved:current.settings.scaleGenerationCount, enterpriseImageGrounding:true }, null, 2));
} finally {
  await stopChild(child);
  await stopChild(child2);
  ai.close();
  await sleep(300);
  await rm(dataDir, { recursive:true, force:true });
  if (stderr) process.stderr.write(stderr);
}
