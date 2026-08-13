import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgent-QA-enterprise-guard-${process.pid}`);
const port = 17931;
await rm(dataDir, { recursive:true, force:true });
const child = spawn(process.execPath, [resolve(root, 'server.cjs')], {
  cwd:root,
  env:{ ...process.env, CONTENTOPS_PORT:String(port), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1' },
  windowsHide:true,
  stdio:['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const post = (route, body = {}) => fetch(`http://127.0.0.1:${port}${route}`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) }).then((response) => response.json());
const getState = () => fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());

try {
  let ready = false;
  for (let index = 0; index < 80; index += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!ready) throw new Error(`server failed: ${output}`);
  await post('/api/settings/save', { generationCount:1, imageCount:2, aiBaseUrl:'http://127.0.0.1:9/v1', aiModel:'unused' });
  await post('/api/ai/credential/save', { apiKey:'qa-placeholder' });
  const saved = await post('/api/enterprise-profile/save', { name:'占位库', brandName:'食出甄选', productFacts:['1'], makeActive:true });
  if (!saved.ok) throw new Error(saved.message);
  const snapshot = await getState();
  if (snapshot.runtime.enterpriseProductionReady !== false) throw new Error('占位企业库被错误标记为可生产');
  snapshot.candidates = [{ id:'candidate_guard', platform:'小红书', title:'测试候选', body:'只用于校验生产门禁', status:'selected', analysisStatus:'completed', imageUrls:[] }];
  await writeFile(resolve(dataDir, 'state.json'), JSON.stringify(snapshot, null, 2));
  child.kill();
  await new Promise((done) => child.once('exit', done));
  const child2 = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, env:{ ...process.env, CONTENTOPS_PORT:String(port), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1' }, windowsHide:true, stdio:'ignore' });
  try {
    for (let index = 0; index < 80; index += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise((done) => setTimeout(done, 100)); }
    const master = await post('/api/master/start');
    if (!master.ok) throw new Error(`人工总控未能启动：${JSON.stringify(master)}`);
    const result = await post('/api/variant/generate', { candidateId:'candidate_guard' });
    if (result.ok || result.code !== 'ENTERPRISE_PROFILE_INSUFFICIENT') throw new Error(`占位企业库未被生产门禁拦截：${JSON.stringify(result)}`);
    console.log(JSON.stringify({ status:'PASS', placeholderProfileRejected:true, readinessHonest:true, code:result.code }, null, 2));
  } finally { child2.kill(); }
} finally {
  child.kill();
  await new Promise((done) => setTimeout(done, 200));
  await rm(dataDir, { recursive:true, force:true });
}
