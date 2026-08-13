import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ChromeSession } = require('../collector/chrome-session.cjs');

const commandCalls = [];
const lightweightClient = { async open() { return this; }, async command(method) { commandCalls.push(method); return { result:{ value:2 } }; }, close() {} };
const handshakeSession = new ChromeSession({ chromePath:'unused', profileDir:'unused', port:1, headless:true, clientFactory:() => lightweightClient });
await handshakeSession.connect({ webSocketDebuggerUrl:'ws://healthy' });
assert.deepEqual(commandCalls, ['Runtime.evaluate']);

const session = new ChromeSession({ chromePath:'unused', profileDir:'unused', port:1, headless:true });
let connected = 0; let closed = 0; let created = 0;
session.ensureStarted = async () => ({ started:false });
session.getOrCreateTab = async () => ({ id:'stale', webSocketDebuggerUrl:'ws://stale' });
session.createTab = async () => ({ id:'fresh', webSocketDebuggerUrl:'ws://fresh' });
session.closeTab = async () => { closed += 1; };
session.connect = async (tab) => { connected += 1; if (tab.id === 'stale') throw new Error('Page.enable 执行超时'); return { id:'client', close() {} }; };
const result = await session.openClient('https://example.test/', 'example.test');
assert.equal(result.recovered, true);
assert.equal(result.tab.id, 'fresh');
assert.equal(connected, 2);
assert.equal(closed, 1);

const restartSession = new ChromeSession({ chromePath:'unused', profileDir:'unused', port:2, headless:true });
let restartConnections = 0; let browserRestarts = 0; let restartCreates = 0;
restartSession.ensureStarted = async () => ({ started:false });
restartSession.getOrCreateTab = async () => ({ id:'old', webSocketDebuggerUrl:'ws://old' });
restartSession.createTab = async () => ({ id:`fresh-${++restartCreates}`, webSocketDebuggerUrl:`ws://fresh-${restartCreates}` });
restartSession.closeTab = async () => {};
restartSession.restartOwnedBrowser = async () => { browserRestarts += 1; };
restartSession.connect = async (tab) => { restartConnections += 1; if (restartConnections < 3) throw new Error(`${tab.id} 无响应`); return { close() {} }; };
const restarted = await restartSession.openClient('https://example.test/', 'example.test');
assert.equal(restarted.recoveryStage, 'browser_restart');
assert.equal(browserRestarts, 1);
assert.equal(restartConnections, 3);

const missingChrome = new ChromeSession({ chromePath:'Z:/not-found/chrome.exe', chromeDiagnostic:'环境检查：Chrome 不可用；已检查保存路径与常见安装目录。', profileDir:'unused', port:3, headless:true });
await assert.rejects(() => missingChrome.ensureStarted(), /环境检查：Chrome 不可用/);

console.log(JSON.stringify({ status:'PASS', unnecessaryPageEnableRemoved:true, lightweightHandshake:commandCalls, staleTargetRecovered:true, staleTabClosed:closed, connections:connected, fullBrowserRestartRecovered:true, browserRestarts, missingChromeGetsActionableDiagnostic:true }, null, 2));
