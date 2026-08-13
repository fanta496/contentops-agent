import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-text-freedom-${process.pid}`);
const appPort = 17867;
const aiPort = 19987;
const prompts = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEILV/5zOFDzdoQCepz6aeExAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELi3cqoDfaKuZM4AAAAASUVORK5CYII=', 'base64');
await rm(dataDir, { recursive:true, force:true });
const ai = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  if (req.url.endsWith('/images/generations')) {
    const body = JSON.parse(raw || '{}'); prompts.push(String(body.prompt || ''));
    res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ data:[{ b64_json:png.toString('base64') }] }));
  }
  res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ choices:[{message:{content:'{"ok":true}'}}] }));
});
await new Promise((done) => ai.listen(aiPort, '127.0.0.1', done));
const start = () => spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, env:{...process.env, CONTENTOPS_PORT:String(appPort), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1'}, windowsHide:true, stdio:'ignore' });
const post = (route, body={}) => fetch(`http://127.0.0.1:${appPort}${route}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) }).then((r)=>r.json());
const state = () => fetch(`http://127.0.0.1:${appPort}/api/state`).then((r)=>r.json());
const ready = async () => { for(let i=0;i<80;i+=1){try{if((await fetch(`http://127.0.0.1:${appPort}/health`)).ok)return;}catch{}await new Promise((done)=>setTimeout(done,100));} throw new Error('service timeout'); };
let child = start();
try {
  await ready();
  await post('/api/settings/save',{workflowAutoEnabled:false,xhsEnabled:true,xhsKeywords:['测试'],imageTextMode:'exact',imageMaxConcurrentJobs:4,imageQualityReviewEnabled:false,imageDailyBudget:100,imageCostPerImage:0});
  const profile=await post('/api/model-profile/save',{kind:'image',name:'image',baseUrl:`http://127.0.0.1:${aiPort}/v1`,model:'image',apiKey:'key'});
  await post('/api/model-profile/test',{kind:'image',id:profile.profile.id}); await post('/api/model-profile/activate',{kind:'image',id:profile.profile.id});
  const current=await state();
  current.candidates=[{id:'candidate_text',platform:'小红书',title:'来源',status:'generated',source:'QA',analysisStatus:'completed',detailStatus:'enriched',imageUrls:[]}];
  current.variants=[{id:'variant_text',candidateId:'candidate_text',platform:'小红书',title:'文字自由测试',body:'正文',tags:[],status:'draft',imageTextMode:'free',imageRules:{textMode:'free',imageCount:4,imageMaxConcurrentJobs:4,imageQualityReviewEnabled:false},imagePages:[
    {id:'page_free',index:1,textMode:'inherit',copy:'不会被强制',imagePrompt:'  自由页：画面标题写 ABC 2026\n'},
    {id:'page_exact',index:2,textMode:'exact',copy:'SALE 7折',imagePrompt:'准确文字页'},
    {id:'page_suggest',index:3,textMode:'suggest',copy:'夏日新品 Summer',imagePrompt:'参考文字页'},
    {id:'page_none',index:4,textMode:'no_text',copy:'编辑稿保留',imagePrompt:'无文字页'}
  ]}];
  await writeFile(resolve(dataDir,'state.json'),JSON.stringify(current)); child.kill(); await new Promise((done)=>setTimeout(done,400)); child=start(); await ready(); const restartedState=await state(); if(restartedState.settings.imageTextMode!=='exact') throw new Error(`文字草稿偏好重启后丢失：${restartedState.settings.imageTextMode}`); prompts.length=0;
  await post('/api/master/start'); const queued=await post('/api/variant/image/generate',{id:'variant_text'}); if(!queued.ok)throw new Error(JSON.stringify(queued));
  let after; for(let i=0;i<100;i+=1){after=await state();if(!['queued','running'].includes(after.variants[0].imageJob?.status))break;await new Promise((done)=>setTimeout(done,50));}
  const expected=['  自由页：画面标题写 ABC 2026\n','准确文字页','参考文字页','无文字页'];
  for(const prompt of expected) if(!prompts.includes(prompt)) throw new Error(`工作台提示词没有原样发送：${prompt}\n实际：${JSON.stringify(prompts)}`);
  if(prompts.some((prompt)=>prompt.includes('整组概念：')||prompt.includes('本页文字模式：')||prompt.includes('视觉质检指出：')||prompt.includes('原始画面要求：'))) throw new Error(`仍存在隐藏后端加工：${JSON.stringify(prompts)}`);
  if(after.variants[0].imageJob.status !== 'completed') throw new Error(JSON.stringify(after.variants[0].imageJob));
  console.log(JSON.stringify({status:'PASS',workspacePromptSentVerbatim:true,noHiddenEnrichment:true,draftPreferencePersistedAfterRestart:true,prompts:prompts.length},null,2));
} finally { child.kill(); ai.close(); await new Promise((done)=>setTimeout(done,300)); await rm(dataDir,{recursive:true,force:true}); }
