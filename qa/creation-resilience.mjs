import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-creation-${process.pid}`);
const appPort = 18300 + (process.pid % 300); const aiPort = 19300 + (process.pid % 300);
const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEILV/5zOFDzdoQCepz6aeExAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELi3cqoDfaKuZM4AAAAASUVORK5CYII=';
await rm(dataDir, { recursive:true, force:true }); let calls = 0;
const ai = createServer(async (req, res) => {
  let raw=''; for await (const part of req) raw += part;
  const body = JSON.parse(raw || '{}'); const prompt = body.messages?.at(-1)?.content || ''; const count = Number(prompt.match(/创作\s+(\d+)\s+套/)?.[1] || 2);
  calls += 1;
  if (calls === 1) { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]})); }
  if (calls === 2) { res.writeHead(503, {'content-type':'application/json'}); return res.end(JSON.stringify({error:{message:'upstream temporary unavailable'}})); }
  const assetId = prompt.match(/"id"\s*:\s*"(asset_[^"]+)"/)?.[1] || '';
  const variants = Array.from({length:count}, (_, index) => ({
    title:`策划${index + 1}`,
    body:`基于真实事实和真实卖点的正文${index + 1}`,
    tags:['测试'],
    enterpriseGrounding:{
      productAngle:'以企业真实产品为内容主角',
      factsUsed:['真实事实'],
      sellingPointsUsed:['真实卖点'],
      proofPointsUsed:[],
      assetIds:[assetId],
      assetUsage:[`${assetId}：第1页使用产品原图，包装与标识不可改动`]
    },
    visualStrategy:{ concept:'真实产品场景化清单', coverHook:'产品原图加问题钩子', continuity:'统一品牌色与真实产品主体', palette:['品牌色'], avoidGeneric:['不得用无关图库图'] },
    imagePages:[{role:'cover',purpose:'建立停留钩子',copy:'封面',imagePrompt:'真实产品居中，预留标题区的原创封面底图'},{role:'evidence',purpose:'展示企业事实',copy:'正文1',imagePrompt:'围绕真实事实的原创证据页底图'},{role:'process',purpose:'解释使用过程',copy:'正文2',imagePrompt:'围绕真实产品使用过程的原创底图'},{role:'action',purpose:'给出行动建议',copy:'行动',imagePrompt:'延续同一产品与品牌色的原创行动页底图'}]
  }));
  res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({variants})}}],usage:{prompt_tokens:10,completion_tokens:10}}));
});
await new Promise((done) => ai.listen(aiPort, '127.0.0.1', done));
const child = spawn(process.execPath, [resolve(root,'server.cjs')], { cwd:root, env:{...process.env, CONTENTOPS_PORT:String(appPort), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1', CONTENTOPS_TEST_ASYNC_CREATION:'1'}, windowsHide:true, stdio:['ignore','pipe','pipe'] });
const post=(route, body={}) => fetch(`http://127.0.0.1:${appPort}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then((r)=>r.json());
const get=()=>fetch(`http://127.0.0.1:${appPort}/api/state`).then((r)=>r.json());
try {
  for(let i=0;i<80;i+=1){ try{if((await fetch(`http://127.0.0.1:${appPort}/health`)).ok)break;}catch{} await new Promise((done)=>setTimeout(done,100)); }
  await post('/api/settings/save',{workflowAutoEnabled:false,xhsEnabled:true,xhsKeywords:['测试'],manualRawLimit:30,automaticRawLimit:50,manualFinalLimit:10,automaticFinalLimit:10,generationCount:2,creationAutoRetryCount:2,dailyBudget:100,visionDailyBudget:100,visionMaxImages:2});
  const saved = await post('/api/model-profile/save',{kind:'text',name:'text',baseUrl:`http://127.0.0.1:${aiPort}/v1`,model:'mock',apiKey:'key'});
  await post('/api/model-profile/test',{kind:'text',id:saved.profile.id}); await post('/api/model-profile/activate',{kind:'text',id:saved.profile.id});
  const enterprise=await post('/api/enterprise-profile/save',{name:'企业资料',brandName:'品牌',productName:'产品',productFacts:['真实事实'],sellingPoints:['真实卖点'],makeActive:true}); const enterpriseImage=await post('/api/enterprise-image/upload',{profileId:enterprise.profile.id,mime:'image/png',data:onePixelPng,name:'隔离测试产品图',kind:'product',description:'仅用于一做重试回归'}); if(!enterpriseImage.ok) throw new Error(enterpriseImage.message); await post('/api/master/start');
  let current=await get(); current.candidates=[{id:'creation_retry',platform:'小红书',title:'一做重试',status:'selected',analysisStatus:'completed',analysis:{summary:'ok',productionBlueprint:{}},structure:[],imageUrls:[]}]; await writeFile(resolve(dataDir,'state.json'),JSON.stringify(current,null,2));
  child.kill(); await new Promise((done)=>setTimeout(done,250));
  const child2=spawn(process.execPath,[resolve(root,'server.cjs')],{cwd:root,env:{...process.env, CONTENTOPS_PORT:String(appPort), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1', CONTENTOPS_TEST_ASYNC_CREATION:'1'},windowsHide:true,stdio:'ignore'});
  try {
    for(let i=0;i<80;i+=1){ try{if((await fetch(`http://127.0.0.1:${appPort}/health`)).ok)break;}catch{} await new Promise((done)=>setTimeout(done,100)); }
    await post('/api/master/start'); const accepted=await post('/api/variant/generate',{candidateId:'creation_retry'}); if(!accepted.ok || !accepted.accepted) throw new Error(`未异步接单：${JSON.stringify(accepted)}`);
    for(let i=0;i<100;i+=1){ current=await get(); if(current.variants.length===2)break; await new Promise((done)=>setTimeout(done,100)); }
    const candidate=current.candidates.find((item)=>item.id==='creation_retry'); if(current.variants.length!==2 || candidate.creationTask?.status!=='completed' || candidate.creationTask?.attempts!==2 || calls!==3) throw new Error(`一做重试/任务状态异常：${JSON.stringify({variants:current.variants.length,task:candidate.creationTask,calls})}`);
    const again=await post('/api/variant/generate',{candidateId:'creation_retry'}); if(!again.ok || !again.existing || current.variants.length!==2) throw new Error('成功后未防重复生成');
    console.log(JSON.stringify({status:'PASS',acceptedAsync:true,transientRetry:true,attempts:candidate.creationTask.attempts,calls},null,2));
  } finally { child2.kill(); }
} finally { child.kill(); ai.close(); await rm(dataDir,{recursive:true,force:true}); }
