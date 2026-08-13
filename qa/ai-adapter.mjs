import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractJson, endpoint, callJson } = require('../ai/openai-compatible.cjs');

assert.deepEqual(extractJson('{"ok":true}'), { ok: true });
assert.deepEqual(extractJson('```json\n{"score":88}\n```'), { score: 88 });
assert.deepEqual(extractJson('说明文字 {"decision":"scale"} 结束'), { decision: 'scale' });
assert.equal(endpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
assert.equal(endpoint('http://127.0.0.1:9000/v1'), 'http://127.0.0.1:9000/v1/chat/completions');
assert.throws(() => endpoint('http://example.com/v1'), /HTTPS/);
assert.match(String(callJson), /maxOutputTokens/);
assert.match(String(callJson), /max_tokens/);

console.log(JSON.stringify({ status: 'PASS', jsonExtraction: true, endpointValidation: true }, null, 2));
