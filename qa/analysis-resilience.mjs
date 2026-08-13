import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-resilience-${process.pid}`);
const appPort = 17858; const aiPort = 19998;
await rm(dataDir, { recursive:true, force:true });
let visionCalls = 0;
const ai = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw || '{}'); const content = body.messages?.at(-1)?.content || [];
  const visual = Array.isArray(content) && content.some((item) => item.type === 'image_url');
  if (visual && ++visionCalls === 1) { res.writeHead(503, { 'content-type':'application/json' }); return res.end(JSON.stringify({ error:{ message:'temporary upstream outage' } })); }
  const serialized = JSON.stringify(body); const data = serialized.includes('连接成功') ? { ok:true, message:'连接成功' } : visual ? { visualScore:80, coverHook:'封面钩子', visualSummary:'视觉摘要', pages:[], sequence:[], visualHooks:[], generationHints:[], risks:[], lowConfidencePages:[] } : serialized.includes('第一阶段文本分析') ? { textScore:80, summary:'文本摘要', tags:[], structure:[], hooks:[], valuePoints:[], concerns:[], risks:[], textStrengths:[], textWeaknesses:[], recommended:true } : { score:80, summary:'综合摘要', tags:[], structure:[], hooks:[], valuePoints:[], concerns:[], risks:[], recommended:true, productionBlueprint:{} };
  res.writeHead(200, { 'content-type':'application/json' }); res.end(JSON.stringify({ choices:[{ message:{ content:JSON.stringify(data) } }], usage:{ prompt_tokens:1, completion_tokens:1 } }));
});
await new Promise((done) => ai.listen(aiPort, '127.0.0.1', done));
const child = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, env:{ ...process.env, CONTENTOPS_PORT:String(appPort), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1' }, windowsHide:true, stdio:'ignore' });
const post = (route, body={}) => fetch(`http://127.0.0.1:${appPort}${route}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) }).then((r) => r.json());
const state = () => fetch(`http://127.0.0.1:${appPort}/api/state`).then((r) => r.json());
try {
  for (let i=0;i<80;i+=1) { try { if ((await fetch(`http://127.0.0.1:${appPort}/health`)).ok) break; } catch {} await new Promise((done)=>setTimeout(done,100)); }
  await post('/api/settings/save', { workflowAutoEnabled:false, xhsEnabled:true, xhsKeywords:['测试'], analysisConcurrency:2, analysisAutoRetryCount:1, aiAnalysisLimit:10, dailyBudget:100, visionDailyBudget:100, visionMaxImages:1, aiBaseUrl:`http://127.0.0.1:${aiPort}/v1`, aiModel:'text', visionBaseUrl:`http://127.0.0.1:${aiPort}/v1`, visionModel:'vision' });
  await post('/api/ai/credential/save', { apiKey:'text-key' }); await post('/api/vision/credential/save', { apiKey:'vision-key' }); await post('/api/ai/test'); await post('/api/vision/test'); await post('/api/master/start');
  const current = await state(); current.candidates = ['A','B'].map((title, index) => ({ id:`candidate_${index}`, platform:'小红书', title, author:'QA', keyword:'测试', body:'正文', status:'new', detailStatus:'enriched', imageUrls:[`http://127.0.0.1:${aiPort}/image-${index}.jpg`], analysisStatus:'pending', metrics:{} }));
  await writeFile(resolve(dataDir, 'state.json'), JSON.stringify(current)); child.kill(); await new Promise((done)=>setTimeout(done,400));
  const child2 = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, env:{ ...process.env, CONTENTOPS_PORT:String(appPort), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1' }, windowsHide:true, stdio:'ignore' });
  for (let i=0;i<80;i+=1) { try { if ((await fetch(`http://127.0.0.1:${appPort}/health`)).ok) break; } catch {} await new Promise((done)=>setTimeout(done,100)); }
  const textProfile = await post('/api/model-profile/save', { kind:'text', name:'text', baseUrl:`http://127.0.0.1:${aiPort}/v1`, model:'text', apiKey:'text-key' });
  const visionProfile = await post('/api/model-profile/save', { kind:'vision', name:'vision', baseUrl:`http://127.0.0.1:${aiPort}/v1`, model:'vision', apiKey:'vision-key' });
  await post('/api/model-profile/test', { kind:'text', id:textProfile.profile.id });
  // The first visual request deliberately fails. Test again so activation proves the retryable service recovered.
  await post('/api/model-profile/test', { kind:'vision', id:visionProfile.profile.id });
  await post('/api/model-profile/test', { kind:'vision', id:visionProfile.profile.id });
  await post('/api/model-profile/activate', { kind:'text', id:textProfile.profile.id }); await post('/api/model-profile/activate', { kind:'vision', id:visionProfile.profile.id });
  await post('/api/master/start');
  const first = await post('/api/candidate/analyze', { id:'candidate_0' });
  const second = await post('/api/candidate/analyze', { id:'candidate_1' });
  const after = await state();
  if (!first.ok || !second.ok || after.candidates.filter((item) => item.analysisStatus === 'completed').length !== 2 || visionCalls < 3) throw new Error(JSON.stringify({ first, second, statuses:after.candidates.map((item) => ({ id:item.id, status:item.analysisStatus, task:item.analysisTask })), visionCalls }));
  child2.kill(); console.log(JSON.stringify({ status:'PASS', transientVisionRetry:true, otherCandidateContinues:true, visionCalls }, null, 2));
} finally { child.kill(); ai.close(); await new Promise((done)=>setTimeout(done,300)); await rm(dataDir, { recursive:true, force:true }); }
