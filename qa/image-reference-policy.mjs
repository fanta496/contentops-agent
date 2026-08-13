import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-image-policy-${process.pid}`);
const appPort = 17873; const aiPort = 19993;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEILV/5zOFDzdoQCepz6aeExAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELi3cqoDfaKuZM4AAAAASUVORK5CYII=', 'base64');
let edits = 0; let generations = 0;
await rm(dataDir, { recursive:true, force:true });
const ai = createServer(async (req, res) => {
  for await (const _ of req) {}
  if (req.url.endsWith('/images/edits')) edits += 1;
  else if (req.url.endsWith('/images/generations')) generations += 1;
  res.writeHead(200, {'content-type':'application/json'});
  res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
});
await new Promise((done) => ai.listen(aiPort, '127.0.0.1', done));
let child;
const start = () => { child = spawn(process.execPath, [resolve(root, 'server.cjs')], {cwd:root, env:{...process.env, CONTENTOPS_PORT:String(appPort), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1'}, windowsHide:true, stdio:'ignore'}); };
const ready = async () => { for(let i=0;i<80;i+=1){try{if((await fetch(`http://127.0.0.1:${appPort}/health`)).ok)return;}catch{}await new Promise((done)=>setTimeout(done,100));} throw new Error('server not ready'); };
const post = (route, body={}) => fetch(`http://127.0.0.1:${appPort}${route}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then((r)=>r.json());
const state = () => fetch(`http://127.0.0.1:${appPort}/api/state`).then((r)=>r.json());
const waitJob = async (id) => { let item; for(let i=0;i<100;i+=1){item=(await state()).variants.find((x)=>x.id===id);if(!['queued','running'].includes(item?.imageJob?.status))return item;await new Promise((done)=>setTimeout(done,50));} throw new Error(`job timeout: ${id}`); };
try {
  start(); await ready();
  await post('/api/settings/save',{workflowAutoEnabled:false,xhsEnabled:true,xhsKeywords:['测试'],imageQualityReviewEnabled:false,imageDailyBudget:100,imageCostPerImage:0});
  const enterprise = await post('/api/enterprise-profile/save',{name:'策略测试库',brandName:'测试品牌',productName:'测试产品',productFacts:['仅用于隔离回归'],sellingPoints:['测试卖点'],makeActive:true});
  const uploaded = await post('/api/enterprise-image/upload',{profileId:enterprise.profile.id,mime:'image/png',data:`data:image/png;base64,${png.toString('base64')}`,name:'参考图',kind:'product',description:'仅验证参考图策略'});
  const ref = await post('/api/model-profile/save',{kind:'image',name:'参考图档案',baseUrl:`http://127.0.0.1:${aiPort}/v1`,model:'image-edit',apiKey:'key',imageInputMode:'reference_edit'});
  await post('/api/model-profile/test',{kind:'image',id:ref.profile.id}); await post('/api/model-profile/activate',{kind:'image',id:ref.profile.id});
  const text = await post('/api/model-profile/save',{kind:'image',name:'文字档案',baseUrl:`http://127.0.0.1:${aiPort}/v1`,model:'image-gen',apiKey:'key',imageInputMode:'text_only'});
  await post('/api/model-profile/test',{kind:'image',id:text.profile.id});
  edits = 0; generations = 0;
  const snapshot = await state();
  snapshot.candidates=[{id:'candidate_policy',platform:'小红书',title:'来源',status:'generated',analysisStatus:'completed'}];
  const pages = (id) => [1,2].map((index)=>({id:`page_${id}_${index}`,index,copy:`文案${index}`,imagePrompt:`测试画面${index}`}));
  const variant = (id, policy, assetIds=[uploaded.asset.id]) => ({id,candidateId:'candidate_policy',platform:'小红书',title:id,body:'正文',tags:[],status:'draft',imageReferencePolicy:policy,enterpriseGrounding:{assetIds,assetUsage:['产品图']},imageRules:{imageQualityReviewEnabled:false},imagePages:pages(id)});
  snapshot.variants=[variant('required_ok','required'),variant('disabled','disabled'),variant('auto_ok','auto'),variant('required_no_asset','required',[])];
  await writeFile(resolve(dataDir,'state.json'),JSON.stringify(snapshot)); child.kill(); await new Promise((done)=>setTimeout(done,400)); start(); await ready(); await post('/api/master/start');
  for (const id of ['required_ok','disabled','auto_ok','required_no_asset']) { const queued=await post('/api/variant/image/generate',{id}); if(!queued.ok) throw new Error(`${id}: ${JSON.stringify(queued)}`); await waitJob(id); }
  let after=await state();
  const byId=(id)=>after.variants.find((x)=>x.id===id);
  if(byId('required_ok').imageJob.referenceMode!=='reference_edit'||byId('auto_ok').imageJob.referenceMode!=='reference_edit'||byId('disabled').imageJob.referenceMode!=='text_only') throw new Error('参考图有效模式不正确');
  if(byId('required_no_asset').imageJob.status!=='failed'||!byId('required_no_asset').imageJob.error.includes('没有选中可用')) throw new Error('required 无素材没有明确阻止');
  if(edits!==4||generations!==2) throw new Error(JSON.stringify({edits,generations}));
  await post('/api/model-profile/activate',{kind:'image',id:text.profile.id});
  const beforeCalls=edits+generations;
  const update=await post('/api/variant/update',{id:'required_ok',imageReferencePolicy:'required',title:'required_ok',body:'正文',tags:[],imagePages:pages('required_ok')});
  if(!update.ok) throw new Error(update.message);
  await post('/api/variant/image/generate',{id:'required_ok',force:true}); const blocked=await waitJob('required_ok');
  if(blocked.imageJob.status!=='failed'||!blocked.imageJob.error.includes('未启用参考图模式')||edits+generations!==beforeCalls) throw new Error('required + text_only 应零调用阻止');
  const oldAsset=byId('disabled').imagePages[0].asset;
  const changed=await post('/api/variant/update',{id:'disabled',imageReferencePolicy:'required',title:'disabled',body:'正文',tags:[],imagePages:pages('disabled')});
  after=await state();
  if(!changed.ok||!changed.policyChanged||changed.invalidated!==2||after.variants.find((x)=>x.id==='disabled').imagePages.some((page)=>page.asset)||!oldAsset) throw new Error('切换策略没有废弃旧图');
  console.log(JSON.stringify({status:'PASS',requiredUsesEdits:true,disabledUsesGenerations:true,autoUsesAvailableReference:true,requiredMissingAssetBlocked:true,requiredUnsupportedProfileZeroCalls:true,policyChangeInvalidatesImages:true},null,2));
} finally { if(child&&!child.killed)child.kill(); ai.close(); await new Promise((done)=>setTimeout(done,300)); await rm(dataDir,{recursive:true,force:true}); }
