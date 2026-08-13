import { spawn } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-enterprise-export-${process.pid}`);
const exportRoot = resolve(dataDir, 'exports');
const port = 17861;
const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEILV/5zOFDzdoQCepz6aeExAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELi3cqoDfaKuZM4AAAAASUVORK5CYII=';
await rm(dataDir, { recursive:true, force:true });
const child = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, env:{ ...process.env, CONTENTOPS_PORT:String(port), CONTENTOPS_DATA_DIR:dataDir, CONTENTOPS_OPEN_EXPORT_FOLDER:'0' }, windowsHide:true, stdio:['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
const post = (route, body = {}) => fetch(`http://127.0.0.1:${port}${route}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) }).then((response) => response.json());
const getState = () => fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());

try {
  for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise((done) => setTimeout(done, 100)); }
  const profile = await post('/api/enterprise-profile/save', { name:'可导出企业库', brandName:'测试品牌', productFacts:['可核实事实'], makeActive:true });
  if (!profile.ok) throw new Error(profile.message);
  const first = await post('/api/enterprise-image/upload', { profileId:profile.profile.id, mime:'image/png', data:onePixelPng, name:'产品正面', kind:'product', description:'用于导出验证的产品正面图' });
  const second = await post('/api/enterprise-image/upload', { profileId:profile.profile.id, mime:'image/png', data:onePixelPng, name:'产品正面', kind:'reference', description:'' });
  if (!first.ok || !second.ok) throw new Error(first.message || second.message);
  const before = JSON.stringify((await getState()).enterpriseProfiles[0]);
  const invalid = await post('/api/enterprise-profile/export', { profileId:profile.profile.id, directory:'relative-path' });
  if (invalid.ok) throw new Error('相对路径不应允许导出');
  const blockedParent = resolve(dataDir, 'not-a-directory'); await writeFile(blockedParent, 'not a directory');
  const blocked = await post('/api/enterprise-profile/export', { profileId:profile.profile.id, directory:blockedParent });
  if (blocked.ok) throw new Error('无法写入的导出目录不应返回成功');
  if (JSON.stringify((await getState()).enterpriseProfiles[0]) !== before) throw new Error('导出写入失败不应修改企业资料库');
  const exported = await post('/api/enterprise-profile/export', { profileId:profile.profile.id, directory:exportRoot });
  if (!exported.ok) throw new Error(exported.message);
  const files = await readdir(exported.path); if (!files.includes('企业资料库.json') || !files.includes('说明.txt') || !files.includes('images')) throw new Error('导出包缺少清单或图片目录');
  const images = await readdir(resolve(exported.path, 'images')); if (images.length !== 2 || new Set(images).size !== 2) throw new Error('导出图片不完整或同名图片被覆盖');
  const snapshot = JSON.parse(await readFile(resolve(exported.path, '企业资料库.json'), 'utf8'));
  if (snapshot.format !== 'contentops-enterprise-library-v1' || snapshot.profile.imageAssets.length !== 2 || snapshot.profile.imageAssets.some((asset) => !asset.file.startsWith('images/') || asset.file.includes('enterprise-assets'))) throw new Error('导出清单不完整或泄露了本机业务路径');
  const after = JSON.stringify((await getState()).enterpriseProfiles[0]);
  if (after !== before) throw new Error('导出不应修改企业资料库');
  console.log(JSON.stringify({ status:'PASS', exportSnapshot:true, copiedImages:images.length, sameNameSafe:true, sourceUnchanged:true, localPathsHidden:true, invalidDirectoryRejected:true, failedExportIsAtomic:true }, null, 2));
} finally {
  if (!child.killed) child.kill();
  await new Promise((done) => setTimeout(done, 250));
  await rm(dataDir, { recursive:true, force:true });
  if (stderr) process.stderr.write(stderr);
}
