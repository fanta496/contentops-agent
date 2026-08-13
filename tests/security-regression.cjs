const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { ChromeSession } = require('../collector/chrome-session.cjs');

function testNoLegacyCdpPortsInSource() {
  const root = path.resolve(__dirname, '..');
  const sources = [
    'server.cjs',
    'collector/chrome-session.cjs',
    'collector/xiaohongshu.cjs',
    'collector/douyin.cjs',
    'collector/xhs-creator-center.cjs'
  ];
  const legacy = /--remote-debugging-(?:port|address)|CONTENTOPS_(?:XHS|DOUYIN)_CHROME_PORT/;
  for (const relative of sources) {
    assert.equal(legacy.test(fs.readFileSync(path.join(root, relative), 'utf8')), false, `${relative} must not restore a CDP TCP endpoint`);
  }
}

function pipeBrowserFixture() {
  const child = new EventEmitter();
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = Buffer.alloc(0);
  let killed = false;
  child.stdio = [null, null, null, input, output];
  child.kill = () => { killed = true; child.emit('exit', null, 'SIGTERM'); return true; };
  input.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let delimiter = buffer.indexOf(0);
    while (delimiter >= 0) {
      const raw = buffer.subarray(0, delimiter);
      buffer = buffer.subarray(delimiter + 1);
      delimiter = buffer.indexOf(0);
      if (!raw.length) continue;
      const request = JSON.parse(raw.toString('utf8'));
      let result = {};
      if (request.method === 'Browser.getVersion') result = { product: 'test-browser' };
      else if (request.method === 'Target.getTargets') result = { targetInfos: [{ targetId: 'page-1', type: 'page', url: 'about:blank' }] };
      else if (request.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      else if (request.method === 'Runtime.evaluate') result = { result: { value: request.params.expression === '6 * 7' ? 42 : 2 } };
      output.write(Buffer.concat([Buffer.from(JSON.stringify({ id: request.id, result }), 'utf8'), Buffer.from([0])]));
    }
  });
  return { child, wasKilled: () => killed };
}

async function testPrivateCdpPipe() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ContentOpsAgentV2-QA-pipe-regression-'));
  const fixture = pipeBrowserFixture();
  let spawnArgs = [];
  let spawnOptions = null;
  const session = new ChromeSession({
    chromePath: path.join(profile, 'chrome.exe'),
    profileDir: profile,
    headless: true,
    exists: () => true,
    spawnImpl: (_command, args, options) => {
      spawnArgs = args;
      spawnOptions = options;
      return fixture.child;
    }
  });
  let client;
  try {
    const started = await session.ensureStarted('about:blank');
    assert.equal(started.started, true);
    assert.ok(spawnArgs.includes('--remote-debugging-pipe'));
    assert.equal(spawnArgs.some((value) => String(value).startsWith('--remote-debugging-port=')), false);
    assert.equal(spawnArgs.includes('--remote-debugging-address=127.0.0.1'), false);
    assert.deepEqual(spawnOptions.stdio, ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']);
    const tabs = await session.listTabs();
    client = await session.connect(tabs[0]);
    assert.equal(await client.evaluate('6 * 7'), 42);
  } finally {
    client?.close();
    session.stop();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  assert.equal(fixture.wasKilled(), true);
}

function testNonWindowsCredentialRejection() {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ContentOpsAgentV2-QA-credential-regression-'));
  const modulePath = require.resolve('../ai/credential-store.cjs');
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    delete require.cache[modulePath];
    const { CredentialStore } = require('../ai/credential-store.cjs');
    assert.throws(() => new CredentialStore(temporary), /Windows DPAPI/);
    assert.equal(fs.existsSync(path.join(temporary, 'secrets')), false);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    delete require.cache[modulePath];
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

(async () => {
  testNoLegacyCdpPortsInSource();
  await testPrivateCdpPipe();
  testNonWindowsCredentialRejection();
  process.stdout.write(JSON.stringify({ ok: true, privateCdpPipe: true, nonWindowsPlaintextFallback: false }) + '\n');
})().catch((error) => {
  process.stderr.write(`SECURITY_REGRESSION_FAILED: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
