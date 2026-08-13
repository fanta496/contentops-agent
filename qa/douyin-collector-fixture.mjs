import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DouyinCollector, searchScript, detailScript } = require('../collector/douyin.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = resolve(root, 'qa', `.douyin-fixture-profile-${process.pid}-${Date.now()}`);
const errorDir = resolve(root, 'qa', `.douyin-fixture-errors-${process.pid}-${Date.now()}`);
const html = (body, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const image = (url, extra = '') => `<img width="300" height="300" src="${url}" ${extra}>`;
const noteMarkup = ({ title = 'alpha image note', body = 'alpha purchase checklist #alpha #safe', count = 1, images = [], frame = '' } = {}) => html(`
  ${frame}
  <section class="detail">
    ${images.join('')}
    <div>点赞 128000</div><div>收藏 3400</div><div>评论 120</div><div>转发 56</div>
    <div>1 / ${count}</div><div>@alpha_lab</div><div>${title}</div><div>${body}</div><div>2026-07-20</div><div>图文</div>
  </section>`);

const completeImages = [
  image('https://p3.douyinpic.com/obj/alpha-1.webp?size=large'),
  image('https://p9.byteimg.com/obj/alpha-1.webp?size=small'), // same media path: must deduplicate
  image('https://p9.byteimg.com/obj/alpha-2.webp'),
  image('https://p3.douyinpic.com/obj/alpha-3.webp'),
  image('https://p3.douyinpic.com/obj/alpha-4.webp'),
  image('https://p3.douyinpic.com/obj/alpha-5.webp'),
  image('https://p3.douyinpic.com/obj/alpha-6.webp', 'style="display:none"') // hidden carousel slide
];
const notePage = noteMarkup({ count:6, images:completeImages });
const incompletePage = noteMarkup({ title:'alpha incomplete media', body:'alpha safe incomplete body', count:3, images:[image('https://p3.douyinpic.com/obj/incomplete-1.webp')] });
const noImageNotePage = noteMarkup({ title:'alpha missing media', body:'body without images', count:3, images:[] });
const hiddenCaptchaNote = noteMarkup({ count:1, images:[image('https://p3.douyinpic.com/obj/hidden-frame.webp')], frame:'<iframe src="/rc-verifycenter/empty" style="display:none"></iframe>' });
const visibleCaptchaNote = noteMarkup({ count:1, images:[image('https://p3.douyinpic.com/obj/visible-frame.webp')], frame:'<iframe src="/rc-verifycenter/empty" style="position:fixed;left:10px;top:10px;width:320px;height:240px"></iframe>' });
const misleadingMetricPage = html(`<section class="detail">${image('https://p3.douyinpic.com/obj/metric-negative.webp')}<div>1 / 1</div><div>@alpha_lab</div><div>alpha metric negative</div><div>点赞3倍技巧，收藏5个方法</div><div>2026-07-20</div><div>图文</div></section>`);
const delayedCarouselCountPage = html(`<section class="detail">${image('https://p3.douyinpic.com/obj/delayed-count-1.webp')}<div>@alpha_lab</div><div>alpha delayed carousel</div><div>alpha safe delayed body</div><div>2026-07-20</div><div>图文</div></section><script>setTimeout(() => { const count=document.createElement('div'); count.textContent='1 / 3'; document.querySelector('.detail').prepend(count); }, 500);</script>`);
const structuredPage = html(`
  <script type="application/json">${JSON.stringify({ app:{ aweme_detail:{ aweme_id:'700005', item_title:'structured alpha title', desc:'structured alpha first line\nsafe second line #alpha', author:{ nickname:'state_author' }, create_time:1784476800, statistics:{ digg_count:9001, collect_count:801, comment_count:71, share_count:61 }, image_post_info:{ images:[
    { display_image:{ url_list:['https://p3.douyinpic.com/obj/state-1.webp?x=1','https://p9.byteimg.com/obj/state-1.webp?x=2'] } },
    { origin_image:{ url_list:['https://p9.byteimg.com/obj/state-2.webp'] } },
    { download_url:{ url_list:['https://p3.douyinpic.com/obj/state-3.webp'] } }
  ] } } } })}</script>
  <main><div>1/3</div><div>图文</div></main>`);

const searchPage = html(`
  <iframe src="/rc-verifycenter/empty" style="display:none"></iframe>
  <article class="card"><a href="/note/700001?modal_id=700001">${image('https://p3.douyinpic.com/obj/alpha.webp')}<h3>alpha image note</h3><p>1/6 alpha</p></a></article>
  <article class="card"><a href="/video/700002?modal_id=700002">${image('https://p3.douyinpic.com/obj/video.webp')}<h3>alpha video</h3><p>video 00:20</p></a></article>`);
const modernSearchPage = html(`<main id="search-content-area">
  <iframe src="/rc-verifycenter/empty" style="display:none"></iframe>
  <div class="modern-card" onclick="location.href='/note/700001?modal_id=700001'">${image('https://p3.douyinpic.com/obj/modern-1.webp')}<p>alpha modern image note</p></div>
  <div class="modern-card" onclick="location.href='/video/700002?modal_id=700002'">${image('https://p3.douyinpic.com/obj/modern-2.webp')}<p>01:15 alpha modern video</p></div>
  <div class="modern-card" onclick="location.href='/video/700008?modal_id=700008'">${image('https://p3.douyinpic.com/obj/modern-3.webp')}<p>alpha disguised media card</p></div>
</main>`);
const visibleCaptchaSearch = html(`<main id="search-content-area"><iframe src="/rc-verifycenter/empty" style="width:320px;height:240px"></iframe>${image('https://p3.douyinpic.com/obj/captcha-search.webp')}</main>`);
const conflictingSearch = html(`<main id="search-content-area"><article class="card"><a href="/note/700001?modal_id=999999">${image('https://p3.douyinpic.com/obj/conflict-search.webp')}<span>alpha conflicting card</span></a></article></main>`);

const scrollCards = Array.from({ length:205 }, (_, index) => {
  const id = String(710000 + index);
  return `<article class="card"><a href="/note/${id}?modal_id=${id}">${image(`https://p3.douyinpic.com/obj/scroll-${id}.webp`)}<span>alpha scroll ${index}</span><span>1/1</span></a></article>`;
}).join('');
const scrollingSearchPage = html(`<main id="search-content-area">${scrollCards}</main>`, `<style>body{margin:0}.card{display:inline-block;width:190px;height:250px;overflow:hidden;vertical-align:top}.card img{width:180px;height:200px;display:block}.card a{display:block;width:188px;height:245px}</style>`);

const server = createServer((request, response) => {
  const route = new URL(request.url, 'http://127.0.0.1').pathname;
  let body = searchPage;
  if (route === '/empty' || route === '/rc-verifycenter/empty') body = html('');
  else if (route.startsWith('/note/700001')) body = notePage;
  else if (route.startsWith('/note/700003')) body = incompletePage;
  else if (route.startsWith('/note/700004')) body = noImageNotePage;
  else if (route.startsWith('/note/700005')) body = structuredPage;
  else if (route.startsWith('/note/700006')) body = hiddenCaptchaNote;
  else if (route.startsWith('/note/700007')) body = visibleCaptchaNote;
  else if (route.startsWith('/note/700009')) body = misleadingMetricPage;
  else if (route.startsWith('/note/700010')) body = delayedCarouselCountPage;
  else if (/^\/note\/71\d+$/.test(route)) body = noteMarkup({ title:'scroll alpha note', body:'alpha methods and safe checklist', count:1, images:[image(`https://p3.douyinpic.com/obj${route}.webp`)] });
  else if (route.startsWith('/video/')) body = html('<section class="detail"><video controls></video><div>alpha video page</div></section>');
  else if (route === '/login') body = html('<div>扫码登录 请先登录</div>');
  else if (route === '/captcha') body = html('<div>安全验证 请完成验证</div>');
  else if (route === '/modern') body = modernSearchPage;
  else if (route === '/visible-frame-search') body = visibleCaptchaSearch;
  else if (route === '/conflicting-search') body = conflictingSearch;
  else if (route === '/scroll') body = scrollingSearchPage;
  response.writeHead(200, { 'content-type':'text/html; charset=utf-8' }); response.end(body);
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const fixturePort = server.address().port;
const reserve = createServer(); await new Promise((done) => reserve.listen(0, '127.0.0.1', done)); const chromePort = reserve.address().port; await new Promise((done) => reserve.close(done));
const collector = new DouyinCollector({ chromePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profileDir, errorDir, port:chromePort, headless:true, detailBaseUrl:`http://127.0.0.1:${fixturePort}` });
collector.searchUrl = () => `http://127.0.0.1:${fixturePort}/search`;

try {
  const directStarted = Date.now();
  const direct = await collector.importLink(`http://127.0.0.1:${fixturePort}/note/700001?modal_id=700001`);
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.ok(Date.now() - directStarted < 5000, `完整详情不应固定等待15秒: ${Date.now() - directStarted}ms`);
  assert.equal(direct.item.imageCount, 6);
  assert.equal(direct.item.imageUrls.length, 6);
  assert.ok(direct.item.imageUrls.some((url) => url.includes('byteimg.com')));
  assert.equal(new Set(direct.item.imageUrls.map((value) => new URL(value).pathname)).size, 6);

  const result = await collector.collect({ keywords:['alpha'], rawLimit:10, detailLimit:5, finalLimit:5, delayMs:700 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.items.length, 1, JSON.stringify(result));
  const item = result.items[0];
  assert.equal(item.id, '700001'); assert.equal(item.contentType, 'image_text'); assert.equal(item.detailStatus, 'enriched');
  assert.equal(item.author, 'alpha_lab'); assert.equal(item.likes, 128000); assert.equal(item.saves, 3400); assert.equal(item.comments, 120); assert.equal(item.shares, 56);
  assert.deepEqual(item.tags, ['alpha','safe']); assert.equal(item.imageUrls.length, 6); assert.equal(item.publishedAt, '2026-07-19T16:00:00.000Z');
  assert.equal(result.filterStats.rejected.video, 1);

  collector.searchUrl = () => `http://127.0.0.1:${fixturePort}/modern`;
  const modernResult = await collector.collect({ keywords:['alpha'], rawLimit:10, detailLimit:5, finalLimit:5, delayMs:700 });
  assert.equal(modernResult.ok, true, JSON.stringify(modernResult));
  assert.equal(modernResult.items.length, 1, JSON.stringify(modernResult));
  assert.equal(modernResult.items[0].id, '700001', JSON.stringify(modernResult));
  assert.equal(modernResult.filterStats.rejected.video, 2, JSON.stringify(modernResult));

  const structured = await collector.importLink(`http://127.0.0.1:${fixturePort}/note/700005`);
  assert.equal(structured.ok, true, JSON.stringify(structured));
  assert.equal(structured.item.title, 'structured alpha title');
  assert.equal(structured.item.author, 'state_author');
  assert.equal(structured.item.body, 'structured alpha first line\nsafe second line #alpha');
  assert.equal(structured.item.imageUrls.length, 3);
  assert.ok(structured.item.imageUrls.some((url) => url.includes('/obj/state-1.webp')), JSON.stringify(structured.item.imageUrls));
  assert.equal(structured.item.likes, 9001);

  const incomplete = await collector.importLink(`http://127.0.0.1:${fixturePort}/note/700003`);
  assert.equal(incomplete.ok, false, JSON.stringify(incomplete));
  assert.equal(incomplete.code, 'INCOMPLETE_MEDIA', JSON.stringify(incomplete));
  assert.equal(incomplete.detail.imageCount, 3);
  assert.equal(incomplete.detail.imageUrls.length, 1);
  const noImage = await collector.importLink(`http://127.0.0.1:${fixturePort}/note/700004`);
  assert.equal(noImage.ok, false, JSON.stringify(noImage));
  assert.equal(noImage.code, 'NOT_IMAGE_NOTE', JSON.stringify(noImage));
  const video = await collector.importLink(`http://127.0.0.1:${fixturePort}/video/700002`);
  assert.equal(video.ok, false, JSON.stringify(video));
  assert.equal(video.code, 'NOT_IMAGE_NOTE', JSON.stringify(video));
  const conflicting = await collector.importLink(`http://127.0.0.1:${fixturePort}/note/700001?modal_id=999999`);
  assert.equal(conflicting.code, 'ID_MISMATCH', JSON.stringify(conflicting));
  const delayedCount = await collector.importLink(`http://127.0.0.1:${fixturePort}/note/700010`);
  assert.equal(delayedCount.code, 'INCOMPLETE_MEDIA', JSON.stringify(delayedCount));
  assert.equal(delayedCount.detail.imageCount, 3, JSON.stringify(delayedCount));

  const { client } = await collector.session.openClient(`http://127.0.0.1:${fixturePort}/login`, '127.0.0.1');
  try {
    await collector.session.navigate(client, `http://127.0.0.1:${fixturePort}/login`, 100);
    assert.equal((await client.evaluate(detailScript('700001'))).requiresLogin, true);
    await collector.session.navigate(client, `http://127.0.0.1:${fixturePort}/captcha`, 100);
    assert.equal((await client.evaluate(detailScript('700001'))).captcha, true);
    await collector.session.navigate(client, `http://127.0.0.1:${fixturePort}/modern`, 100);
    const modern = await client.evaluate(searchScript(8));
    assert.equal(modern.captcha, false, JSON.stringify(modern));
    assert.equal(modern.structureChanged, false, JSON.stringify(modern));
    assert.equal(modern.visibleResultCards, 2, JSON.stringify(modern));
    assert.equal(modern.clickTargets.length, 2, JSON.stringify(modern));
    await collector.session.navigate(client, `http://127.0.0.1:${fixturePort}/visible-frame-search`, 100);
    assert.equal((await client.evaluate(searchScript(8))).captcha, true);
    await collector.session.navigate(client, `http://127.0.0.1:${fixturePort}/conflicting-search`, 100);
    const conflictingCard = await client.evaluate(searchScript(8));
    assert.equal(conflictingCard.idConflicts, 1, JSON.stringify(conflictingCard));
    assert.equal(conflictingCard.clickTargets.length, 0, JSON.stringify(conflictingCard));
    assert.equal(conflictingCard.structureChanged, true, JSON.stringify(conflictingCard));
    await collector.session.navigate(client, `http://127.0.0.1:${fixturePort}/note/700006`, 100);
    assert.equal((await client.evaluate(detailScript('700006'))).captcha, false);
    await collector.session.navigate(client, `http://127.0.0.1:${fixturePort}/note/700007`, 100);
    assert.equal((await client.evaluate(detailScript('700007'))).captcha, true);
    await collector.session.navigate(client, `http://127.0.0.1:${fixturePort}/note/700009`, 100);
    const metricNegative = await client.evaluate(detailScript('700009'));
    assert.equal(metricNegative.likes, '', JSON.stringify(metricNegative));
    assert.equal(metricNegative.saves, '', JSON.stringify(metricNegative));
    await collector.session.navigate(client, `http://127.0.0.1:${fixturePort}/note/700001`, 100);
    const mismatched = await client.evaluate(detailScript('999999'));
    assert.equal(mismatched.meaningful, false, JSON.stringify(mismatched));
    assert.equal(mismatched.diagnostic.idMatches, false, JSON.stringify(mismatched));
  } finally { client.close(); }

  collector.searchUrl = () => `http://127.0.0.1:${fixturePort}/scroll`;
  const scrolling = await collector.collect({ keywords:['alpha safe'], rawLimit:200, detailLimit:1, finalLimit:1, delayMs:100 });
  assert.equal(scrolling.ok, true, JSON.stringify(scrolling));
  assert.equal(scrolling.filterStats.raw, 200, JSON.stringify(scrolling.filterStats));
  assert.equal(scrolling.items.length, 1, JSON.stringify(scrolling));
  assert.equal(scrolling.items[0].localRelevanceScore, 100);

  let stop = false; const stopTimer = setTimeout(() => { stop = true; }, 180); const stoppedAt = Date.now();
  const stopped = await collector.collect({ keywords:['alpha'], rawLimit:200, detailLimit:1, finalLimit:1, delayMs:3000, shouldStop:() => stop });
  clearTimeout(stopTimer);
  assert.equal(stopped.code, 'MASTER_STOPPED', JSON.stringify(stopped));
  assert.ok(Date.now() - stoppedAt < 1500, `停止响应过慢: ${Date.now() - stoppedAt}ms`);

  assert.match(searchScript(8), /isVideo/); assert.match(detailScript('700001'), /mediaComplete/);
  console.log(JSON.stringify({ status:'PASS', completeImages:direct.item.imageUrls.length, structuredImages:structured.item.imageUrls.length, incompleteRejected:incomplete.code, modernVideosFiltered:modernResult.filterStats.rejected.video, scrolledRaw:scrolling.filterStats.raw, cancellationMs:Date.now()-stoppedAt, item }, null, 2));
} finally {
  collector.closeBrowser();
  await new Promise((done) => setTimeout(done, 800));
  await new Promise((done) => server.close(done));
  await rm(profileDir, { recursive:true, force:true, maxRetries:5, retryDelay:300 });
  await rm(errorDir, { recursive:true, force:true, maxRetries:5, retryDelay:300 });
}
