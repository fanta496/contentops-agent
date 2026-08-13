function imageEndpoint(baseUrl, inputMode = 'text_only') {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('尚未配置生图模型接口地址');
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('生图模型接口必须使用 HTTPS；本机地址可使用 HTTP');
  const leaf = inputMode === 'reference_edit' ? '/images/edits' : '/images/generations';
  if (url.pathname.endsWith('/images/generations') || url.pathname.endsWith('/images/edits')) return `${url.origin}${url.pathname.replace(/\/images\/(?:generations|edits)$/, leaf)}`;
  if (url.pathname.endsWith('/v1')) return `${url.href.replace(/\/$/, '')}${leaf}`;
  return `${url.href.replace(/\/$/, '')}/v1${leaf}`;
}

function imageUsage(payload = {}) {
  const usage = payload.usage || {};
  return { inputTokens: Number(usage.input_tokens || usage.prompt_tokens || 0), outputTokens: Number(usage.output_tokens || usage.completion_tokens || 0), totalTokens: Number(usage.total_tokens || 0) };
}

function detectImageMime(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return '';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

function validateBase64Image(value) {
  const raw = String(value || '').trim().replace(/^data:image\/(?:png|jpeg|webp);base64,/i, '');
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('生图供应商返回图片为空或超过 25MB 安全上限');
  const mime = detectImageMime(bytes);
  if (!mime) throw new Error('生图供应商返回的 Base64 不是有效的 PNG、JPG 或 WebP 图片');
  return { bytes, mime };
}

async function readResponseText(response, maxBytes = 36 * 1024 * 1024) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) throw new Error('生图模型响应超过安全上限');
  if (!response.body) return '';
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk); total += bytes.length;
    if (total > maxBytes) throw new Error('生图模型响应超过安全上限');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase();
  if (value === '::1' || value === '::' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true;
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || parts[0] === 169 && parts[1] === 254 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168 || parts[0] >= 224;
}

async function publicImageUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('生图供应商返回的图片 URL 不合法'); }
  if (url.protocol !== 'https:') throw new Error('生图供应商返回的图片 URL 必须使用 HTTPS');
  if (!url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) throw new Error('生图供应商返回的图片 URL 指向本机或内网，已拒绝下载');
  const addresses = isIP(url.hostname) ? [{ address:url.hostname }] : await lookup(url.hostname, { all:true, verbatim:true }).catch(() => { throw new Error('生图供应商返回的图片 URL 无法解析'); });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) throw new Error('生图供应商返回的图片 URL 指向本机或内网，已拒绝下载');
  return url;
}

async function downloadImageUrl(value, timeoutMs) {
  const url = await publicImageUrl(value);
  const response = await fetch(url, { signal:AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`生图供应商返回的图片 URL 无法下载：HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > 25 * 1024 * 1024) throw new Error('生图供应商返回图片超过 25MB 安全上限');
  if (!response.body) throw new Error('生图供应商返回图片为空');
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk); total += bytes.length;
    if (total > 25 * 1024 * 1024) throw new Error('生图供应商返回图片超过 25MB 安全上限');
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks, total);
  const mime = detectImageMime(bytes);
  if (!mime) throw new Error('生图供应商返回的 URL 内容不是有效的 PNG、JPG 或 WebP 图片');
  return { bytes, mime };
}

async function generateImage({ baseUrl, apiKey, model, prompt, size = '', timeoutMs = 180000, inputMode = 'text_only', referenceImages = [] }) {
  if (!String(model || '').trim()) throw new Error('尚未配置生图模型名称');
  if (!String(apiKey || '').trim()) throw new Error('尚未保存生图模型 API 凭据');
  // 生产端必须把图片保留到本机，避免供应商临时 URL 过期或无法导出。
  // OpenAI Images 兼容接口通常以 b64_json 返回；不支持此能力的供应商会在连接测试阶段被拦住。
  const normalizedMode = ['reference_edit', 'reference_generation_json'].includes(inputMode) ? inputMode : 'text_only';
  const text = String(prompt ?? ''); if (!text.trim()) throw new Error('图片提示词不能为空');
  let body; const headers = { authorization: `Bearer ${apiKey}` };
  if (normalizedMode === 'reference_edit') {
    const references = Array.isArray(referenceImages) ? referenceImages.filter((item) => item?.bytes?.length && item?.mime) : [];
    if (!references.length) throw new Error('当前生图档案要求参考图，但本套内容没有可用的参考图片');
    body = new FormData(); body.set('model', model); body.set('prompt', text); body.set('n', '1'); body.set('response_format', 'b64_json');
    if (String(size || '').trim()) body.set('size', String(size).trim());
    for (const [index, reference] of references.slice(0, 4).entries()) body.append('image', new Blob([reference.bytes], { type:reference.mime }), reference.name || `reference-${index + 1}.png`);
  } else {
    body = { model, prompt:text, n:1, response_format:'b64_json' };
    if (normalizedMode === 'reference_generation_json') {
      const references = Array.isArray(referenceImages) ? referenceImages.filter((item) => item?.bytes?.length && item?.mime) : [];
      if (!references.length) throw new Error('当前生图档案要求参考图，但本套内容没有可用的参考图片');
      body.image = references.slice(0, 4).map((reference) => `data:${reference.mime};base64,${Buffer.from(reference.bytes).toString('base64')}`);
      // GPT Image generations 参考图兼容格式使用 JSON image 数组，不使用 multipart。
      delete body.response_format;
    }
    if (String(size || '').trim()) body.size = String(size).trim(); headers['content-type'] = 'application/json'; body = JSON.stringify(body);
  }
  const response = await fetch(imageEndpoint(baseUrl, normalizedMode), { method:'POST', headers, body, signal:AbortSignal.timeout(timeoutMs) });
  const raw = await readResponseText(response);
  if (!response.ok) throw new Error(`生图模型接口 HTTP ${response.status}：${raw.slice(0, 300)}`);
  let payload; try { payload = JSON.parse(raw); } catch { throw new Error('生图模型接口没有返回 JSON 响应'); }
  // OpenAI-compatible gateways usually return data[0], while a few gateways
  // wrap the exact same item in data.images[0].  Accept both without weakening
  // the response validation; URL and Base64 are each valid output contracts.
  const asset = payload?.data?.[0] || payload?.data?.images?.[0] || payload?.images?.[0];
  const b64 = asset?.b64_json || asset?.base64 || '';
  const url = asset?.url || '';
  if (!b64 && !url) throw new Error(payload?.error?.message || payload?.message || '生图模型没有返回 b64_json 或图片 URL');
  if (b64) { validateBase64Image(b64); return { b64, url:'', revisedPrompt: asset.revised_prompt || '', usage: imageUsage(payload) }; }
  const downloaded = await downloadImageUrl(url, timeoutMs);
  return { b64:downloaded.bytes.toString('base64'), url:'', revisedPrompt: asset.revised_prompt || '', usage: imageUsage(payload), downloadedFrom:url, mime:downloaded.mime };
}

module.exports = { imageEndpoint, generateImage, validateBase64Image };
const { lookup } = require('node:dns/promises');
const { isIP } = require('node:net');
