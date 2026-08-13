import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [html, css, js, server, douyinCollector, prompts] = await Promise.all(['index.html', 'styles.css', 'app.js', 'server.cjs', 'collector/douyin.cjs', 'ai/prompts.cjs'].map((file) => readFile(resolve(root, file), 'utf8')));
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
const codeBetween = (start, end) => {
  const from = js.indexOf(start);
  const to = js.indexOf(end, from + start.length);
  return from >= 0 && to > from ? js.slice(from, to) : '';
};
const globalActionsCode = codeBetween('function bindGlobalActions()', 'function platformAgentEnabled');
const dashboardCode = codeBetween('function renderDashboard()', 'function renderRuns()');
const openVariantCode = codeBetween('function openVariant(id)', 'function renderReview()');
const openMetricsCode = codeBetween('function openMetrics(id)', 'function renderLoop()');
const supervisorCode = codeBetween('function renderSupervisor()', 'function renderSettings()');
const collectionCode = codeBetween('async function runXhsScan', 'function openModal(id)');
const checks = {
  noDuplicateIds: duplicateIds.length === 0,
  allViewsPresent: ['dashboard', 'runs', 'radar', 'creation', 'review', 'loop', 'enterprise', 'materials', 'supervisor', 'settings'].every((view) => html.includes(`id="view-${view}"`)),
  dialogsAccessible: ['sourceModal', 'metricsModal', 'variantModal', 'enterpriseModal', 'modelProfileModal'].every((id) => new RegExp(`id="${id}"[^>]+role="dialog"[^>]+aria-modal="true"`).test(html)),
  mobileBreakpoint: css.includes('@media (max-width: 720px)'),
  offlineState: css.includes('.service-offline') && js.includes('renderConnectionState'),
  editableReview: js.includes('variantEditForm') && js.includes('updateVariant'),
  sourceEvidence: js.includes('openCandidateSource'),
  settingsDirtyProtection: js.includes('settingsDirty') && js.includes('设置尚未保存，离开后本次修改会丢失') && js.includes("window.addEventListener('beforeunload'") ,
  asyncFailureHandling: (js.match(/catch \(error\)/g) || []).length >= 10,
  pollingReduced: js.includes('}, 3000);'),
  realXhsCollection: html.includes('小红书已投入使用') && js.includes("api.runCollection('小红书')"),
  douyinCollectionConfigured: html.includes('id="douyinKeywords"') && html.includes('id="testDouyinCollection"') && js.includes("api.runCollection('抖音')") && server.includes('douyinEnabled') && server.includes('verification_required'),
  noDemoModeLabel: !html.includes('安全演示模式') && !js.includes("mode.textContent = serviceOnline ? '安全演示模式'"),
  collectorControls: ['openXhsLogin', 'checkXhsLogin', 'testXhsCollection', 'xhsKeywords', 'openDouyinLogin', 'testDouyinCollection', 'douyinKeywords', 'scanDouyinButton'].every((id) => html.includes(`id="${id}"`)),
  dualWorkflowEntry: ['startWorkflow', 'autoWorkflowToggle', 'collectOnly'].every((id) => html.includes(`id="${id}"`)) && js.includes('runWorkflow'),
  blockedWorkflowResume: html.includes('id="resumeWorkflow"') && js.includes("'/api/workflow/resume'"),
  targetVisibleOnDashboard: html.includes('本次抓什么') && html.includes('抓取 Agent') && html.includes('专用 Chrome 采集器'),
  detailEvidenceVisible: js.includes('抓取 Agent 已保存') && js.includes('item.detailStatus') && js.includes('item.imageCount'),
  realAiCredentialFlow: ['modelProfileForm', 'testModelProfile', 'addTextProfile', 'addVisionProfile'].every((id) => html.includes(`id="${id}"`)) && js.includes('saveModelProfile') && js.includes('activateModelProfile'),
  noFalseClosedLoopClaim: !html.includes('完整闭环已就位') && !js.includes("['02', '自动分析', '爆款评分完成', 'active']"),
  manualAndAutomaticQualityModes: html.includes('手动每个平台原始抓取量') && html.includes('自动每轮每个平台原始抓取量') && html.includes('上午自动运行') && html.includes('下午自动运行') && js.includes('本地去屎') && server.includes('automaticRawLimit'),
  fixedTwiceDailySchedule: server.includes('dueAutomaticSlot') && server.includes('lastAutomaticSlot') && !server.includes('lastScheduledAt')
};
checks.enterpriseLibrarySeparated = html.includes('企业素材库') && html.includes('成功素材库') && js.includes('/api/enterprise-profile/save') && server.includes('enterpriseProfiles') && server.includes('activeEnterpriseProfileId');
checks.enterpriseCreateEditProtocol = js.includes("form.dataset.mode = profile ? 'edit' : 'create'") && js.includes("data.mode = form.dataset.mode === 'edit' ? 'edit' : 'create'") && server.includes("mode === 'create' && requestedId") && server.includes("mode === 'edit' && !requestedId") && server.includes('mode === \'edit\' && !existing');
checks.enterpriseLibraryExport = html.includes('id="enterpriseExportForm"') && js.includes('openEnterpriseExport') && js.includes("'/api/enterprise-profile/export'") && server.includes('function exportEnterpriseProfile') && server.includes("format:'contentops-enterprise-library-v1'");
checks.safeCleanupControls = ['cleanupCandidates','cleanupVariants','cleanupRuns'].every((id) => html.includes(`id="${id}"`)) && js.includes('/api/candidate/delete') && js.includes('/api/variant/cleanup') && server.includes('该候选已有审核通过、已导出、已发布或成功沉淀的内容') && server.includes('该版本或其二做子版本已有审核、导出、发布或成功沉淀记录');
checks.configurableFirstAndSecondCreation = html.includes('name="generationCount"') && html.includes('name="scaleGenerationCount"') && server.includes('state.settings.scaleGenerationCount');
checks.manualMasterControl = html.includes('id="masterStart"') && html.includes('id="masterStop"') && js.includes('/api/master/start') && server.includes('masterGeneration') && server.includes('人工总控已停止');
checks.separateTextAndVisionModels = ['textProfileList', 'visionProfileList', 'activeTextProfileId', 'activeVisionProfileId'].every((token) => `${html}\n${server}`.includes(token)) && js.includes('renderModelProfiles') && server.includes('candidateSynthesisPrompt');
checks.modelProfileSafety = server.includes("'/api/model-profile/test'") && server.includes("'/api/model-profile/activate'") && server.includes('连接档案必须先测试成功才能启用') && server.includes('activeModelFingerprint');
checks.ignoreCandidateRefreshesState = js.includes("const result = await api.setCandidateStatus(item.id, 'ignored')") && js.includes('state = await api.getState(); selectedCandidateId = state.candidates.find');
checks.douyinWarningVisible = js.includes("['小红书', collector, state.settings.xhsEnabled]") && js.includes("['抖音', douyinCollector, state.settings.douyinEnabled]") && js.includes('完成${platform}安全验证');
checks.douyinStateIsHonest = js.includes("result.code === 'PAGE_STRUCTURE_CHANGED'") && dashboardCode.includes('collectorReadiness(douyinCollector, Boolean(state.settings.douyinEnabled))') && douyinCollector.includes("code:'PAGE_STRUCTURE_CHANGED'") && douyinCollector.includes('structureChanged') && server.includes("screenshot:''");
checks.platformAwareProduction = server.includes("platform: candidate.platform || '小红书'") && js.includes('${escapeHtml(item.platform)}图文预览') && server.includes('PLATFORM_PERFORMANCE_NOT_IMPLEMENTED');
checks.disabledPlatformsAreNeutral = supervisorCode.includes('const enabled = platformAgentEnabled(agent)') && supervisorCode.includes("const statusLabel = enabled ? agentStatusText(agent.status) : '未启用'") && supervisorCode.includes('不会参与抓取、自动调度或主管告警') && supervisorCode.includes('在系统设置中启用后才会参与运行');
checks.supervisorInspectionIsHonest = globalActionsCode.includes('const remainingIssues = state.agents.filter((agent) => platformAgentEnabled(agent)') && globalActionsCode.includes("toast('巡检完成，仍需处理'") && globalActionsCode.includes('所有已启用模块心跳正常') && !globalActionsCode.includes("if (!targets.length) return toast('巡检完成', '所有模块心跳正常')");
checks.combinedCollectionStaysLocked = js.includes('let collectionBatchRunning = false') && collectionCode.includes('const releaseButtons = lockButtons(collectionActionButtons())') && collectionCode.includes("runXhsScan({ manageButtons: false })") && collectionCode.includes("runDouyinScan({ manageButtons: false })") && collectionCode.includes('collectionBatchRunning = false;\n      releaseButtons();');
checks.workflowAndCollectionEntrypointsStaySynchronized = js.includes("'quickStartPrimary', 'quickStartSecondary', 'startWorkflow', 'collectOnly'") && js.includes('function syncCollectionActionButtons()') && js.includes("Boolean(state?.runtime?.workflowRunning)") && js.includes('const releaseButtons = lockButtons(collectionActionButtons());\n    toast(\'正在启动完整工作流\'');
checks.inflightStopRemainsVisible = server.includes('workflowRunning: Boolean(workflowPromise)') && server.includes('workflowCancelling: Boolean(workflowPromise && !state.settings.masterEnabled)') && js.includes("workflowCancelling ? '正在停止当前任务'") && js.includes("masterEnabled || Boolean(runtime.workflowRunning)");
checks.platformBoundariesStaySeparate = !openVariantCode.includes('抖音二次分析尚未接入') && openVariantCode.includes('一做工作台 / ${escapeHtml(item.platform)}') && openMetricsCode.includes("if (item.platform !== '小红书') return toast('抖音二次分析尚未接入'");
checks.readinessUsesOnlyEnabledPlatforms = dashboardCode.includes("].filter((item) => item.enabled)") && dashboardCode.includes('const targetReady = enabledPlatforms.length > 0') && dashboardCode.includes('const scheduleActive = masterEnabled && scheduleRequested') && dashboardCode.includes("workflowReady ? '手动阶段可运行'") && dashboardCode.includes('platformKeywordLabel(state.settings.xhsEnabled, state.settings.xhsKeywords)');
checks.automationCopyIsTruthful = html.includes('自动处理所有已启用平台的抓取与AI预选') && html.includes('24小时模式会处理所有已启用平台') && !html.includes('真实验收完成前不会开放24小时自动运行');
checks.enterpriseImageUploadGuarded = js.includes("const extensionMime = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp' }") && js.includes("catch (error) { toast('图片保存失败'") && server.includes("url.pathname === '/api/enterprise-image/upload' ? 15 * 1024 * 1024") && server.includes('imageBytesMatchMime(bytes, mime)');
checks.quickStartIsProgressive = ['quickStartGuide','quickStartSteps','quickStartPrimary','quickStartSecondary'].every((id) => html.includes(`id="${id}"`)) && js.includes('function renderQuickStartGuide()') && js.includes('先验证抓取和AI分析') && js.includes("action === 'run_workflow'");
checks.productionSetupRoutesToMissingPrerequisite = js.includes("if (!state.runtime?.enterpriseProductionReady) { navigate('enterprise'); return; }") && js.includes("if (!state.runtime?.imageReady) openModelProfile('image');");
checks.advancedSettingsHiddenByDefault = html.includes('id="toggleAdvancedSettings"') && html.includes('advanced-setting') && css.includes('.settings-form:not(.show-advanced) .advanced-setting') && js.includes('advancedSettingsVisible');
checks.hiddenSettingsCannotSilentlyBlockSubmit = html.includes('id="settingsForm" novalidate');
checks.quickLoginProbe = js.includes("'/api/collector/xhs/probe'") && server.includes("route === '/api/collector/xhs/probe'") && server.includes('withActiveCollector(createXhsCollector, (collector) => collector.probe') && html.includes('检查登录状态');
checks.explicitActionsStartMaster = js.includes('function ensureMasterForExplicitAction()') && collectionCode.includes('ensureMasterForExplicitAction()') && js.includes('人工总控已自动开启');
checks.xhsBrowserTasksSerialized = server.includes('function xhsBrowserBusy()') && ['小红书后台', '小红书登录', '小红书检查', '小红书链接导入'].every((token) => server.includes(token)) && server.includes('!xhsBrowserBusy()');
checks.variantModalLiveRefresh = js.includes('function variantModalStateSignature(item)') && js.includes('const modalWasOpen = Boolean(modalId') && js.includes('variantModalStateSignature(refreshedVariant) !== previousModalSignature') && js.includes('openVariant(modalId)') && js.includes("if (id === 'variantModal') { activeVariantModalId = null; activeVariantModalSignature = ''; }");
checks.variantReferencePolicySelectable = openVariantCode.includes('name="imageReferencePolicy"') && ['auto', 'required', 'disabled'].every((value) => openVariantCode.includes(`value="${value}"`)) && openVariantCode.includes('Generations JSON image 数组') && openVariantCode.includes('Edits multipart 文件') && openVariantCode.includes('当前任务正在通过') && openVariantCode.includes('最近完成任务实际通过') && server.includes("imageReferencePolicy:'auto'") && server.includes("effectiveInputMode = connection.imageInputMode") && html.includes('value="reference_generation_json"');
checks.imagePromptIsUserControlled = html.includes('最终以工作台中人工确认的本页生图提示词为准') && server.includes("return String(page.imagePrompt ?? '');") && server.includes("prompt = String(page.imagePrompt ?? '')") && server.includes('单页生图提示词不能超过6000个字符') && !server.includes('视觉质检指出：${page.quality.problems') && !js.includes('name="imageTextMode"') && !js.includes('本页文字模式');
checks.imageCanvasContractIsTruthful = html.includes('value="2:3"') && html.includes('1024×1536') && html.includes('value="3:2"') && !html.includes('value="3:4">3:4（小红书常用）') && server.includes("const sizes = { '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024' }") && prompts.includes('图片像素符合 size 时不得以其他平台经验比例为由扣分');
if (Object.values(checks).some((value) => !value)) {
  console.error(JSON.stringify({ status: 'FAIL', duplicateIds, checks }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: 'PASS', checks }, null, 2));
