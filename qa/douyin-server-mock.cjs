const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
const controlFile = process.env.CONTENTOPS_TEST_DOUYIN_CONTROL_FILE || '';
const logFile = process.env.CONTENTOPS_TEST_DOUYIN_LOG_FILE || '';

function readControl() {
  try { return JSON.parse(fs.readFileSync(controlFile, 'utf8')); }
  catch { return {}; }
}

function log(event, detail = {}) {
  if (!logFile) return;
  fs.mkdirSync(path.dirname(logFile), { recursive:true });
  fs.appendFileSync(logFile, `${JSON.stringify({ event, at:new Date().toISOString(), ...detail })}\n`, 'utf8');
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function controlledDelay(event, shouldStop) {
  const control = readControl();
  const delayMs = Math.max(20, Number(control[`${event}DelayMs`] ?? control.delayMs ?? 700));
  log(`${event}:start`, { delayMs });
  const startedAt = Date.now();
  while (Date.now() - startedAt < delayMs) {
    if (shouldStop?.()) { log(`${event}:stopped`); return false; }
    await sleep(Math.min(25, delayMs));
  }
  log(`${event}:finish`);
  return true;
}

function douyinItem(sourceUrl, version = 1, imageToken = 'stable', imageHost = 'p3.douyinpic.com') {
  const id = (String(sourceUrl).match(/[?&]modal_id=(\d+)/) || String(sourceUrl).match(/\/(?:note|video)\/(\d+)/) || [])[1] || '930001';
  return {
    id,
    url:`https://www.douyin.com/note/${id}`,
    sourceUrl,
    title:`抖音测试图文 v${version}`,
    body:`这是第${version}版正文，只用于离线服务端安全回归。`,
    author:'离线QA',
    tags:[`版本${version}`,'安全回归'],
    imageUrls:[`https://${imageHost}/obj/offline-${id}-v${version}.webp?x-signature=${encodeURIComponent(imageToken)}`],
    imageCount:1,
    likes:100 + version,
    saves:20 + version,
    comments:5 + version,
    shares:2 + version,
    publishedAtRaw:'2026-07-28',
    publishedAt:'2026-07-27T16:00:00.000Z',
    contentType:'image_text',
    detailStatus:'enriched',
    parserVersion:'douyin-offline-server-qa-v1',
    sourceMethod:'offline_mock',
    collectedAt:new Date().toISOString(),
    rawText:[`抖音测试图文 v${version}`, `这是第${version}版正文`],
    diagnostic:{ offlineMock:true, version }
  };
}

class FakeDouyinCollector {
  async openLogin() {
    await controlledDelay('douyin.openLogin');
    return { ok:true, message:'离线模拟登录窗口已完成' };
  }

  async importLink(sourceUrl) {
    await controlledDelay('douyin.importLink');
    const control = readControl();
    if (control.douyinImportResult === 'fail') return { ok:false, code:'MOCK_IMPORT_FAILED', message:'离线模拟导入失败' };
    return { ok:true, item:douyinItem(sourceUrl, Number(control.importVersion || 1), String(control.imageToken || 'stable'), String(control.imageHost || 'p3.douyinpic.com')) };
  }

  async collect(options = {}) {
    const completed = await controlledDelay('douyin.collect', options.shouldStop);
    if (!completed) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，离线模拟采集已中断' };
    const control = readControl();
    if (control.douyinCollectResult === 'fail') return { ok:false, code:'MOCK_DOUYIN_FAILED', message:'离线模拟抖音采集失败' };
    const items = control.douyinCollectItems === 'one' ? [douyinItem('https://www.douyin.com/note/930002', Number(control.importVersion || 1), String(control.imageToken || 'stable'), String(control.imageHost || 'p3.douyinpic.com'))] : [];
    return { ok:true, items, warnings:[], filterStats:{ raw:items.length, prefiltered:items.length, detailed:items.length, qualified:items.length, rejected:{ video:0, low_relevance:0, no_images:0, low_interaction:0 }, duplicates:0 }, message:items.length ? '' : '离线模拟：本轮无候选' };
  }

  closeBrowser() {}
}

class FakeXhsCollector {
  async openLogin() { await controlledDelay('xhs.openLogin'); return { ok:true, message:'离线模拟小红书登录' }; }
  async importLink(sourceUrl) { await controlledDelay('xhs.importLink'); return { ok:false, code:'MOCK_XHS_IMPORT_DISABLED', message:`离线模拟未导入 ${sourceUrl}` }; }
  async collect(options = {}) {
    const completed = await controlledDelay('xhs.collect', options.shouldStop);
    if (!completed) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，离线模拟小红书采集已中断' };
    const control = readControl();
    if (control.xhsCollectResult !== 'success') return { ok:false, code:'MOCK_XHS_FAILED', message:'离线模拟小红书采集失败' };
    return { ok:true, items:[], warnings:[], filterStats:{ raw:0, qualified:0 } };
  }
  closeBrowser() {}
}

class FakeCreatorCenterCollector {
  async openLogin() { log('creator.openLogin:called'); throw new Error('抖音门禁失效：错误进入小红书创作后台 openLogin'); }
  async probe() { log('creator.probe:called'); throw new Error('抖音门禁失效：错误进入小红书创作后台 probe'); }
  async collect() { log('creator.collect:called'); throw new Error('抖音门禁失效：错误进入小红书创作后台 collect'); }
}

Module._load = function patchedLoad(request, parent, isMain) {
  const fromServer = parent?.filename && path.basename(parent.filename) === 'server.cjs';
  if (fromServer && /[\\/]collector[\\/]douyin\.cjs$/.test(request)) return { DouyinCollector:FakeDouyinCollector };
  if (fromServer && /[\\/]collector[\\/]xiaohongshu\.cjs$/.test(request)) return { XiaohongshuCollector:FakeXhsCollector };
  if (fromServer && /[\\/]collector[\\/]xhs-creator-center\.cjs$/.test(request)) {
    const actual = originalLoad.call(this, request, parent, isMain);
    return { ...actual, XiaohongshuCreatorCenterCollector:FakeCreatorCenterCollector };
  }
  return originalLoad.call(this, request, parent, isMain);
};
