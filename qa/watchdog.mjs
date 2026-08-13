import { spawn, spawnSync } from 'node:child_process';
import { rm, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const product = resolve(root, '成品');
const source = resolve(root, 'launcher', 'ContentOpsWatchdog.cs');
const watchdog = resolve(product, `ContentOpsWatchdog-v2-QA-${process.pid}.exe`);
const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const reservePort = createServer();
await new Promise((done, reject) => { reservePort.once('error', reject); reservePort.listen(0, '127.0.0.1', done); });
const port = reservePort.address().port;
await new Promise((done) => reservePort.close(done));
const data = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-watchdog-${process.pid}`);
await rm(data, { recursive: true, force: true });
const compiled = spawnSync(compiler, ['/nologo', '/target:winexe', `/out:${watchdog}`, source], { cwd:root, windowsHide:true, encoding:'utf8' });
if (compiled.status !== 0) throw new Error(`看门狗测试编译失败：${compiled.stderr || compiled.stdout}`);
const watchdogSource = await readFile(source, 'utf8');
if (!watchdogSource.includes('TryStopOwnedUnresponsiveServer') || !watchdogSource.includes('process.MainModule.FileName') || !watchdogSource.includes('SameDirectory(lockRoot, Root)')) throw new Error('看门狗缺少假活进程安全恢复保护');
const env = { ...process.env, CONTENTOPS_PORT: String(port), CONTENTOPS_DATA_DIR: data };
const child = spawn(watchdog, [], { cwd: product, windowsHide: true, env, stdio: 'ignore' });
await new Promise((done) => setTimeout(done, 500));
const duplicate = spawn(watchdog, [], { cwd: product, windowsHide: true, env, stdio: 'ignore' });
const duplicateExit = await Promise.race([new Promise((done) => duplicate.on('close', done)), new Promise((done) => setTimeout(() => done(null), 3000))]);
if (duplicateExit === null) { duplicate.kill(); child.kill(); throw new Error('重复看门狗没有被单实例保护拒绝'); }

let healthy = false;
for (let i = 0; i < 50; i += 1) {
  try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok && (await response.json()).appId === 'contentops-agent-v2') { healthy = true; break; } } catch {}
  await new Promise((done) => setTimeout(done, 500));
}
if (!healthy) { child.kill(); throw new Error('看门狗没有拉起后台'); }
const lock = JSON.parse(await readFile(resolve(data, 'server.lock.json'), 'utf8'));
process.kill(lock.pid);

let restarted = false;
for (let i = 0; i < 90; i += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (response.ok) {
      const next = JSON.parse(await readFile(resolve(data, 'server.lock.json'), 'utf8'));
      if (next.pid !== lock.pid) { restarted = true; break; }
    }
  } catch {}
  await new Promise((done) => setTimeout(done, 500));
}
child.kill();
try { const finalLock = JSON.parse(await readFile(resolve(data, 'server.lock.json'), 'utf8')); process.kill(finalLock.pid); } catch {}
await new Promise((done) => setTimeout(done, 700));
await rm(data, { recursive: true, force: true });
for (let attempt = 0; attempt < 10; attempt += 1) {
  try { await rm(watchdog, { force:true }); break; }
  catch { await new Promise((done) => setTimeout(done, 250)); }
}
if (!restarted) throw new Error('看门狗没有在后台退出后重新拉起');
console.log(JSON.stringify({ status: 'PASS', initialStart: true, restartAfterCrash: true, singleWatchdog: true }, null, 2));
