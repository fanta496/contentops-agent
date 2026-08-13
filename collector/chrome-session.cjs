const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

// Chromium's remote-debugging-pipe protocol is NUL-delimited JSON over two
// inherited process handles. Unlike a DevTools TCP port, it has no endpoint
// that another local process can discover or connect to.
class CdpPipeConnection {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    output.on('data', (chunk) => this.handleData(chunk));
    output.once('error', (error) => this.fail(error));
    output.once('end', () => this.fail(codedError('BROWSER_CDP_PIPE_CLOSED', 'Chrome私有调试管道已关闭')));
    output.once('close', () => this.fail(codedError('BROWSER_CDP_PIPE_CLOSED', 'Chrome私有调试管道已关闭')));
    input.once('error', (error) => this.fail(error));
  }

  isOpen() {
    return !this.closed && this.input && !this.input.destroyed && this.output && !this.output.destroyed;
  }

  handleData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    let delimiter = this.buffer.indexOf(0);
    while (delimiter >= 0) {
      const raw = this.buffer.subarray(0, delimiter);
      this.buffer = this.buffer.subarray(delimiter + 1);
      delimiter = this.buffer.indexOf(0);
      if (!raw.length) continue;
      let message;
      try { message = JSON.parse(raw.toString('utf8')); }
      catch (error) {
        this.fail(codedError('BROWSER_CDP_PIPE_PROTOCOL_ERROR', 'Chrome私有调试管道返回了无效数据', error));
        return;
      }
      if (Object.prototype.hasOwnProperty.call(message, 'id') && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || 'Chrome调试命令失败'));
        else pending.resolve(message.result || {});
        continue;
      }
      if (!message.method) continue;
      const callbacks = this.listeners.get(String(message.sessionId || '')) || [];
      callbacks.forEach((callback) => callback(message));
    }
  }

  command(method, params = {}, sessionId = '', timeoutMs = 15000) {
    if (!this.isOpen()) return Promise.reject(codedError('BROWSER_CDP_PIPE_CLOSED', 'Chrome私有调试管道不可用'));
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(codedError('BROWSER_CDP_COMMAND_TIMEOUT', `${method} 执行超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.input.write(Buffer.concat([Buffer.from(JSON.stringify(message), 'utf8'), Buffer.from([0])])); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  subscribe(sessionId, callback) {
    const key = String(sessionId || '');
    const callbacks = this.listeners.get(key) || [];
    callbacks.push(callback);
    this.listeners.set(key, callbacks);
    return () => this.listeners.set(key, (this.listeners.get(key) || []).filter((item) => item !== callback));
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    const failure = error instanceof Error ? error : new Error(String(error || 'Chrome私有调试管道已关闭'));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
    this.listeners.clear();
  }

  close() {
    if (this.closed) return;
    this.fail(codedError('BROWSER_CDP_PIPE_CLOSED', 'Chrome私有调试管道已关闭'));
    try { this.input.end(); } catch {}
  }
}

class CdpClient {
  constructor(connection, sessionId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.listeners = new Map();
    this.closed = false;
    this.unsubscribe = connection.subscribe(sessionId, (message) => {
      const callbacks = this.listeners.get(message.method) || [];
      callbacks.forEach((callback) => callback(message.params));
    });
  }

  command(method, params = {}, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(codedError('BROWSER_CDP_CLIENT_CLOSED', 'Chrome页面连接已关闭'));
    return this.connection.command(method, params, this.sessionId, timeoutMs);
  }

  on(method, callback) {
    const callbacks = this.listeners.get(method) || [];
    callbacks.push(callback);
    this.listeners.set(method, callbacks);
    return () => this.listeners.set(method, (this.listeners.get(method) || []).filter((item) => item !== callback));
  }

  async evaluate(expression, timeoutMs = 15000) {
    const result = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行失败');
    return result.result?.value;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.connection.command('Target.detachFromTarget', { sessionId: this.sessionId }, '', 3000).catch(() => {});
  }
}

class PipeBrowser {
  constructor({ chromePath, chromeDiagnostic, profileDir, headless, spawnImpl, exists }) {
    this.chromePath = chromePath;
    this.chromeDiagnostic = chromeDiagnostic;
    this.profileDir = profileDir;
    this.headless = headless;
    this.spawnImpl = spawnImpl;
    this.exists = exists;
    this.child = null;
    this.connection = null;
    this.starting = null;
  }

  isRunning() {
    return Boolean(this.child && this.connection?.isOpen());
  }

  async ensureStarted(url = 'about:blank') {
    if (this.isRunning()) return { started: false, pid: this.child.pid };
    if (this.starting) return this.starting;
    this.starting = this.start(url);
    try { return await this.starting; }
    finally { this.starting = null; }
  }

  async start(url) {
    if (!this.exists(this.chromePath)) throw new Error(this.chromeDiagnostic || `没有找到Chrome：${this.chromePath}`);
    fs.mkdirSync(this.profileDir, { recursive: true });
    const args = [
      '--remote-debugging-pipe',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      '--disable-popup-blocking'
    ];
    if (this.headless) args.push('--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage');
    args.push(url);
    const child = this.spawnImpl(this.chromePath, args, {
      detached: false,
      // Chromium reserves fd 3 for commands and fd 4 for responses.
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      windowsHide: this.headless
    });
    const input = child?.stdio?.[3];
    const output = child?.stdio?.[4];
    if (!child || !input || !output) throw codedError('BROWSER_CDP_PIPE_UNAVAILABLE', 'Chrome没有提供私有调试管道');
    const connection = new CdpPipeConnection(input, output);
    this.child = child;
    this.connection = connection;
    child.once('error', (error) => {
      if (this.child === child) connection.fail(error);
    });
    child.once('exit', () => {
      if (this.child !== child) return;
      connection.fail(codedError('BROWSER_CDP_PIPE_CLOSED', 'Chrome私有调试管道已关闭'));
      this.child = null;
      this.connection = null;
    });
    let lastError = null;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        await connection.command('Browser.getVersion', {}, '', 600);
        return { started: true, pid: child.pid };
      } catch (error) {
        lastError = error;
        if (!connection.isOpen()) break;
        await wait(200);
      }
    }
    this.stop();
    throw codedError('BROWSER_CDP_PIPE_UNAVAILABLE', `Chrome启动失败或私有调试管道不可用：${lastError?.message || '未知错误'}`, lastError);
  }

  activeConnection() {
    if (!this.isRunning()) throw codedError('BROWSER_CDP_PIPE_CLOSED', 'Chrome私有调试管道不可用');
    return this.connection;
  }

  async listTabs() {
    const result = await this.activeConnection().command('Target.getTargets', {}, '', 3000);
    return (result.targetInfos || []).map((target) => ({ id: target.targetId, type: target.type, url: target.url, title: target.title, parentId: target.openerId || '' }));
  }

  async createTab(url) {
    const result = await this.activeConnection().command('Target.createTarget', { url: String(url || 'about:blank') }, '', 5000);
    return { id: result.targetId, type: 'page', url: String(url || 'about:blank') };
  }

  async closeTab(tabId) {
    if (!tabId || !this.isRunning()) return;
    try { await this.connection.command('Target.closeTarget', { targetId: tabId }, '', 3000); } catch {}
  }

  async connect(tab, clientFactory) {
    const targetId = String(tab?.id || tab?.targetId || '');
    if (!targetId) throw new Error('Chrome页面没有调试目标');
    const connection = this.activeConnection();
    const attached = await connection.command('Target.attachToTarget', { targetId, flatten: true }, '', 10000);
    if (!attached.sessionId) throw new Error('Chrome页面没有私有调试会话');
    const client = clientFactory(connection, attached.sessionId);
    try {
      // 采集器只主动调用 Page.navigate / Runtime.evaluate / captureScreenshot，
      // 不依赖 Page.enable 或 Runtime.enable 推送的事件。把 enable 当作硬门槛会让
      // 某些长时间运行的 SPA target 永久卡在握手阶段，因此仅做一次轻量读探针。
      await client.command('Runtime.evaluate', { expression: '1 + 1', returnByValue: true }, 8000);
      return client;
    } catch (error) {
      client.close();
      throw codedError('BROWSER_TARGET_UNRESPONSIVE', `Chrome页面无响应：${error.message}`, error);
    }
  }

  stop() {
    const child = this.child;
    const connection = this.connection;
    this.child = null;
    this.connection = null;
    connection?.close();
    if (!child) return;
    // Only terminate the process tree started by this private pipe session.
    try {
      if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 });
      else child.kill?.();
    } catch { try { child.kill?.(); } catch {} }
  }
}

const PIPE_BROWSERS = new Map();

class ChromeSession {
  constructor({ chromePath, chromeDiagnostic = '', profileDir, headless = false, clientFactory, spawnImpl = spawn, exists = fs.existsSync }) {
    this.chromePath = chromePath;
    this.chromeDiagnostic = chromeDiagnostic;
    this.profileDir = profileDir;
    this.headless = headless;
    this.clientFactory = clientFactory || ((connection, sessionId) => new CdpClient(connection, sessionId));
    this.spawnImpl = spawnImpl;
    this.exists = exists;
    this.sessionKey = `${path.resolve(chromePath || '').toLowerCase()}|${path.resolve(profileDir || '').toLowerCase()}`;
  }

  browser() {
    let browser = PIPE_BROWSERS.get(this.sessionKey);
    if (!browser) {
      browser = new PipeBrowser({ chromePath: this.chromePath, chromeDiagnostic: this.chromeDiagnostic, profileDir: this.profileDir, headless: this.headless, spawnImpl: this.spawnImpl, exists: this.exists });
      PIPE_BROWSERS.set(this.sessionKey, browser);
    }
    return browser;
  }

  async isRunning() { return this.browser().isRunning(); }

  async ensureStarted(url = 'about:blank') { return this.browser().ensureStarted(url); }

  async listTabs() { return this.browser().listTabs(); }

  async createTab(url) { return this.browser().createTab(url); }

  async closeTab(tabId) { return this.browser().closeTab(tabId); }

  async getOrCreateTab(url, hostHint) {
    const tabs = await this.listTabs();
    const existing = tabs.find((tab) => tab.type === 'page' && (!hostHint || String(tab.url).includes(hostHint)));
    return existing || this.createTab(url);
  }

  async connect(tab) { return this.browser().connect(tab, this.clientFactory); }

  stopOwnedChromeProcesses() { this.stop(); }

  async restartOwnedBrowser(url) {
    this.stop();
    await wait(600);
    await this.ensureStarted(url);
  }

  // 三级恢复：复用现有页 -> 新建页 -> 仅重启本产品专用 Chrome。
  // 最后一层同时覆盖浏览器由之前任务启动、但当前目标无响应的情况。
  async openClient(url, hostHint) {
    let lastError = null;
    const attempts = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let tab;
      try {
        if (attempt === 2) await this.restartOwnedBrowser(url);
        else await this.ensureStarted(url);
        tab = attempt === 0 ? await this.getOrCreateTab(url, hostHint) : await this.createTab(url);
        return { tab, client: await this.connect(tab), recovered: attempt > 0, recoveryStage: attempt === 0 ? 'none' : attempt === 1 ? 'new_tab' : 'browser_restart' };
      } catch (error) {
        lastError = error;
        attempts.push({ stage: attempt === 0 ? 'existing_tab' : attempt === 1 ? 'new_tab' : 'browser_restart', code: error.code || '', message: error.message });
        if (tab?.id) await this.closeTab(tab.id);
      }
    }
    const failure = codedError('BROWSER_SESSION_RECOVERY_FAILED', `小红书专用浏览器连续恢复失败：${lastError?.message || '未知错误'}`, lastError);
    failure.attempts = attempts;
    throw failure;
  }

  async navigate(client, url, waitMs = 2500) {
    await client.command('Page.navigate', { url }, 20000);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const ready = await client.evaluate('document.readyState');
      if (ready === 'complete' || ready === 'interactive') break;
      await wait(250);
    }
    await wait(waitMs);
  }

  async screenshot(client, outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const result = await client.command('Page.captureScreenshot', { format: 'png', fromSurface: true }, 15000);
    fs.writeFileSync(outputPath, Buffer.from(result.data, 'base64'));
    return outputPath;
  }

  stop() {
    const browser = PIPE_BROWSERS.get(this.sessionKey);
    if (!browser) return;
    PIPE_BROWSERS.delete(this.sessionKey);
    browser.stop();
  }

  static shutdownAll() {
    for (const browser of PIPE_BROWSERS.values()) browser.stop();
    PIPE_BROWSERS.clear();
  }
}

module.exports = { ChromeSession, CdpClient, CdpPipeConnection, wait, codedError };
