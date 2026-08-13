function extractJson(text) {
  const source = String(text || '').trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || source;
  try { return JSON.parse(candidate); } catch {}
  const objectStart = candidate.indexOf('{');
  const objectEnd = candidate.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) return JSON.parse(candidate.slice(objectStart, objectEnd + 1));
  const arrayStart = candidate.indexOf('[');
  const arrayEnd = candidate.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) return JSON.parse(candidate.slice(arrayStart, arrayEnd + 1));
  throw new Error('模型没有返回可解析的 JSON');
}

function endpoint(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('尚未配置模型接口地址');
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('模型接口必须使用 HTTPS；本机地址可使用 HTTP');
  if (url.pathname.endsWith('/chat/completions')) return url.href;
  if (url.pathname.endsWith('/v1')) return `${url.href.replace(/\/$/, '')}/chat/completions`;
  return `${url.href.replace(/\/$/, '')}/v1/chat/completions`;
}

async function callJson({ baseUrl, apiKey, model, system, prompt, timeoutMs = 60000, temperature = 0.3, maxOutputTokens = 4000 }) {
  if (!String(model || '').trim()) throw new Error('尚未配置模型名称');
  if (!String(apiKey || '').trim()) throw new Error('尚未保存模型 API 凭据');
  const response = await fetch(endpoint(baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature, max_tokens: maxOutputTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: `${system}\n必须返回一个可解析的 json object。` }, { role: 'user', content: `请严格使用 json object 返回结果，不要输出 json 以外的说明。\n\n${prompt}` }] }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`模型接口 HTTP ${response.status}：${raw.slice(0, 300)}`);
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('模型接口没有返回 JSON 响应'); }
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error(payload?.error?.message || '模型接口没有返回内容');
  const usage = payload.usage || {};
  return { data: extractJson(content), usage: { inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0), outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0), totalTokens: Number(usage.total_tokens || 0) }, rawContent: content };
}

module.exports = { callJson, extractJson, endpoint };
