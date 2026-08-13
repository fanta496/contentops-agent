import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-model-profiles-${process.pid}`);
const port = 17844;
await rm(data, { recursive: true, force: true });
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); const visual = Array.isArray(body.messages?.[0]?.content);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(visual ? { ok: true, summary: 'test' } : { ok: true, message: 'ok' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
});
await new Promise((done) => mock.listen(19992, '127.0.0.1', done));
const child = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd: root, env: { ...process.env, CONTENTOPS_PORT: String(port), CONTENTOPS_DATA_DIR: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const post = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.json());

try {
  for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise((done) => setTimeout(done, 100)); }
  let result = await post('/api/model-profile/save', { kind: 'text', name: 'Text A', provider: 'test', baseUrl: 'http://127.0.0.1:19992/v1', model: 'model-a', apiKey: 'key-a' });
  if (!result.ok) throw new Error(result.message);
  const firstId = result.profile.id;
  result = await post('/api/model-profile/test', { kind: 'text', id: firstId }); if (!result.ok) throw new Error(result.message);
  result = await post('/api/model-profile/activate', { kind: 'text', id: firstId }); if (!result.ok) throw new Error(result.message);
  result = await post('/api/model-profile/save', { kind: 'text', name: 'Text B', provider: 'test', baseUrl: 'http://127.0.0.1:19992/v1', model: 'model-b', apiKey: 'key-b' });
  const secondId = result.profile.id;
  if ((await post('/api/model-profile/activate', { kind: 'text', id: secondId })).ok) throw new Error('untested profile activated');
  await post('/api/model-profile/save', { kind: 'text', id: secondId, name: 'Text B', provider: 'test', baseUrl: 'http://127.0.0.1:1/v1', model: 'model-b' });
  if ((await post('/api/model-profile/test', { kind: 'text', id: secondId })).ok) throw new Error('invalid profile test succeeded');
  let state = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  if (state.settings.activeTextProfileId !== firstId || !state.runtime.aiReady || state.settings.lastAiCheckOk !== true) throw new Error('backup test changed active connection');
  result = await post('/api/model-profile/save', { kind: 'text', id: firstId, name: 'Text A', provider: 'test', baseUrl: 'http://127.0.0.1:19992/v1', model: 'model-a', apiKey: 'new-key' });
  if (result.profile.lastTestOk) throw new Error('changing key did not require retest');
  console.log(JSON.stringify({ status: 'PASS', testedThenActivated: true, untestedBlocked: true, backupFailureIsolated: true, keyChangeRequiresRetest: true }, null, 2));
} finally { child.kill(); mock.close(); await new Promise((done) => setTimeout(done, 300)); await rm(data, { recursive: true, force: true }); }
