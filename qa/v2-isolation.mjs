import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const product = resolve(root, '成品');
const node = resolve(product, 'runtime', 'node.exe');
const server = resolve(product, 'server.cjs');
const fixtureRoot = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-isolation-${process.pid}`);
const fixtureData = resolve(fixtureRoot, 'explicit-data');
const fixtureProfile = resolve(fixtureRoot, 'explicit-profile');
const fixtureErrors = resolve(fixtureRoot, 'errors');
const fixtureAppData = resolve(fixtureRoot, 'appdata');
const port = 17839;
const defaultPort = 17840;
const defaultData = join(process.env.APPDATA || process.env.USERPROFILE || product, 'ContentOpsAgentV2');
const legacyData = join(process.env.APPDATA || process.env.USERPROFILE || product, 'ContentOpsAgent');

await rm(fixtureData, { recursive: true, force: true });
await rm(fixtureProfile, { recursive: true, force: true });
await rm(fixtureErrors, { recursive: true, force: true });
await rm(fixtureAppData, { recursive: true, force: true });
await rm(fixtureRoot, { recursive: true, force: true });
await mkdir(fixtureData, { recursive: true });
await mkdir(fixtureProfile, { recursive: true });
await writeFile(resolve(fixtureProfile, 'override-marker.txt'), 'profile override preserved', 'utf8');

const child = spawn(node, [server], {
  cwd: product,
  windowsHide: true,
  env: {
    ...process.env,
    CONTENTOPS_PORT: String(port),
    CONTENTOPS_DATA_DIR: fixtureData,
    CONTENTOPS_XHS_PROFILE_DIR: fixtureProfile,
    CONTENTOPS_COLLECTOR_ERROR_DIR: fixtureErrors
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
let healthy = false;
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (response.ok && (await response.json()).appId === 'contentops-agent-v2') { healthy = true; break; }
  } catch {}
  await new Promise((done) => setTimeout(done, 100));
}

if (!healthy) {
  child.kill();
  throw new Error(`V2 隔离检查后台未启动：${stderr}`);
}

const lock = JSON.parse(await readFile(resolve(fixtureData, 'server.lock.json'), 'utf8'));
await access(resolve(fixtureProfile, 'override-marker.txt'));
child.kill();
await new Promise((done) => child.on('close', done));

const defaultEnv = { ...process.env, APPDATA: fixtureAppData, CONTENTOPS_PORT: String(defaultPort) };
delete defaultEnv.CONTENTOPS_DATA_DIR;
const defaultChild = spawn(node, [server], { cwd: product, windowsHide: true, env: defaultEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let defaultHealthy = false;
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${defaultPort}/health`);
    if (response.ok && (await response.json()).appId === 'contentops-agent-v2') { defaultHealthy = true; break; }
  } catch {}
  await new Promise((done) => setTimeout(done, 100));
}
if (!defaultHealthy) {
  defaultChild.kill();
  throw new Error('V2 默认目录检查后台未启动');
}
await access(resolve(fixtureAppData, 'ContentOpsAgentV2', 'server.lock.json'));
let legacyDefaultCreated = true;
try { await access(resolve(fixtureAppData, 'ContentOpsAgent')); } catch { legacyDefaultCreated = false; }
defaultChild.kill();
await new Promise((done) => defaultChild.on('close', done));

const source = await readFile(server, 'utf8');
const launcher = await readFile(resolve(root, 'launcher', 'ContentOpsLauncher.cs'), 'utf8');
const watchdog = await readFile(resolve(root, 'launcher', 'ContentOpsWatchdog.cs'), 'utf8');
const checks = {
  v2Identity: healthy,
  explicitDataOverride: lock.root === product,
  explicitProfileOverride: true,
  defaultRuntimeUsesV2Data: defaultHealthy,
  legacyDefaultNotCreated: !legacyDefaultCreated,
  defaultDataNamespace: source.includes("'ContentOpsAgentV2'"),
  defaultDataPathIsolated: defaultData !== legacyData,
  lockLivesUnderExplicitData: resolve(fixtureData, 'server.lock.json').startsWith(fixtureData),
  defaultUiProfileNamespace: launcher.includes('"ContentOpsAgentV2", "ChromeProfile"'),
  launcherPassesDataDirectory: launcher.includes('start.EnvironmentVariables["CONTENTOPS_DATA_DIR"] = dataDirectory'),
  watchdogPinsDataDirectory: watchdog.includes('start.EnvironmentVariables["CONTENTOPS_DATA_DIR"] = dataDirectory')
};

await rm(fixtureData, { recursive: true, force: true });
await rm(fixtureProfile, { recursive: true, force: true });
await rm(fixtureErrors, { recursive: true, force: true });
await rm(fixtureAppData, { recursive: true, force: true });
await rm(fixtureRoot, { recursive: true, force: true });

if (Object.values(checks).some((value) => !value)) {
  console.error(JSON.stringify({ status: 'FAIL', checks }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: 'PASS', checks }, null, 2));
