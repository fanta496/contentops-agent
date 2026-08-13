import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { XiaohongshuCreatorCenterCollector, numberFromText, percentFromText, secondsFromText } = require('../collector/xhs-creator-center.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appData = process.env.APPDATA;
const profileDir = join(appData, 'ContentOpsAgentV2', 'browser-profiles', 'xiaohongshu');
const errorDir = join(appData, 'ContentOpsAgentV2', 'collector-errors');
const tempRoot = resolve(process.env.TEMP || root, `ContentOpsAgent-real-creator-smoke-${process.pid}-${Date.now()}`);
const dataDir = join(tempRoot, 'data');
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const allocatePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer(); probe.unref(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close((error) => error ? reject(error) : resolvePort(port)); });
});

await mkdir(dataDir, { recursive:true });
const collector = new XiaohongshuCreatorCenterCollector({ chromePath, profileDir, errorDir, port:17841, headless:false });
const live = await collector.collect();
if (!live.ok) throw new Error(`真实创作者后台不可读：${live.code || ''} ${live.message || ''}`);
const row = (live.rows || []).find((item) => item.title && item.publishedAtRaw);
if (!row) throw new Error('真实创作者后台没有可用于绑定验证的笔记行');
const expected = {
  exposure:numberFromText(row.values?.['曝光']), views:numberFromText(row.values?.['观看']), coverClickRate:percentFromText(row.values?.['封面点击率']),
  likes:numberFromText(row.values?.['点赞']), comments:numberFromText(row.values?.['评论']), saves:numberFromText(row.values?.['收藏']), followers:numberFromText(row.values?.['涨粉']),
  shares:numberFromText(row.values?.['分享']), averageViewSeconds:secondsFromText(row.values?.['人均观看时长'])
};
const candidateId = 'candidate_real_creator_smoke'; const variantId = 'variant_real_creator_smoke';
await writeFile(join(dataDir, 'state.json'), JSON.stringify({
  version:2, mode:'workflow-agent', settings:{ masterEnabled:true, workflowAutoEnabled:false },
  candidates:[{ id:candidateId, platform:'小红书', title:'真实后台隔离验证', status:'generated' }],
  variants:[{ id:variantId, candidateId, workflowRunId:'', platform:'小红书', account:'真实后台隔离验证', title:row.title, body:'隔离验证，不进入正式业务数据', tags:[], status:'published', imagePages:[], pages:[], publicationUrl:'https://www.xiaohongshu.com/explore/real-creator-binding-smoke', publishedAt:row.publishedAtRaw, performanceSnapshots:[] }],
  publications:[], materials:[], enterpriseProfiles:[], workflowRuns:[], agents:[], activity:[]
}, null, 2), 'utf8');

const port = await allocatePort();
const child = spawn(process.execPath, [join(root, 'server.cjs')], { cwd:root, windowsHide:true, stdio:['ignore','pipe','pipe'], env:{ ...process.env, CONTENTOPS_PORT:String(port), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_XHS_PROFILE_DIR:profileDir, CONTENTOPS_XHS_CHROME_PORT:'17841', CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1' } });
let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
const post = (route, body = {}) => fetch(`http://127.0.0.1:${port}${route}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) }).then((response) => response.json());
const getState = () => fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {} await new Promise((done) => setTimeout(done, 100)); }
  if (!ready) throw new Error(`隔离验证服务未启动：${stderr}`);
  const result = await post('/api/performance/collect', { variantIds:[variantId], manual:true });
  if (!result.ok || result.sampled !== 1) throw new Error(`真实后台没有匹配到隔离笔记：${JSON.stringify(result)}`);
  const state = await getState(); const variant = state.variants.find((item) => item.id === variantId);
  const actual = variant.metrics || {};
  for (const key of ['exposure','views','likes','comments','saves','followers','shares']) if (Number(actual[key] || 0) !== Number(expected[key] || 0)) throw new Error(`${key}映射不一致：expected=${expected[key]} actual=${actual[key]}`);
  if (actual.coverClickRate !== expected.coverClickRate || actual.averageViewSeconds !== expected.averageViewSeconds) throw new Error('点击率或观看时长映射不一致');
  if (variant.creatorMatchedBy !== 'title_and_minute' || variant.creatorMatchConfidence !== 98 || !variant.creatorRowKey?.startsWith('fallback:')) throw new Error(`真实后台绑定证据不正确：${JSON.stringify({matchedBy:variant.creatorMatchedBy,confidence:variant.creatorMatchConfidence,rowKey:variant.creatorRowKey})}`);
  console.log(JSON.stringify({ status:'PASS', source:'real_xiaohongshu_creator_center', title:row.title, publishedAt:row.publishedAtRaw, matchedBy:variant.creatorMatchedBy, confidence:variant.creatorMatchConfidence, metrics:expected, formalDataUntouched:true }, null, 2));
} finally {
  try { spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide:true, stdio:'ignore', timeout:8000 }); } catch {}
  if (child.exitCode === null) try { child.kill(); } catch {}
  await new Promise((done) => setTimeout(done, 400));
  await rm(tempRoot, { recursive:true, force:true }).catch(() => {});
  if (stderr) process.stderr.write(stderr);
}
