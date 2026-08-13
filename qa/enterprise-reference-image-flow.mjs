import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-reference-image-${process.pid}`);
const appPort = 17868; const aiPort = 19988;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEILV/5zOFDzdoQCepz6aeExAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELi3cqoDfaKuZM4AAAAASUVORK5CYII=', 'base64');
let editCalls = 0; let generationCalls = 0; let multipartContainedImage = false; let multipartFieldsValid = true; let sizeFieldObserved = false; let authorizationPresent = false; let actualPromptVerbatim = false;
await rm(dataDir, { recursive:true, force:true });
const ai = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks);
  if (req.url.endsWith('/images/edits')) { editCalls += 1; const type = String(req.headers['content-type'] || ''); const raw = body.toString('latin1'); const utf8 = body.toString('utf8'); actualPromptVerbatim = actualPromptVerbatim || (utf8.includes('保留产品真实外观') && !utf8.includes('整组概念：') && !utf8.includes('原始画面要求：')); authorizationPresent = authorizationPresent || /^Bearer\s+\S+/i.test(String(req.headers.authorization || '')); multipartContainedImage = multipartContainedImage || type.includes('multipart/form-data') && body.includes(Buffer.from('name="image"')) && (body.includes(Buffer.from('reference-capability-test.png')) || body.includes(Buffer.from('.png'))); multipartFieldsValid = multipartFieldsValid && ['name="model"','name="prompt"','name="n"','name="response_format"','name="image"','b64_json'].every((token) => raw.includes(token)); sizeFieldObserved = sizeFieldObserved || raw.includes('name="size"') && raw.includes('1024x1024'); res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({data:{images:[{base64:png.toString('base64')}]}})); }
  if (req.url.endsWith('/images/generations')) { generationCalls += 1; res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]})); }
  res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}));
});
await new Promise((done) => ai.listen(aiPort, '127.0.0.1', done));
let child;
const start = () => { child = spawn(process.execPath, [resolve(root, 'server.cjs')], {cwd:root, env:{...process.env, CONTENTOPS_PORT:String(appPort), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1'}, windowsHide:true, stdio:'ignore'}); };
const waitReady = async () => { for(let i=0;i<80;i+=1){try{if((await fetch(`http://127.0.0.1:${appPort}/health`)).ok)return;}catch{}await new Promise((done)=>setTimeout(done,100));} throw new Error('server not ready'); };
const post = (route, body={}) => fetch(`http://127.0.0.1:${appPort}${route}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then((r)=>r.json());
const getState = () => fetch(`http://127.0.0.1:${appPort}/api/state`).then((r)=>r.json());
try {
  start(); await waitReady();
  await post('/api/settings/save',{workflowAutoEnabled:false,xhsEnabled:true,xhsKeywords:['测试'],imageQualityReviewEnabled:false,imageDailyBudget:100,imageCostPerImage:0});
  const enterprise = await post('/api/enterprise-profile/save',{name:'隔离测试企业库',brandName:'测试品牌',productName:'测试产品',productFacts:['仅用于本地回归'],sellingPoints:['测试卖点'],makeActive:true});
  const uploaded = await post('/api/enterprise-image/upload',{profileId:enterprise.profile.id,mime:'image/png',data:`data:image/png;base64,${png.toString('base64')}`,name:'测试参考图',kind:'product',description:'仅验证图片传输链路，不作为品牌真实性依据'});
  const refProfile = await post('/api/model-profile/save',{kind:'image',name:'参考图测试',baseUrl:`http://127.0.0.1:${aiPort}/v1`,model:'image-edit',apiKey:'key',imageInputMode:'reference_edit'});
  const tested = await post('/api/model-profile/test',{kind:'image',id:refProfile.profile.id}); if(!tested.ok) throw new Error(tested.message);
  await post('/api/model-profile/activate',{kind:'image',id:refProfile.profile.id}); await post('/api/master/start');
  const state = await getState(); state.candidates=[{id:'candidate_ref',platform:'小红书',title:'来源',status:'generated',analysisStatus:'completed'}]; state.variants=[{id:'variant_ref',candidateId:'candidate_ref',platform:'小红书',title:'参考图回归',body:'正文',tags:[],status:'draft',enterpriseGrounding:{assetIds:[uploaded.asset.id],assetUsage:['产品图']},imageRules:{imageQualityReviewEnabled:false},imagePages:[{id:'page_ref',index:1,copy:'文案',imagePrompt:'保留产品真实外观'}]}];
  await writeFile(resolve(dataDir,'state.json'),JSON.stringify(state)); child.kill(); await new Promise((done)=>setTimeout(done,400)); start(); await waitReady(); await post('/api/master/start');
  const queued=await post('/api/variant/image/generate',{id:'variant_ref'}); if(!queued.ok) throw new Error(JSON.stringify(queued));
  let after; for(let i=0;i<100;i+=1){after=await getState();if(!['queued','running'].includes(after.variants[0].imageJob?.status))break;await new Promise((done)=>setTimeout(done,50));}
  const variant=after.variants[0]; if(variant.imageJob.status!=='completed'||variant.imageJob.referenceMode!=='reference_edit'||variant.imageJob.referenceAssetIds[0]!==uploaded.asset.id||variant.imagePages[0].asset.referenceMode!=='reference_edit') throw new Error(JSON.stringify(variant));
  if(editCalls<2||generationCalls!==0||!multipartContainedImage||!multipartFieldsValid||!sizeFieldObserved||!authorizationPresent||!actualPromptVerbatim) throw new Error(JSON.stringify({editCalls,generationCalls,multipartContainedImage,multipartFieldsValid,sizeFieldObserved,authorizationPresent,actualPromptVerbatim}));
  console.log(JSON.stringify({status:'PASS',editsEndpoint:true,multipartImageReceived:true,workspacePromptSentVerbatim:true,multipartRequiredFieldsValid:true,configuredSizeFieldObserved:true,authorizationHeaderPresent:true,assetIdAudited:true,temporaryAssetIsolated:true},null,2));
} finally { if(child&&!child.killed)child.kill(); ai.close(); await new Promise((done)=>setTimeout(done,300)); await rm(dataDir,{recursive:true,force:true}); }
