const { extractJson } = require('./openai-compatible.cjs');

const VISION_TEST_IMAGE_URL = 'https://raw.githubusercontent.com/github/explore/bc9b677c85a4dbe12896bd01530116f8861d3ebb/topics/javascript/javascript.png';

function visionEndpoint(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('尚未配置视觉模型接口地址');
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('视觉模型接口必须使用 HTTPS；本机地址可使用 HTTP');
  if (url.pathname.endsWith('/responses')) return { url: url.href, format: 'responses' };
  if (url.pathname.endsWith('/chat/completions')) return { url: url.href, format: 'chat' };
  if (url.pathname.endsWith('/v1')) return { url: `${url.href.replace(/\/$/, '')}/chat/completions`, format: 'chat' };
  return { url: `${url.href.replace(/\/$/, '')}/v1/chat/completions`, format: 'chat' };
}

function safeImageUrls(values, limit = 12, { allowTrustedTestImage = false, allowDataImages = false } = {}) {
  const allowed = [];
  for (const value of values || []) {
    const raw = String(value || '');
    if (allowDataImages && /^data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i.test(raw) && raw.length <= 20 * 1024 * 1024) {
      if (!allowed.includes(raw)) allowed.push(raw);
      if (allowed.length >= limit) break;
      continue;
    }
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      const trustedTestImage = allowTrustedTestImage && url.href === VISION_TEST_IMAGE_URL;
      // Only accept known first-party media CDNs.  This is deliberately not a
      // generic HTTPS allow-list: the vision request must not become an SSRF-like
      // proxy for arbitrary URLs supplied by scraped content.
      const trustedContentCdn = /(^|\.)xhscdn\.com$/i.test(url.hostname)
        || /(^|\.)douyinpic\.com$/i.test(url.hostname)
        || /(^|\.)byteimg\.com$/i.test(url.hostname);
      if (!trustedContentCdn && !['127.0.0.1', 'localhost'].includes(url.hostname) && !trustedTestImage) continue;
      if (/avatar/i.test(url.hostname + url.pathname)) continue;
      if (url.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) url.protocol = 'https:';
      const normalized = url.href;
      if (!allowed.includes(normalized)) allowed.push(normalized);
    } catch {}
    if (allowed.length >= limit) break;
  }
  return allowed;
}

function responseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  for (const output of payload?.output || []) for (const content of output?.content || []) if (content?.type === 'output_text' && content.text) return content.text;
  const chat = payload?.choices?.[0]?.message?.content;
  if (typeof chat === 'string') return chat;
  if (Array.isArray(chat)) return chat.map((item) => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n');
  return '';
}

async function callVisionJson({ baseUrl, apiKey, model, prompt, imageUrls, timeoutMs = 120000, detail = 'auto', maxOutputTokens = 4000, allowTrustedTestImage = false, allowDataImages = false }) {
  if (!String(model || '').trim()) throw new Error('尚未配置视觉模型名称');
  if (!String(apiKey || '').trim()) throw new Error('尚未保存视觉模型 API 凭据');
  const images = safeImageUrls(imageUrls, 12, { allowTrustedTestImage, allowDataImages });
  if (!images.length) throw new Error('没有可提交给视觉模型的公开图片地址');
  const endpoint = visionEndpoint(baseUrl);
  const responseBody = endpoint.format === 'responses'
    ? { model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, ...images.map((image_url) => ({ type: 'input_image', image_url, detail }))] }], max_output_tokens: maxOutputTokens, text: { format: { type: 'json_object' } }, store: false }
    : { model, temperature: 0.2, max_tokens: maxOutputTokens, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.map((url) => ({ type: 'image_url', image_url: { url, detail } }))] }] };
  const response = await fetch(endpoint.url, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(responseBody),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`视觉模型接口 HTTP ${response.status}：${raw.slice(0, 300)}`);
  let payload; try { payload = JSON.parse(raw); } catch { throw new Error('视觉模型接口没有返回 JSON 响应'); }
  const text = responseText(payload);
  if (!text) throw new Error(payload?.error?.message || '视觉模型接口没有返回分析内容');
  const usage = payload.usage || {};
  return { data: extractJson(text), imageCount: images.length, usage: { inputTokens: Number(usage.input_tokens || usage.prompt_tokens || 0), outputTokens: Number(usage.output_tokens || usage.completion_tokens || 0), totalTokens: Number(usage.total_tokens || 0) }, rawContent: text };
}

module.exports = { callVisionJson, visionEndpoint, safeImageUrls, responseText, VISION_TEST_IMAGE_URL };
