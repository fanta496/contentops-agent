import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-supervisor-self-${process.pid}`);
const port = 18400 + (process.pid % 500);
let child;

const stateUrl = `http://127.0.0.1:${port}/api/state`;
const start = async () => {
  child = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, windowsHide:true, stdio:'ignore', env:{ ...process.env, CONTENTOPS_PORT:String(port), CONTENTOPS_DATA_DIR:dataDir } });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('测试服务未启动');
};
const stop = async () => { try { child?.kill(); } catch {} await new Promise((done) => setTimeout(done, 350)); };

try {
  await rm(dataDir, { recursive:true, force:true });
  await start();
  const state = await fetch(stateUrl).then((response) => response.json());
  state.settings.xhsEnabled = true;
  state.settings.douyinEnabled = false;
  for (const agent of state.agents) {
    if (agent.id === 'supervisor') Object.assign(agent, { status:'warning', detail:'1个模块状态需要处理' });
    else if (agent.id === 'xhs-collector') Object.assign(agent, { status:'ready', detail:'已就绪', errorCode:'' });
    else if (agent.id === 'analyst') Object.assign(agent, { status:'healthy', detail:'评分队列为空' });
    else if (agent.id === 'creator') Object.assign(agent, { status:'idle', detail:'等待人工选款' });
    else if (agent.id === 'douyin-collector') Object.assign(agent, { status:'warning', detail:'抖音未启用', errorCode:'PAGE_STRUCTURE_UNVERIFIED' });
    else Object.assign(agent, { status:'healthy', detail:'正常' });
  }
  await writeFile(resolve(dataDir, 'state.json'), JSON.stringify(state, null, 2));
  await stop();
  await start();
  const repaired = await fetch(stateUrl).then((response) => response.json());
  const supervisor = repaired.agents.find((agent) => agent.id === 'supervisor');
  if (supervisor?.status !== 'healthy' || supervisor?.detail !== '刚刚完成全局巡检') throw new Error(`主管把自身告警误判为外部故障：${JSON.stringify(supervisor)}`);
  console.log(JSON.stringify({ status:'PASS', supervisorSelfWarningExcluded:true }, null, 2));
} finally {
  await stop();
  await rm(dataDir, { recursive:true, force:true });
}
