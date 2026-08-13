import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { callJson } = require('../ai/openai-compatible.cjs');

let requestBody = null;
const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk; requestBody = JSON.parse(raw);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"score":91,"summary":"高潜方法型内容"}\n```' } }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }));
});
await new Promise((done) => server.listen(19998, '127.0.0.1', done));
try {
  const result = await callJson({ baseUrl: 'http://127.0.0.1:19998/v1', apiKey: 'local-test-key', model: 'local-test-model', system: 'test', prompt: 'test', temperature: 0 });
  if (result.data.score !== 91 || result.usage.totalTokens !== 150 || requestBody.model !== 'local-test-model' || !String(requestBody.response_format?.type).includes('json')) throw new Error('AI适配器结构化调用异常');
  console.log(JSON.stringify({ status: 'PASS', structuredOutput: true, usage: result.usage, endpoint: '/v1/chat/completions' }, null, 2));
} finally { server.close(); }
