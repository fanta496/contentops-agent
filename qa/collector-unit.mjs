import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeCount,
  normalizeOptionalCount,
  normalizePublishedAt,
  extractionScript,
  detailExtractionScript,
  mergeDetail,
  relevanceScore,
  searchQualityScore,
  detailQuality,
  isRecoverableBrowserError,
  browserRecoveryFailure,
  navigationReached,
  dedupeRanked,
  XiaohongshuCollector
} = require('../collector/xiaohongshu.cjs');

assert.equal(normalizeCount('1.2万'), 12000);
assert.equal(normalizeCount('2w'), 20000);
assert.equal(normalizeCount('3.4千'), 3400);
assert.equal(normalizeCount('5k'), 5000);
assert.equal(normalizeCount('1,234'), 1234);
assert.equal(normalizeCount('1.1亿'), 110000000);
assert.equal(normalizeOptionalCount('收藏 2.5万'), 25000);
assert.equal(normalizeOptionalCount('赞'), null);
assert.equal(normalizePublishedAt(1750000000), '2025-06-15T15:06:40.000Z');
assert.equal(normalizePublishedAt('2026-07-18 15:15'), '2026-07-18T07:15:00.000Z');
assert.equal(normalizePublishedAt('昨天 09:30', '2026-07-20T04:00:00.000Z'), '2026-07-19T01:30:00.000Z');
assert.match(extractionScript(8), /results\.length >= 8/);
assert.match(extractionScript(8), /isVideo/);
assert.match(detailExtractionScript('note-alpha'), /publishedAtRaw/);
assert.match(detailExtractionScript('note-alpha'), /imageUrls/);
assert.match(detailExtractionScript('note-alpha'), /requiresLogin/);
assert.match(extractionScript(12), /accessUrl/);
assert.match(extractionScript(12), /xsec_token/);

const enriched = mergeDetail(
  { id: 'note-alpha', title: '卡片标题', author: '卡片作者', likeText: '1.2万', coverUrl: 'https://img.example/cover.jpg' },
  {
    meaningful: true,
    title: '详情标题',
    author: '详情作者',
    body: '正文内容 #内容运营 #增长',
    tags: ['内容运营', '增长'],
    publishedAtRaw: '2026-07-18 15:15',
    imageUrls: ['https://img.example/1.jpg', 'https://img.example/2.jpg'],
    likeText: '2万', saveText: '收藏 3.4千', commentText: 89,
    contentType: 'image_text'
  },
  '2026-07-20T00:00:00.000Z'
);
assert.equal(enriched.title, '详情标题');
assert.equal(enriched.body, '正文内容 #内容运营 #增长');
assert.deepEqual(enriched.tags, ['内容运营', '增长']);
assert.equal(enriched.publishedAt, '2026-07-18T07:15:00.000Z');
assert.deepEqual(enriched.imageUrls, ['https://img.example/1.jpg', 'https://img.example/2.jpg']);
assert.equal(enriched.likes, 20000);
assert.equal(enriched.saves, 3400);
assert.equal(enriched.comments, 89);
assert.equal(enriched.detailStatus, 'enriched');

const unavailable = mergeDetail({ id: 'note-beta', likeText: '88', coverUrl: 'https://img.example/cover.jpg' }, null, '2026-07-20T00:00:00.000Z');
assert.equal(unavailable.likes, 88);
assert.equal(unavailable.saves, null);
assert.equal(unavailable.detailStatus, 'unavailable');

assert.equal(relevanceScore({ title: '食品安全避坑指南' }, '食品安全'), 42);
assert.equal(relevanceScore({ title: '和crush的聊天记录' }, '食品安全'), 0);
assert.ok(searchQualityScore({ title: '食品安全避坑指南', author: '研究所', likeText: '1.2万', coverUrl: 'x' }, '食品安全', 0, false) > 70);
assert.equal(detailQuality({ keyword: '食品安全', title: '聊天记录', body: '恋爱日常', detailStatus: 'enriched', imageUrls: ['x'], likes: 20, saves: 1, comments: 2, contentType: 'image_text' }, true).qualified, false);
assert.equal(detailQuality({ keyword: '食品安全', title: '超级高赞恋爱聊天', body: '恋爱日常', detailStatus: 'enriched', imageUrls: ['x'], likes: 2000000, saves: 500000, comments: 100000, contentType: 'image_text' }, true).rejectReason, 'low_relevance');
assert.equal(detailQuality({ keyword: '食品安全', title: '食品安全普通分享', body: '食品安全内容', detailStatus: 'enriched', imageUrls: ['x'], likes: 10, saves: 2, comments: 1, contentType: 'image_text' }, false).rejectReason, 'low_interaction');
assert.equal(detailQuality({ keyword: '食品安全', title: '食品安全长文', body: '食品安全完整正文', detailStatus: 'enriched', imageUrls: [], likes: 10000, saves: 3000, comments: 500, contentType: 'image_text' }, false).rejectReason, 'no_images');
assert.equal(detailQuality({ keyword: '食品安全', title: '食品安全避坑指南', body: '食品安全完整方法', detailStatus: 'enriched', imageUrls: ['x'], likes: 5000, saves: 1500, comments: 200, contentType: 'image_text' }, true).qualified, true);
assert.deepEqual(dedupeRanked([{ id:'1', title:'同一标题', author:'甲' }, { id:'2', title:'同一标题', author:'甲' }, { id:'3', title:'另一标题', author:'乙' }]), { kept:[{ id:'1', title:'同一标题', author:'甲' }, { id:'3', title:'另一标题', author:'乙' }], duplicates:1 });

const fixtureCollector = new XiaohongshuCollector({
  chromePath: 'unused', profileDir: 'unused', errorDir: 'unused', searchBaseUrl: 'http://127.0.0.1:19999/xhs-search.html'
});
assert.equal(fixtureCollector.homeUrl(), 'http://127.0.0.1:19999/xhs-search.html');
assert.equal(fixtureCollector.hostHint(), '127.0.0.1');
assert.match(fixtureCollector.searchUrl('内容运营'), /keyword=%E5%86%85%E5%AE%B9%E8%BF%90%E8%90%A5/);

const recoveryFailureCollector = new XiaohongshuCollector({ chromePath:'unused', profileDir:'unused', errorDir:'unused' });
recoveryFailureCollector.session.openClient = async () => { const error = new Error('Runtime.evaluate 执行超时'); error.code = 'BROWSER_SESSION_RECOVERY_FAILED'; error.attempts = [{ stage:'existing_tab' }, { stage:'new_tab' }, { stage:'browser_restart' }]; throw error; };
const recoveryFailure = await recoveryFailureCollector.collect({ keywords:['内容运营'] });
assert.equal(recoveryFailure.code, 'BROWSER_SESSION_RECOVERY_FAILED');
assert.equal(recoveryFailure.recoveryAttempts.length, 3);
assert.match(recoveryFailure.message, /自动尝试新标签页和重启恢复/);

assert.equal(isRecoverableBrowserError(Object.assign(new Error('Page.navigate 执行超时'), { code:'BROWSER_CDP_COMMAND_TIMEOUT' })), true);
assert.equal(navigationReached(
  'https://www.xiaohongshu.com/search_result?keyword=%E5%86%85%E5%AE%B9%E8%BF%90%E8%90%A5',
  { href:'https://www.xiaohongshu.com/' },
  { href:'https://www.xiaohongshu.com/search_result?keyword=%E5%86%85%E5%AE%B9%E8%BF%90%E8%90%A5', readyState:'complete', bodyTextLength:200, imageCount:3 }
), true);
assert.equal(navigationReached(
  'https://www.xiaohongshu.com/search_result?keyword=%E5%86%85%E5%AE%B9%E8%BF%90%E8%90%A5',
  { href:'https://www.xiaohongshu.com/search_result?keyword=%E6%97%A7%E8%AF%8D' },
  { href:'https://www.xiaohongshu.com/search_result?keyword=%E6%97%A7%E8%AF%8D', readyState:'complete', bodyTextLength:200, imageCount:3 }
), false);
const exhaustedRecovery = browserRecoveryFailure(Object.assign(new Error('Runtime.evaluate 执行超时'), { code:'BROWSER_CDP_COMMAND_TIMEOUT' }), 2);
assert.equal(exhaustedRecovery.code, 'BROWSER_SESSION_RECOVERY_FAILED');
assert.equal(exhaustedRecovery.attempts.at(-1).recoveryCount, 2);
const midRunRecoveryCollector = new XiaohongshuCollector({ chromePath:'unused', profileDir:'unused', errorDir:'unused', searchBaseUrl:'http://127.0.0.1:19999/xhs-search.html' });
let recoveryOpenCount = 0;
const searchItem = { id:'note-alpha', title:'内容运营爆款方法', author:'测试作者', likeText:'1.2万', coverUrl:'data:image/gif;base64,R0lGODlhAQABAAAAACw=', url:'http://127.0.0.1:19999/explore/note-alpha', accessUrl:'http://127.0.0.1:19999/search_result/note-alpha?xsec_token=test' };
const firstClient = {
  async evaluate(expression) {
    if (String(expression).includes('readyState:')) return { href:'http://127.0.0.1:19999/xhs-search.html?keyword=%E5%86%85%E5%AE%B9%E8%BF%90%E8%90%A5', readyState:'complete', bodyTextLength:300, imageCount:2 };
    if (String(expression).includes('const cards =')) return [searchItem];
    if (String(expression).includes('results.length >=')) return { results:[searchItem], requiresLogin:false, captcha:false };
    return { results:[searchItem], requiresLogin:false, captcha:false };
  },
  close() {}
};
const recoveredClient = {
  async evaluate(expression) {
    if (String(expression).includes('readyState:')) return { href:searchItem.accessUrl, readyState:'complete', bodyTextLength:500, imageCount:3 };
    return { identityMatched:true, meaningful:true, title:'内容运营爆款方法', author:'测试作者', body:'内容运营完整正文和企业增长方法', tags:['内容运营'], publishedAtRaw:'2026-07-18 15:15', imageUrls:['https://img.example/note-alpha.jpg'], likeText:'1.2万', saveText:'3400', commentText:'89', contentType:'image_text', requiresLogin:false, captcha:false, url:searchItem.accessUrl };
  },
  close() {}
};
midRunRecoveryCollector.session.openClient = async () => ({ client:++recoveryOpenCount === 1 ? firstClient : recoveredClient, recovered:recoveryOpenCount > 1, recoveryStage:recoveryOpenCount > 1 ? 'new_tab' : 'none' });
midRunRecoveryCollector.session.navigate = async (client, url) => {
  if (client === firstClient && url.includes('note-alpha')) {
    const error = new Error('Page.navigate 执行超时'); error.code = 'BROWSER_CDP_COMMAND_TIMEOUT'; throw error;
  }
};
const recoveredCollection = await midRunRecoveryCollector.collect({ keywords:['内容运营'], rawLimit:1, maxPerKeyword:1, detailLimit:1, finalLimit:1, scrollRounds:0, delayMs:1 });
assert.equal(recoveredCollection.ok, true, JSON.stringify(recoveredCollection));
assert.equal(recoveredCollection.items.length, 1);
assert.equal(recoveryOpenCount, 2);
assert.ok(recoveredCollection.warnings.some((warning) => warning.code === 'BROWSER_SESSION_RECOVERED'), JSON.stringify(recoveredCollection));

const searchRecoveryCollector = new XiaohongshuCollector({ chromePath:'unused', profileDir:'unused', errorDir:'unused', searchBaseUrl:'http://127.0.0.1:19999/xhs-search.html' });
let searchRecoveryOpenCount = 0;
let searchRecoveredUrl = 'http://127.0.0.1:19999/xhs-search.html';
const staleSearchClient = {
  async evaluate(expression) {
    if (String(expression).includes('readyState:')) return { href:'http://127.0.0.1:19999/xhs-search.html', readyState:'complete', bodyTextLength:100, imageCount:1 };
    return [];
  },
  close() {}
};
const healthySearchClient = {
  async evaluate(expression) {
    if (String(expression).includes('readyState:')) return { href:searchRecoveredUrl, readyState:'complete', bodyTextLength:500, imageCount:3 };
    if (String(expression).includes('const expectedId =')) return { identityMatched:true, meaningful:true, title:'内容运营爆款方法', author:'测试作者', body:'内容运营完整正文和企业增长方法', tags:['内容运营'], publishedAtRaw:'2026-07-18 15:15', imageUrls:['https://img.example/note-alpha.jpg'], likeText:'1.2万', saveText:'3400', commentText:'89', contentType:'image_text', requiresLogin:false, captcha:false, url:searchItem.accessUrl };
    if (String(expression).includes('const cards =')) return [searchItem];
    if (String(expression).includes('results.length >=')) return { results:[searchItem], requiresLogin:false, captcha:false };
    return { results:[searchItem], requiresLogin:false, captcha:false };
  },
  close() {}
};
searchRecoveryCollector.session.openClient = async () => ({ client:++searchRecoveryOpenCount === 1 ? staleSearchClient : healthySearchClient, recovered:searchRecoveryOpenCount > 1, recoveryStage:searchRecoveryOpenCount > 1 ? 'new_tab' : 'none' });
searchRecoveryCollector.session.navigate = async (client, url) => {
  if (client === staleSearchClient) { const error = new Error('Page.navigate 执行超时'); error.code = 'BROWSER_CDP_COMMAND_TIMEOUT'; throw error; }
  searchRecoveredUrl = url;
};
const searchRecoveredCollection = await searchRecoveryCollector.collect({ keywords:['内容运营'], rawLimit:1, maxPerKeyword:1, detailLimit:1, finalLimit:1, scrollRounds:0, delayMs:1 });
assert.equal(searchRecoveredCollection.ok, true);
assert.equal(searchRecoveredCollection.items.length, 1);
assert.equal(searchRecoveryOpenCount, 2);
assert.ok(searchRecoveredCollection.warnings.some((warning) => warning.code === 'BROWSER_SESSION_RECOVERED' && warning.stage === 'search'));

const softNavigationCollector = new XiaohongshuCollector({ chromePath:'unused', profileDir:'unused', errorDir:'unused', searchBaseUrl:'http://127.0.0.1:19999/xhs-search.html' });
let softOpenCount = 0;
let softCurrentUrl = 'http://127.0.0.1:19999/xhs-search.html';
let softSearchTimeoutPending = true;
const softClient = {
  async evaluate(expression) {
    if (String(expression).includes('readyState:')) return { href:softCurrentUrl, readyState:'complete', bodyTextLength:500, imageCount:3 };
    if (String(expression).includes('const expectedId =')) return { identityMatched:true, meaningful:true, title:'内容运营爆款方法', author:'测试作者', body:'内容运营完整正文和企业增长方法', tags:['内容运营'], publishedAtRaw:'2026-07-18 15:15', imageUrls:['https://img.example/note-alpha.jpg'], likeText:'1.2万', saveText:'3400', commentText:'89', contentType:'image_text', requiresLogin:false, captcha:false, url:searchItem.accessUrl };
    if (String(expression).includes('const cards =')) return [searchItem];
    if (String(expression).includes('results.length >=')) return { results:[searchItem], requiresLogin:false, captcha:false };
    return { results:[searchItem], requiresLogin:false, captcha:false };
  },
  close() {}
};
softNavigationCollector.session.openClient = async () => { softOpenCount += 1; return { client:softClient, recovered:false, recoveryStage:'none' }; };
softNavigationCollector.session.navigate = async (_client, url) => {
  softCurrentUrl = url;
  if (url.includes('keyword=') && softSearchTimeoutPending) { softSearchTimeoutPending = false; const error = new Error('Page.navigate 执行超时'); error.code = 'BROWSER_CDP_COMMAND_TIMEOUT'; throw error; }
};
const softRecoveredCollection = await softNavigationCollector.collect({ keywords:['内容运营'], rawLimit:1, maxPerKeyword:1, detailLimit:1, finalLimit:1, scrollRounds:0, delayMs:1 });
assert.equal(softRecoveredCollection.ok, true);
assert.equal(softRecoveredCollection.items.length, 1);
assert.equal(softOpenCount, 1);
assert.ok(softRecoveredCollection.warnings.some((warning) => warning.code === 'NAVIGATION_TIMEOUT_PAGE_READY' && warning.stage === 'search'));

console.log(JSON.stringify({
  status: 'PASS', normalizeCount: true, publishedAt: true, fixtureIsolation: true,
  extractionScript: true, detailExtractionScript: true, mergeDetail: true, sessionFailurePropagated:true,
  midRunBrowserRecovery:true, searchNavigationRecovery:true, softNavigationTimeoutRecovery:true
}, null, 2));
