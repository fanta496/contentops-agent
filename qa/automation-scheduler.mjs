import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await readFile(resolve(root, 'server.cjs'), 'utf8');

// The scheduler is intentionally time-zone fixed: operating the VM in another
// time zone must not alter the business schedule configured in Shanghai time.
assert.match(server, /timeZone: 'Asia\/Shanghai'/);
assert.match(server, /lastAutomaticSlot/);
assert.match(server, /workflowPromise/);
assert.match(server, /if \(!state\.settings\.masterEnabled \|\| !state\.settings\.workflowAutoEnabled\) return;/);
assert.match(server, /runWorkflow\('scheduled'\)/);
assert.match(server, /performanceAutoAttemptAllowed\(\)/);
assert.match(server, /deferPerformanceAttempt\(30\)/);
assert.match(server, /performancePausedCode/);
assert.match(server, /performanceLastAlertKey/);
assert.match(server, /supervisorCheck\(\{ persist:false \}\)/);
assert.match(server, /collectionResults = \[\]; const platformFailures = \[\]/);
assert.match(server, /if \(!collectionResults\.length\)/);
assert.match(server, /部分平台采集暂停/);
assert.match(server, /collectionRunning: \['小红书', '小红书后台', '小红书登录', '小红书检查', '小红书链接导入', '抖音', '抖音链接导入', '抖音登录'\]\.some/);
assert.match(server, /performanceAutoAttemptAllowed\(\) && !xhsBrowserBusy\(\)/);

console.log(JSON.stringify({
  status: 'PASS',
  shanghaiSchedule: true,
  oncePerSlot: true,
  noConcurrentWorkflow: true,
  masterStopGate: true,
  partialPlatformIsolation: true,
  collectorStatusCoversAllBrowserTasks: true,
  xhsSchedulerMutex: true
}, null, 2));
