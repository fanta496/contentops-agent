import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const product = resolve(root, '成品');
const node = resolve(product, 'runtime', 'node.exe');
const server = resolve(product, 'server.cjs');
const data = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-single-instance-${process.pid}`);
const port = 17835;
await rm(data, { recursive: true, force: true });
const env = { ...process.env, CONTENTOPS_PORT: String(port), CONTENTOPS_DATA_DIR: data };
const first = spawn(node, [server], { cwd: product, windowsHide: true, env, stdio: 'ignore' });
for (let i = 0; i < 40; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise((done) => setTimeout(done, 100)); }
const lockBefore = JSON.parse(await readFile(resolve(data, 'server.lock.json'), 'utf8'));
const second = spawn(node, [server], { cwd: product, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
const secondCode = await new Promise((done) => second.on('close', done));
const lockAfter = JSON.parse(await readFile(resolve(data, 'server.lock.json'), 'utf8'));
const healthy = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
first.kill(); await new Promise((done) => first.on('close', done));
await rm(data, { recursive: true, force: true });
const pass = secondCode === 0 && lockBefore.pid === lockAfter.pid && healthy;
console.log(JSON.stringify({ status: pass ? 'PASS' : 'FAIL', secondExited: secondCode === 0, originalPidPreserved: lockBefore.pid === lockAfter.pid, serviceHealthy: healthy }, null, 2));
if (!pass) process.exit(1);
