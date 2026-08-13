import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, readFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = resolve(root, '成品', 'runtime', 'node.exe');
const server = resolve(root, '成品', 'server.cjs');
const data = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-recovery-${process.pid}`);
const port = 17834;
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

function run(envExtra = {}, selfTest = true) {
  return new Promise((done, reject) => {
    const child = spawn(node, selfTest ? [server, '--self-test'] : [server], { cwd: resolve(root, '成品'), windowsHide: true, env: { ...process.env, CONTENTOPS_PORT: String(port), CONTENTOPS_DATA_DIR: data, ...envExtra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('close', (code) => code === 0 ? done(stdout) : reject(new Error(stderr || stdout)));
  });
}

const live = spawn(node, [server], { cwd: resolve(root, '成品'), windowsHide: true, env: { ...process.env, CONTENTOPS_PORT: String(port), CONTENTOPS_DATA_DIR: data }, stdio: 'ignore' });
for (let i = 0; i < 30; i += 1) {
  try { const health = await fetch(`http://127.0.0.1:${port}/health`); if (health.ok) break; } catch {}
  await new Promise((done) => setTimeout(done, 100));
}
await fetch(`http://127.0.0.1:${port}/api/settings/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowAutoEnabled: true, xhsEnabled: true, douyinEnabled: false, xhsKeywords:['内容运营'], intervalMinutes: 60, dailyCandidateLimit: 500, aiAnalysisLimit: 20, dailyBudget: 30, aiBaseUrl: '', aiModel: '', feishuWebhook: '' }) });
live.kill();
await new Promise((done) => live.on('close', done));
const stateFile = resolve(data, 'state.json');
const backupFile = resolve(data, 'state.backup.json');
JSON.parse(await readFile(stateFile, 'utf8'));
JSON.parse(await readFile(backupFile, 'utf8'));
await copyFile(stateFile, backupFile);
await writeFile(stateFile, '{bad-json', 'utf8');
const output = await run({ CONTENTOPS_TEST_RECOVERY_CHECK: '1' });
const recovered = JSON.parse(output.match(/\{[\s\S]*\}/)[0]);
if (!recovered.recovered) throw new Error('没有从备份恢复');
JSON.parse(await readFile(stateFile, 'utf8'));
console.log(JSON.stringify({ status: 'PASS', atomicSave: true, backupRecovery: true }, null, 2));
await rm(data, { recursive: true, force: true });
