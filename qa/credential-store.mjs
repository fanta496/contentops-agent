import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CredentialStore } = require('../ai/credential-store.cjs');
const dataDir = resolve(process.env.TEMP || '.', `ContentOpsAgentV2-QA-credential-${process.pid}`);
await rm(dataDir, { recursive: true, force: true });
try {
  const store = new CredentialStore(dataDir);
  store.save('local-test-secret');
  assert.equal(store.has(), true);
  assert.equal(store.read(), 'local-test-secret');
  assert.equal(store.cached, 'local-test-secret');
  assert.equal(store.read(), 'local-test-secret');
  store.clear();
  assert.equal(store.has(), false);
  assert.equal(store.cached, undefined);
  console.log(JSON.stringify({ status: 'PASS', windowsEncryptedRoundTrip: process.platform === 'win32', saveReadClear: true, cachedReads:true }, null, 2));
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
