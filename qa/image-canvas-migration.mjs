import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.TEMP || root, `ContentOpsAgentV2-QA-canvas-migration-${process.pid}`);
const port = 18000 + (process.pid % 1000);
const start = () => spawn(process.execPath, [resolve(root, 'server.cjs')], { cwd:root, env:{ ...process.env, CONTENTOPS_PORT:String(port), CONTENTOPS_DATA_DIR:dataDir }, windowsHide:true, stdio:'ignore' });
const state = () => fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
const ready = async () => { for (let index = 0; index < 80; index += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {} await new Promise((done) => setTimeout(done, 100)); } throw new Error('service timeout'); };

await rm(dataDir, { recursive:true, force:true });
let child = start();
try {
  await ready();
  const legacy = await state();
  legacy.settings.imageAspectRatio = '3:4';
  legacy.settings.imageSize = '1024x1536';
  legacy.candidates = [{ id:'candidate_legacy_canvas', platform:'小红书', title:'旧版比例草稿', status:'generated', source:'QA', analysisStatus:'completed' }];
  legacy.variants = [{ id:'variant_legacy_canvas', candidateId:'candidate_legacy_canvas', title:'旧版比例版本', status:'draft', imageRules:{ aspectRatio:'9:16', size:'1024x1536', textMode:'free', style:'realistic', imageCount:2 }, imagePages:[] }];
  await writeFile(resolve(dataDir, 'state.json'), JSON.stringify(legacy));
  child.kill(); await new Promise((done) => setTimeout(done, 400));
  child = start(); await ready();
  const migrated = await state();
  const disk = JSON.parse(await readFile(resolve(dataDir, 'state.json'), 'utf8'));
  const apiRules = migrated.variants[0]?.imageRules || {};
  const diskRules = disk.variants[0]?.imageRules || {};
  const expected = (rules) => rules.aspectRatio === '2:3' && rules.size === '1024x1536';
  if (migrated.settings.imageAspectRatio !== '2:3' || migrated.settings.imageSize !== '1024x1536' || disk.settings.imageAspectRatio !== '2:3' || disk.settings.imageSize !== '1024x1536' || !expected(apiRules) || !expected(diskRules)) throw new Error(JSON.stringify({ apiSettings:migrated.settings, diskSettings:disk.settings, apiRules, diskRules }));
  console.log(JSON.stringify({ status:'PASS', legacySettingsMigrated:true, legacyVariantMigrated:true, persistedAcrossColdStart:true }, null, 2));
} finally {
  child.kill(); await new Promise((done) => setTimeout(done, 300)); await rm(dataDir, { recursive:true, force:true });
}
