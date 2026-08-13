import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-state-rollback-${process.pid}`);
const port = 17863;
await rm(dataDir, { recursive:true, force:true });
const child = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, env:{...process.env, CONTENTOPS_PORT:String(port), CONTENTOPS_DATA_DIR:dataDir}, windowsHide:true, stdio:'ignore' });
const post = async (route, body) => { const response = await fetch(`http://127.0.0.1:${port}${route}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); return { status:response.status, body:await response.json() }; };
try {
  for(let i=0;i<80;i+=1){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await new Promise((done)=>setTimeout(done,100));}
  const created = await post('/api/enterprise-profile/save',{name:'回滚测试库'}); if(!created.body.ok) throw new Error(created.body.message);
  await mkdir(resolve(dataDir,'state.tmp.json'));
  const failed = await post('/api/enterprise-profile/archive',{id:created.body.profile.id});
  if(failed.status < 500 || failed.body.ok) throw new Error('强制持久化失败没有返回结构化失败');
  const current = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  if(current.enterpriseProfiles[0].status !== 'active') throw new Error('持久化失败后内存状态没有回滚');
  if(!(await fetch(`http://127.0.0.1:${port}/health`)).ok) throw new Error('持久化失败后服务未存活');
  console.log(JSON.stringify({status:'PASS', failedWriteRolledBack:true, structuredFailure:true, serverSurvived:true},null,2));
} finally { child.kill(); await rm(dataDir,{recursive:true,force:true}); }
