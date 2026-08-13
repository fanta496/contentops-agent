import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [launcher, starter, server, chromeRuntime] = await Promise.all([
  readFile(resolve(root, 'launcher/ContentOpsLauncher.cs'), 'utf8'),
  readFile(resolve(root, 'start-agent.ps1'), 'utf8'),
  readFile(resolve(root, 'server.cjs'), 'utf8'),
  readFile(resolve(root, 'collector/chrome-runtime.cjs'), 'utf8')
]);
const checks = {
  launcherPersistsDiscoveredChrome: launcher.includes('ResolveChromePath') && launcher.includes('runtime-config.json') && launcher.includes('SaveChromePath'),
  launcherChecksRegistryAndInstallLocations: launcher.includes('App Paths\\chrome.exe') && launcher.includes('ProgramFilesX86') && launcher.includes('LocalApplicationData'),
  launcherAllowsExplicitSelection: launcher.includes('OpenFileDialog') && launcher.includes('请选择 chrome.exe') && launcher.includes('不是可用的 chrome.exe'),
  launcherPassesResolvedPathToBackend: launcher.includes('CONTENTOPS_CHROME_PATH') && launcher.includes('CONTENTOPS_DATA_DIR') && launcher.includes('Path.GetFileName(candidate).Equals("chrome.exe"'),
  backendReadsSameConfig: server.includes("resolveChromeRuntime({ dataDir:DATA_DIR })") && chromeRuntime.includes("'runtime-config.json'") && chromeRuntime.includes('savedChromePath'),
  collectorFailureIsActionable: server.includes('CHROME_RUNTIME.diagnostic') && chromeRuntime.includes('Chrome未通过启动前检查'),
  starterBoundedPackageSearchAndDiagnostic: starter.includes('$levelOne') && starter.includes('$levelTwo') && !/Get-ChildItem[^\r\n]*-Depth\s+\d+/i.test(starter) && starter.includes('没有找到完整应用包') && starter.includes('多个完整应用包')
};
if (Object.values(checks).some((value) => !value)) throw new Error(JSON.stringify(checks));
console.log(JSON.stringify({ status:'PASS', checks }, null, 2));
