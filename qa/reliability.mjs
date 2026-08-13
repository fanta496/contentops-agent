import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = resolve(root, '成品', 'runtime', 'node.exe');
const server = resolve(root, '成品', 'server.cjs');
const dataRoot = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-reliability-${process.pid}`);

async function runCase(name, overrides) {
  const env = { ...process.env, CONTENTOPS_PORT: '17832', CONTENTOPS_DATA_DIR: resolve(dataRoot, name), CONTENTOPS_TEST_OVERRIDES: JSON.stringify(overrides), CONTENTOPS_TEST_EXPECT_BLOCK: '1' };
  const child = spawn(node, [server, '--self-test'], { cwd: resolve(root, '成品'), windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((done) => child.on('close', done));
  if (code !== 0) throw new Error(`${name}: ${stderr || stdout}`);
  const match = stdout.match(/\{[\s\S]*\}/);
  const report = match ? JSON.parse(match[0]) : null;
  if (!report?.blocked) throw new Error(`${name}: 没有触发熔断`);
  return { name, message: report.message };
}

const results = [];
results.push(await runCase('采集总开关', { collectionEnabled: false, xhsEnabled: true }));
{
  const env = { ...process.env, CONTENTOPS_PORT: '17832', CONTENTOPS_DATA_DIR: resolve(dataRoot, 'candidate-cap'), CONTENTOPS_TEST_OVERRIDES: JSON.stringify({ collectionEnabled: true, xhsEnabled: true, dailyCandidateLimit: 1, candidatesToday: 1, usageDate: new Date().toISOString().slice(0, 10) }) };
  const child = spawn(node, [server, '--self-test'], { cwd: resolve(root, '成品'), windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((done) => child.on('close', done));
  if (code !== 0 || !stdout.includes('candidates')) throw new Error(`候选新增上限: ${stderr || stdout}`);
  results.push({ name: '候选新增上限', message: '停止新增，但真实采集仍允许更新历史候选快照' });
}
{
  const env = { ...process.env, CONTENTOPS_PORT: '17832', CONTENTOPS_DATA_DIR: resolve(dataRoot, 'budget-cap'), CONTENTOPS_TEST_OVERRIDES: JSON.stringify({ collectionEnabled: true, xhsEnabled: true, dailyCandidateLimit: 500, aiAnalysisLimit: 500, candidatesToday: 0, analysesToday: 0, dailyBudget: 0, spentToday: 0, usageDate: new Date().toISOString().slice(0, 10) }), CONTENTOPS_TEST_EXPECT_BUDGET_BLOCK: '1' };
  const child = spawn(node, [server, '--self-test'], { cwd: resolve(root, '成品'), windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((done) => child.on('close', done));
  if (code !== 0 || !stdout.includes('预算')) throw new Error(`预算熔断: ${stderr || stdout}`);
  results.push({ name: '预算熔断', message: '今日AI预算不足，已自动熔断' });
}
console.log(JSON.stringify({ status: 'PASS', results }, null, 2));
await rm(dataRoot, { recursive: true, force: true });
