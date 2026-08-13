import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-master-stop-all-${process.pid}`);
const port = 18100 + (process.pid % 500);
const aiPort = 19600 + (process.pid % 500);
await rm(dataDir, { recursive:true, force:true });

const ai = createServer(async (request, response) => {
  for await (const _chunk of request) {}
  response.writeHead(200, { 'content-type':'application/json' });
  response.end(JSON.stringify({ choices:[{ message:{ content:JSON.stringify({ variants:[] }) } }], usage:{ prompt_tokens:1, completion_tokens:1 } }));
});
await new Promise((done) => ai.listen(aiPort, '127.0.0.1', done));

let child;
const post = (route, body = {}) => fetch(`http://127.0.0.1:${port}${route}`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) }).then((response) => response.json());
const getState = () => fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
const start = async () => {
  child = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, windowsHide:true, stdio:'ignore', env:{ ...process.env, CONTENTOPS_PORT:String(port), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1' } });
  for (let index = 0; index < 80; index += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {} await new Promise((done) => setTimeout(done, 100)); }
  throw new Error('测试服务未启动');
};

try {
  await start();
  await post('/api/settings/save', { workflowAutoEnabled:false, xhsEnabled:true, xhsKeywords:['测试'], manualRawLimit:30, automaticRawLimit:50, manualFinalLimit:10, automaticFinalLimit:10, generationCount:1, scaleGenerationCount:1, imageCount:2, dailyBudget:10, visionDailyBudget:10, imageDailyBudget:10, aiBaseUrl:`http://127.0.0.1:${aiPort}/v1`, aiModel:'test', visionBaseUrl:`http://127.0.0.1:${aiPort}/v1`, visionModel:'test' });
  let state = await getState();
  state.candidates = [
    { id:'candidate_stop', platform:'小红书', title:'总控停止候选', status:'selected', analysisStatus:'completed', analysis:{}, structure:[], imageUrls:[] },
    { id:'candidate_existing', platform:'小红书', title:'已有版本候选', status:'generated', analysisStatus:'completed', analysis:{}, structure:[], imageUrls:[] }
  ];
  state.variants = [
    { id:'variant_stop', candidateId:'candidate_existing', platform:'小红书', account:'测试', title:'总控停止版本', body:'正文', tags:[], status:'draft', decision:'scale', imagePages:[{ id:'page_1', index:1, copy:'A', imagePrompt:'提示词A', asset:null }, { id:'page_2', index:2, copy:'B', imagePrompt:'提示词B', asset:null }], pages:['A','B'], performanceSnapshots:[] },
    { id:'variant_metrics_stop', candidateId:'candidate_existing', platform:'小红书', account:'测试', title:'总控停止数据版本', body:'正文', tags:[], status:'approved', decision:null, imagePages:[], pages:[], performanceSnapshots:[] }
  ];
  state.workflowRuns = [
    { id:'run_blocked_stop', trigger:'manual', status:'blocked', currentStep:'analyze', startedAt:new Date().toISOString(), finishedAt:new Date().toISOString(), steps:[
      { id:'collect', status:'completed', detail:'已抓取' },
      { id:'analyze', status:'blocked', detail:'模型暂不可用' },
      { id:'select', status:'pending', detail:'' },
      { id:'create', status:'pending', detail:'' }
    ], counts:{} }
  ];
  await writeFile(resolve(dataDir, 'state.json'), JSON.stringify(state, null, 2));
  child.kill(); await new Promise((done) => setTimeout(done, 400)); await start();
  const creation = await post('/api/variant/generate', { candidateId:'candidate_stop' });
  const image = await post('/api/variant/image/generate', { id:'variant_stop' });
  const scale = await post('/api/variant/scale', { id:'variant_stop' });
  const metrics = await post('/api/metrics/save', { variantId:'variant_metrics_stop', link:'https://www.xiaohongshu.com/explore/metrics-stop', exposure:1000, likes:10, saves:10, comments:1 });
  for (const [name, result] of Object.entries({ creation, image, scale, metrics })) if (result.code !== 'MASTER_STOPPED') throw new Error(`总控停止未阻断 ${name}：${JSON.stringify(result)}`);
  await post('/api/master/stop');
  state = await getState();
  const cancelledBlockedRun = state.workflowRuns.find((run) => run.id === 'run_blocked_stop');
  if (cancelledBlockedRun?.status !== 'cancelled' || cancelledBlockedRun.steps.find((step) => step.id === 'analyze')?.status !== 'cancelled' || cancelledBlockedRun.steps.find((step) => step.id === 'select')?.status !== 'skipped') throw new Error(`受阻任务未被总控彻底取消：${JSON.stringify(cancelledBlockedRun)}`);
  console.log(JSON.stringify({ status:'PASS', blocked:['creation','image','scale','metrics'], blockedRunCancelled:true }, null, 2));
} finally {
  try { child?.kill(); } catch {}
  await new Promise((done) => ai.close(done));
  await new Promise((done) => setTimeout(done, 300));
  await rm(dataDir, { recursive:true, force:true });
}
