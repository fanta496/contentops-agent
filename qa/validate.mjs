import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const node = process.execPath;
const server = resolve(root, 'server.cjs');
const renderer = resolve(root, 'launcher', 'bin', 'CardRenderer.exe');

if (!existsSync(renderer)) throw new Error('缺少 launcher/bin/CardRenderer.exe。请先运行 .\\launcher\\build.ps1。');

const child = spawn(node, [server, '--self-test'], {
  cwd: root,
  windowsHide: true,
  env: { ...process.env, CONTENTOPS_CARD_RENDERER: renderer, CONTENTOPS_PORT: '17832', CONTENTOPS_DATA_DIR: resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-validate-${process.pid}`) },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

const code = await new Promise((resolveCode) => child.on('close', resolveCode));
if (code !== 0) {
  console.error(stderr || stdout || `Self-test exited with ${code}`);
  process.exit(code || 1);
}

const match = stdout.match(/\{[\s\S]*\}/);
if (!match) throw new Error('自检没有返回结构化结果。');
const report = JSON.parse(match[0]);

const checks = {
  endToEnd: report.ok === true,
  candidates: report.candidates >= 1,
  tenVariants: report.variants >= 10,
  pngCards: report.pngCards === 7,
  supervisor: report.agents === 7,
  manualPublishGate: report.decision === 'test',
  scaleLoop: report.scaledVariants === 5,
  materialGrowth: report.materials >= 1,
  generationIdempotent: report.generationIdempotent === true,
  scaleIdempotent: report.scaleIdempotent === true
};

if (Object.values(checks).some((value) => !value)) {
  console.error(JSON.stringify({ report, checks }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: 'PASS', report, checks }, null, 2));
await rm(resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-validate-${process.pid}`), { recursive: true, force: true });
