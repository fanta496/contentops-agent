import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=resolve(process.env.TEMP||root,`ContentOpsAgentV2-QA-multi-select-${process.pid}`); const port=17876;
await rm(dataDir,{recursive:true,force:true}); let child;
const start=()=>{child=spawn(process.execPath,[resolve(root,'server.cjs')],{cwd:root,env:{...process.env,CONTENTOPS_PORT:String(port),CONTENTOPS_DATA_DIR:dataDir,CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1'},windowsHide:true,stdio:'ignore'});};
const ready=async()=>{for(let i=0;i<80;i+=1){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('server not ready');};
const post=(route,body={})=>fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
const state=()=>fetch(`http://127.0.0.1:${port}/api/state`).then(r=>r.json());
try{
  start();await ready();const snapshot=await state();
  snapshot.candidates=[1,2].map(index=>({id:`candidate_${index}`,platform:'小红书',title:`候选${index}`,status:'new',analysisStatus:'completed'}));
  snapshot.workflowRuns=[{id:'run_multi',trigger:'manual',status:'waiting_human',currentStep:'select',startedAt:new Date().toISOString(),finishedAt:'',candidateIds:['candidate_1','candidate_2'],counts:{raw:2,filtered:2,collected:2,analyzed:2,selected:0,generated:0,approved:0,published:0,performanceAnalyzed:0,scaled:0},actualCost:0,error:'',steps:[{id:'collect',status:'completed',detail:''},{id:'analyze',status:'completed',detail:''},{id:'select',status:'waiting_human',detail:''},{id:'create',status:'pending',detail:''},{id:'publish',status:'pending',detail:''},{id:'performance',status:'pending',detail:''},{id:'scale',status:'pending',detail:''}]}];
  await writeFile(resolve(dataDir,'state.json'),JSON.stringify(snapshot));child.kill();await new Promise(r=>setTimeout(r,300));start();await ready();
  const first=await post('/api/candidate/status',{id:'candidate_1',status:'selected'});const second=await post('/api/candidate/status',{id:'candidate_2',status:'selected'});const duplicate=await post('/api/candidate/status',{id:'candidate_2',status:'selected'});const after=await state();const run=after.workflowRuns[0];
  if(!first.ok||!second.ok||!duplicate.existing||run.counts.selected!==2||run.currentStep!=='create'||!run.steps.find(x=>x.id==='select').detail.includes('2 条'))throw new Error(JSON.stringify({first,second,duplicate,run}));
  console.log(JSON.stringify({status:'PASS',multipleSelectionsCounted:true,duplicateIdempotent:true,selected:run.counts.selected,currentStep:run.currentStep},null,2));
}finally{if(child&&!child.killed)child.kill();await new Promise(r=>setTimeout(r,200));await rm(dataDir,{recursive:true,force:true});}
