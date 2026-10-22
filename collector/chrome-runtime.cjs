const fs = require('fs');
const path = require('path');

function savedChromePath(configFile, readFile = fs.readFileSync) {
  // 启动器写配置时带 UTF-8 BOM，Node 的 readFile 不会剥掉，
  // JSON.parse 直接抛错，保存的浏览器路径就被静默丢弃了。
  try {
    const text = String(readFile(configFile, 'utf8')).replace(/^\uFEFF/, '');
    const value = JSON.parse(text)?.chromePath;
    return typeof value === 'string' ? value.trim() : '';
  }
  catch { return ''; }
}

function resolveChromeRuntime({ dataDir, env = process.env, exists = fs.existsSync, readFile = fs.readFileSync } = {}) {
  const runtimeConfigFile = path.join(dataDir || '', 'runtime-config.json');
  const configured = env.CONTENTOPS_CHROME_PATH || savedChromePath(runtimeConfigFile, readFile);
  const standardPaths = [
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    // 没装 Chrome 的机器上，Edge 同样是 Chromium，CDP 私有管道一样可用。
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  const candidates = []; const seen = new Set();
  for (const raw of [configured, ...standardPaths]) {
    const candidate = String(raw || '').trim(); const key = candidate.toLowerCase();
    if (!candidate || seen.has(key)) continue;
    seen.add(key); candidates.push(candidate);
  }
  // 启动器允许用户选任意的 Chromium 内核浏览器（本机常见的是 Edge），
  // 但这里原来写死只认 chrome.exe，选了 Edge 就等于选了个不存在的路径。
  // 现在按「Chromium 系可执行文件名」放行；CDP 协议对这几个都通用。
  const CHROMIUM_EXE = /^(chrome|msedge|brave|chromium|vivaldi|thorium)\.exe$/i;
  const found = candidates.find((candidate) => CHROMIUM_EXE.test(path.basename(candidate)) && exists(candidate));
  return {
    path: found || configured || standardPaths[0],
    configFile: runtimeConfigFile,
    found: Boolean(found),
    diagnostic: `浏览器未通过启动前检查。已检查：${candidates.join('；')}。请从启动器的首次环境检查中选择 Chrome 或 Edge，或设置 CONTENTOPS_CHROME_PATH。`
  };
}

module.exports = { savedChromePath, resolveChromeRuntime };
