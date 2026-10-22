'use strict';
// 状态存储：默认状态、schema 迁移、公开状态投影、进程锁。
// 这些函数从 server.cjs 原样搬来，依赖通过 env 注入，函数体未做改动。
//
// 约定：
// - 这里不持有 state 本身，避免和 server.cjs 的模块级绑定出现两份真相。
// - 新增字段要同时改 initialState() 的默认值和 normalizeState() 的迁移分支，
//   否则老版本 state.json 读进来会是 undefined。

module.exports = function createStateModule(env) {
  const { BACKUP_FILE, CREDENTIALS, DATA_DIR, DATA_FILE, DAY, FEISHU_CREDENTIALS, LOCK_FILE, ROOT, SELF_TEST, TEMP_FILE, VISION_CREDENTIALS, aiReady, analysisReady, creationJobLocks, creatorRowKey, enterpriseProductionReadiness, feishuWebhookUrl, finiteNumber, fs, hasFeishuWebhook, imageJobLocks, imageReady, localClock, localDay, nextAutomaticRunAt, noteIdFromUrl, normalizeClock, normalizeEnterpriseProfile, normalizeImageJob, normalizeImagePage, normalizeImageRules, normalizeKeywords, normalizePerformanceSampleHours, normalizePerformanceSnapshot, normalizeTextList, now, path, profileCredentialStore, profileListFrom, profileShape, promptText, safeText, uid, visionReady } = env;

function initialState() {
  return {
    version: 2, mode: 'workflow-agent', createdAt: now(), lastSavedAt: now(),
    settings: { masterEnabled: false, textProfiles: [], visionProfiles: [], imageProfiles: [], activeTextProfileId: '', activeVisionProfileId: '', activeImageProfileId: '', collectionEnabled: false, workflowAutoEnabled: false, autoMorningTime: '10:00', autoAfternoonTime: '17:00', lastAutomaticSlot: '', manualRawLimit: 50, automaticRawLimit: 200, manualFinalLimit: 10, automaticFinalLimit: 10, dailyCandidateLimit: 500, aiAnalysisLimit: 20, analysisConcurrency: 3, analysisAutoRetryCount: 2, creationAutoRetryCount: 2, generationCount: 10, scaleGenerationCount: 5, imageCount: 4, imageAspectRatio: '2:3', imageSize: '1024x1536', imageTextMode: 'free', imageStyle: 'realistic', imageMaxConcurrentJobs: 4, concurrencyProfileVersion: 1, imageQualityReviewEnabled: true, imageQualityThreshold: 78, imageAutoRetryCount: 1, imagePipelineVersion: 3, brandColors: [], mustShow: [], prohibitedElements: [], imageDailyBudget: 30, imageSpentToday: 0, imageCostPerImage: 0, dailyBudget: 30, spentToday: 0, visionDailyBudget: 30, visionSpentToday: 0, usageDate: DAY(), candidatesToday: 0, analysesToday: 0, generationsToday: 0, imageGenerationsToday: 0, xhsEnabled: true, douyinEnabled: false, xhsKeywords: ['内容运营'], douyinKeywords: ['内容运营'], xhsMaxPerKeyword: 50, xhsScrollRounds: 2, xhsDelayMs: 2500, douyinDelayMs: 3500, performanceAutoEnabled: true, performanceSampleHours: [2, 24, 72], performanceAccountBaselineNotes: 12, performanceLastAutomaticSlot: '', performanceNextAttemptAt: '', performancePausedCode: '', performanceLastAlertKey: '', performanceLastAlertAt: '', feishuWebhookConfigured: false, aiBaseUrl: '', aiModel: '', aiInputPricePerMillion: 0, aiOutputPricePerMillion: 0, aiCredentialConfigured: false, lastAiCheckAt: '', lastAiCheckOk: false, visionBaseUrl: 'https://api.tu-zi.com', visionModel: '', visionInputPricePerMillion: 0, visionOutputPricePerMillion: 0, visionMaxImages: 12, visionCredentialConfigured: false, lastVisionCheckAt: '', lastVisionCheckOk: false },
    agents: [
      { id: 'orchestrator', name: '内容总管 Agent', type: '编排', status: 'idle', detail: '等待人工启动或下一次定时任务', lastHeartbeat: now(), restarts: 0 },
    { id: 'supervisor', name: '运行监控 Agent', type: '监控', status: 'healthy', detail: '全局心跳正常', lastHeartbeat: now(), restarts: 0 },
      { id: 'xhs-collector', name: '抓取 Agent', type: '抓取', status: 'needs_login', detail: '负责抓什么与何时抓；执行工具等待小红书登录', tool: '小红书专用 Chrome 采集器', lastHeartbeat: now(), restarts: 0 },
      { id: 'douyin-collector', name: '抖音抓取 Agent', type: '抓取', status: 'needs_login', detail: '负责低频搜索公开抖音图文；等待专用浏览器登录确认', tool: '抖音专用 Chrome 采集器', lastHeartbeat: now(), restarts: 0 },
      { id: 'analyst', name: '爆款分析 Agent', type: '分析', status: 'healthy', detail: '评分队列为空', lastHeartbeat: now(), restarts: 0 },
      { id: 'creator', name: '图文生产 Agent', type: '生产', status: 'idle', detail: '等待人工选款', lastHeartbeat: now(), restarts: 0 },
      { id: 'data-agent', name: '数据循环 Agent', type: '分析', status: 'healthy', detail: '等待已发布笔记进入后台数据采样', lastHeartbeat: now(), restarts: 0 }
    ],
    candidates: [], variants: [], publications: [], materials: [], enterpriseProfiles: [], activeEnterpriseProfileId: '', workflowRuns: [],
    activity: [
      { id: uid('log'), level: 'success', title: '系统启动完成', detail: '小红书公开图文采集与抖音单链接图文导入已就绪', at: now() },
      { id: uid('log'), level: 'info', title: '等待人工登录', detail: '小红书用于低频公开图文采集；抖音用于人工提交的单条公开图文链接导入', at: now() }
    ]
  };
}

function readStateFile(file) {
  try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); return [1, 2].includes(parsed?.version) ? parsed : null; }
  catch { return null; }
}

function normalizeState(loaded) {
  const defaults = initialState();
  const next = loaded || defaults;
  const priorConcurrencyProfileVersion = Number(loaded?.settings?.concurrencyProfileVersion || 0);
  const migratedFromDemo = Boolean(loaded) && !['real-collection', 'workflow-agent'].includes(next.mode) && !SELF_TEST;
  next.settings = { ...defaults.settings, ...(next.settings || {}) };
  next.settings.textProfiles = Array.isArray(next.settings.textProfiles) ? next.settings.textProfiles : [];
  next.settings.visionProfiles = Array.isArray(next.settings.visionProfiles) ? next.settings.visionProfiles : [];
  next.settings.imageProfiles = Array.isArray(next.settings.imageProfiles) ? next.settings.imageProfiles : [];
  next.settings.activeTextProfileId = safeText(next.settings.activeTextProfileId, 120);
  next.settings.activeVisionProfileId = safeText(next.settings.activeVisionProfileId, 120);
  next.settings.activeImageProfileId = safeText(next.settings.activeImageProfileId, 120);
  next.version = 2;
  next.mode = 'workflow-agent';
  if (migratedFromDemo) Object.assign(next.settings, { collectionEnabled: false, candidatesToday: 0, analysesToday: 0 });
  next.settings.douyinEnabled = Boolean(next.settings.douyinEnabled);
  next.settings.douyinKeywords = normalizeKeywords(next.settings.douyinKeywords);
  next.settings.douyinDelayMs = finiteNumber(next.settings.douyinDelayMs, defaults.settings.douyinDelayMs, 1500, 30000);
  // v1.4.6 used fixed DevTools TCP ports. They are intentionally discarded now
  // that Chromium is controlled through a private inherited process pipe.
  delete next.settings.xhsChromePort;
  delete next.settings.douyinChromePort;
  next.settings.xhsKeywords = normalizeKeywords(next.settings.xhsKeywords);
  next.settings.performanceAutoEnabled = next.settings.performanceAutoEnabled !== false;
  next.settings.performanceSampleHours = env.normalizePerformanceSampleHours(next.settings.performanceSampleHours);
  next.settings.performanceAccountBaselineNotes = finiteNumber(next.settings.performanceAccountBaselineNotes, defaults.settings.performanceAccountBaselineNotes, 3, 100);
  next.settings.performanceLastAutomaticSlot = safeText(next.settings.performanceLastAutomaticSlot, 120);
  next.settings.performanceNextAttemptAt = safeText(next.settings.performanceNextAttemptAt, 80);
  next.settings.performancePausedCode = safeText(next.settings.performancePausedCode, 80);
  next.settings.performanceLastAlertKey = safeText(next.settings.performanceLastAlertKey, 500);
  next.settings.performanceLastAlertAt = safeText(next.settings.performanceLastAlertAt, 80);
  next.settings.autoMorningTime = normalizeClock(next.settings.autoMorningTime, '10:00');
  next.settings.autoAfternoonTime = normalizeClock(next.settings.autoAfternoonTime, '17:00');
  // 图片生产 v2：保留用户已选比例/风格，补齐可恢复任务、超时和视觉质检字段。
  next.settings.imagePipelineVersion = finiteNumber(next.settings.imagePipelineVersion, 1, 1, 99);
  if (next.settings.imagePipelineVersion < 2) {
    if (!next.settings.imageTextMode || next.settings.imageTextMode === 'no_text') next.settings.imageTextMode = 'smart_overlay';
    next.settings.imagePipelineVersion = 2;
  }
  if (next.settings.imagePipelineVersion < 3) {
    next.settings.imageTextMode = next.settings.imageTextMode === 'no_text' ? 'no_text' : next.settings.imageTextMode === 'with_text' ? 'suggest' : 'free';
    next.settings.imagePipelineVersion = 3;
  }
  next.settings.imageSingleTimeoutSeconds = finiteNumber(next.settings.imageSingleTimeoutSeconds, 180, 30, 900);
  next.settings.imageJobTimeoutMinutes = finiteNumber(next.settings.imageJobTimeoutMinutes, 15, 2, 120);
  next.settings.analysisConcurrency = finiteNumber(next.settings.analysisConcurrency, defaults.settings.analysisConcurrency, 1, 5);
  next.settings.analysisAutoRetryCount = finiteNumber(next.settings.analysisAutoRetryCount, defaults.settings.analysisAutoRetryCount, 0, 3);
  next.settings.creationAutoRetryCount = finiteNumber(next.settings.creationAutoRetryCount, defaults.settings.creationAutoRetryCount, 0, 3);
  next.settings.imageMaxConcurrentJobs = finiteNumber(next.settings.imageMaxConcurrentJobs, defaults.settings.imageMaxConcurrentJobs, 1, 8);
  if (priorConcurrencyProfileVersion < 1) { next.settings.imageMaxConcurrentJobs = 4; next.settings.concurrencyProfileVersion = 1; }
  next.settings.imageQualityReviewEnabled = next.settings.imageQualityReviewEnabled !== false;
  next.settings.imageQualityThreshold = finiteNumber(next.settings.imageQualityThreshold, 78, 50, 100);
  next.settings.imageAutoRetryCount = finiteNumber(next.settings.imageAutoRetryCount, 1, 0, 2);
  // Persist one truthful image-canvas contract. Previous releases presented a
  // 1024x1536 provider canvas as several incompatible ratios; migrate both
  // settings and historical drafts before the UI or export reads them.
  const normalizedSettingsImageRules = env.normalizeImageRules(next.settings);
  Object.assign(next.settings, {
    imageAspectRatio: normalizedSettingsImageRules.aspectRatio,
    imageSize: normalizedSettingsImageRules.size,
    imageTextMode: normalizedSettingsImageRules.textMode,
    imageStyle: normalizedSettingsImageRules.style,
    imageCount: normalizedSettingsImageRules.imageCount,
    imageSingleTimeoutSeconds: Math.round(normalizedSettingsImageRules.singleTimeoutMs / 1000),
    imageJobTimeoutMinutes: Math.round(normalizedSettingsImageRules.jobTimeoutMs / 60000),
    imageMaxConcurrentJobs: normalizedSettingsImageRules.maxConcurrentJobs,
    imageQualityReviewEnabled: normalizedSettingsImageRules.qualityReviewEnabled,
    imageQualityThreshold: normalizedSettingsImageRules.qualityThreshold,
    imageAutoRetryCount: normalizedSettingsImageRules.autoRetryCount
  });
  next.settings.aiCredentialConfigured = CREDENTIALS.has();
  next.settings.visionCredentialConfigured = VISION_CREDENTIALS.has();
  const legacyFeishuWebhook = safeText(next.settings.feishuWebhook, 2000);
  if (legacyFeishuWebhook && env.feishuWebhookUrl(legacyFeishuWebhook) && !FEISHU_CREDENTIALS.has()) {
    try { FEISHU_CREDENTIALS.save(legacyFeishuWebhook); } catch {}
  }
  delete next.settings.feishuWebhook;
  next.settings.feishuWebhookConfigured = env.hasFeishuWebhook(next.settings);
  // 旧版单连接配置平滑迁移为档案。旧 Key 只在本机 DPAPI 存储中读取并复制，绝不写入 state.json。
  for (const kind of ['text', 'vision']) {
    const list = env.profileListFrom(next.settings, kind);
    const activeKey = kind === 'vision' ? 'activeVisionProfileId' : 'activeTextProfileId';
    const baseUrl = kind === 'vision' ? next.settings.visionBaseUrl : next.settings.aiBaseUrl;
    const model = kind === 'vision' ? next.settings.visionModel : next.settings.aiModel;
    const legacyStore = kind === 'vision' ? VISION_CREDENTIALS : CREDENTIALS;
    if (!list.length && baseUrl && model && legacyStore.has()) {
      const profile = env.profileShape(kind, { name: '旧版默认连接（已迁移）', provider: '旧版配置', baseUrl, model, inputPricePerMillion: kind === 'vision' ? next.settings.visionInputPricePerMillion : next.settings.aiInputPricePerMillion, outputPricePerMillion: kind === 'vision' ? next.settings.visionOutputPricePerMillion : next.settings.aiOutputPricePerMillion });
      profile.lastTestOk = Boolean(kind === 'vision' ? next.settings.lastVisionCheckOk : next.settings.lastAiCheckOk);
      list.push(profile);
      env.profileCredentialStore(kind, profile.id).save(legacyStore.read());
      next.settings[activeKey] = profile.id;
    }
  }
  delete next.settings.aiApiKey;
  const priorAgents = Array.isArray(next.agents) ? next.agents : [];
  next.agents = defaults.agents.map((defaultAgent) => ({ ...defaultAgent, ...(priorAgents.find((item) => item.id === defaultAgent.id) || {}) }));
  const dataAgent = next.agents.find((item) => item.id === 'data-agent');
  if (dataAgent?.status === 'needs_login' && /浏览器已打开.*等待人工登录后测试数据采集/.test(dataAgent.detail || '')) Object.assign(dataAgent, { status:'idle', detail:'创作后台登录状态尚未检查；可点击“重新检查”或“测试读取后台”确认' });
  next.candidates = (Array.isArray(next.candidates) ? next.candidates : []).filter((item) => !['演示数据', '演示采集'].includes(item?.source));
  next.candidates.forEach((item) => {
    if (['queued', 'running', 'retrying'].includes(item.creationTask?.status)) item.creationTask = { ...item.creationTask, status:'retryable_failed', lastError:'后台服务重启前任务未完成；可从“一做”直接重试，不会重抓或重分析', updatedAt:now(), nextRetryAt:'' };
  });
  const candidateIds = new Set(next.candidates.map((item) => item.id));
  next.variants = (Array.isArray(next.variants) ? next.variants : []).filter((item) => candidateIds.has(item.candidateId) && item.source !== '演示数据');
  next.variants.forEach((item) => {
    item.tags = normalizeTextList(item.tags, 12, 60);
    item.imageReferencePolicy = ['auto', 'required', 'disabled'].includes(item.imageReferencePolicy) ? item.imageReferencePolicy : 'auto';
    item.imageRules = env.normalizeImageRules(item.imageRules || next.settings);
    item.imageTextMode = ['free', 'exact', 'suggest', 'no_text'].includes(item.imageTextMode) ? item.imageTextMode : item.imageRules.textMode;
    item.imagePages = Array.isArray(item.imagePages) ? item.imagePages.map((page, index) => env.normalizeImagePage(page, index)).filter(Boolean) : [];
    item.imageJob = item.imageJob ? env.normalizeImageJob(item.imageJob, item.id) : null;
    if (item.imageJob && ['queued', 'running'].includes(item.imageJob.status)) {
      Object.assign(item.imageJob, { status:'interrupted', error:'后台服务在图片任务执行期间退出；已保留完成页，可人工继续未完成页面', message:'任务因程序退出中断', finishedAt:now(), updatedAt:now(), currentPageId:'', currentPageIndex:0 });
    }
    item.imageStatus = item.imageJob?.status === 'interrupted' ? 'interrupted' : item.imagePages.length && item.imagePages.every((page) => page.asset?.file) ? 'ready' : item.imagePages.some((page) => page.asset?.file) ? 'partial' : (item.imagePages.length ? 'draft' : 'legacy');
    item.performanceSnapshots = Array.isArray(item.performanceSnapshots) ? item.performanceSnapshots : (item.metrics ? [env.normalizePerformanceSnapshot(item.metrics, 'legacy_manual')] : []);
    item.publishedAt = safeText(item.publishedAt, 80);
    item.publicationUrl = safeText(item.publicationUrl || item.metrics?.link, 2000);
    item.publicationOriginalUrl = safeText(item.publicationOriginalUrl || item.publicationUrl, 2000);
    item.publicationNoteId = safeText(item.publicationNoteId || noteIdFromUrl(item.publicationUrl), 80).toLowerCase();
    item.creatorRowKey = safeText(item.creatorRowKey, 500);
    item.creatorMatchedBy = safeText(item.creatorMatchedBy, 80);
    item.creatorMatchConfidence = finiteNumber(item.creatorMatchConfidence, 0, 0, 100);
  });
  const variantIds = new Set(next.variants.map((item) => item.id));
  next.publications = (Array.isArray(next.publications) ? next.publications : []).filter((item) => variantIds.has(item.variantId)).map((item) => ({ ...item, snapshots: Array.isArray(item.snapshots) ? item.snapshots : [], publicationUrl: safeText(item.publicationUrl || item.metrics?.link, 2000), publicationOriginalUrl:safeText(item.publicationOriginalUrl || item.publicationUrl || item.metrics?.link, 2000), publicationNoteId:safeText(item.publicationNoteId || noteIdFromUrl(item.publicationUrl || item.metrics?.link), 80).toLowerCase(), creatorRowKey:safeText(item.creatorRowKey, 500), creatorMatchedBy:safeText(item.creatorMatchedBy, 80), creatorMatchConfidence:finiteNumber(item.creatorMatchConfidence, 0, 0, 100), publishedAt: safeText(item.publishedAt, 80) }));
  next.materials = (Array.isArray(next.materials) ? next.materials : []).filter((item) => !['mat_1', 'mat_2', 'mat_3'].includes(item.id) && (!item.sourceVariantId || variantIds.has(item.sourceVariantId)));
  next.enterpriseProfiles = (Array.isArray(next.enterpriseProfiles) ? next.enterpriseProfiles : []).map(normalizeEnterpriseProfile).filter((item) => item.name);
  next.activeEnterpriseProfileId = safeText(next.activeEnterpriseProfileId, 120);
  if (!next.enterpriseProfiles.some((item) => item.id === next.activeEnterpriseProfileId && item.status === 'active')) next.activeEnterpriseProfileId = next.enterpriseProfiles.find((item) => item.status === 'active')?.id || '';
  next.workflowRuns = Array.isArray(next.workflowRuns) ? next.workflowRuns : [];
  next.workflowRuns.forEach((run) => {
    run.counts = { collected: 0, analyzed: 0, selected: 0, generated: 0, approved: 0, published: 0, performanceAnalyzed: 0, scaled: 0, ...(run.counts || {}) };
    run.candidateIds = Array.isArray(run.candidateIds) ? run.candidateIds : [];
  });
  next.activity = Array.isArray(next.activity) ? next.activity : [];
  const xhsAgent = next.agents.find((item) => item.id === 'xhs-collector');
  if (xhsAgent && /演示适配器/.test(xhsAgent.detail || '')) Object.assign(xhsAgent, { status: 'needs_login', detail: '请先打开专用浏览器并人工登录' });
  const douyinAgent = next.agents.find((item) => item.id === 'douyin-collector');
  if (douyinAgent?.status === 'disabled') Object.assign(douyinAgent, { status: 'needs_login', detail: '请先打开抖音专用浏览器并人工登录后测试采集' });
  if (douyinAgent?.status === 'ready' && /新增\s*0\s*条，更新\s*0\s*条/.test(douyinAgent.detail || '') && !next.candidates.some((item) => item.platform === '抖音')) Object.assign(douyinAgent, { status:'warning', detail:'旧版抖音零结果不能证明采集成功；请等待1.3真实页面适配验收', errorCode:'PAGE_STRUCTURE_UNVERIFIED', screenshot:'' });
  return next;
}

function applyTestOverrides(target) {
  const raw = process.env.CONTENTOPS_TEST_OVERRIDES;
  if (!SELF_TEST || !raw) return target;
  try { Object.assign(target.settings, JSON.parse(raw)); return target; }
  catch (error) { throw new Error(`测试覆盖参数无效：${error.message}`); }
}

function publicState(state, collectionLocks, workflowPromise, activeCollectors) {
  const safe = structuredClone(state);
  delete safe.settings.aiApiKey;
  delete safe.settings.feishuWebhook;
  safe.settings.aiCredentialConfigured = CREDENTIALS.has();
  safe.settings.visionCredentialConfigured = VISION_CREDENTIALS.has();
  safe.settings.feishuWebhookConfigured = env.hasFeishuWebhook(state.settings);
  for (const kind of ['text', 'vision', 'image']) {
    const activeId = kind === 'vision' ? safe.settings.activeVisionProfileId : kind === 'image' ? safe.settings.activeImageProfileId : safe.settings.activeTextProfileId;
    env.profileListFrom(safe.settings, kind).forEach((profile) => {
      profile.credentialConfigured = env.profileCredentialStore(kind, profile.id).has();
      profile.active = profile.id === activeId;
      delete profile.apiKey;
    });
  }
  safe.runtime = {
    workflowRunning: Boolean(workflowPromise), workflowCancelling: Boolean(workflowPromise && !state.settings.masterEnabled), collectionRunning: ['小红书', '小红书后台', '小红书登录', '小红书检查', '小红书链接导入', '抖音', '抖音链接导入', '抖音登录'].some((key) => collectionLocks.has(key)), aiReady: env.aiReady(), visionReady: env.visionReady(), imageReady: env.imageReady(), analysisReady: env.analysisReady(),
    activeCollectors: activeCollectors.size,
    imageJobsRunning: env.imageJobLocks().size,
    creationJobsRunning: env.creationJobLocks().size,
    nextAutomaticRunAt: state.settings.workflowAutoEnabled ? env.nextAutomaticRunAt() : null,
    targetSummary: `手动抓${state.settings.manualRawLimit}留${state.settings.manualFinalLimit} · 自动${state.settings.autoMorningTime}/${state.settings.autoAfternoonTime}抓${state.settings.automaticRawLimit}留${state.settings.automaticFinalLimit}`,
    enterpriseProductionReady: env.enterpriseProductionReadiness(state.enterpriseProfiles.find((item) => item.id === state.activeEnterpriseProfileId))?.ready === true
  };
  return safe;
}
function createLock() {
  if (SELF_TEST) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (existing?.pid && existing.pid !== process.pid) {
      try { process.kill(existing.pid, 0); throw new Error(`已有后台进程正在运行（PID ${existing.pid}）`); }
      catch (error) { if (!String(error.message).startsWith('已有后台')) fs.rmSync(LOCK_FILE, { force: true }); else throw error; }
    }
  } catch (error) {
    if (String(error.message).startsWith('已有后台')) throw error;
  }
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: now(), root: ROOT }), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing;
    try { existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch {}
    if (existing?.pid) try { process.kill(existing.pid, 0); throw new Error(`已有后台进程正在运行（PID ${existing.pid}）`); } catch (checkError) { if (String(checkError.message).startsWith('已有后台')) throw checkError; }
    fs.rmSync(LOCK_FILE, { force: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: now(), root: ROOT }), { flag: 'wx' });
  }
}

function releaseLock() { if (!SELF_TEST) try { const current = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); if (current.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true }); } catch {} }

  return {
    initialState,
    normalizeState,
    applyTestOverrides,
    readStateFile,
    publicState,
    createLock,
    releaseLock
  };
};
