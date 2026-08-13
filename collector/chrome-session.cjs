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

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open(timeoutMs = 10000) {
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.socket.removeEventListener('open', onOpen); this.socket.removeEventListener('error', onError); };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => {
        cleanup();
        try { this.socket.close(); } catch {}
        reject(codedError('BROWSER_CDP_CONNECT_TIMEOUT', '连接Chrome页面超时'));
      }, timeoutMs);
      this.socket.addEventListener('open', onOpen, { once: true });
      this.socket.addEventListener('error', onError, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const task = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(task.timer);
        if (message.error) task.reject(new Error(message.error.message));
        else task.resolve(message.result);
        return;
      }
      const callbacks = this.listeners.get(message.method) || [];
      callbacks.forEach((callback) => callback(message.params));
    });
    this.socket.addEventListener('close', () => {
      for (const task of this.pending.values()) {
        clearTimeout(task.timer);
        task.reject(new Error('Chrome页面连接已关闭'));
      }
      this.pending.clear();
    });
    return this;
  }

  command(method, params = {}, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(codedError('BROWSER_CDP_COMMAND_TIMEOUT', `${method} 执行超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  on(method, callback) {
    const callbacks = this.listeners.get(method) || [];
    callbacks.push(callback);
    this.listeners.set(method, callbacks);
    return () => this.listeners.set(method, callbacks.filter((item) => item !== callback));
  }

  async evaluate(expression, timeoutMs = 15000) {
    const result = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行失败');
    return result.result?.value;
  }

  close() {
    try { this.socket.close(); } catch {}
  }
}

class ChromeSession {
  constructor({ chromePath, chromeDiagnostic = '', profileDir, port, headless = false, clientFactory }) {
    this.chromePath = chromePath;
    this.chromeDiagnostic = chromeDiagnostic;
    this.profileDir = profileDir;
    this.port = port;
    this.headless = headless;
    this.pid = null;
    this.clientFactory = clientFactory || ((url) => new CdpClient(url));
  }

  endpoint(pathname = '/json/version') {
    return `http://127.0.0.1:${this.port}${pathname}`;
  }

  async isRunning() {
    try {
      const response = await fetch(this.endpoint(), { signal: AbortSignal.timeout(800) });
      return response.ok;
    } catch { return false; }
  }

  async ensureStarted(url = 'about:blank') {
    if (await this.isRunning()) return { started: false };
    if (!fs.existsSync(this.chromePath)) throw new Error(this.chromeDiagnostic || `没有找到Chrome：${this.chromePath}`);
    fs.mkdirSync(this.profileDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${this.port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      '--disable-popup-blocking'
    ];
    if (this.headless) args.push('--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage');
    args.push(url);
    const child = spawn(this.chromePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: this.headless
    });
    this.pid = child.pid;
    child.unref();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await this.isRunning()) return { started: true, pid: child.pid };
      await wait(200);
    }
    throw new Error('Chrome启动失败或调试端口不可用');
  }

  async listTabs() {
    const response = await fetch(this.endpoint('/json/list'), { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`读取Chrome页面失败：HTTP ${response.status}`);
    return response.json();
  }

  async createTab(url) {
    const response = await fetch(this.endpoint(`/json/new?${encodeURIComponent(url)}`), { method: 'PUT', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`创建Chrome页面失败：HTTP ${response.status}`);
    return response.json();
  }

  async closeTab(tabId) {
    if (!tabId) return;
    try { await fetch(this.endpoint(`/json/close/${encodeURIComponent(tabId)}`), { signal:AbortSignal.timeout(3000) }); } catch {}
  }

  async getOrCreateTab(url, hostHint) {
    const tabs = await this.listTabs();
    const existing = tabs.find((tab) => tab.type === 'page' && (!hostHint || String(tab.url).includes(hostHint)));
    return existing || this.createTab(url);
  }

  async connect(tab) {
    if (!tab?.webSocketDebuggerUrl) throw new Error('Chrome页面没有调试连接地址');
    const client = await this.clientFactory(tab.webSocketDebuggerUrl).open();
    try {
      // 采集器只主动调用 Page.navigate / Runtime.evaluate / captureScreenshot，
      // 不依赖 Page.enable 或 Runtime.enable 推送的事件。把 enable 当作硬门槛会让
      // 某些长时间运行的 SPA target 永久卡在握手阶段，因此仅做一次轻量读探针。
      await client.command('Runtime.evaluate', { expression:'1 + 1', returnByValue:true }, 8000);
      return client;
    } catch (error) { client.close(); throw codedError('BROWSER_TARGET_UNRESPONSIVE', `Chrome页面无响应：${error.message}`, error); }
  }

  stopOwnedChromeProcesses() {
    const profile = path.resolve(this.profileDir).replace(/'/g, "''");
    const portToken = `--remote-debugging-port=${this.port}`.replace(/'/g, "''");
    const script = `$profile='${profile}';$portToken='${portToken}';Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" -ErrorAction SilentlyContinue|Where-Object{$_.CommandLine -and $_.CommandLine.IndexOf($profile,[System.StringComparison]::OrdinalIgnoreCase)-ge 0 -and $_.CommandLine.IndexOf($portToken,[System.StringComparison]::OrdinalIgnoreCase)-ge 0}|ForEach-Object{Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    try { spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide:true, stdio:'ignore', timeout:10000 }); } catch {}
    this.pid = null;
  }

  async restartOwnedBrowser(url) {
    this.stop();
    this.stopOwnedChromeProcesses();
    await wait(600);
    await this.ensureStarted(url);
  }

  // 三级恢复：复用现有页 -> 新建页 -> 仅重启本产品专用 Chrome。
  // 最后一层同时覆盖“Chrome 是上一次服务启动的，因此当前 session 没有 pid”的情况。
  async openClient(url, hostHint) {
    let lastError = null;
    const attempts = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let tab;
      try {
        if (attempt === 2) await this.restartOwnedBrowser(url);
        else await this.ensureStarted(url);
        tab = attempt === 0 ? await this.getOrCreateTab(url, hostHint) : await this.createTab(url);
        return { tab, client:await this.connect(tab), recovered:attempt > 0, recoveryStage:attempt === 0 ? 'none' : attempt === 1 ? 'new_tab' : 'browser_restart' };
      } catch (error) {
        lastError = error;
        attempts.push({ stage:attempt === 0 ? 'existing_tab' : attempt === 1 ? 'new_tab' : 'browser_restart', code:error.code || '', message:error.message });
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
    if (!this.pid) return;
    // Chrome 会派生渲染、GPU 等子进程。只杀主进程会让测试资料目录被锁住，
    // 也可能在服务退出后留下一个仍占调试端口的采集器；仅终止本实例自己启动的 PID 树。
    try { spawnSync('taskkill.exe', ['/PID', String(this.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 }); }
    catch { try { process.kill(this.pid); } catch {} }
    this.pid = null;
  }
}

module.exports = { ChromeSession, CdpClient, wait, codedError };
