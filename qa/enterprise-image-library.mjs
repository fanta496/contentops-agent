import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-enterprise-images-${process.pid}`);
const port = 17857;
const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEILV/5zOFDzdoQCepz6aeExAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELi3cqoDfaKuZM4AAAAASUVORK5CYII=';
const pngBytes = Buffer.from(onePixelPng.split(',')[1], 'base64');
const largePngBytes = Buffer.concat([pngBytes, Buffer.alloc(1200 * 1024)]);
const largePng = `data:image/png;base64,${largePngBytes.toString('base64')}`;
await rm(dataDir, { recursive:true, force:true });
const child = spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, env:{ ...process.env, CONTENTOPS_PORT:String(port), CONTENTOPS_DATA_DIR:dataDir }, windowsHide:true, stdio:['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
const post = (route, body = {}) => fetch(`http://127.0.0.1:${port}${route}`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) }).then((response) => response.json());
const getState = () => fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());

try {
  for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise((done) => setTimeout(done, 100)); }
  const profile = await post('/api/enterprise-profile/save', { name:'图片企业库', brandName:'测试品牌', productName:'测试产品', productFacts:['已核实产品事实'], sellingPoints:['已核实产品卖点'], makeActive:true });
  if (!profile.ok) throw new Error(profile.message);
  const oversizedTransport = await new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({ host:'127.0.0.1', port, path:'/api/enterprise-image/upload', method:'POST', headers:{ 'content-type':'application/json', 'content-length':16 * 1024 * 1024 } }, (response) => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { raw += chunk; }); response.on('end', () => resolveRequest({ status:response.statusCode, body:JSON.parse(raw || '{}') }));
    });
    request.on('error', rejectRequest); request.end('{}');
  });
  if (oversizedTransport.status !== 413 || !String(oversizedTransport.body.message || '').includes('15MB')) throw new Error(`超大请求没有返回明确413：${JSON.stringify(oversizedTransport)}`);
  const withoutDescription = await post('/api/enterprise-image/upload', { profileId:profile.profile.id, mime:'image/png', data:onePixelPng, name:'无说明图片', kind:'product', description:'' });
  if (!withoutDescription.ok || withoutDescription.asset.description) throw new Error('无说明企业图片应可归档，但不得伪造说明');
  const wrongSignature = await post('/api/enterprise-image/upload', { profileId:profile.profile.id, mime:'image/png', data:`data:image/png;base64,${Buffer.from('not-a-real-png').toString('base64')}`, name:'伪造图片', kind:'product', description:'不应入库' });
  if (wrongSignature.ok) throw new Error('文件签名与 MIME 不一致的企业图片不应入库');
  const uploaded = await post('/api/enterprise-image/upload', { profileId:profile.profile.id, mime:'image/png', data:largePng, name:'产品包装正面', kind:'product', description:'白色产品包装正面，用于产品介绍页', immutableNotes:'不可改动包装文字' });
  if (!uploaded.ok) throw new Error(uploaded.message);
  if (uploaded.asset.size !== largePngBytes.length || uploaded.asset.size <= 1024 * 1024) throw new Error('大于1MB的企业图片没有按真实大小入库');
  const imageResponse = await fetch(`http://127.0.0.1:${port}/api/enterprise-image/${encodeURIComponent(uploaded.asset.id)}`);
  if (!imageResponse.ok || imageResponse.headers.get('content-type') !== 'image/png') throw new Error('企业图片读取失败');
  const current = await getState();
  if (current.enterpriseProfiles[0].imageAssets.length !== 2 || current.enterpriseProfiles[0].imageAssets.some((asset) => asset.file.includes('..'))) throw new Error('企业图片元数据不正确');
  const staleCreate = await post('/api/enterprise-profile/save', { mode:'create', id:profile.profile.id, name:'不允许覆盖旧库' });
  if (staleCreate.ok) throw new Error('新建请求携带旧资料库标识时不应覆盖旧库');
  const updated = await post('/api/enterprise-profile/save', { mode:'edit', id:profile.profile.id, name:'图片企业库（已编辑）' });
  if (!updated.ok) throw new Error(updated.message);
  if (updated.profile.imageAssets.length !== 2) throw new Error('编辑资料库的返回对象没有保留已有图片资产');
  const afterProfileEdit = await getState();
  if (afterProfileEdit.enterpriseProfiles[0].imageAssets.length !== 2) throw new Error('编辑资料库覆盖了已有图片资产');
  const malformedPath = resolve(dataDir, 'enterprise-assets', ...withoutDescription.asset.file.split('/'));
  await rm(malformedPath, { force:true }); await mkdir(malformedPath, { recursive:true });
  const malformedDelete = await post('/api/enterprise-image/delete', { profileId:profile.profile.id, assetId:withoutDescription.asset.id });
  if (malformedDelete.ok) throw new Error('物理图片不是普通文件时不应删除元数据');
  const afterMalformedDelete = await getState();
  if (!afterMalformedDelete.enterpriseProfiles[0].imageAssets.some((asset) => asset.id === withoutDescription.asset.id)) throw new Error('物理删除失败却丢失了图片元数据');
  await rm(malformedPath, { recursive:true, force:true }); await writeFile(malformedPath, pngBytes);
  const deleted = await post('/api/enterprise-image/delete', { profileId:profile.profile.id, assetId:uploaded.asset.id });
  if (!deleted.ok) throw new Error(deleted.message);
  const deletedWithoutDescription = await post('/api/enterprise-image/delete', { profileId:profile.profile.id, assetId:withoutDescription.asset.id });
  if (!deletedWithoutDescription.ok) throw new Error(deletedWithoutDescription.message);
  const afterDelete = await fetch(`http://127.0.0.1:${port}/api/enterprise-image/${encodeURIComponent(uploaded.asset.id)}`);
  if (afterDelete.status !== 404) throw new Error('删除后企业图片仍可读取');
  console.log(JSON.stringify({ status:'PASS', uploadStored:true, uploadOverOneMegabyte:true, oversizedTransportRejectedWith413:true, mimeSignatureChecked:true, localRead:true, deleteRemoved:true, descriptionOptional:true, profileEditPreservedImages:true, staleCreateCannotOverwrite:true, failedPhysicalDeletePreservesMetadata:true }, null, 2));
} finally {
  if (!child.killed) child.kill();
  await new Promise((done) => setTimeout(done, 250));
  await rm(dataDir, { recursive:true, force:true });
  if (stderr) process.stderr.write(stderr);
}
