import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { creatorSessionStatus, noteIdFromUrl } = require('../collector/xhs-creator-center.cjs');
if (creatorSessionStatus({ captcha:true }).code !== 'CAPTCHA' || creatorSessionStatus({ requiresLogin:true }).code !== 'LOGIN_REQUIRED' || creatorSessionStatus({ ok:true, rows:[] }).loggedIn !== true || creatorSessionStatus({}).code !== 'PAGE_UNRECOGNIZED') throw new Error('创作后台状态分类异常');
if (noteIdFromUrl('https://www.xiaohongshu.com/explore/64f123456789abcdef123456?xsec_token=test') !== '64f123456789abcdef123456' || noteIdFromUrl('https://example.com/?note_id=64f123456789abcdef123456') !== '64f123456789abcdef123456') throw new Error('小红书笔记ID解析异常');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-creator-${process.pid}-${Date.now()}`);
const dataDir = resolve(tempRoot, 'data');
const profileDir = resolve(tempRoot, 'profile');
await rm(dataDir, { recursive:true, force:true });
await rm(profileDir, { recursive:true, force:true });
const fs = await import('node:fs/promises');
await fs.mkdir(dataDir, { recursive:true });
await fs.writeFile(resolve(dataDir, 'state.json'), JSON.stringify({ version:2, mode:'workflow-agent', settings:{ masterEnabled:false }, candidates:[{ id:'candidate_creator', title:'参考', platform:'小红书' }], variants:[
  { id:'variant_creator', candidateId:'candidate_creator', workflowRunId:'', platform:'小红书', account:'测试账号', title:'测试发布笔记', body:'这是已发布笔记的正文。', tags:['测试'], status:'published', imagePages:[], pages:[], publishedAt:'2026-07-19T10:00:00+08:00', publicationUrl:'https://www.xiaohongshu.com/explore/64f123456789abcdef123456', performanceSnapshots:[] },
  { id:'variant_duplicate_a', candidateId:'candidate_creator', workflowRunId:'', platform:'小红书', account:'测试账号', title:'重复标题！！', body:'A', tags:[], status:'published', imagePages:[], pages:[], publishedAt:'2026-07-19T10:00:00+08:00', performanceSnapshots:[] },
  { id:'variant_duplicate_b', candidateId:'candidate_creator', workflowRunId:'', platform:'小红书', account:'测试账号', title:'重复标题', body:'B', tags:[], status:'published', imagePages:[], pages:[], publishedAt:'2026-07-19T10:00:00+08:00', performanceSnapshots:[] },
  { id:'variant_manual', candidateId:'candidate_creator', workflowRunId:'', platform:'小红书', account:'测试账号', title:'刚发布笔记', body:'人工登记测试', tags:[], status:'approved', imagePages:[], pages:[] },
  { id:'variant_observation', candidateId:'candidate_creator', workflowRunId:'', platform:'小红书', account:'测试账号', title:'阶段观察笔记', body:'阶段分析保持测试', tags:[], status:'published', imagePages:[], pages:[], publishedAt:new Date(Date.now() - 3 * 3600000).toISOString(), publicationUrl:'https://www.xiaohongshu.com/explore/74f123456789abcdef123456', performanceSnapshots:[] },
  { id:'variant_invalid', candidateId:'candidate_creator', workflowRunId:'', platform:'小红书', account:'测试账号', title:'无效指标测试', body:'原子保存测试', tags:[], status:'approved', imagePages:[], pages:[] }
], publications:[], materials:[], enterpriseProfiles:[], workflowRuns:[], agents:[], activity:[] }, null, 2));

const creator = createServer((request, response) => {
  response.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="zh-CN"><body><script>setTimeout(() => { document.body.insertAdjacentHTML('beforeend', \`<table><thead><tr><th>笔记基础信息</th><th>曝光</th><th>观看</th><th>封面点击率</th><th>点赞</th><th>评论</th><th>收藏</th><th>涨粉</th><th>分享</th><th>人均观看时长</th><th>弹幕</th><th>操作</th></tr></thead><tbody><tr><td><a href="https://www.xiaohongshu.com/explore/64f123456789abcdef123456">测试发布笔记</a>\\n发布于2026-07-20 10:00</td><td>12,000</td><td>1,560</td><td>13.00%</td><td>820</td><td>98</td><td>700</td><td>28</td><td>84</td><td>18s</td><td>0</td><td>详情数据</td></tr><tr><td><a href="https://www.xiaohongshu.com/explore/74f123456789abcdef123456">阶段观察笔记</a>\\n发布于2026-08-07 12:00</td><td>2,000</td><td>360</td><td>18.00%</td><td>160</td><td>20</td><td>120</td><td>8</td><td>14</td><td>12s</td><td>0</td><td>详情数据</td></tr><tr><td>重复标题\\n发布于2026-07-20 10:00</td><td>9,000</td><td>900</td><td>10.00%</td><td>500</td><td>50</td><td>300</td><td>10</td><td>30</td><td>9s</td><td>0</td><td>详情数据</td></tr></tbody></table>\`); }, 2200);</script></body></html>`);
});
await new Promise((done) => creator.listen(19994, '127.0.0.1', done));

const port = 18000 + (process.pid % 1000);
const chromePort = 19000 + (process.pid % 1000);
const child = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, windowsHide:true, stdio:['ignore','pipe','pipe'], env:{ ...process.env, CONTENTOPS_PORT:String(port), CONTENTOPS_XHS_CHROME_PORT:String(chromePort), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_XHS_PROFILE_DIR:profileDir, CONTENTOPS_XHS_CREATOR_URL:'http://127.0.0.1:19994/statistics/data-analysis', CONTENTOPS_COLLECTOR_HEADLESS:'1', CONTENTOPS_TEST_ALLOW_UNVERIFIED:'1' } });
let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
const post = (route, body = {}) => fetch(`http://127.0.0.1:${port}${route}`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) }).then((res) => res.json());
const state = () => fetch(`http://127.0.0.1:${port}/api/state`).then((res) => res.json());

try {
  for (let index = 0; index < 80; index += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise((done) => setTimeout(done, 100)); }
  const opened = await post('/api/collector/xhs-creator/open-login'); if (!opened.ok || !opened.loggedIn) throw new Error(`打开后台后未识别登录状态：${JSON.stringify(opened)}`);
  const masterForProbe = await post('/api/master/start'); if (!masterForProbe.ok) throw new Error(`登录检查竞态前总控未开启：${JSON.stringify(masterForProbe)}`);
  const delayedProbe = post('/api/performance/collect', { variantIds:['missing_variant'], manual:true });
  await new Promise((done) => setTimeout(done, 500));
  const stoppedDuringProbe = await post('/api/master/stop'); if (!stoppedDuringProbe.ok) throw new Error(`登录检查期间停止失败：${JSON.stringify(stoppedDuringProbe)}`);
  const delayedProbeResult = await delayedProbe; if (delayedProbeResult.code !== 'MASTER_STOPPED') throw new Error(`登录检查期间停止未中断返回：${JSON.stringify(delayedProbeResult)}`);
  let stoppedProbeState = await state(); const stoppedProbeAgent = stoppedProbeState.agents.find((item) => item.id === 'data-agent'); if (stoppedProbeAgent?.status !== 'idle' || !stoppedProbeAgent.detail.includes('人工总控已停止')) throw new Error(`登录检查返回覆盖了停止状态：${JSON.stringify(stoppedProbeAgent)}`);
  const beforeMasterProbe = await post('/api/performance/collect', { variantIds:['missing_variant'], manual:true });
  if (!beforeMasterProbe.ok || !beforeMasterProbe.loginReady || beforeMasterProbe.sampled !== 0) throw new Error(`停止状态下登录探测失败：${JSON.stringify(beforeMasterProbe)}`);
  let probeState = await state(); if (probeState.agents.find((item) => item.id === 'data-agent')?.status !== 'ready') throw new Error('登录有效但数据循环 Agent 未变为已就绪');
  const master = await post('/api/master/start'); if (!master.ok) throw new Error(master.message);
  const collected = await post('/api/performance/collect', { variantIds:['variant_creator'], manual:true });
  if (!collected.ok || collected.sampled !== 1) throw new Error(`后台数据采集失败：${JSON.stringify(collected)}`);
  const after = await state(); const variant = after.variants.find((item) => item.id === 'variant_creator');
  if (variant.performanceSnapshots.length !== 3 || !variant.performanceSnapshots.some((item) => item.milestoneHours === 2 && item.missing) || !variant.performanceSnapshots.some((item) => item.milestoneHours === 24 && item.missing) || variant.performanceAnalysis?.stage !== 'final' || variant.metrics.exposure !== 12000 || variant.metrics.saves !== 700 || variant.metrics.coverClickRate !== 13 || variant.publicationNoteId !== '64f123456789abcdef123456' || variant.creatorMatchedBy !== 'note_id' || variant.creatorMatchConfidence !== 100 || !variant.creatorRowKey?.startsWith('note:') || !after.publications.length) throw new Error('人工强制读取未按真实节点分析，或后台字段映射、笔记ID绑定、错过节点标记和快照沉淀异常');
  const finalDecision = variant.decision;
  const refreshedFinal = await post('/api/performance/collect', { variantIds:['variant_creator'], manual:true });
  if (!refreshedFinal.ok || refreshedFinal.sampled !== 1) throw new Error(`最终节点再次刷新失败：${JSON.stringify(refreshedFinal)}`);
  const afterFinalRefresh = await state(); const preservedFinal = afterFinalRefresh.variants.find((item) => item.id === 'variant_creator');
  if (preservedFinal.performanceAnalysis?.stage !== 'final' || preservedFinal.decision !== finalDecision) throw new Error('最终二次分析结论被后续人工刷新降级');
  if (preservedFinal.metrics.source !== 'xiaohongshu_creator_center') throw new Error('真实创作后台指标来源未保留');
  const observed = await post('/api/performance/collect', { variantIds:['variant_observation'], manual:true });
  if (!observed.ok || observed.sampled !== 1) throw new Error(`阶段节点读取失败：${JSON.stringify(observed)}`);
  const afterObservation = await state(); const observation = afterObservation.variants.find((item) => item.id === 'variant_observation');
  if (observation.performanceAnalysis?.stage !== 'observation') throw new Error('2小时真实节点未形成阶段分析');
  const observationReason = observation.performanceAnalysis.reason;
  const observationRefresh = await post('/api/performance/collect', { variantIds:['variant_observation'], manual:true });
  if (!observationRefresh.ok) throw new Error(`阶段节点再次刷新失败：${JSON.stringify(observationRefresh)}`);
  const afterObservationRefresh = await state(); const preservedObservation = afterObservationRefresh.variants.find((item) => item.id === 'variant_observation');
  if (preservedObservation.performanceAnalysis?.stage !== 'observation' || preservedObservation.performanceAnalysis.reason !== observationReason) throw new Error('阶段性AI分析被节点间人工刷新覆盖');
  const ambiguous = await post('/api/performance/collect', { variantIds:['variant_duplicate_a','variant_duplicate_b'], manual:true });
  if (!ambiguous.ok || ambiguous.sampled !== 0 || ambiguous.ambiguous?.length !== 2) throw new Error(`同标题误配保护异常：${JSON.stringify(ambiguous)}`);
  const manual = await post('/api/metrics/save', { variantId:'variant_manual', publishedAt:new Date().toISOString(), exposure:10000, likes:900, saves:700, comments:180, link:'https://www.xiaohongshu.com/explore/manual' });
  if (!manual.ok || manual.decision !== 'test' || manual.final) throw new Error(`人工登记提前二做保护异常：${JSON.stringify(manual)}`);
  const linkOnly = await post('/api/metrics/save', { variantId:'variant_manual', publishedAt:new Date().toISOString(), link:'https://www.xiaohongshu.com/explore/manual' });
  if (!linkOnly.ok || linkOnly.tracked !== true) throw new Error(`仅链接自动跟踪登记失败：${JSON.stringify(linkOnly)}`);
  const afterLinkOnly = await state(); const tracked = afterLinkOnly.variants.find((item) => item.id === 'variant_manual');
  if (!tracked?.publicationUrl || tracked.performanceSnapshots.some((snapshot) => snapshot.source === 'manual' && snapshot.exposure === 0 && snapshot.likes === 0 && snapshot.saves === 0 && snapshot.comments === 0)) throw new Error('仅链接登记未保存链接或错误写入了零值人工快照');
  const invalidMetrics = await post('/api/metrics/save', { variantId:'variant_invalid', publishedAt:new Date().toISOString(), exposure:10, likes:11, saves:1, comments:1, link:'https://www.xiaohongshu.com/explore/84f123456789abcdef123456' });
  const afterInvalid = await state(); const invalidVariant = afterInvalid.variants.find((item) => item.id === 'variant_invalid');
  if (invalidMetrics.ok || invalidVariant.status !== 'approved' || invalidVariant.publicationUrl) throw new Error('无效人工指标发生部分提交');
  console.log(JSON.stringify({ status:'PASS', stopDuringLoginProbe:true, loginProbeWhileStopped:true, dataAgentReady:true, forcedReadUsesRealMilestones:true, finalDecisionPreservedAfterRefresh:true, observationPreservedAfterRefresh:true, realMetricSourcePreserved:true, invalidMetricsAtomic:true, sampled:collected.sampled, missedMilestones:variant.performanceSnapshots.filter((item) => item.missing).map((item) => item.milestoneHours), ambiguous:ambiguous.ambiguous.length, manualDecision:manual.decision, linkOnlyAutoTracking:true, initialSnapshotFound:linkOnly.sampled, publications:after.publications.length }, null, 2));
} finally {
  // Chrome 不是 node 的直接子进程；显式停掉本测试的整棵进程树，防止锁住临时资料目录。
  try { spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide:true, stdio:'ignore', timeout:8000 }); } catch {}
  if (!child.killed && child.exitCode === null) child.kill();
  await new Promise((done) => setTimeout(done, 500));
  await new Promise((done) => creator.close(done));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { await rm(dataDir, { recursive:true, force:true }); await rm(profileDir, { recursive:true, force:true }); break; }
    catch { await new Promise((done) => setTimeout(done, 250)); }
  }
  await rm(tempRoot, { recursive:true, force:true }).catch(() => {});
  if (stderr) process.stderr.write(stderr);
}
