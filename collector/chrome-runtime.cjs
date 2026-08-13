const fs = require('fs');
const path = require('path');

function savedChromePath(configFile, readFile = fs.readFileSync) {
  try { const value = JSON.parse(readFile(configFile, 'utf8'))?.chromePath; return typeof value === 'string' ? value.trim() : ''; }
  catch { return ''; }
}

function resolveChromeRuntime({ dataDir, env = process.env, exists = fs.existsSync, readFile = fs.readFileSync } = {}) {
  const runtimeConfigFile = path.join(dataDir || '', 'runtime-config.json');
  const configured = env.CONTENTOPS_CHROME_PATH || savedChromePath(runtimeConfigFile, readFile);
  const standardPaths = [
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];
  const candidates = []; const seen = new Set();
  for (const raw of [configured, ...standardPaths]) {
    const candidate = String(raw || '').trim(); const key = candidate.toLowerCase();
    if (!candidate || seen.has(key)) continue;
    seen.add(key); candidates.push(candidate);
  }
  const found = candidates.find((candidate) => path.basename(candidate).toLowerCase() === 'chrome.exe' && exists(candidate));
  return {
    path: found || configured || standardPaths[0],
    configFile: runtimeConfigFile,
    found: Boolean(found),
    diagnostic: `Chrome未通过启动前检查。已检查：${candidates.join('；')}。请从启动器的首次环境检查中选择 chrome.exe，或设置 CONTENTOPS_CHROME_PATH。`
  };
}

module.exports = { savedChromePath, resolveChromeRuntime };
