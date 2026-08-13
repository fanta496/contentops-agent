const fs = require('node:fs');
const path = require('node:path');
const { ChromeSession, wait } = require('./chrome-session.cjs');
const { normalizeOptionalCount, normalizePublishedAt } = require('./xiaohongshu.cjs');

function workIdentity(value) {
  const raw = String(value || '');
  const modalId = (raw.match(/[?&]modal_id=(\d+)/) || [])[1] || '';
  const pathId = (raw.match(/\/(?:note|video)\/(\d+)/) || [])[1] || '';
  return { id: modalId || pathId, modalId, pathId, conflict: Boolean(modalId && pathId && modalId !== pathId) };
}

async function waitInterruptibly(ms, shouldStop, stepMs = 100) {
  const deadline = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < deadline) {
    if (shouldStop?.()) return false;
    await wait(Math.min(Math.max(20, stepMs), Math.max(1, deadline - Date.now())));
  }
  return !shouldStop?.();
}

function extractTags(text) {
  const tags = []; const pattern = /#([^#\s，。！？、；;:：]+)/g; let match;
  while ((match = pattern.exec(String(text || ''))) && tags.length < 30) {
    const tag = String(match[1]).trim(); if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function searchScript(limit = 20) {
  return `(() => {
    const limit = ${Math.max(1, Math.min(100, Number(limit) || 20))};
    const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
    const visible = (node) => { try { if (typeof node.checkVisibility === 'function' && !node.checkVisibility({ checkOpacity:true, checkVisibilityCSS:true })) return false; const b=node.getBoundingClientRect(), s=getComputedStyle(node); return b.width>8 && b.height>8 && b.right>0 && b.bottom>0 && b.left<innerWidth && b.top<innerHeight && s.display!=='none' && s.visibility!=='hidden' && Number(s.opacity || 1)>0; } catch { return false; } };
    const mediaKey = (value) => { try { const url=new URL(String(value || ''), location.href); return url.pathname.toLowerCase(); } catch { return String(value || '').split('?')[0].toLowerCase(); } };
    const seen = new Set(), results = []; let idConflicts = 0;
    for (const link of [...document.querySelectorAll('a[href*="modal_id="],a[href*="/note/"],a[href*="/video/"]')]) {
      if (!visible(link)) continue;
      const href = link.href || '';
      const modalId=(href.match(/[?&]modal_id=(\\d+)/) || [])[1] || '', pathId=(href.match(/\\/(?:note|video)\\/(\\d+)/) || [])[1] || '';
      if (modalId && pathId && modalId !== pathId) { idConflicts += 1; continue; }
      const id = modalId || pathId;
      if (!id || seen.has(id)) continue;
      const card = link.closest('[data-e2e],article,[class*="card"],[class*="Card"],[class*="feed"],[class*="Feed"]') || link.parentElement;
      const rawCardText = String(card?.innerText || link.innerText || ''); const text = clean(rawCardText); if (!text) continue;
      const isVideo = /\\/video\\//.test(href) || /(?:视频|播放|时长\\s*[:：]?\\s*\\d{1,2}:\\d{2})/.test(text);
      const hasImageHint = /(?:图文|\\d+\\s*\\/\\s*\\d+|多图)/.test(text) || Boolean(card?.querySelector('img'));
      const image = card?.querySelector('img');
      const titleLines=rawCardText.split(/\\n+/).map(clean).filter(Boolean);
      seen.add(id); results.push({ id, url: href, title: clean((card?.querySelector('h1,h2,h3,[class*="title"],[class*="Title"]')?.innerText) || titleLines[0] || text.slice(0,120)), rawText:text, coverUrl:image?.currentSrc || image?.getAttribute('data-src') || image?.src || '', isVideo, hasImageHint });
      if (results.length >= limit) break;
    }
    const full = clean(document.body?.innerText || '');
    const explicitResultArea = document.querySelector('#search-content-area');
    const resultArea = explicitResultArea || document.body;
    const largeImages = [...resultArea.querySelectorAll('img')].filter((image) => {
      if (!visible(image)) return false;
      const box = image.getBoundingClientRect();
      return box.width >= 160 && box.height >= 160;
    });
    const visibleResultCards = largeImages.length;
    const clickTargets = []; const seenTargets = new Set();
    for (const image of largeImages) {
      const coverUrl = image.currentSrc || image.getAttribute('data-src') || image.src || '';
      const directLink=image.closest('a[href*="modal_id="],a[href*="/note/"],a[href*="/video/"]');
      if (directLink) {
        const href=directLink.href || '', modalId=(href.match(/[?&]modal_id=(\\d+)/) || [])[1] || '', pathId=(href.match(/\\/(?:note|video)\\/(\\d+)/) || [])[1] || '';
        if (modalId || pathId) continue;
      }
      let node = image.parentElement; let card = node;
      for (let depth = 0; node && node !== resultArea && depth < 7; depth += 1, node = node.parentElement) {
        const text = clean(node.innerText); const imageTotal = node.querySelectorAll('img').length;
        if (text.length >= 8 && text.length <= 700 && imageTotal <= 4) card = node;
      }
      const text = clean(card?.innerText); if (!text) continue;
      const box = image.getBoundingClientRect();
      const isVideo = /(?:^|\\s)\\d{1,2}:\\d{2}(?:\\s|$)/.test(text) || /(?:视频|播放|时长)/.test(text);
      const rawLines=String(card?.innerText || '').split(/\\n+/).map(clean).filter(Boolean);
      const title = rawLines.find((line) => line && !/^@/.test(line) && !/^\\d+(?:\\.\\d+)?[万wW]?$/.test(line) && !/^\\d{1,2}:\\d{2}$/.test(line)) || text.slice(0, 120);
      const signature=mediaKey(coverUrl) + '|' + title;
      if (seenTargets.has(signature)) continue;
      clickTargets.push({ x:Math.round(box.left + box.width / 2), y:Math.round(box.top + box.height / 2), coverUrl, coverKey:mediaKey(coverUrl), title, rawText:text, isVideo, hasImageHint:!isVideo || /图文|多图|\\d+\\s*\\/\\s*\\d+/.test(text) });
      seenTargets.add(signature);
      if (clickTargets.length >= limit) break;
    }
    // A populated result grid with zero parseable links means Douyin changed
    // the card contract.  Returning an honest adapter error is safer than a
    // false successful run containing zero candidates.
    const structureChanged = Boolean((explicitResultArea && results.length === 0 && visibleResultCards >= 2 && clickTargets.length === 0) || (idConflicts > 0 && results.length === 0 && clickTargets.length === 0));
    // Douyin preloads a verifycenter iframe on ordinary search pages.  Its
    // existence alone is not a challenge; stop only when the frame is visible.
    const captchaFrameVisible = [...document.querySelectorAll('iframe')].some((frame) => /(?:verifycenter|nocaptcha|captcha|rc-verify)/i.test(frame.src || '') && visible(frame));
    const scrolling=document.scrollingElement || document.documentElement;
    return { results, clickTargets, visibleResultCards, structureChanged, idConflicts, scrollTop:Number(scrolling?.scrollTop || window.scrollY || 0), scrollHeight:Number(scrolling?.scrollHeight || 0), viewportHeight:Number(scrolling?.clientHeight || innerHeight || 0), requiresLogin:/扫码登录|手机号登录|登录后查看|请先登录/.test(full), captcha:/安全验证|请完成验证|拖动滑块|验证码|异常访问/.test(full) || captchaFrameVisible };
  })()`;
}

function detailScript(expectedId = '') {
  return `(() => {
    const expectedId = ${JSON.stringify(String(expectedId))};
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const cleanMultiline = (value) => String(value || '').split(/\\n+/).map(clean).filter(Boolean).join('\\n');
    const visible = (node) => { try { if (typeof node.checkVisibility === 'function' && !node.checkVisibility({ checkOpacity:true, checkVisibilityCSS:true })) return false; const box=node.getBoundingClientRect(), style=getComputedStyle(node); return box.width>4 && box.height>4 && box.right>0 && box.bottom>0 && box.left<innerWidth && box.top<innerHeight && style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity || 1)>0; } catch { return false; } };
    const trustedImage = (value) => { try { const url=new URL(String(value || ''), location.href); return ['http:','https:'].includes(url.protocol) && /(^|\\.)(?:douyinpic|byteimg)\\.com$/i.test(url.hostname) && !/(?:avatar|logo)/i.test(url.hostname + url.pathname); } catch { return false; } };
    const normalizeImage = (value) => { try { const url=new URL(String(value || ''), location.href); if (url.protocol === 'http:') url.protocol='https:'; return url.href; } catch { return ''; } };
    const imageKey = (value) => { try { const url=new URL(String(value || ''), location.href); return url.pathname.toLowerCase(); } catch { return String(value || '').split('?')[0].toLowerCase(); } };
    const rawLines = String(document.body?.innerText || '').split(/\\n+/).map(clean).filter(Boolean);
    const fullText = rawLines.join(' ');
    const modalId = new URL(location.href).searchParams.get('modal_id') || '';
    const pathId = (location.href.match(/\\/(?:note|video)\\/(\\d+)/) || [])[1] || '';
    const urlIdConflict = Boolean(modalId && pathId && modalId !== pathId);
    const currentId = urlIdConflict ? '' : modalId || pathId;
    const workId = currentId || expectedId;
    const idMatches = Boolean(!urlIdConflict && currentId && (!expectedId || currentId === expectedId));
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible).map((node) => clean(node.innerText || node.getAttribute('aria-label'))).filter(Boolean);
    const dialogRoots = [...document.querySelectorAll('[role="dialog"],[class*="modal"],[class*="detail"],[class*="feed"]')].filter(visible);
    const textNodes = [...document.querySelectorAll('div,article,section')].filter((node) => visible(node) && /图文|发布时间：/.test(clean(node.innerText)) && node.querySelector('img'));
    const roots = [...new Set([...dialogRoots, ...textNodes])];
    const candidates = roots.map((root) => {
      const rawText = String(root.innerText || ''); const text = clean(rawText); const images = [...root.querySelectorAll('img')].filter((img) => { if (!visible(img)) return false; const box = img.getBoundingClientRect(); return ((img.naturalWidth || 0) >= 240 && (img.naturalHeight || 0) >= 240) || (box.width >= 240 && box.height >= 240); });
      const score = (text.includes('图文') ? 20 : 0) + (workId && location.href.includes(workId) ? 10 : 0) + Math.min(images.length, 12) * 2 - Math.min(text.length / 1800, 10);
      return { root, rawText, text, images, score };
    }).filter((entry) => entry.images.length).sort((a,b) => b.score - a.score || a.text.length - b.text.length);
    const chosen = candidates[0] || { root: document.body, rawText:String(document.body?.innerText || ''), text: fullText, images: [], score: 0 };
    const lines = chosen.rawText.split(/\\n+/).map(clean).filter(Boolean);
    const structuredEntries = []; const parsedRoots=[];
    for (const script of document.querySelectorAll('script[type="application/ld+json"],script[type="application/json"],script#__NEXT_DATA__,script#RENDER_DATA')) {
      try { let raw=script.textContent || ''; if (script.id === 'RENDER_DATA' && /^%7B/i.test(raw.trim())) raw=decodeURIComponent(raw); const value=JSON.parse(raw || 'null'); if (value) parsedRoots.push(value); } catch {}
    }
    const queue=[...parsedRoots]; const visited=new WeakSet(); let visitedCount=0; let queueIndex=0;
    while (queueIndex < queue.length && visitedCount < 12000) {
      const entry=queue[queueIndex++]; if (!entry || typeof entry !== 'object' || visited.has(entry)) continue; visited.add(entry); visitedCount += 1;
      if (entry.headline || entry.description || entry.image || entry.aweme_id || entry.awemeId || entry.item_id || entry.itemId || entry.image_post_info || entry.imagePostInfo || entry.statistics) structuredEntries.push(entry);
      if (Array.isArray(entry)) queue.push(...entry); else for (const value of Object.values(entry)) if (value && typeof value === 'object') queue.push(value);
    }
    const entryId=(entry) => clean(entry?.aweme_id || entry?.awemeId || entry?.item_id || entry?.itemId || entry?.group_id || entry?.groupId || '');
    const entryScore=(entry) => (entryId(entry) && entryId(entry) === workId ? 100 : 0) + (entry.image_post_info || entry.imagePostInfo || entry.images ? 30 : 0) + (entry.item_title || entry.itemTitle || entry.title || entry.headline ? 20 : 0) + (entry.statistics ? 10 : 0);
    const exactEntries=structuredEntries.filter((entry) => workId && entryId(entry) === workId).sort((a,b) => entryScore(b)-entryScore(a));
    const pageEntries=structuredEntries.filter((entry) => !entryId(entry) && (entry.headline || entry.description || entry.image)).sort((a,b) => entryScore(b)-entryScore(a));
    const structured = exactEntries[0] || pageEntries[0] || {};
    const structuredWorkId=entryId(structured);
    const structuredAuthorValue=structured.author || structured.authorInfo || structured.user || {};
    const structuredAuthor = typeof structuredAuthorValue === 'string' ? structuredAuthorValue : structuredAuthorValue?.nickname || structuredAuthorValue?.name || structuredAuthorValue?.unique_id || structuredAuthorValue?.uniqueId || '';
    const author = clean(structuredAuthor || lines.find((line) => /^@/.test(line)) || rawLines.find((line) => /^@/.test(line)) || '');
    const publishedAtRaw = lines.find((line) => /(?:20\\d{2}年|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}月\\d{1,2}日|昨天|前天|今天)/.test(line)) || '';
    const typeIndex = lines.findIndex((line) => line === '图文');
    const contentLines = (typeIndex >= 0 ? lines.slice(typeIndex + 1) : lines).filter((line) => !/^@/.test(line) && !/^(?:\\d+(?:\\.\\d+)?[万wW]?)$/.test(line) && !/(?:发布时间：|20\\d{2}年|\\d{1,2}月\\d{1,2}日)/.test(line));
    const pageIndex = lines.findIndex((line) => /^\\d+\\s*\\/\\s*\\d+$/.test(line));
    const publishedIndex = lines.findIndex((line) => /^发布时间：/.test(line));
    const pageTitle = pageIndex >= 0 ? lines[pageIndex + 2] || '' : '';
    const pageContent = pageIndex >= 0 ? lines.slice(pageIndex + 3).filter((line) => line !== '图文' && !/^发布时间：/.test(line) && !/(?:20\\d{2}年|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}月\\d{1,2}日)/.test(line) && !/^(?:点赞|收藏|评论|转发|分享)\\s*\\d/i.test(line)).join('\\n') : '';
    const metaTitle = clean(document.querySelector('meta[property="og:title"],meta[name="twitter:title"]')?.content || '');
    const metaDescription = clean(document.querySelector('meta[property="og:description"],meta[name="description"]')?.content || '');
    const structuredTitle = clean(structured.item_title || structured.itemTitle || structured.title || structured.headline || structured.name || '');
    const structuredBody = cleanMultiline(structured.desc || structured.description || structured.content || '');
    const title = clean(structuredTitle || metaTitle || pageTitle || contentLines[0] || '');
    const body = cleanMultiline(structuredBody || metaDescription || pageContent || contentLines.filter((line) => line !== title).join('\\n') || '');
    const stateImageSources=[structured.image_post_info?.images,structured.imagePostInfo?.images,structured.images,structured.image_list,structured.imageList,structured.pictures,structured.image].filter(Boolean);
    const stateImageUrls=[];
    const collectStructuredImages=(value, depth=0, keyPath='') => {
      if (depth > 6 || value == null) return;
      if (typeof value === 'string') { if (trustedImage(value) && !/(?:^|[._-])(?:avatar|author|user|music|video|play)(?:[._-]|$)/i.test(keyPath)) stateImageUrls.push(normalizeImage(value)); return; }
      if (Array.isArray(value)) { for (const item of value) collectStructuredImages(item, depth+1, keyPath); return; }
      if (typeof value !== 'object') return;
      for (const [key,item] of Object.entries(value)) { if (/^(?:avatar|author|user|music|video|play)(?:_|$)/i.test(key)) continue; collectStructuredImages(item, depth+1, keyPath + '.' + key); }
    };
    for (const source of stateImageSources) collectStructuredImages(source);
    const imageNodes=[...new Set([...(chosen.root?.querySelectorAll?.('img') || []), ...chosen.images])];
    const domImageUrls=imageNodes.map((img) => { const url=img.currentSrc || img.getAttribute('data-src') || img.getAttribute('data-original') || img.src || ''; const box=img.getBoundingClientRect(); const width=Math.max(img.naturalWidth || 0, Number(img.getAttribute('width')) || 0, box.width || 0), height=Math.max(img.naturalHeight || 0, Number(img.getAttribute('height')) || 0, box.height || 0); const descriptor=[url,img.alt,img.className].join(' '); return width>=240 && height>=240 && !/(?:avatar|logo|头像)/i.test(descriptor) && trustedImage(url) ? normalizeImage(url) : ''; }).filter(Boolean);
    const allImages=[]; const imageKeys=new Set();
    for (const value of [...stateImageUrls,...domImageUrls]) { const key=imageKey(value); if (!key || imageKeys.has(key)) continue; imageKeys.add(key); allImages.push(value); }
    const numbers = pageIndex >= 4 ? lines.slice(pageIndex - 4, pageIndex) : [...buttons, ...rawLines].map((value) => (String(value).match(/^(\\d+(?:\\.\\d+)?(?:万|w)?)$/i) || [])[1]).filter(Boolean);
    const pageCount = Math.max(0,...lines.map((line) => Number((line.match(/^\\d+\\s*\\/\\s*(\\d+)$/) || [])[1] || 0)));
    const expectedImageCount=pageCount || new Set(stateImageUrls.map(imageKey)).size || allImages.length;
    const imageUrls=allImages.slice(0, Math.max(1, Math.min(30, expectedImageCount || 30)));
    const mediaComplete=Boolean(imageUrls.length && (!expectedImageCount || imageUrls.length >= expectedImageCount));
    const completenessEvidence=pageCount ? 'page_count' : stateImageUrls.length ? 'structured_images' : imageUrls.length ? 'dom_only' : 'none';
    const labeledCount = (labels) => { for (const value of [...buttons, ...rawLines]) { const text=clean(value); for (const label of labels) { if (!text.startsWith(label)) continue; const count=(text.slice(label.length).trim().match(/^(?:[:：]\\s*|[（(]\\s*)?(\\d+(?:\\.\\d+)?(?:万|w)?)(?:\\s*[）)])?(?:\\s|$)/i) || [])[1]; if (count) return count; } } return ''; };
    const statistics=structured.statistics || structured.stats || {};
    const stat=(...keys) => { for (const key of keys) if (statistics[key] != null && statistics[key] !== '') return String(statistics[key]); return ''; };
    const labeledLikes = stat('digg_count','diggCount','like_count','likeCount') || labeledCount(['点赞']);
    const labeledComments = stat('comment_count','commentCount') || labeledCount(['评论']);
    const labeledSaves = stat('collect_count','collectCount') || labeledCount(['收藏']);
    const labeledShares = stat('share_count','shareCount') || labeledCount(['转发','分享']);
    const hasLogin = /扫码登录|手机号登录|登录后查看|请先登录/.test(fullText);
    const captchaFrameVisible=[...document.querySelectorAll('iframe')].some((frame) => /(?:verifycenter|nocaptcha|captcha|rc-verify)/i.test(frame.src || '') && visible(frame));
    const hasCaptcha = /安全验证|请完成验证|拖动滑块|验证码|异常访问/.test(fullText) || captchaFrameVisible;
    const visibleVideo=[...document.querySelectorAll('video')].some(visible);
    const structuredVideo=Boolean(structured.video && !stateImageUrls.length);
    const hasVideo = /\\/video\\//.test(location.href) || structuredVideo || (visibleVideo && pageCount < 2 && !stateImageUrls.length);
    const contentType=!hasVideo && imageUrls.length && (stateImageUrls.length || pageCount >= 1 || /图文|发布时间：/.test(chosen.text)) ? 'image_text' : hasVideo ? 'video' : 'unknown';
    const createTime=Number(structured.create_time || structured.createTime || 0); const statePublishedAt=createTime > 1000000000 ? new Date(createTime * 1000).toISOString() : '';
    return { url: location.href, canonicalUrl: workId ? 'https://www.douyin.com/note/' + workId : location.href, id: workId, title, body, author: author || '', publishedAtRaw: statePublishedAt || (publishedIndex >= 0 ? lines[publishedIndex].replace(/^发布时间：/, '').trim() : publishedAtRaw),
      tags: ${extractTags.toString()}(title + '\\n' + body), imageUrls, imageCount: expectedImageCount || imageUrls.length, mediaComplete, likes: labeledLikes || numbers[0] || '', comments: labeledComments || numbers[1] || '', saves: labeledSaves || numbers[2] || '', shares: labeledShares || numbers[3] || '',
      contentType, meaningful: Boolean(workId && idMatches && title && imageUrls.length && mediaComplete && !hasVideo), requiresLogin: hasLogin, captcha: hasCaptcha,
      diagnostic: { rootScore: chosen.score, visibleImages: chosen.images.length, candidateRoots: candidates.length, pageHasModalId: Boolean(modalId), currentId, idMatches, urlIdConflict, hasVideo, visibleVideo, structuredWorkId, structuredData:Boolean(structuredTitle || structuredBody || stateImageUrls.length), expectedImages:expectedImageCount, capturedImages:imageUrls.length, mediaComplete, completenessEvidence } };
  })()`;
}

class DouyinCollector {
  constructor({ chromePath, chromeDiagnostic, profileDir, errorDir, port = 17842, headless = false, detailBaseUrl = 'https://www.douyin.com', searchBaseUrl = '' }) {
    this.session = new ChromeSession({ chromePath, chromeDiagnostic, profileDir, port, headless });
    this.errorDir = errorDir;
    this.detailBaseUrl = String(detailBaseUrl || 'https://www.douyin.com').replace(/\/+$/, '');
    this.searchBaseUrl = String(searchBaseUrl || '').replace(/\/+$/, '');
  }

  async navigateWithStop(client, url, waitMs = 0, shouldStop) {
    if (shouldStop?.()) return false;
    let navigationState = null;
    const navigation = client.command('Page.navigate', { url }, 20000).then(
      () => { navigationState = { ok:true }; },
      (error) => { navigationState = { ok:false, error }; }
    );
    while (!navigationState) {
      if (shouldStop?.()) {
        client.close();
        await Promise.race([navigation, wait(500)]).catch(() => {});
        return false;
      }
      await wait(50);
    }
    if (!navigationState.ok) throw navigationState.error;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (shouldStop?.()) { client.close(); return false; }
      const ready = await client.evaluate('document.readyState');
      if (ready === 'complete' || ready === 'interactive') break;
      await wait(100);
    }
    return waitInterruptibly(waitMs, shouldStop);
  }

  async scrollSearchPage(client, { delayMs = 800, shouldStop } = {}) {
    if (shouldStop?.()) return { stopped:true, moved:false, atEnd:false, scrollTop:0 };
    const state = await client.evaluate(`(() => {
      const area=document.querySelector('#search-content-area') || document.body;
      const candidates=[]; let node=area;
      while (node && node !== document.body && node !== document.documentElement) { candidates.push(node); node=node.parentElement; }
      const scrolling=document.scrollingElement || document.documentElement; candidates.push(scrolling);
      const root=candidates.find((item) => item !== scrolling && item.scrollHeight > item.clientHeight + 160 && /(?:auto|scroll)/.test(getComputedStyle(item).overflowY)) || scrolling;
      const before=root === scrolling ? Number(scrolling.scrollTop || window.scrollY || 0) : Number(root.scrollTop || 0);
      const viewport=Math.max(320, Number(root === scrolling ? innerHeight : root.clientHeight) || 0);
      const max=Math.max(0, Number(root.scrollHeight || 0) - viewport);
      const next=Math.min(max, before + Math.max(320, Math.floor(viewport * 0.82)));
      if (root === scrolling) window.scrollTo(0, next); else root.scrollTop=next;
      const after=root === scrolling ? Number(scrolling.scrollTop || window.scrollY || next) : Number(root.scrollTop || next);
      return { before, after, max, moved:after > before + 2, atEnd:after >= max - 2 };
    })()`);
    const continued = await waitInterruptibly(Math.max(250, Math.min(1500, Number(delayMs) || 800)), shouldStop);
    return { ...state, scrollTop:state.after, stopped:!continued };
  }

  async restoreSearchScroll(client, scrollTop, shouldStop) {
    if (!(Number(scrollTop) > 0)) return !shouldStop?.();
    if (shouldStop?.()) return false;
    await client.evaluate(`(() => {
      const area=document.querySelector('#search-content-area') || document.body;
      const candidates=[]; let node=area;
      while (node && node !== document.body && node !== document.documentElement) { candidates.push(node); node=node.parentElement; }
      const scrolling=document.scrollingElement || document.documentElement; candidates.push(scrolling);
      const root=candidates.find((item) => item !== scrolling && item.scrollHeight > item.clientHeight + 160 && /(?:auto|scroll)/.test(getComputedStyle(item).overflowY)) || scrolling;
      if (root === scrolling) window.scrollTo(0, ${Math.max(0, Number(scrollTop) || 0)}); else root.scrollTop=${Math.max(0, Number(scrollTop) || 0)};
    })()`);
    return waitInterruptibly(250, shouldStop);
  }

  async openLogin() {
    const home = 'https://www.douyin.com/';
    const { client } = await this.session.openClient(home, 'douyin.com');
    try { await this.session.navigate(client, home, 700); } finally { client.close(); }
    return { ok:true, message:'已打开抖音专用浏览器，请人工扫码登录；登录凭据仅保留在此专用浏览器资料目录' };
  }

  async importLink(sourceUrl, { shouldStop } = {}) {
    const sourceIdentity = workIdentity(sourceUrl);
    if (sourceIdentity.conflict) return { ok:false, code:'ID_MISMATCH', message:'链接中的作品路径 ID 与 modal_id 不一致，已拒绝导入，避免把错误作品写入候选池' };
    if (shouldStop?.()) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音链接导入已中断' };
    const { client } = await this.session.openClient('https://www.douyin.com/', 'douyin.com');
    try {
      if (shouldStop?.()) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音链接导入已中断' };
      const sourceId = sourceIdentity.id;
      if (!await this.navigateWithStop(client, sourceUrl, 900, shouldStop)) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音链接导入已中断' };
      const currentUrl = await client.evaluate('location.href');
      const currentIdentity = workIdentity(currentUrl);
      if (currentIdentity.conflict) return { ok:false, code:'ID_MISMATCH', message:'抖音跳转后的作品路径 ID 与 modal_id 不一致，已拒绝导入' };
      const expectedId = sourceId || currentIdentity.id;
      if (/\/video\//.test(String(currentUrl)) || (/\/video\//.test(String(sourceUrl)) && sourceId)) return { ok:false, code:'NOT_IMAGE_NOTE', message:'该链接是抖音视频，不会进入图文候选池' };
      // 搜索结果页的 modal_id 不保证在无点击场景下展开详情；统一跳转到作品规范页后再读取。
      if (expectedId && !new RegExp(`/note/${expectedId}(?:[/?#]|$)`).test(String(currentUrl))) {
        if (!await this.navigateWithStop(client, `${this.detailBaseUrl}/note/${expectedId}`, 700, shouldStop)) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音链接导入已中断' };
      }
      // readyState=complete 不代表 SPA 作品数据已出现。轮询真实解析结果；
      // 数据稳定但媒体不完整时尽快返回明确错误，不再固定空等 15 秒。
      const deadline = Date.now() + 15000;
      let detail = null; let lastFingerprint = ''; let stableReads = 0;
      while (Date.now() < deadline) {
        if (shouldStop?.()) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音链接导入已中断' };
        detail = await client.evaluate(detailScript(expectedId));
        if (detail.captcha || detail.requiresLogin || detail.contentType === 'video') break;
        const fingerprint = JSON.stringify([detail.id, detail.title, detail.contentType, detail.imageCount, detail.imageUrls?.length || 0, detail.mediaComplete]);
        stableReads = fingerprint === lastFingerprint ? stableReads + 1 : 0;
        lastFingerprint = fingerprint;
        if (detail.meaningful && detail.diagnostic?.completenessEvidence !== 'dom_only') break;
        if (detail.meaningful && stableReads >= 5) break;
        if (stableReads >= 5 && detail.title && (detail.imageUrls?.length || detail.contentType !== 'unknown')) break;
        if (stableReads >= 12 && detail.title) break;
        if (!await waitInterruptibly(350, shouldStop)) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音链接导入已中断' };
      }
      detail ||= await client.evaluate(detailScript(expectedId));
      if (detail.captcha) return { ok:false, code:'CAPTCHA', message:'抖音要求安全验证，已停止导入，请人工处理', screenshot:await this.captureFailure(client, 'captcha') };
      if (detail.requiresLogin) return { ok:false, code:'LOGIN_REQUIRED', message:'抖音登录状态不可用，请在抖音专用浏览器重新扫码登录', screenshot:await this.captureFailure(client, 'login') };
      if (detail.diagnostic?.urlIdConflict || !detail.diagnostic?.idMatches) return { ok:false, code:'ID_MISMATCH', message:'详情页作品 ID 与请求作品 ID 不一致，已拒绝导入', detail };
      if (detail.contentType === 'image_text' && !detail.mediaComplete) return { ok:false, code:'INCOMPLETE_MEDIA', message:`该图文标称 ${detail.imageCount || 0} 张图片，但只读取到 ${detail.imageUrls?.length || 0} 张；已拒绝不完整导入`, detail };
      if (!detail.meaningful || detail.contentType !== 'image_text') return { ok:false, code:'NOT_IMAGE_NOTE', message:'该公开链接未识别为可读取的抖音图文；视频、私密、已删除或页面结构变化不会导入', detail };
      return { ok:true, item:{ id:detail.id, url:detail.canonicalUrl, sourceUrl, title:detail.title, body:detail.body, author:detail.author.replace(/^@/, ''), tags:detail.tags, imageUrls:detail.imageUrls, imageCount:detail.imageCount, likes:normalizeOptionalCount(detail.likes) || 0, saves:normalizeOptionalCount(detail.saves), comments:normalizeOptionalCount(detail.comments), shares:normalizeOptionalCount(detail.shares), publishedAtRaw:detail.publishedAtRaw, publishedAt:normalizePublishedAt(detail.publishedAtRaw), contentType:'image_text', detailStatus:'enriched', parserVersion:'douyin-browser-link-v2', sourceMethod:'user_submitted_browser', collectedAt:new Date().toISOString(), rawText:[detail.title, detail.body].filter(Boolean), diagnostic:detail.diagnostic } };
    } catch (error) { return { ok:false, code:'COLLECTOR_ERROR', message:error.message, screenshot:await this.captureFailure(client, 'error').catch(() => '') }; }
    finally { client.close(); }
  }

  searchUrl(keyword) {
    if (this.searchBaseUrl) {
      const url = new URL(this.searchBaseUrl);
      url.searchParams.set('keyword', keyword);
      return url.toString();
    }
    return `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=general`;
  }

  async resolveClickTargets(client, searchUrl, targets, { delayMs = 1500, shouldStop, scrollTop = 0 } = {}) {
    const results = []; let unresolved = 0; let attempted = 0; let resolved = 0;
    for (let index = 0; index < (targets || []).length; index += 1) {
      if (shouldStop?.()) return { stopped:true, results, unresolved, attempted, resolved };
      const target = targets[index];
      if (target.isVideo) {
        results.push({ id:`visible-video-${index}-${target.coverUrl || target.title}`, url:'', title:target.title, rawText:target.rawText, coverUrl:target.coverUrl, isVideo:true, hasImageHint:false });
        continue;
      }
      attempted += 1;
      if (!await this.restoreSearchScroll(client, scrollTop, shouldStop)) return { stopped:true, results, unresolved, attempted, resolved };
      const point = await client.evaluate(`(() => {
        const expected=${JSON.stringify(String(target.coverUrl || ''))}, expectedKey=${JSON.stringify(String(target.coverKey || ''))}, expectedTitle=${JSON.stringify(String(target.title || ''))};
        const clean=(value) => String(value || '').replace(/\\s+/g,' ').trim();
        const key=(value) => { try { const url=new URL(String(value || ''), location.href); return url.pathname.toLowerCase(); } catch { return String(value || '').split('?')[0].toLowerCase(); } };
        const visible=(node) => { try { const box=node.getBoundingClientRect(), style=getComputedStyle(node); return box.width>8 && box.height>8 && box.right>0 && box.bottom>0 && box.left<innerWidth && box.top<innerHeight && style.display!=='none' && style.visibility!=='hidden'; } catch { return false; } };
        const images=[...document.querySelectorAll('img')].filter(visible);
        let image=images.find((item) => (item.currentSrc || item.getAttribute('data-src') || item.src || '') === expected);
        if (!image && expectedKey) image=images.find((item) => key(item.currentSrc || item.getAttribute('data-src') || item.src || '') === expectedKey);
        if (!image && expectedTitle) image=images.find((item) => { let node=item; for(let depth=0;node && depth<7;depth+=1,node=node.parentElement) if(clean(node.innerText).includes(expectedTitle)) return true; return false; });
        if (!image) return null;
        const box=image.getBoundingClientRect(); const clickable=image.closest('a,button,[role="button"],[role="link"]') || image;
        clickable.click(); return { x:Math.round(box.left + box.width/2), y:Math.round(box.top + box.height/2) };
      })()`);
      if (!point) { unresolved += 1; continue; }
      let afterDomClick = '';
      for (let poll = 0; poll < 10; poll += 1) {
        if (!await waitInterruptibly(100, shouldStop)) return { stopped:true, results, unresolved, attempted, resolved };
        afterDomClick = String(await client.evaluate('location.href') || '');
        if (workIdentity(afterDomClick).id) break;
      }
      if (!workIdentity(afterDomClick).id) {
        await client.command('Input.dispatchMouseEvent', { type:'mousePressed', x:point.x, y:point.y, button:'left', clickCount:1 }, 10000);
        await client.command('Input.dispatchMouseEvent', { type:'mouseReleased', x:point.x, y:point.y, button:'left', clickCount:1 }, 10000);
      }
      if (!await waitInterruptibly(Math.max(700, Math.min(2500, delayMs)), shouldStop)) return { stopped:true, results, unresolved, attempted, resolved };
      const currentUrl = String(await client.evaluate('location.href') || '');
      const identity = workIdentity(currentUrl);
      if (identity.id && !identity.conflict) { resolved += 1; results.push({ id:identity.id, url:currentUrl, title:target.title, rawText:target.rawText, coverUrl:target.coverUrl, isVideo:/\/video\//.test(currentUrl), hasImageHint:target.hasImageHint, resolvedFromClick:true }); }
      else unresolved += 1;
      if (!await this.navigateWithStop(client, searchUrl, Math.max(500, Math.min(1400, delayMs)), shouldStop)) return { stopped:true, results, unresolved, attempted, resolved };
      if (!await this.restoreSearchScroll(client, scrollTop, shouldStop)) return { stopped:true, results, unresolved, attempted, resolved };
    }
    return { stopped:false, results, unresolved, attempted, resolved };
  }

  async collect({ keywords, rawLimit = 20, detailLimit = 10, finalLimit = 5, delayMs = 3000, strict = false, onProgress, shouldStop }) {
    const normalized = [...new Set((keywords || []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 30);
    if (!normalized.length) return { ok:false, code:'NO_KEYWORDS', message:'请先配置至少一个抖音关键词' };
    if (shouldStop?.()) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音采集已中断' };
    const rawTarget = Math.max(1, Math.min(500, Number(rawLimit) || 20));
    const detailTarget = Math.max(1, Math.min(200, Number(detailLimit) || 10));
    const { tab, client } = await this.session.openClient('https://www.douyin.com/', 'douyin.com');
    const items = [], seen = new Set(), warnings = [];
    const stats = { raw:0, prefiltered:0, detailed:0, qualified:0, rejected:{ video:0, low_relevance:0, no_images:0, low_interaction:0 }, duplicates:0 };
    try {
      for (let index = 0; index < normalized.length; index += 1) {
        if (shouldStop?.()) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音采集已中断' };
        const keyword = normalized[index]; const keywordSearchUrl=this.searchUrl(keyword); onProgress?.({ keyword, index, total:normalized.length, stage:'navigate' });
        if (!await this.navigateWithStop(client, keywordSearchUrl, Math.max(700, Math.min(2500, delayMs)), shouldStop)) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音采集已中断' };
        // Douyin may preload an out-of-process verification iframe even without
        // showing a challenge.  A target URL alone is therefore insufficient.
        const targets = await this.session.listTabs();
        const challengeFrame = targets.some((target) => target.type === 'iframe' && target.parentId === tab.id && /(?:verifycenter|nocaptcha|captcha|rc-verify)/i.test(String(target.url || '')));
        const challengeFrameVisible = challengeFrame && await client.evaluate(`(() => [...document.querySelectorAll('iframe')].some((frame) => { if (!/(?:verifycenter|nocaptcha|captcha|rc-verify)/i.test(frame.src || '')) return false; if (typeof frame.checkVisibility === 'function' && !frame.checkVisibility({ checkOpacity:true, checkVisibilityCSS:true })) return false; const box=frame.getBoundingClientRect(), style=getComputedStyle(frame); return box.width>8 && box.height>8 && box.right>0 && box.bottom>0 && box.left<innerWidth && box.top<innerHeight && style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity || 1)>0; }))()`);
        if (challengeFrameVisible) return { ok:false, code:'CAPTCHA', message:'抖音要求安全验证，已停止采集，请人工处理', screenshot:await this.captureFailure(client, 'captcha') };
        const remainingKeywords = normalized.length - index;
        const keywordRawGoal = Math.max(1, Math.ceil((rawTarget - stats.raw) / remainingKeywords));
        const keywordResults=[]; const keywordIds=new Set(); const processedTargets=new Set();
        let noProgressPasses=0; const maxPasses=Math.max(3, Math.min(60, Math.ceil(keywordRawGoal / 4) + 6));
        for (let pass=0; pass<maxPasses && keywordResults.length<keywordRawGoal; pass+=1) {
          if (shouldStop?.()) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音采集已中断' };
          const page = await client.evaluate(searchScript(Math.min(100, Math.max(8, keywordRawGoal - keywordResults.length + 4))));
          if (page.captcha) return { ok:false, code:'CAPTCHA', message:'抖音要求安全验证，已停止采集，请人工处理', screenshot:await this.captureFailure(client, 'captcha') };
          if (page.requiresLogin) return { ok:false, code:'LOGIN_REQUIRED', message:'抖音登录状态不可用，请在抖音专用浏览器重新扫码登录', screenshot:await this.captureFailure(client, 'login') };
          if (page.structureChanged) return { ok:false, code:'PAGE_STRUCTURE_CHANGED', message:`抖音搜索页显示了至少 ${page.visibleResultCards || 0} 个内容卡片，但当前适配器无法读取作品标识；已停止本轮，避免把解析失败误报为零结果`, screenshot:await this.captureFailure(client, 'structure') };
          if (page.idConflicts) warnings.push({ code:'CARD_ID_CONFLICT', message:`${page.idConflicts} 个卡片的路径 ID 与 modal_id 冲突，已跳过` });
          const discovered=[...(page.results || [])];
          const freshTargets=(page.clickTargets || []).filter((target) => { const signature=`${target.coverKey || target.coverUrl}|${target.title}`; if (processedTargets.has(signature)) return false; processedTargets.add(signature); return true; });
          if (freshTargets.length) {
            const clicked = await this.resolveClickTargets(client, keywordSearchUrl, freshTargets, { delayMs, shouldStop, scrollTop:page.scrollTop });
            if (clicked.stopped) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音采集已中断' };
            discovered.push(...clicked.results);
            if (clicked.attempted && !clicked.resolved) return { ok:false, code:'PAGE_STRUCTURE_CHANGED', message:`抖音搜索页存在 ${clicked.attempted} 个疑似图文卡片，但点击后均无法取得作品标识；已停止本轮`, screenshot:await this.captureFailure(client, 'structure') };
            if (clicked.unresolved) warnings.push({ code:'CARD_UNRESOLVED', message:`${clicked.unresolved} 个可见卡片点击后未取得作品标识` });
          }
          let added=0;
          for (const card of discovered) { if (!card?.id || keywordIds.has(card.id)) continue; keywordIds.add(card.id); keywordResults.push(card); added += 1; if (keywordResults.length >= keywordRawGoal) break; }
          noProgressPasses = added ? 0 : noProgressPasses + 1;
          onProgress?.({ keyword, index, total:normalized.length, stage:'scan', pass:pass+1, count:keywordResults.length, target:keywordRawGoal });
          if (keywordResults.length >= keywordRawGoal) break;
          const scroll = await this.scrollSearchPage(client, { delayMs:Math.max(300, Math.min(1500, delayMs / 2)), shouldStop });
          if (scroll.stopped) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音采集已中断' };
          if (!scroll.moved || (scroll.atEnd && noProgressPasses >= 1) || noProgressPasses >= 4) break;
        }
        const raw=[]; const remainingRaw=Math.max(0, rawTarget-stats.raw);
        for (const card of keywordResults) { if (seen.has(card.id)) { stats.duplicates += 1; continue; } if (raw.length >= remainingRaw) break; seen.add(card.id); raw.push(card); }
        stats.raw += raw.length;
        const remainingDetail=Math.max(0, detailTarget-stats.prefiltered);
        const keywordDetailGoal=Math.max(0, Math.ceil(remainingDetail / remainingKeywords));
        const candidates = raw.filter((x) => { if (x.isVideo) { stats.rejected.video += 1; return false; } if (!x.hasImageHint) { stats.rejected.no_images += 1; return false; } return true; }).slice(0, keywordDetailGoal);
        stats.prefiltered += candidates.length;
        for (let detailIndex = 0; detailIndex < candidates.length; detailIndex += 1) {
          if (shouldStop?.()) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音采集已中断' };
          const card = candidates[detailIndex]; onProgress?.({ keyword, index, total:normalized.length, stage:'detail', detailIndex, detailTotal:candidates.length, title:card.title });
          const detail = await this.importLink(card.url, { shouldStop });
          if (!detail.ok) { if (['CAPTCHA','LOGIN_REQUIRED','MASTER_STOPPED'].includes(detail.code)) return detail; warnings.push({ code:detail.code, id:card.id, message:detail.message }); continue; }
          stats.detailed += 1;
          const item = { ...detail.item, keyword, sourceMethod:'douyin_search_browser' };
          const haystack = `${item.title} ${item.body} ${item.tags.join(' ')}`.toLowerCase();
          const related = keyword.toLowerCase().split(/\s+/).filter(Boolean).some((part) => haystack.includes(part));
          const engagement = Number(item.likes || 0) + Number(item.comments || 0) * 3 + Number(item.saves || 0) * 2;
          if (!related) { stats.rejected.low_relevance += 1; continue; }
          if (strict && engagement < 100) { stats.rejected.low_interaction += 1; continue; }
          item.localQualityScore = Math.min(100, 40 + Math.min(40, Math.log10(Math.max(1, engagement)) * 12) + (item.imageUrls.length ? 15 : 0));
          item.localRelevanceScore = related ? 100 : 0; item.localFilterMode = strict ? 'automatic_strict' : 'manual_standard'; items.push(item);
        }
        onProgress?.({ keyword, index, total:normalized.length, stage:'done', count:candidates.length });
        if (stats.raw >= rawTarget) break;
        if (index < normalized.length - 1 && !await waitInterruptibly(Math.max(700, Math.min(2500, delayMs)), shouldStop)) return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止，抖音采集已中断' };
      }
      const unique = items.sort((a,b) => b.localQualityScore - a.localQualityScore).slice(0, Math.max(1, Math.min(50, Number(finalLimit) || 5)));
      stats.qualified = unique.length;
      return { ok:true, items:unique, keywordCount:normalized.length, warnings, filterStats:stats, message:unique.length ? '' : '本轮没有达到质量门槛的公开抖音图文' };
    } catch (error) { return { ok:false, code:'COLLECTOR_ERROR', message:error.message, screenshot:await this.captureFailure(client, 'error').catch(() => '') }; }
    finally { client.close(); }
  }

  async captureFailure(client, reason) { fs.mkdirSync(this.errorDir, { recursive:true }); const output = path.join(this.errorDir, `douyin-${reason}-${Date.now()}.png`); return this.session.screenshot(client, output); }
  closeBrowser() { this.session.stop(); }
}

module.exports = { DouyinCollector, detailScript, searchScript };
