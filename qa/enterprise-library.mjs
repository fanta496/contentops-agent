import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-enterprise-${process.pid}`);
const port = 17839;
await rm(dataDir, { recursive: true, force: true });
const child = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd: root, env: { ...process.env, CONTENTOPS_PORT: String(port), CONTENTOPS_DATA_DIR: dataDir }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
const post = (route, body = {}) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.json());
const getState = () => fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());

try {
  for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise((done) => setTimeout(done, 100)); }
  const minimal = await post('/api/enterprise-profile/save', { name: '空资料库' });
  if (!minimal.ok) throw new Error(`只填写名称的企业资料库应可保存：${minimal.message}`);
  const first = await post('/api/enterprise-profile/save', { name: '食品安全产品线', category: '食品检测', brandName: '安心检', productName: '家庭食品快检服务', positioning: '面向家庭的食品风险教育与检测服务', audience: '关注儿童饮食安全的家庭', brandVoice: '专业但不制造恐慌', productFacts: ['提供预约检测服务', '报告由人工复核'], sellingPoints: ['结果清晰易懂'], proofPoints: ['报告可追溯'], forbiddenClaims: ['不得承诺百分之百安全'], visualRules: ['使用品牌蓝色'], referenceLinks: ['https://example.com/product'], makeActive: true });
  if (!first.ok || !first.active) throw new Error(`首个资料库保存失败：${JSON.stringify(first)}`);
  const second = await post('/api/enterprise-profile/save', { name: '企业客户产品线', brandName: '安心检', productName: '企业抽检服务', productFacts: ['按合同范围执行'], sellingPoints: ['批量管理'], makeActive: false });
  if (!second.ok) throw new Error(second.message);
  let state = await getState();
  if (state.enterpriseProfiles.length !== 3 || state.activeEnterpriseProfileId !== first.profile.id) throw new Error('资料库数量或默认选择错误');
  const protectedBefore = JSON.stringify({ active:state.activeEnterpriseProfileId, profiles:state.enterpriseProfiles.map((item) => ({ id:item.id, name:item.name, status:item.status, images:item.imageAssets.length })) });
  const staleCreate = await post('/api/enterprise-profile/save', { mode:'create', id:first.profile.id, name:'不得覆盖食品安全产品线' });
  if (staleCreate.ok) throw new Error('新建资料库携带旧标识时不应覆盖原库');
  const missingEditId = await post('/api/enterprise-profile/save', { mode:'edit', name:'不得无标识编辑' });
  if (missingEditId.ok) throw new Error('缺少标识的编辑请求不应被接受');
  const unknownEdit = await post('/api/enterprise-profile/save', { mode:'edit', id:'enterprise_does_not_exist', name:'不得创建未知编辑对象' });
  if (unknownEdit.ok) throw new Error('未知编辑对象不应被创建为新资料库');
  state = await getState();
  const protectedAfter = JSON.stringify({ active:state.activeEnterpriseProfileId, profiles:state.enterpriseProfiles.map((item) => ({ id:item.id, name:item.name, status:item.status, images:item.imageAssets.length })) });
  if (protectedAfter !== protectedBefore) throw new Error('失败的新建或编辑请求改变了已有资料库');
  await post('/api/enterprise-profile/activate', { id: second.profile.id });
  await post('/api/enterprise-profile/archive', { id: second.profile.id });
  state = await getState();
  if (state.enterpriseProfiles.find((item) => item.id === second.profile.id)?.status !== 'archived' || state.activeEnterpriseProfileId === second.profile.id) throw new Error('停用或自动切换错误');
  const archivedEdit = await post('/api/enterprise-profile/save', { mode:'edit', id:second.profile.id, name:'企业客户产品线（停用后编辑）', productFacts:['仍处于停用状态'] });
  if (!archivedEdit.ok || archivedEdit.profile.status !== 'archived') throw new Error('编辑已停用资料库时不应恢复启用状态');
  state = await getState();
  if (state.enterpriseProfiles.find((item) => item.id === second.profile.id)?.status !== 'archived' || state.activeEnterpriseProfileId === second.profile.id) throw new Error('停用资料库编辑后状态或当前生产库错误');
  await post('/api/enterprise-profile/restore', { id: second.profile.id });
  child.kill(); await new Promise((done) => setTimeout(done, 400));
  const saved = JSON.parse(await readFile(resolve(dataDir, 'state.json'), 'utf8'));
  if (saved.enterpriseProfiles.length !== 3) throw new Error('企业素材库未持久化');
  console.log(JSON.stringify({ status: 'PASS', profiles: saved.enterpriseProfiles.length, activeEnterpriseProfileId: saved.activeEnterpriseProfileId, minimalLibraryAllowed: true, failedWritesAreAtomic: true, createEditModesSeparated: true, archivedProfileEditPreservesState:true }, null, 2));
} finally {
  if (!child.killed) child.kill();
  await new Promise((done) => setTimeout(done, 300));
  await rm(dataDir, { recursive: true, force: true });
  if (stderr) process.stderr.write(stderr);
}
