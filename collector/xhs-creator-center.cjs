const fs = require('node:fs');
const path = require('node:path');
const { ChromeSession } = require('./chrome-session.cjs');

const CREATOR_HOME = 'https://creator.xiaohongshu.com/statistics/data-analysis';

function numberFromText(value) {
  const text = String(value ?? '').replace(/,/g, '').trim();
  if (!text || text === '-' || text === '--') return 0;
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

function percentFromText(value) {
  const match = String(value ?? '').match(/([\d.]+)\s*%/);
  return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
}

function secondsFromText(value) {
  const text = String(value ?? '').trim();
  const minute = text.match(/([\d.]+)\s*分/);
  const second = text.match(/([\d.]+)\s*(?:秒|s)/i);
  if (minute) return Math.round(Number(minute[1]) * 60 + (second ? Number(second[1]) : 0));
  return second ? Math.round(Number(second[1])) : null;
}

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 160);
}

function noteIdFromUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch {}
  try {
    const url = new URL(decoded, 'https://www.xiaohongshu.com');
    for (const key of ['note_id', 'noteId', 'source_note_id', 'sourceNoteId']) {
      const candidate = url.searchParams.get(key);
      if (/^[0-9a-f]{16,32}$/i.test(candidate || '')) return candidate.toLowerCase();
    }
    const pathMatch = url.pathname.match(/\/(?:explore|discovery\/item|note|published)\/([0-9a-f]{16,32})(?:\/|$)/i);
    if (pathMatch) return pathMatch[1].toLowerCase();
  } catch {}
  return (decoded.match(/\b[0-9a-f]{24}\b/i) || [])[0]?.toLowerCase() || '';
}

function tableExtractionScript() {
  return `(() => {
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects?.().length));
    const noteId = (value) => {
      const text = String(value || '');
      try {
        const url = new URL(text, location.origin);
        for (const key of ['note_id','noteId','source_note_id','sourceNoteId']) {
          const candidate = url.searchParams.get(key);
          if (/^[0-9a-f]{16,32}$/i.test(candidate || '')) return candidate.toLowerCase();
        }
        const match = url.pathname.match(/\\/(?:explore|discovery\\/item|note|published)\\/([0-9a-f]{16,32})(?:\\/|$)/i);
        if (match) return match[1].toLowerCase();
      } catch {}
      return (text.match(/\\b[0-9a-f]{24}\\b/i) || [])[0]?.toLowerCase() || '';
    };
    const bodyText = clean(document.body?.innerText || '');
    const loginSignals = ['短信登录','扫码登录','手机号登录','发送验证码','解锁创作者专属功能'];
    const captchaSignals = ['安全验证','拖动滑块','验证码','请完成验证'];
    const loginVisible = [...document.querySelectorAll('[class*="login" i],[class*="Login"],[role="dialog"]')].some(visible);
    const captchaVisible = [...document.querySelectorAll('[class*="captcha" i],[class*="verify" i],[class*="geetest" i],iframe[src*="captcha"],iframe[src*="verify"]')].some(visible);
    const table = [...document.querySelectorAll('table')].find((node) => /笔记基础信息/.test(clean(node.innerText))) || document.querySelector('table');
    if (!table) return { ok:false, requiresLogin: loginVisible || loginSignals.some((item) => bodyText.includes(item)), captcha: captchaVisible || captchaSignals.some((item) => bodyText.includes(item)), rows: [], bodyText: bodyText.slice(0, 800) };
    const headerCells = [...table.querySelectorAll('thead th')];
    const headers = headerCells.map((cell) => clean(cell.innerText));
    const rows = [...table.querySelectorAll('tbody tr')].map((row) => {
      const cells = [...row.querySelectorAll('td')].map((cell) => clean(cell.innerText));
      if (!cells.length) return null;
      const values = {}; headers.forEach((header, index) => { values[header] = cells[index] || ''; });
      const first = cells[0] || '';
      const parts = first.split(/\\n| 发布于/).map(clean).filter(Boolean);
      const title = parts[0] || '';
      const published = (first.match(/发布于\\s*([^\\n]+)/) || [])[1] || '';
      const coverUrl = row.querySelector('.note-cover img, img')?.src || '';
      const hrefs = [...row.querySelectorAll('a[href]')].map((anchor) => anchor.href).filter(Boolean);
      const extractedNoteId = hrefs.map(noteId).find(Boolean) || '';
      const stableHref = hrefs.find((href) => noteId(href) === extractedNoteId) || hrefs[0] || '';
      return { title, publishedAtRaw: clean(published), coverUrl, cells, values, hrefs, noteId:extractedNoteId, stableHref };
    }).filter(Boolean);
    return { ok:true, rows, headers, requiresLogin:false, captcha:false, pageTitle: document.title, url: location.href };
  })()`;
}

function creatorSessionStatus(result = {}) {
  if (result.captcha) return { ok:false, loggedIn:false, code:'CAPTCHA', message:'小红书创作后台要求安全验证，请在专用浏览器人工处理' };
  if (result.requiresLogin) return { ok:false, loggedIn:false, code:'LOGIN_REQUIRED', message:'小红书创作后台登录状态不可用，请在专用浏览器人工登录' };
  if (result.ok) return { ok:true, loggedIn:true, code:'READY', message:'小红书创作后台登录有效，数据页面可读取', rows:result.rows || [], headers:result.headers || [], pageTitle:result.pageTitle || '', url:result.url || '' };
  return { ok:false, loggedIn:null, code:'PAGE_UNRECOGNIZED', message:'已打开小红书创作后台，但未识别到数据页面；请检查页面是否改版或账号权限' };
}

class XiaohongshuCreatorCenterCollector {
  constructor({ chromePath, chromeDiagnostic, profileDir, errorDir, port = 17841, headless = false, creatorUrl = CREATOR_HOME }) {
    this.session = new ChromeSession({ chromePath, chromeDiagnostic, profileDir, port, headless });
    this.errorDir = errorDir;
    this.creatorUrl = creatorUrl;
  }

  async waitForStatus(client, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    let latest = {};
    while (Date.now() < deadline) {
      latest = await client.evaluate(tableExtractionScript());
      if (latest?.requiresLogin || latest?.captcha || (latest?.ok && Array.isArray(latest.rows) && latest.rows.length)) return creatorSessionStatus(latest);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return creatorSessionStatus(latest);
  }

  async inspectAfterNavigation(waitMs = 1000) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tab = await this.session.getOrCreateTab(this.creatorUrl, 'creator.xiaohongshu.com');
      const client = await this.session.connect(tab);
      try {
        await this.session.navigate(client, this.creatorUrl, waitMs);
        return await this.waitForStatus(client);
      } catch (error) {
        lastError = error;
        if (!/页面连接已关闭/.test(error.message) || attempt > 0) throw error;
      } finally { client.close(); }
    }
    throw lastError || new Error('小红书创作后台页面连接失败');
  }

  async openLogin() {
    await this.session.ensureStarted(this.creatorUrl);
    return this.inspectAfterNavigation(800);
  }

  async probe() {
    await this.session.ensureStarted(this.creatorUrl);
    try {
      return await this.inspectAfterNavigation(1000);
    } catch (error) {
      return { ok:false, loggedIn:null, code:'COLLECTOR_ERROR', message:error.message };
    }
  }

  async collect() {
    await this.session.ensureStarted(this.creatorUrl);
    const tab = await this.session.getOrCreateTab(this.creatorUrl, 'creator.xiaohongshu.com');
    const client = await this.session.connect(tab);
    try {
      await this.session.navigate(client, this.creatorUrl, 1400);
      const status = await this.waitForStatus(client);
      if (!status.ok) return { ...status, screenshot:await this.captureFailure(client, status.code === 'CAPTCHA' ? 'creator-captcha' : status.code === 'LOGIN_REQUIRED' ? 'creator-login' : 'creator-page') };
      return { ok:true, rows:status.rows || [], headers:status.headers || [], collectedAt:new Date().toISOString() };
    } catch (error) {
      let screenshot = '';
      try { screenshot = await this.captureFailure(client, 'creator-error'); } catch {}
      return { ok:false, code:'COLLECTOR_ERROR', message:error.message, screenshot };
    } finally { client.close(); }
  }

  async captureFailure(client, reason) {
    fs.mkdirSync(this.errorDir, { recursive:true });
    const output = path.join(this.errorDir, `xiaohongshu-${reason}-${Date.now()}.png`);
    return this.session.screenshot(client, output);
  }

  closeBrowser() { this.session.stop(); }
}

module.exports = { XiaohongshuCreatorCenterCollector, numberFromText, percentFromText, secondsFromText, normalizeTitle, noteIdFromUrl, tableExtractionScript, creatorSessionStatus };
