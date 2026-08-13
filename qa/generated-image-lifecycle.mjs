import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-image-lifecycle-${process.pid}`);
const generatedDir = resolve(dataDir, 'generated-images');
const enterpriseDir = resolve(dataDir, 'enterprise-assets', 'enterprise_1');
const port = 17864;
const stamp = new Date().toISOString();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEILV/5zOFDzdoQCepz6aeExAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELi3cqoDfaKuZM4AAAAASUVORK5CYII=', 'base64');
const page = (variantId, index) => ({ id:`${variantId}_page_${index}`, index, role:index === 1 ? 'cover' : 'content', purpose:`目的${index}`, copy:`文案${index}`, imagePrompt:`提示词${index}`, asset:{ file:`${variantId}/${String(index).padStart(2,'0')}.png`, mime:'image/png', generatedAt:stamp, source:'QA' } });
const variant = (id, status = 'draft') => ({ id, candidateId:`candidate_${id}`, platform:'小红书', status, title:`标题_${id}`, body:`正文_${id}`, tags:['测试'], pages:['文案1','文案2'], imagePages:[page(id,1),page(id,2)], imageStatus:'ready', createdAt:stamp, updatedAt:stamp });
const variants = [variant('variant_edit'), variant('variant_delete'), variant('variant_cleanup','pending'), variant('variant_rollback','draft')];
const state = {
  version:2, mode:'workflow-agent', createdAt:stamp, lastSavedAt:stamp,
  settings:{ xhsKeywords:['测试'], xhsEnabled:true, douyinEnabled:false, generationCount:1, scaleGenerationCount:1, masterEnabled:false, workflowAutoEnabled:false, collectionEnabled:false },
  agents:[], candidates:variants.map((item)=>({id:item.candidateId,title:item.title,status:'generated'})), variants, publications:[], materials:[], workflowRuns:[], activity:[],
  enterpriseProfiles:[{ id:'enterprise_1', name:'保留的企业库', brandName:'品牌', productName:'产品', productFacts:['事实'], sellingPoints:[], proofPoints:[], forbiddenClaims:[], visualRules:[], referenceLinks:[], status:'active', createdAt:stamp, updatedAt:stamp, imageAssets:[{id:'asset_1',name:'企业原图.png',mime:'image/png',size:png.length,file:'enterprise_1/asset_1.png',description:'企业原图',createdAt:stamp}] }],
  activeEnterpriseProfileId:'enterprise_1'
};
await rm(dataDir,{recursive:true,force:true});
await mkdir(generatedDir,{recursive:true});
for (const item of variants) for (const imagePage of item.imagePages) { const file=resolve(generatedDir,imagePage.asset.file); await mkdir(dirname(file),{recursive:true}); await writeFile(file,png); }
await mkdir(enterpriseDir,{recursive:true}); await writeFile(resolve(enterpriseDir,'asset_1.png'),png);
await writeFile(resolve(dataDir,'state.json'),JSON.stringify(state,null,2)); await writeFile(resolve(dataDir,'state.backup.json'),JSON.stringify(state,null,2));

const child=spawn(process.execPath,[resolve(root,'server.cjs')],{cwd:root,env:{...process.env,CONTENTOPS_PORT:String(port),CONTENTOPS_DATA_DIR:dataDir},windowsHide:true,stdio:['ignore','pipe','pipe']});
let stderr=''; child.stderr.on('data',(chunk)=>stderr+=chunk);
const post=async(route,body={})=>{const response=await fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
const getState=()=>fetch(`http://127.0.0.1:${port}/api/state`).then((response)=>response.json());
const exists=async(file)=>{try{return (await stat(file)).isFile();}catch{return false;}};
const updateBody=(item,changedFirstPrompt=false)=>({id:item.id,title:item.title,body:item.body,tags:item.tags,imagePages:item.imagePages.map((entry,index)=>({...entry,imagePrompt:index===0&&changedFirstPrompt?`${entry.imagePrompt}-已修改`:entry.imagePrompt}))});
try {
  for(let i=0;i<80;i+=1){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await new Promise((done)=>setTimeout(done,100));}

  const edit=variants.find((item)=>item.id==='variant_edit');
  const edited=await post('/api/variant/update',updateBody(edit,true));
  if(!edited.body.ok||edited.body.invalidated!==1)throw new Error(`编辑失效结果不正确：${JSON.stringify(edited)}`);
  if(await exists(resolve(generatedDir,'variant_edit/01.png')))throw new Error('编辑提示词后旧图片没有删除');
  if(!(await exists(resolve(generatedDir,'variant_edit/02.png'))))throw new Error('编辑提示词误删了未变化页面图片');

  const deleted=await post('/api/variant/delete',{id:'variant_delete'});
  if(!deleted.body.ok||deleted.body.deleted!==1)throw new Error(`删除版本失败：${JSON.stringify(deleted)}`);
  if(await exists(resolve(generatedDir,'variant_delete/01.png'))||await exists(resolve(generatedDir,'variant_delete/02.png')))throw new Error('删除版本后生成图片仍存在');

  const cleaned=await post('/api/variant/cleanup');
  if(!cleaned.body.ok||cleaned.body.deleted!==1)throw new Error(`批量清理失败：${JSON.stringify(cleaned)}`);
  if(await exists(resolve(generatedDir,'variant_cleanup/01.png'))||await exists(resolve(generatedDir,'variant_cleanup/02.png')))throw new Error('批量清理后生成图片仍存在');

  await mkdir(resolve(dataDir,'state.tmp.json'));
  const rollback=variants.find((item)=>item.id==='variant_rollback');
  const failed=await post('/api/variant/update',updateBody(rollback,true));
  if(failed.status<500||failed.body.ok)throw new Error('持久化失败没有返回结构化失败');
  const rolledBackState=await getState();
  const rolledBackVariant=rolledBackState.variants.find((item)=>item.id==='variant_rollback');
  if(!rolledBackVariant?.imagePages?.[0]?.asset?.file)throw new Error('持久化失败后图片元数据没有回滚');
  if(!(await exists(resolve(generatedDir,'variant_rollback/01.png'))))throw new Error('持久化失败后物理图片没有恢复');
  await rm(resolve(dataDir,'state.tmp.json'),{recursive:true,force:true});

  const reset=await post('/api/data/reset');
  if(!reset.body.ok)throw new Error(`数据重置失败：${JSON.stringify(reset)}`);
  const finalState=await getState();
  if(finalState.variants.length||finalState.candidates.length)throw new Error('数据重置没有清空业务数据');
  if(finalState.enterpriseProfiles.length!==1||finalState.activeEnterpriseProfileId!=='enterprise_1')throw new Error('数据重置误删企业素材库');
  if(!(await exists(resolve(enterpriseDir,'asset_1.png'))))throw new Error('数据重置误删企业原图');
  if(await exists(resolve(generatedDir,'variant_rollback/01.png'))||await exists(resolve(generatedDir,'variant_edit/02.png')))throw new Error('数据重置没有清理剩余生成图片');
  const trashRoot=resolve(generatedDir,'.trash');
  let trashEntries=[]; try{trashEntries=await readdir(trashRoot,{recursive:true});}catch{}
  if(trashEntries.some(Boolean))throw new Error(`生成图片事务垃圾未清空：${trashEntries.join(',')}`);
  JSON.parse(await readFile(resolve(dataDir,'state.json'),'utf8'));
  console.log(JSON.stringify({status:'PASS',editCleanup:true,deleteCleanup:true,batchCleanup:true,persistenceRollback:true,resetCleanup:true,enterpriseAssetsPreserved:true,trashEmpty:true},null,2));
} finally {
  child.kill(); await new Promise((done)=>setTimeout(done,300)); await rm(dataDir,{recursive:true,force:true}); if(stderr)process.stderr.write(stderr);
}
