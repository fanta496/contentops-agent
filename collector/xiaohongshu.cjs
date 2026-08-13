const fs = require('node:fs');
const path = require('node:path');
const { ChromeSession, wait } = require('./chrome-session.cjs');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function normalizeCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!text) return 0;
  const match = text.match(/([\d.]+)\s*([亿万wW千kK]?)/);
  if (!match) return 0;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return 0;
  const unit = match[2].toLowerCase();
  if (unit === '亿') return Math.round(number * 100000000);
  if (unit === '万' || unit === 'w') return Math.round(number * 10000);
  if (unit === '千' || unit === 'k') return Math.round(number * 1000);
  return Math.round(number);
}

function normalizeOptionalCount(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
  const text = String(value).trim();
  if (!text || !/[\d.]/.test(text)) return null;
  return normalizeCount(text);
}

function normalizeForMatch(value) {
  return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function relevanceScore(item, keyword, includeDetail = false) {
  const needle = normalizeForMatch(keyword);
  if (!needle) return 0;
  const fields = [item?.title, ...(item?.rawText || [])];
  if (includeDetail) fields.push(item?.body, ...(item?.tags || []));
  const haystack = normalizeForMatch(fields.join(' '));
  if (haystack.includes(needle)) return 42;
  const chars = [...new Set([...needle])];
  const charHits = chars.filter((char) => haystack.includes(char)).length;
  const charRatio = chars.length ? charHits / chars.length : 0;
  const bigrams = []; for (let index = 0; index < needle.length - 1; index += 1) bigrams.push(needle.slice(index, index + 2));
  const bigramHits = bigrams.filter((part) => haystack.includes(part)).length;
  const bigramRatio = bigrams.length ? bigramHits / bigrams.length : 0;
  if (bigramRatio >= 0.66) return 32;
  if (charRatio >= 0.75) return 22;
  if (charRatio >= 0.5) return 10;
  return 0;
}

function interactionScore(item, includeDetail = false) {
  const likes = normalizeOptionalCount(item?.likes ?? item?.likeText) || 0;
  const saves = normalizeOptionalCount(item?.saves) || 0;
  const comments = normalizeOptionalCount(item?.comments) || 0;
  const weighted = likes + saves * 2.4 + comments * 3.2;
  const score = Math.log10(Math.max(1, weighted + 1)) * 9;
  return Math.min(includeDetail ? 38 : 34, Math.round(score));
}

function searchQualityScore(item, keyword, rank = 0, strict = false) {
  const relevance = relevanceScore(item, keyword, false);
  const rankTrust = Math.max(0, (strict ? 10 : 14) - Math.floor(rank / 3));
  const completeness = (item?.title ? 3 : 0) + (item?.coverUrl ? 2 : 0) + (item?.author ? 1 : 0);
  return relevance + interactionScore(item, false) + rankTrust + completeness;
}

function detailQuality(item, strict = false) {
  const relevance = relevanceScore(item, item?.keyword, true);
  const weightedInteractions = (normalizeOptionalCount(item?.likes) || 0) + (normalizeOptionalCount(item?.saves) || 0) * 2.4 + (normalizeOptionalCount(item?.comments) || 0) * 3.2;
  const completeness = (item?.detailStatus === 'enriched' ? 8 : 0) + (item?.body ? 5 : 0) + (item?.imageUrls?.length ? 4 : 0)
    + (item?.saves !== null && item?.saves !== undefined ? 2 : 0) + (item?.comments !== null && item?.comments !== undefined ? 2 : 0);
  const score = relevance + interactionScore(item, true) + completeness;
  const minimum = strict ? 58 : 44;
  let rejectReason = '';
  if (item?.contentType === 'video') rejectReason = 'video';
  else if (item?.detailStatus !== 'enriched') rejectReason = 'detail_unavailable';
  else if (!(item?.imageUrls?.length > 0)) rejectReason = 'no_images';
  else if (relevance < (strict ? 22 : 10)) rejectReason = 'low_relevance';
  else if (weightedInteractions < (strict ? 1000 : 120)) rejectReason = 'low_interaction';
  else if (score < minimum) rejectReason = 'low_quality';
  return { score, relevance, weightedInteractions, qualified: !rejectReason, rejectReason };
}

function dedupeRanked(items) {
  const seenIds = new Set(); const seenFingerprints = new Set(); const kept = []; let duplicates = 0;
  for (const item of items) {
    const fingerprint = `${normalizeForMatch(item.title).slice(0, 80)}|${normalizeForMatch(item.author).slice(0, 30)}`;
    if (seenIds.has(item.id) || (fingerprint.length > 5 && seenFingerprints.has(fingerprint))) { duplicates += 1; continue; }
    seenIds.add(item.id); if (fingerprint.length > 5) seenFingerprints.add(fingerprint); kept.push(item);
  }
  return { kept, duplicates };
}

function cardPoolScript(limit = 100) {
  const resultLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  return `(() => {
    const cards = [...document.querySelectorAll('section[class*="note-item"],article,[class*="feed-card"]')];
    const results = []; const seen = new Set();
    for (const card of cards) {
      const anchors = [...card.querySelectorAll('a[href]')];
      const idAnchor = anchors.find((a) => new RegExp('/(?:explore|search_result|discovery/item)/').test(a.getAttribute('href') || a.href || ''));
      if (!idAnchor) continue;
      let href = idAnchor.href || idAnchor.getAttribute('href') || '';
      const id = (href.match(new RegExp('/(?:explore|search_result|discovery/item)/([^/?#]+)')) || [])[1];
      if (!id || seen.has(id)) continue; seen.add(id);
      const accessAnchor = anchors.find((a) => { const value = a.href || a.getAttribute('href') || ''; return value.includes(id) && (value.includes('xsec_token=') || value.includes('/search_result/')); });
      let accessUrl = accessAnchor?.href || accessAnchor?.getAttribute('href') || href;
      try { href = new URL('/explore/' + id, location.origin).href; accessUrl = new URL(accessUrl, location.origin).href; } catch {}
      const text = (card.innerText || '').split('\\n').map((part) => part.trim()).filter(Boolean);
      const title = (card.querySelector('[class~="title"],[class*="title"],h3,h2')?.innerText || card.querySelector('img')?.alt || text[0] || '').trim();
      const author = (card.querySelector('[class*="author"] [class*="name"],[class*="author"],a[href*="/user/profile/"]')?.innerText || text.find((part) => part !== title && part.length <= 30) || '').trim();
      const likeText = (card.querySelector('[class*="like"] [class*="count"],[class*="like"],[class~="count"]')?.innerText || text.slice().reverse().find((part) => new RegExp('^[\\d.]+\\s*[亿万wW千kK]?$').test(part)) || '').trim();
      const image = card.querySelector('img'); const coverUrl = image?.currentSrc || image?.getAttribute('data-src') || image?.src || '';
      const isVideo = Boolean(card.querySelector('video,[class*="play-icon"],[class*="video-icon"],[class*="video-card"]'));
      if (title) results.push({ id, url: href, accessUrl, title, author, likeText, coverUrl, isVideo, rawText: text.slice(0, 12) });
      if (results.length >= ${resultLimit}) break;
    }
    return results;
  })()`;
}

function shanghaiParts(reference) {
  const date = new Date(reference);
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds()
  };
}

function shanghaiIso(year, month, day, hour = 0, minute = 0, second = 0) {
  const timestamp = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const check = shanghaiParts(date);
  if (!check || check.year !== year || check.month !== month || check.day !== day || check.hour !== hour || check.minute !== minute) return '';
  return date.toISOString();
}

function calendarDay(parts, offsetDays) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offsetDays));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function normalizePublishedAt(value, reference = Date.now()) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
    const raw = Number(value);
    if (Number.isFinite(raw) && raw > 0) {
      const date = new Date(raw < 100000000000 ? raw * 1000 : raw);
      return Number.isNaN(date.getTime()) ? '' : date.toISOString();
    }
  }
  const original = String(value).replace(/\s+/g, ' ').trim();
  if (!original) return '';
  const text = original.replace(/^(?:编辑于|发布于|更新于)\s*/, '').trim();
  const now = new Date(reference);
  const current = shanghaiParts(now);
  if (!current) return '';

  const relative = text.match(/(\d+)\s*(秒|分钟|小时|天)前/);
  if (relative) {
    const amount = Number(relative[1]);
    const units = { 秒: 1000, 分钟: 60000, 小时: 3600000, 天: 86400000 };
    return new Date(now.getTime() - amount * units[relative[2]]).toISOString();
  }
  if (/刚刚|片刻前/.test(text)) return now.toISOString();

  const relativeDay = text.match(/^(今天|昨天|前天)(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (relativeDay) {
    const offset = relativeDay[1] === '昨天' ? -1 : relativeDay[1] === '前天' ? -2 : 0;
    const day = calendarDay(current, offset);
    return shanghaiIso(day.year, day.month, day.day, Number(relativeDay[2] || 0), Number(relativeDay[3] || 0), Number(relativeDay[4] || 0));
  }

  const full = text.match(/(20\d{2})[年\-/.](\d{1,2})[月\-/.](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (full) return shanghaiIso(Number(full[1]), Number(full[2]), Number(full[3]), Number(full[4] || 0), Number(full[5] || 0), Number(full[6] || 0));

  const partial = text.match(/(?:^|\s)(\d{1,2})[月\-/.](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (partial) {
    let year = current.year;
    const month = Number(partial[1]); const day = Number(partial[2]);
    let iso = shanghaiIso(year, month, day, Number(partial[3] || 0), Number(partial[4] || 0), Number(partial[5] || 0));
    if (iso && new Date(iso).getTime() > now.getTime() + 2 * 86400000) iso = shanghaiIso(year - 1, month, day, Number(partial[3] || 0), Number(partial[4] || 0), Number(partial[5] || 0));
    return iso;
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString();
}

function extractionScript(limit) {
  const resultLimit = Math.max(1, Math.min(500, Number(limit) || 12));
  return `(() => {
    const bodyText = (document.body?.innerText || '').slice(0, 20000);
    const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects?.().length));
    const anchors = [...document.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/item/"]')];
    const results = [];
    const seen = new Set();
    for (const anchor of anchors) {
      let href = anchor.href || anchor.getAttribute('href') || '';
      if (!href) continue;
      try { href = new URL(href, location.origin).href; } catch { continue; }
      const idMatch = href.match(new RegExp('/(?:explore|discovery/item)/([^/?#]+)'));
      const id = idMatch?.[1] || href;
      if (seen.has(id)) continue;
      seen.add(id);
      const card = anchor.closest('[class*="note-item"],section,article,li,[class*="feed-card"],[class*="card"]') || anchor.parentElement;
      if (!card) continue;
      const text = (card.innerText || '').split('\\n').map((part) => part.trim()).filter(Boolean);
      const titleNode = card.querySelector('[class~="title"],[class*="title"],h3,h2');
      const authorNode = card.querySelector('[class*="author"] [class*="name"],[class*="author"],a[href*="/user/profile/"]');
      const likeNode = card.querySelector('[class*="like"] [class*="count"],[class*="like"],[class~="count"]');
      const image = card.querySelector('img');
      const title = (titleNode?.innerText || anchor.getAttribute('title') || image?.alt || text[0] || '').trim();
      if (!title || title.length > 180) continue;
      const author = (authorNode?.innerText || text.find((part) => part !== title && part.length <= 30) || '').trim();
      const likeText = (likeNode?.innerText || likeNode?.getAttribute('aria-label') || text.slice().reverse().find((part) => new RegExp('^[\\d.]+\\s*[亿万wW千kK]?$').test(part)) || '').trim();
      const cardAnchors = [...card.querySelectorAll('a[href]')];
      const accessAnchor = cardAnchors.find((candidate) => {
        const candidateHref = candidate.href || candidate.getAttribute('href') || '';
        return candidateHref.includes(id) && (candidateHref.includes('xsec_token=') || candidateHref.includes('/search_result/'));
      });
      let accessUrl = accessAnchor?.href || accessAnchor?.getAttribute('href') || href;
      try { accessUrl = new URL(accessUrl, location.origin).href; } catch { accessUrl = href; }
      const isVideo = Boolean(card.querySelector('video,[class*="play-icon"],[class*="video-icon"],[class*="video-card"]'));
      const coverUrl = image?.currentSrc || image?.getAttribute('data-src') || image?.src || '';
      results.push({ id, url: href, accessUrl, title, author, likeText, coverUrl, isVideo, rawText: text.slice(0, 12) });
      if (results.length >= ${resultLimit}) break;
    }
    const loginSignals = ['扫码登录','手机号登录','登录后查看','请先登录','登录后浏览更多'];
    const captchaSignals = ['安全验证','请完成验证','拖动滑块','验证码','异常访问'];
    const loginVisible = [...document.querySelectorAll('[class*="login"],[class*="Login"],[role="dialog"]')].some(visible);
    const captchaVisible = [...document.querySelectorAll('[class*="captcha"],[class*="geetest"],[class*="verify-dialog"],[class*="verification"],[id*="captcha"],iframe[src*="captcha"],iframe[src*="verify"]')].some(visible);
    return {
      url: location.href,
      title: document.title,
      results,
      requiresLogin: results.length === 0 && (loginVisible || loginSignals.some((text) => bodyText.includes(text))),
      captcha: captchaVisible || (results.length === 0 && captchaSignals.some((text) => bodyText.includes(text))),
      bodyExcerpt: bodyText.slice(0, 1000)
    };
  })()`;
}

function detailExtractionScript(noteId) {
  const expectedId = JSON.stringify(String(noteId || ''));
  return `(() => {
    const expectedId = ${expectedId};
    const bodyText = (document.body?.innerText || '').slice(0, 30000);
    const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects?.().length));
    const text = (node) => (node?.innerText || node?.textContent || '').replace(/\\s+/g, ' ').trim();
    const first = (root, selectors) => {
      for (const selector of selectors) {
        try { const node = root?.querySelector?.(selector); if (node && text(node)) return text(node); } catch {}
      }
      return '';
    };
    const valueByKeys = (object, keys) => {
      if (!object || typeof object !== 'object') return undefined;
      for (const key of keys) {
        try { if (object[key] !== undefined && object[key] !== null && object[key] !== '') return object[key]; } catch {}
      }
      let objectKeys = [];
      try { objectKeys = Object.keys(object); } catch { return undefined; }
      for (const wanted of keys) {
        const actual = objectKeys.find((key) => key.toLowerCase() === wanted.toLowerCase());
        try { if (actual && object[actual] !== undefined && object[actual] !== null && object[actual] !== '') return object[actual]; } catch {}
      }
      return undefined;
    };
    const asObject = (value) => value && typeof value === 'object' ? value : null;
    const roots = [];
    for (const key of ['__INITIAL_STATE__','__NEXT_DATA__','__APOLLO_STATE__']) {
      try { if (window[key] && typeof window[key] === 'object') roots.push(window[key]); } catch {}
    }
    for (const script of document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]')) {
      try { const parsed = JSON.parse(script.textContent || ''); if (parsed && typeof parsed === 'object') roots.push(parsed); } catch {}
    }
    const queue = roots.map((value) => ({ value, depth: 0, keyHint: '' }));
    const seen = new WeakSet();
    let inspected = 0;
    let best = null;
    let bestScore = -1;
    while (queue.length && inspected < 15000) {
      const current = queue.shift(); const object = current.value;
      if (!object || typeof object !== 'object' || seen.has(object)) continue;
      seen.add(object); inspected += 1;
      const id = String(valueByKeys(object, ['noteId','note_id','id','itemId','item_id']) || '');
      const keys = (() => { try { return Object.keys(object).map((key) => key.toLowerCase()); } catch { return []; } })();
      let score = 0;
      if (expectedId && (id === expectedId || current.keyHint === expectedId)) score += 20;
      if (keys.some((key) => ['desc','description','content','notetitle','title'].includes(key))) score += 3;
      if (keys.some((key) => key.includes('interact') || key.includes('stat'))) score += 3;
      if (keys.some((key) => key.includes('imagelist') || key === 'images')) score += 3;
      if (score > bestScore) { bestScore = score; best = object; }
      if (current.depth >= 10) continue;
      let entries = [];
      try { entries = Array.isArray(object) ? object.slice(0, 200).map((value, index) => [String(index), value]) : Object.entries(object).slice(0, 300); } catch {}
      for (const [key, value] of entries) if (value && typeof value === 'object' && !(value instanceof Node)) queue.push({ value, depth: current.depth + 1, keyHint: key });
    }

    const candidateObjects = [];
    const addCandidate = (value) => { if (value && typeof value === 'object' && !candidateObjects.includes(value)) candidateObjects.push(value); };
    addCandidate(best);
    const nestedCandidate = asObject(valueByKeys(best, ['note','noteData','item','data']));
    addCandidate(nestedCandidate);
    addCandidate(asObject(valueByKeys(nestedCandidate, ['note','noteData','item','data'])));
    const pick = (keys) => {
      for (const object of candidateObjects) {
        const value = valueByKeys(object, keys);
        if (value !== undefined && value !== null && value !== '') return value;
      }
      return undefined;
    };
    const interaction = asObject(pick(['interactInfo','interactionInfo','interaction','statistics','stats','noteCount'])) || {};
    const user = asObject(pick(['user','author','userInfo','creator'])) || {};

    let jsonLd = null;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || '');
        const entries = Array.isArray(parsed) ? parsed : parsed?.['@graph'] || [parsed];
        const match = entries.find((entry) => entry && (entry.articleBody || entry.headline || /Article|Posting/i.test(String(entry['@type'] || ''))));
        if (match) { jsonLd = match; break; }
      } catch {}
    }

    const detailRoot = document.querySelector('[data-note-detail],.note-detail-mask [class*="note-container"],[class*="note-detail"],article.note-detail,article[itemtype*="Article"],main [class*="note-content"]');
    const domTitle = first(detailRoot || document, ['[class~="title"]','[class*="note-title"]','h1']);
    const domBody = first(detailRoot || document, ['[class~="desc"]','[class*="note-desc"]','#detail-desc','[data-testid="note-content"]','[itemprop="articleBody"]']);
    const domAuthor = first(detailRoot || document, ['[class*="author"] [class*="name"]','[class*="author"] [class*="username"]','a[href*="/user/profile/"]']);
    const domPublished = first(detailRoot || document, ['time','[class*="publish-time"]','[class*="date"]','[class*="time"]']);

    const metricSelectors = {
      like: ['[class*="like-wrapper"] [class*="count"]','[class*="like"] [class*="count"]','[data-testid*="like"]','[aria-label*="点赞"]'],
      save: ['[class*="collect-wrapper"] [class*="count"]','[class*="collect"] [class*="count"]','[class*="fav"] [class*="count"]','[data-testid*="collect"]','[aria-label*="收藏"]'],
      comment: ['[class*="comment-wrapper"] [class*="count"]','[class*="chat-wrapper"] [class*="count"]','[class*="comment"] [class*="count"]','[data-testid*="comment"]','[aria-label*="评论"]']
    };
    const metricWords = { like: ['点赞','like'], save: ['收藏','collect','favorite','fav'], comment: ['评论','comment','chat'] };
    const readMetric = (kind) => {
      for (const selector of metricSelectors[kind]) {
        let node = null; try { node = (detailRoot || document).querySelector(selector); } catch {}
        if (node) { const result = text(node) || node.getAttribute?.('aria-label') || ''; if (/[\\d.]/.test(result)) return result; }
      }
      for (const node of (detailRoot || document).querySelectorAll('button,[role="button"]')) {
        const label = ((node.className || '') + ' ' + (node.getAttribute?.('aria-label') || '') + ' ' + text(node)).toLowerCase();
        if (metricWords[kind].some((word) => label.includes(word)) && /[\\d.]/.test(label)) return label;
      }
      return '';
    };

    const urlOf = (value) => {
      if (typeof value === 'string') return value;
      if (!value || typeof value !== 'object') return '';
      return String(valueByKeys(value, ['urlDefault','urlPre','url','src','originalUrl','masterUrl']) || '');
    };
    const imageUrls = [];
    const addImage = (value) => {
      const url = urlOf(value).trim();
      if (!url || !/^(?:https?:|data:image\\/)/i.test(url) || /\\.svg(?:\\?|$)/i.test(url) || imageUrls.includes(url)) return;
      imageUrls.push(url);
    };
    const stateImages = pick(['imageList','images','image_list','pictures','picList']);
    if (Array.isArray(stateImages)) stateImages.slice(0, 30).forEach(addImage);
    const ldImages = jsonLd?.image;
    (Array.isArray(ldImages) ? ldImages : [ldImages]).filter(Boolean).forEach(addImage);
    if (detailRoot) for (const image of detailRoot.querySelectorAll('[class*="swiper"] img,[class*="slider"] img,[class*="carousel"] img,[class*="note"] img,img[itemprop="image"]')) addImage(image.currentSrc || image.getAttribute('data-src') || image.src || '');

    const stateTitle = pick(['title','noteTitle','headline']);
    const stateBody = pick(['desc','description','content','noteContent','articleBody']);
    const stateAuthor = valueByKeys(user, ['nickname','nickName','name','username']) || (typeof pick(['authorName']) === 'string' ? pick(['authorName']) : '');
    const publishedValue = pick(['time','publishTime','publishedAt','createTime','create_time','datePublished','lastUpdateTime']);
    const title = String(stateTitle || jsonLd?.headline || domTitle || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
    const content = String(stateBody || jsonLd?.articleBody || domBody || '').replace(/\\r/g, '').trim().slice(0, 10000);
    const author = String(stateAuthor || jsonLd?.author?.name || domAuthor || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    const publishedAtRaw = publishedValue ?? jsonLd?.datePublished ?? domPublished ?? '';

    const tags = [];
    const addTag = (value) => {
      const raw = typeof value === 'string' ? value : valueByKeys(value, ['name','title','tagName','topicName']);
      const tag = String(raw || '').replace(/^#+/, '').replace(/\\s+/g, ' ').trim();
      if (tag && tag.length <= 80 && !tags.includes(tag)) tags.push(tag);
    };
    const stateTags = pick(['tagList','tags','topicList','topics','hashTags']);
    if (Array.isArray(stateTags)) stateTags.slice(0, 50).forEach(addTag);
    for (const node of (detailRoot || document).querySelectorAll('a[href*="search_result"],[class*="tag"],[class*="topic"]')) {
      const label = text(node); if (label.startsWith('#')) addTag(label);
    }
    const hashPattern = /#([^#\\s，。！？、；;:：]+)/g;
    let match = null; while ((match = hashPattern.exec(content)) && tags.length < 50) addTag(match[1]);

    const likeText = valueByKeys(interaction, ['likedCount','likeCount','likes','liked_count']) ?? pick(['likedCount','likeCount']) ?? readMetric('like');
    const saveText = valueByKeys(interaction, ['collectedCount','collectCount','collectionCount','favoriteCount','savedCount']) ?? pick(['collectedCount','collectCount']) ?? readMetric('save');
    const commentText = valueByKeys(interaction, ['commentCount','comments','comment_count']) ?? pick(['commentCount']) ?? readMetric('comment');
    const rawType = String(pick(['type','noteType','contentType']) || '').toLowerCase();
    const isVideo = rawType.includes('video') || Boolean(detailRoot?.querySelector('video,[class*="video-player"],[class*="video-container"]'));
    const stateMatched = Boolean(best && String(valueByKeys(best, ['noteId','note_id','id','itemId','item_id']) || '') === expectedId);
    const currentId = (location.href.match(new RegExp('/(?:explore|search_result|discovery/item)/([^/?#]+)')) || [])[1] || '';
    const urlMatched = Boolean(expectedId && currentId === expectedId);
    const identityMatched = stateMatched || urlMatched;
    const hasDetail = Boolean((detailRoot && (title || content || imageUrls.length)) || stateMatched || jsonLd);
    const meaningful = identityMatched && hasDetail;
    const loginSignals = ['扫码登录','手机号登录','登录后查看','请先登录','登录后浏览更多'];
    const captchaSignals = ['安全验证','请完成验证','拖动滑块','验证码','异常访问'];
    const loginVisible = [...document.querySelectorAll('[class*="login"],[class*="Login"],[role="dialog"]')].some(visible);
    const captchaVisible = [...document.querySelectorAll('[class*="captcha"],[class*="geetest"],[class*="verify-dialog"],[class*="verification"],[id*="captcha"],iframe[src*="captcha"],iframe[src*="verify"]')].some(visible);
    return {
      url: location.href, title, body: content, author, publishedAtRaw, tags: tags.slice(0, 30), imageUrls: imageUrls.slice(0, 20),
      likeText, saveText, commentText, contentType: isVideo ? 'video' : 'image_text', meaningful, identityMatched, stateMatched, urlMatched,
      requiresLogin: !meaningful && (loginVisible || loginSignals.some((signal) => bodyText.includes(signal))),
      captcha: captchaVisible || (!meaningful && captchaSignals.some((signal) => bodyText.includes(signal))),
      bodyExcerpt: bodyText.slice(0, 1000)
    };
  })()`;
}

function mergeDetail(base, detail, collectedAt = new Date().toISOString()) {
  const baseLikes = normalizeOptionalCount(base?.likes ?? base?.likeText) ?? 0;
  if (!detail || !detail.meaningful) {
    return {
      ...base, likes: baseLikes, saves: null, comments: null, body: '', tags: [], publishedAt: '', publishedAtRaw: '',
      imageUrls: base?.coverUrl ? [base.coverUrl] : [], contentType: base?.isVideo ? 'video' : 'unknown', detailStatus: 'unavailable', collectedAt
    };
  }
  const imageUrls = Array.isArray(detail.imageUrls) ? detail.imageUrls.filter(Boolean).slice(0, 20) : [];
  const likes = normalizeOptionalCount(detail.likeText);
  return {
    ...base,
    title: String(detail.title || base?.title || '').trim(),
    author: String(detail.author || base?.author || '').trim(),
    coverUrl: imageUrls[0] || base?.coverUrl || '',
    body: String(detail.body || '').trim(),
    tags: Array.isArray(detail.tags) ? detail.tags.map((item) => String(item).trim()).filter(Boolean).slice(0, 30) : [],
    publishedAtRaw: detail.publishedAtRaw ?? '',
    publishedAt: normalizePublishedAt(detail.publishedAtRaw),
    imageUrls,
    likes: likes ?? baseLikes,
    saves: normalizeOptionalCount(detail.saveText),
    comments: normalizeOptionalCount(detail.commentText),
    contentType: detail.contentType || 'image_text',
    detailStatus: 'enriched',
    collectedAt
  };
}

function collectorFailure(error, screenshot = '') {
  const code = error?.code || 'COLLECTOR_ERROR';
  const message = code === 'BROWSER_SESSION_RECOVERY_FAILED'
    ? '小红书专用浏览器已自动尝试新标签页和重启恢复，但页面仍无响应；请关闭占用该专用浏览器的窗口后再重试'
    : error?.message || '小红书采集器发生未知错误';
  return { ok:false, code, message, technicalMessage:error?.message || '', recoveryAttempts:error?.attempts || [], screenshot };
}

function isRecoverableBrowserError(error) {
  if (['BROWSER_CDP_CONNECT_TIMEOUT', 'BROWSER_CDP_COMMAND_TIMEOUT', 'BROWSER_TARGET_UNRESPONSIVE', 'BROWSER_SESSION_RECOVERY_FAILED'].includes(error?.code)) return true;
  return /执行超时|连接已关闭|页面无响应|WebSocket|socket|target closed/i.test(String(error?.message || ''));
}

function browserRecoveryFailure(error, recoveryCount) {
  const failure = new Error(`小红书采集过程中浏览器连续恢复失败：${error?.message || '页面无响应'}`);
  failure.code = 'BROWSER_SESSION_RECOVERY_FAILED';
  failure.cause = error;
  failure.attempts = [
    ...(Array.isArray(error?.attempts) ? error.attempts : []),
    { stage:'mid_collection', recoveryCount, code:error?.code || '', message:error?.message || '' }
  ];
  return failure;
}

function browserPageSnapshotScript() {
  return `(() => ({
    href: String(location.href || ''),
    readyState: String(document.readyState || ''),
    title: String(document.title || ''),
    bodyTextLength: String(document.body?.innerText || '').trim().length,
    imageCount: Number(document.images?.length || 0)
  }))()`;
}

function xhsNoteId(url) {
  try { return (new URL(url).pathname.match(/\/(?:explore|search_result|discovery\/item)\/([^/?#]+)/) || [])[1] || ''; }
  catch { return ''; }
}

function navigationReached(targetUrl, before, after) {
  if (!after || !['interactive', 'complete'].includes(after.readyState)) return false;
  if (Number(after.bodyTextLength || 0) <= 0 && Number(after.imageCount || 0) <= 0) return false;
  let target;
  let actual;
  try { target = new URL(targetUrl); actual = new URL(after.href); }
  catch { return false; }
  if (!['http:', 'https:'].includes(actual.protocol)) return false;

  const targetKeyword = target.searchParams.get('keyword');
  if (targetKeyword !== null) {
    return actual.origin === target.origin
      && actual.pathname === target.pathname
      && actual.searchParams.get('keyword') === targetKeyword;
  }

  const targetNoteId = xhsNoteId(target.href);
  if (targetNoteId) return xhsNoteId(actual.href) === targetNoteId;

  if (actual.origin === target.origin && actual.pathname === target.pathname) return true;

  // xhslink.com 是小红书官方分享短链，最终地址必须由 importLink 再做官方域名校验。
  // 此处只确认浏览器确实离开了原页面，避免把旧搜索页误判成短链已完成跳转。
  if (/^(?:www\.)?xhslink\.com$/i.test(target.hostname)) {
    return Boolean(after.href && after.href !== before?.href);
  }
  return false;
}

class XiaohongshuCollector {
  constructor({ chromePath, chromeDiagnostic, profileDir, errorDir, port = 17841, headless = false, searchBaseUrl, enrichDetails = true }) {
    this.session = new ChromeSession({ chromePath, chromeDiagnostic, profileDir, port, headless });
    this.errorDir = errorDir;
    this.searchBaseUrl = searchBaseUrl || 'https://www.xiaohongshu.com/search_result';
    this.enrichDetails = enrichDetails !== false;
  }

  searchUrl(keyword) {
    const url = new URL(this.searchBaseUrl);
    url.searchParams.set('keyword', keyword);
    if (url.hostname.includes('xiaohongshu.com')) url.searchParams.set('source', 'web_search_result_notes');
    return url.href;
  }

  homeUrl() {
    return this.searchBaseUrl.includes('xiaohongshu.com') ? 'https://www.xiaohongshu.com/' : this.searchBaseUrl;
  }

  hostHint() {
    try { return new URL(this.homeUrl()).hostname; } catch { return undefined; }
  }

  async pageSnapshot(client) {
    return client.evaluate(browserPageSnapshotScript(), 6000);
  }

  async navigateOnce(client, url, waitMs) {
    const before = await this.pageSnapshot(client).catch(() => null);
    try {
      await this.session.navigate(client, url, waitMs);
      return { softRecovered:false, before, after:null };
    } catch (error) {
      if (!isRecoverableBrowserError(error)) throw error;
      const after = await this.pageSnapshot(client).catch(() => null);
      if (!navigationReached(url, before, after)) throw error;
      return { softRecovered:true, before, after, error };
    }
  }

  async runBrowserOperation(client, {
    operation,
    fallbackUrl = this.homeUrl(),
    recoveryCount = 0,
    maxRecoveries = 2,
    onRecovered
  }) {
    let activeClient = client;
    let recoveries = recoveryCount;
    while (true) {
      try {
        return { client:activeClient, value:await operation(activeClient), recoveryCount:recoveries };
      } catch (error) {
        if (!isRecoverableBrowserError(error)) throw error;
        if (recoveries >= maxRecoveries) throw browserRecoveryFailure(error, recoveries);
        recoveries += 1;
        activeClient?.close();
        let reopened;
        try { reopened = await this.session.openClient(fallbackUrl, this.hostHint()); }
        catch (reopenError) { throw browserRecoveryFailure(reopenError, recoveries); }
        activeClient = reopened.client;
        onRecovered?.({
          recovery:recoveries,
          recoveryStage:reopened.recoveryStage || 'none',
          errorCode:error?.code || '',
          message:error?.message || ''
        });
      }
    }
  }

  async openLogin() {
    const home = this.homeUrl();
    let client = null;
    try {
      const opened = await this.session.openClient(home, this.hostHint());
      client = opened.client;
      const result = await this.runBrowserOperation(client, {
        fallbackUrl:home,
        operation:(activeClient) => this.navigateOnce(activeClient, home, 500)
      });
      client = result.client;
      return {
        ok:true,
        message:'已打开小红书专用浏览器，请人工完成登录或验证',
        recovered:result.recoveryCount > 0 || Boolean(result.value?.softRecovered)
      };
    } finally { client?.close(); }
  }

  async probe(keyword = '内容运营') {
    let client = null;
    try {
      const opened = await this.session.openClient(this.homeUrl(), this.hostHint());
      client = opened.client;
      const targetUrl = this.searchUrl(String(keyword || '内容运营').trim());
      const result = await this.runBrowserOperation(client, {
        fallbackUrl:this.homeUrl(),
        operation:async (activeClient) => {
          const navigation = await this.navigateOnce(activeClient, targetUrl, 900);
          const page = await activeClient.evaluate(extractionScript(3), 10000);
          return { navigation, page };
        }
      });
      client = result.client;
      const { page } = result.value;
      const access = await this.accessFailure(client, page);
      if (access) return access;
      const count = Array.isArray(page?.results) ? page.results.length : 0;
      return {
        ok:true,
        code:count ? 'READY' : 'PAGE_REACHABLE',
        message:count ? `登录状态可用，快速检查识别到 ${count} 条公开图文卡片` : '页面可访问，未发现登录或安全验证阻塞；正式采集时会继续校验',
        recovered:Boolean(opened.recovered) || result.recoveryCount > 0 || Boolean(result.value.navigation?.softRecovered),
        recoveryStage:result.recoveryCount > 0 ? 'runtime_recovery' : opened.recoveryStage || 'none'
      };
    } catch (error) {
      const screenshot = client ? await this.captureFailure(client, 'probe-error').catch(() => '') : '';
      return collectorFailure(error, screenshot);
    } finally { client?.close(); }
  }

  async importLink(sourceUrl) {
    new URL(sourceUrl);
    let client = null;
    try {
      const opened = await this.session.openClient(this.homeUrl(), this.hostHint());
      client = opened.client;
      const result = await this.runBrowserOperation(client, {
        fallbackUrl:this.homeUrl(),
        operation:async (activeClient) => {
          const navigation = await this.navigateOnce(activeClient, sourceUrl, 1400);
          const currentUrl = String(await activeClient.evaluate('location.href') || '');
          let current;
          try { current = new URL(currentUrl); }
          catch { return { navigation, failure:{ ok:false, code:'LINK_UNRECOGNIZED', message:'小红书链接跳转后地址无效，未导入' } }; }
          const finalOfficial = ['xiaohongshu.com', 'www.xiaohongshu.com'].some((host) => current.hostname === host || current.hostname.endsWith(`.${host}`));
          const fixtureHost = (() => { try { return new URL(this.searchBaseUrl).hostname; } catch { return ''; } })();
          if (!finalOfficial && current.hostname !== fixtureHost) return { navigation, failure:{ ok:false, code:'LINK_REDIRECT_REJECTED', message:'小红书短链跳转到了非官方页面，已拒绝导入' } };
          const sourceId = (current.pathname.match(/\/(?:explore|search_result|discovery\/item)\/([^/?#]+)/) || [])[1] || '';
          if (!sourceId) return { navigation, failure:{ ok:false, code:'LINK_UNRECOGNIZED', message:'未识别到小红书笔记编号；请粘贴公开笔记完整链接或有效分享短链' } };
          const detail = await activeClient.evaluate(detailExtractionScript(sourceId));
          return { navigation, currentUrl, sourceId, detail, access:await this.accessFailure(activeClient, detail) };
        }
      });
      client = result.client;
      if (result.value.failure) return result.value.failure;
      const { sourceId, detail, access } = result.value;
      // xhslink 官方短链本身不含笔记编号，必须先由专用浏览器完成跳转。
      // 只接受最终仍落在小红书官方站点的地址，避免短链把采集器带到第三方页面。
      if (access) return access;
      if (!detail.identityMatched || !detail.meaningful) return { ok:false, code:'DETAIL_UNAVAILABLE', message:'该小红书链接未读取到可分析的公开正文或图片；链接可能失效、被限制访问或页面结构已变化', detail };
      const item = mergeDetail({ id:sourceId, url:sourceUrl, accessUrl:sourceUrl, title:'', author:'', coverUrl:'', rawText:[] }, detail);
      if (item.contentType === 'video') return { ok:false, code:'NOT_IMAGE_NOTE', message:'该链接是视频内容，当前仅支持图文笔记' };
      if (!item.body && !item.imageUrls.length) return { ok:false, code:'DETAIL_UNAVAILABLE', message:'已打开笔记但没有读取到正文或图片，未加入候选池' };
      return { ok:true, item:{ ...item, id:sourceId, url:sourceUrl, sourceUrl, imageCount:item.imageUrls.length, parserVersion:'xiaohongshu-browser-link-v1', sourceMethod:'user_submitted_browser', detailStatus:'enriched', collectedAt:new Date().toISOString() } };
    } catch (error) { return collectorFailure(error, client ? await this.captureFailure(client, 'link-error').catch(() => '') : ''); }
    finally { client?.close(); }
  }

  async collect({ keywords, maxPerKeyword = 12, rawLimit = 50, detailLimit = 20, finalLimit = 10, strict = false, scrollRounds = 2, delayMs = 2500, enrichDetails = this.enrichDetails, onProgress, shouldStop }) {
    const normalizedKeywords = [...new Set((keywords || []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 30);
    if (!normalizedKeywords.length) return { ok: false, code: 'NO_KEYWORDS', message: '请先配置至少一个小红书关键词' };
    const home = this.homeUrl();
    let client = null;
    const all = [];
    const warnings = [];
    const seenIds = new Set();
    let browserRecoveries = 0;
    const filterStats = { raw: 0, prefiltered: 0, detailed: 0, qualified: 0, rejected: {}, duplicates: 0 };
    try {
      const opened = await this.session.openClient(home, this.hostHint());
      client = opened.client;
      for (let index = 0; index < normalizedKeywords.length; index += 1) {
        if (shouldStop?.()) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，小红书采集已取消' };
        const keyword = normalizedKeywords[index];
        onProgress?.({ keyword, index, total: normalizedKeywords.length, stage: 'navigate' });
        const perKeywordRaw = Math.max(1, Math.min(500, Math.ceil(Number(rawLimit || 50) / normalizedKeywords.length), Number(maxPerKeyword) || 500));
        const searchUrl = this.searchUrl(keyword);
        const searchStage = await this.runBrowserOperation(client, {
          fallbackUrl:home,
          recoveryCount:browserRecoveries,
          operation:async (activeClient) => {
            const navigation = await this.navigateOnce(activeClient, searchUrl, Math.max(1000, delayMs));
            const cardPool = new Map();
            const collectVisibleCards = async () => {
              const cards = await activeClient.evaluate(cardPoolScript(Math.max(perKeywordRaw || 50, 100)));
              for (const item of cards || []) if (!cardPool.has(item.id)) cardPool.set(item.id, item);
            };
            await collectVisibleCards();
            for (let round = 0; round < Math.max(0, Math.min(12, scrollRounds)); round += 1) {
              if (shouldStop?.()) return { stopped:true, navigation, cardPool, page:null };
              await activeClient.evaluate('window.scrollBy({top: Math.max(window.innerHeight * 0.9, 700), behavior: "instant"}); true');
              await wait(Math.max(800, Math.floor(delayMs / 2)));
              await collectVisibleCards();
              if (cardPool.size >= perKeywordRaw) break;
            }
            const page = await activeClient.evaluate(extractionScript(perKeywordRaw));
            return { stopped:false, navigation, cardPool, page };
          },
          onRecovered:(recovery) => warnings.push({ code:'BROWSER_SESSION_RECOVERED', keyword, stage:'search', ...recovery })
        });
        client = searchStage.client;
        browserRecoveries = searchStage.recoveryCount;
        if (searchStage.value.stopped) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，小红书采集已取消' };
        if (searchStage.value.navigation?.softRecovered) {
          warnings.push({ code:'NAVIGATION_TIMEOUT_PAGE_READY', keyword, stage:'search', message:searchStage.value.navigation.error?.message || '搜索页导航超时，但页面已完成渲染并继续采集' });
        }
        const { cardPool, page } = searchStage.value;
        const accessFailure = await this.accessFailure(client, page);
        if (accessFailure) return accessFailure;

        for (const item of page.results || []) if (!cardPool.has(item.id)) cardPool.set(item.id, item);
        const rawItems = [...cardPool.values()].filter((item) => {
          if (item.isVideo || seenIds.has(item.id)) return false;
          seenIds.add(item.id);
          return true;
        }).slice(0, perKeywordRaw);
        filterStats.raw += rawItems.length;
        const perKeywordDetail = Math.max(1, Math.ceil(Number(detailLimit || 20) / normalizedKeywords.length));
        const scoredItems = rawItems.map((item, rank) => ({ ...item, searchRank: rank, searchRelevance: relevanceScore(item, keyword, false), prefilterScore: searchQualityScore(item, keyword, rank, strict) }));
        const relevantItems = scoredItems.filter((item) => item.searchRelevance >= (strict ? 22 : 10));
        filterStats.rejected.low_relevance = (filterStats.rejected.low_relevance || 0) + (scoredItems.length - relevantItems.length);
        const searchItems = relevantItems
          .sort((left, right) => right.prefilterScore - left.prefilterScore).slice(0, perKeywordDetail);
        filterStats.prefiltered += searchItems.length;
        for (let detailIndex = 0; detailIndex < searchItems.length; detailIndex += 1) {
          if (shouldStop?.()) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，小红书采集已取消' };
          const item = searchItems[detailIndex];
          let enriched = mergeDetail({ ...item, keyword }, null);
          if (enrichDetails) {
            onProgress?.({ keyword, index, total: normalizedKeywords.length, stage: 'detail', detailIndex, detailTotal: searchItems.length, title: item.title });
            let detailResult = null;
            try {
              // 小红书搜索卡片的普通 /explore/:id 地址会被重定向到推荐页。
              // 卡片上的 xsec_token 访问地址才带有当前搜索上下文，可正常打开详情弹层。
              const detailStage = await this.runBrowserOperation(client, {
                fallbackUrl:home,
                recoveryCount:browserRecoveries,
                operation:async (activeClient) => {
                  const navigation = await this.navigateOnce(activeClient, item.accessUrl || item.url, Math.max(1200, Math.floor(delayMs / 2)));
                  const detail = await activeClient.evaluate(detailExtractionScript(item.id));
                  return { navigation, detail, accessFailure:await this.accessFailure(activeClient, detail) };
                },
                onRecovered:(recovery) => warnings.push({ code:'BROWSER_SESSION_RECOVERED', id:item.id, url:item.url, stage:'detail', ...recovery })
              });
              client = detailStage.client;
              browserRecoveries = detailStage.recoveryCount;
              detailResult = detailStage.value;
              if (detailResult.navigation?.softRecovered) {
                warnings.push({ code:'NAVIGATION_TIMEOUT_PAGE_READY', id:item.id, url:item.url, stage:'detail', message:detailResult.navigation.error?.message || '详情页导航超时，但页面已完成渲染并继续读取' });
              }
            } catch (error) {
              if (error?.code === 'BROWSER_SESSION_RECOVERY_FAILED') throw error;
              warnings.push({ code:'DETAIL_ERROR', id:item.id, url:item.url, message:error.message });
            }
            if (detailResult?.accessFailure) return detailResult.accessFailure;
            if (detailResult?.detail) {
              const detail = detailResult.detail;
              enriched = mergeDetail({ ...item, keyword }, detail);
              filterStats.detailed += 1;
              if (!detail.identityMatched) warnings.push({ code: 'DETAIL_ID_MISMATCH', id: item.id, url: item.url, actualUrl: detail.url });
              else if (!detail.meaningful) warnings.push({ code: 'DETAIL_UNAVAILABLE', id: item.id, url: item.url });
            }
          }
          if (enriched.contentType !== 'video') {
            const quality = detailQuality(enriched, strict);
            enriched.localQualityScore = quality.score;
            enriched.localRelevanceScore = quality.relevance;
            enriched.localFilterMode = strict ? 'automatic_strict' : 'manual_standard';
            if (quality.qualified) all.push(enriched);
            else filterStats.rejected[quality.rejectReason] = (filterStats.rejected[quality.rejectReason] || 0) + 1;
          }
        }
        onProgress?.({ keyword, index, total: normalizedKeywords.length, stage: 'done', count: searchItems.length });
        if (index < normalizedKeywords.length - 1) await wait(Math.max(1200, delayMs));
      }
      const ranked = all.sort((left, right) => right.localQualityScore - left.localQualityScore);
      const deduped = dedupeRanked(ranked); filterStats.duplicates = deduped.duplicates;
      const unique = deduped.kept.slice(0, Math.max(1, Math.min(50, Number(finalLimit) || 10)));
      filterStats.qualified = unique.length;
      if (!unique.length) {
        let screenshot = '';
        try { screenshot = await this.captureFailure(client, 'no-results'); } catch {}
        return { ok: true, items: [], keywordCount: normalizedKeywords.length, warnings, filterStats, message: '本轮没有达到质量门槛的公开图文' };
      }
      return { ok: true, items: unique, keywordCount: normalizedKeywords.length, warnings, filterStats };
    } catch (error) {
      let screenshot = '';
      if (client) try { screenshot = await this.captureFailure(client, 'error'); } catch {}
      return collectorFailure(error, screenshot);
    } finally {
      client?.close();
    }
  }

  async accessFailure(client, page) {
    if (page?.captcha) {
      const screenshot = await this.captureFailure(client, 'captcha');
      return { ok: false, code: 'CAPTCHA', message: '小红书要求安全验证，采集已暂停，请人工处理', screenshot, page };
    }
    if (page?.requiresLogin) {
      const screenshot = await this.captureFailure(client, 'login');
      return { ok: false, code: 'LOGIN_REQUIRED', message: '小红书登录状态不可用，请人工登录专用浏览器', screenshot, page };
    }
    return null;
  }

  async captureFailure(client, reason) {
    fs.mkdirSync(this.errorDir, { recursive: true });
    const output = path.join(this.errorDir, `xiaohongshu-${reason}-${Date.now()}.png`);
    return this.session.screenshot(client, output);
  }

  closeBrowser() { this.session.stop(); }
}

module.exports = {
  XiaohongshuCollector,
  normalizeCount,
  normalizeOptionalCount,
  normalizePublishedAt,
  relevanceScore,
  searchQualityScore,
  detailQuality,
  isRecoverableBrowserError,
  browserRecoveryFailure,
  browserPageSnapshotScript,
  navigationReached,
  dedupeRanked,
  cardPoolScript,
  extractionScript,
  detailExtractionScript,
  mergeDetail
};
