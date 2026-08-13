import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-page-concurrency-${process.pid}`);
const appPort = 17859; const aiPort = 19999; let active = 0; let peak = 0;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEILV/5zOFDzdoQCepz6aeExAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELi3cqoDfaKuZM4AAAAASUVORK5CYII=', 'base64');
await rm(dataDir, { recursive:true, force:true });
const ai = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  if (req.url.endsWith('/images/generations')) { active += 1; peak = Math.max(peak, active); await new Promise((done) => setTimeout(done, 200)); active -= 1; res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ data:[{ b64_json:png.toString('base64') }] })); }
  res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ choices:[{message:{content:'{"ok":true}'}}] }));
});
await new Promise((done) => ai.listen(aiPort, '127.0.0.1', done));
const child = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, env:{...process.env, CONTENTOPS_PORT:String(appPort), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1'}, windowsHide:true, stdio:'ignore' });
const post = (route, body={}) => fetch(`http://127.0.0.1:${appPort}${route}`, { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body) }).then((r)=>r.json());
const state = () => fetch(`http://127.0.0.1:${appPort}/api/state`).then((r)=>r.json());
try {
  for(let i=0;i<80;i+=1){try{if((await fetch(`http://127.0.0.1:${appPort}/health`)).ok)break;}catch{}await new Promise((done)=>setTimeout(done,100));}
  await post('/api/settings/save',{workflowAutoEnabled:false,xhsEnabled:true,xhsKeywords:['测试'],imageMaxConcurrentJobs:3,imageQualityReviewEnabled:false,imageDailyBudget:100,imageCostPerImage:0});
  const profile=await post('/api/model-profile/save',{kind:'image',name:'image',baseUrl:`http://127.0.0.1:${aiPort}/v1`,model:'image',apiKey:'key'}); await post('/api/model-profile/test',{kind:'image',id:profile.profile.id}); await post('/api/model-profile/activate',{kind:'image',id:profile.profile.id}); await post('/api/master/start');
  const current=await state(); current.candidates=[{id:'candidate_pages',platform:'小红书',title:'并发来源',status:'generated',source:'QA',analysisStatus:'completed',detailStatus:'enriched',imageUrls:[]}]; current.variants=[{id:'variant_pages',candidateId:'candidate_pages',platform:'小红书',title:'并发测试',body:'正文',tags:[],status:'draft',imageRules:{imageCount:4,imageMaxConcurrentJobs:3,imageQualityReviewEnabled:false},imagePages:[1,2,3,4].map((index)=>({id:`page_${index}`,index,copy:`第${index}页`,imagePrompt:`第${index}页图`}))}]; await writeFile(resolve(dataDir,'state.json'),JSON.stringify(current)); child.kill(); await new Promise((done)=>setTimeout(done,400));
  const child2=spawn(process.execPath,[resolve(root,'server.cjs')],{cwd:root,env:{...process.env,CONTENTOPS_PORT:String(appPort),CONTENTOPS_DATA_DIR:dataDir,CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1'},windowsHide:true,stdio:'ignore'});
  for(let i=0;i<80;i+=1){try{if((await fetch(`http://127.0.0.1:${appPort}/health`)).ok)break;}catch{}await new Promise((done)=>setTimeout(done,100));}
  await post('/api/master/start'); const queued=await post('/api/variant/image/generate',{id:'variant_pages'}); if(!queued.ok)throw new Error(JSON.stringify(queued));
  let after; for(let i=0;i<100;i+=1){after=await state();if(!['queued','running'].includes(after.variants[0].imageJob?.status))break;await new Promise((done)=>setTimeout(done,50));}
  if(peak < 3 || after.variants[0].imageJob.status !== 'completed')throw new Error(JSON.stringify({peak,job:after.variants[0].imageJob}));
  child2.kill(); console.log(JSON.stringify({status:'PASS',pageLevelConcurrency:true,peak},null,2));
} finally { child.kill(); ai.close(); await new Promise((done)=>setTimeout(done,300)); await rm(dataDir,{recursive:true,force:true}); }
