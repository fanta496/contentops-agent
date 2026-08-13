const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { XiaohongshuCollector } = require('./collector/xiaohongshu.cjs');
const { DouyinCollector } = require('./collector/douyin.cjs');
const { XiaohongshuCreatorCenterCollector, numberFromText, percentFromText, secondsFromText, normalizeTitle, noteIdFromUrl } = require('./collector/xhs-creator-center.cjs');
const { resolveChromeRuntime } = require('./collector/chrome-runtime.cjs');
const { callJson } = require('./ai/openai-compatible.cjs');
const { callVisionJson, VISION_TEST_IMAGE_URL } = require('./ai/vision-compatible.cjs');
const { generateImage } = require('./ai/image-compatible.cjs');
const { SYSTEM, candidateTextAnalysisPrompt, candidateVisionPrompt, candidateSynthesisPrompt, generationPrompt, imageQualityPrompt, performancePrompt } = require('./ai/prompts.cjs');
const { CredentialStore } = require('./ai/credential-store.cjs');

const HOST = '127.0.0.1';
const APP_ID = 'contentops-agent-v2';
const ROOT = __dirname;
const SELF_TEST = process.argv.includes('--self-test');
const PORT = Number(process.env.CONTENTOPS_PORT || (SELF_TEST ? 17832 : 17851));
const SELF_TEST_DATA_DIR = path.join(os.tmpdir(), 'ContentOpsAgentV2-QA', `self-test-${process.pid}`);
const DATA_DIR = process.env.CONTENTOPS_DATA_DIR || (SELF_TEST ? SELF_TEST_DATA_DIR : path.join(process.env.APPDATA || os.homedir(), 'ContentOpsAgentV2'));
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_FILE = path.join(DATA_DIR, 'state.backup.json');
const TEMP_FILE = path.join(DATA_DIR, 'state.tmp.json');
const LOCK_FILE = path.join(DATA_DIR, 'server.lock.json');
const COLLECTOR_PROFILE_DIR = process.env.CONTENTOPS_XHS_PROFILE_DIR || path.join(DATA_DIR, 'browser-profiles', 'xiaohongshu');
const DOUYIN_COLLECTOR_PROFILE_DIR = process.env.CONTENTOPS_DOUYIN_PROFILE_DIR || path.join(DATA_DIR, 'browser-profiles', 'douyin');
const COLLECTOR_ERROR_DIR = process.env.CONTENTOPS_COLLECTOR_ERROR_DIR || path.join(DATA_DIR, 'collector-errors');
const CHROME_RUNTIME = resolveChromeRuntime({ dataDir:DATA_DIR });
const CHROME_PATH = CHROME_RUNTIME.path;
const CREDENTIALS = new CredentialStore(DATA_DIR);
const VISION_CREDENTIALS = new CredentialStore(DATA_DIR, 'vision-key.dpapi');
const IMAGE_REFERENCE_TEST_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEILV/5zOFDzdoQCepz6aeExAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELi3cqoDfaKuZM4AAAAASUVORK5CYII=', 'base64');
const PROFILE_DIR = path.join(DATA_DIR, 'profiles');
// normalizeState() runs during cold start and may inspect persisted model profiles.
// Initialize the per-profile credential cache before loading any state.
const PROFILE_CREDENTIAL_STORES = new Map();
const GENERATED_IMAGE_DIR = path.join(DATA_DIR, 'generated-images');
// 企业原图是本机业务资产，和模型凭据、运行状态分开保存。图片内容不会写入 state.json，
// 只保存不可猜测的元数据和相对文件名，避免状态文件膨胀及意外泄露。
const ENTERPRISE_ASSET_DIR = path.join(DATA_DIR, 'enterprise-assets');
// Only isolated QA runs may bypass enterprise-image requirements.  A normal
// launch cannot opt out merely by setting one environment variable.
const TEST_ENTERPRISE_IMAGE_BYPASS = process.env.CONTENTOPS_TEST_ALLOW_UNVERIFIED === '1' && process.env.CONTENTOPS_TEST_BYPASS_ENTERPRISE_IMAGE_GATE === '1' && [path.basename(DATA_DIR), path.basename(path.dirname(DATA_DIR))].some((name) => name.startsWith('ContentOpsAgentV2-QA-'));
const DAY = () => localDay();

const now = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function cleanupSelfTestData() { if (SELF_TEST && !process.env.CONTENTOPS_DATA_DIR) try { fs.rmSync(SELF_TEST_DATA_DIR, { recursive: true, force: true }); } catch {} }

// 只用于 --self-test 的离线自检数据，生产运行永远不会写入业务状态。
const candidateSeeds = [
  { platform: '小红书', title: '做内容别再硬憋了，这套选题方法让我一周写完30篇', author: '增长手记', age: '2小时前', metrics: { likes: 3268, saves: 4180, comments: 289 }, growth: 78, score: 92, tags: ['方法清单', '结果前置', '高收藏'], structure: ['结果前置', '痛点共鸣', '3步方法', '行动清单'] },
  { platform: '抖音', title: '为什么你发了100篇，还是没有一篇能跑出来？', author: '内容实验室', age: '47分钟前', metrics: { likes: 8920, saves: 2311, comments: 763 }, growth: 91, score: 90, tags: ['提问钩子', '反常识', '高评论'], structure: ['反问钩子', '错误示范', '底层原因', '替代方案'] },
  { platform: '小红书', title: '我把账号从0做到1万粉，只重复做了这一件事', author: '运营阿圆', age: '5小时前', metrics: { likes: 1942, saves: 2876, comments: 164 }, growth: 62, score: 86, tags: ['案例型', '过程复盘', '适合复制'], structure: ['结果展示', '失败经历', '关键动作', '复盘总结'] },
  { platform: '抖音', title: '收藏率翻3倍的图文首图，原来只改了这4个字', author: '数据派运营', age: '1小时前', metrics: { likes: 5200, saves: 4410, comments: 350 }, growth: 83, score: 89, tags: ['数字钩子', '首图优化', '强实操'], structure: ['数据结果', '前后对比', '拆解原因', '模板赠送'] },
  { platform: '小红书', title: '新手运营最容易浪费时间的7件事，我全踩过', author: '小张不加班', age: '昨天', metrics: { likes: 1180, saves: 1702, comments: 93 }, growth: 31, score: 77, tags: ['避坑清单', '新手向', '长尾'], structure: ['身份认同', '损失厌恶', '清单展开', '评论互动'] }
];

function seedCandidate(item, index) {
  return { id: `candidate_seed_${index}`, ...item, url: item.platform === '小红书' ? 'https://www.xiaohongshu.com/' : 'https://www.douyin.com/', status: index === 2 ? 'selected' : 'new', discoveredAt: new Date(Date.now() - (index + 1) * 42 * 60 * 1000).toISOString(), source: '演示数据', snapshots: 2 + (index % 3), cover: index % 4 };
}

function initialState() {
  return {
    version: 2, mode: 'workflow-agent', createdAt: now(), lastSavedAt: now(),
    settings: { masterEnabled: false, textProfiles: [], visionProfiles: [], imageProfiles: [], activeTextProfileId: '', activeVisionProfileId: '', activeImageProfileId: '', collectionEnabled: false, workflowAutoEnabled: false, autoMorningTime: '10:00', autoAfternoonTime: '17:00', lastAutomaticSlot: '', manualRawLimit: 50, automaticRawLimit: 200, manualFinalLimit: 10, automaticFinalLimit: 10, dailyCandidateLimit: 500, aiAnalysisLimit: 20, analysisConcurrency: 3, analysisAutoRetryCount: 2, creationAutoRetryCount: 2, generationCount: 10, scaleGenerationCount: 5, imageCount: 4, imageAspectRatio: '2:3', imageSize: '1024x1536', imageTextMode: 'free', imageStyle: 'realistic', imageMaxConcurrentJobs: 4, concurrencyProfileVersion: 1, imageQualityReviewEnabled: true, imageQualityThreshold: 78, imageAutoRetryCount: 1, imagePipelineVersion: 3, brandColors: [], mustShow: [], prohibitedElements: [], imageDailyBudget: 30, imageSpentToday: 0, imageCostPerImage: 0, dailyBudget: 30, spentToday: 0, visionDailyBudget: 30, visionSpentToday: 0, usageDate: DAY(), candidatesToday: 0, analysesToday: 0, generationsToday: 0, imageGenerationsToday: 0, xhsEnabled: true, douyinEnabled: false, xhsKeywords: ['内容运营'], douyinKeywords: ['内容运营'], xhsMaxPerKeyword: 50, xhsScrollRounds: 2, xhsDelayMs: 2500, douyinDelayMs: 3500, xhsChromePort: 17841, douyinChromePort: 17842, performanceAutoEnabled: true, performanceSampleHours: [2, 24, 72], performanceAccountBaselineNotes: 12, performanceLastAutomaticSlot: '', performanceNextAttemptAt: '', performancePausedCode: '', performanceLastAlertKey: '', performanceLastAlertAt: '', feishuWebhook: '', aiBaseUrl: '', aiModel: '', aiInputPricePerMillion: 0, aiOutputPricePerMillion: 0, aiCredentialConfigured: false, lastAiCheckAt: '', lastAiCheckOk: false, visionBaseUrl: 'https://api.tu-zi.com', visionModel: '', visionInputPricePerMillion: 0, visionOutputPricePerMillion: 0, visionMaxImages: 12, visionCredentialConfigured: false, lastVisionCheckAt: '', lastVisionCheckOk: false },
    agents: [
      { id: 'orchestrator', name: '内容总管 Agent', type: '编排', status: 'idle', detail: '等待人工启动或下一次定时任务', lastHeartbeat: now(), restarts: 0 },
      { id: 'supervisor', name: '值班主管 Agent', type: '管理', status: 'healthy', detail: '全局心跳正常', lastHeartbeat: now(), restarts: 0 },
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
  next.settings.douyinChromePort = finiteNumber(next.settings.douyinChromePort, defaults.settings.douyinChromePort, 1025, 65535);
  next.settings.xhsKeywords = normalizeKeywords(next.settings.xhsKeywords);
  next.settings.performanceAutoEnabled = next.settings.performanceAutoEnabled !== false;
  next.settings.performanceSampleHours = normalizePerformanceSampleHours(next.settings.performanceSampleHours);
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
  const normalizedSettingsImageRules = normalizeImageRules(next.settings);
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
  // 旧版单连接配置平滑迁移为档案。旧 Key 只在本机 DPAPI 存储中读取并复制，绝不写入 state.json。
  for (const kind of ['text', 'vision']) {
    const list = profileListFrom(next.settings, kind);
    const activeKey = kind === 'vision' ? 'activeVisionProfileId' : 'activeTextProfileId';
    const baseUrl = kind === 'vision' ? next.settings.visionBaseUrl : next.settings.aiBaseUrl;
    const model = kind === 'vision' ? next.settings.visionModel : next.settings.aiModel;
    const legacyStore = kind === 'vision' ? VISION_CREDENTIALS : CREDENTIALS;
    if (!list.length && baseUrl && model && legacyStore.has()) {
      const profile = profileShape(kind, { name: '旧版默认连接（已迁移）', provider: '旧版配置', baseUrl, model, inputPricePerMillion: kind === 'vision' ? next.settings.visionInputPricePerMillion : next.settings.aiInputPricePerMillion, outputPricePerMillion: kind === 'vision' ? next.settings.visionOutputPricePerMillion : next.settings.aiOutputPricePerMillion });
      profile.lastTestOk = Boolean(kind === 'vision' ? next.settings.lastVisionCheckOk : next.settings.lastAiCheckOk);
      list.push(profile);
      profileCredentialStore(kind, profile.id).save(legacyStore.read());
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
    item.imageRules = normalizeImageRules(item.imageRules || next.settings);
    item.imageTextMode = ['free', 'exact', 'suggest', 'no_text'].includes(item.imageTextMode) ? item.imageTextMode : item.imageRules.textMode;
    item.imagePages = Array.isArray(item.imagePages) ? item.imagePages.map((page, index) => normalizeImagePage(page, index)).filter(Boolean) : [];
    item.imageJob = item.imageJob ? normalizeImageJob(item.imageJob, item.id) : null;
    if (item.imageJob && ['queued', 'running'].includes(item.imageJob.status)) {
      Object.assign(item.imageJob, { status:'interrupted', error:'后台服务在图片任务执行期间退出；已保留完成页，可人工继续未完成页面', message:'任务因程序退出中断', finishedAt:now(), updatedAt:now(), currentPageId:'', currentPageIndex:0 });
    }
    item.imageStatus = item.imageJob?.status === 'interrupted' ? 'interrupted' : item.imagePages.length && item.imagePages.every((page) => page.asset?.file) ? 'ready' : item.imagePages.some((page) => page.asset?.file) ? 'partial' : (item.imagePages.length ? 'draft' : 'legacy');
    item.performanceSnapshots = Array.isArray(item.performanceSnapshots) ? item.performanceSnapshots : (item.metrics ? [normalizePerformanceSnapshot(item.metrics, 'legacy_manual')] : []);
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
const testHadRecovery = SELF_TEST && Boolean(process.env.CONTENTOPS_TEST_RECOVERY_CHECK) && fs.existsSync(DATA_FILE) && !readStateFile(DATA_FILE) && Boolean(readStateFile(BACKUP_FILE));
function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const primary = readStateFile(DATA_FILE);
  if (primary) return normalizeState(primary);
  const backup = readStateFile(BACKUP_FILE);
  if (backup) {
    if (fs.existsSync(DATA_FILE)) try { fs.copyFileSync(DATA_FILE, `${DATA_FILE}.corrupt-${Date.now()}`); } catch {}
    try { fs.copyFileSync(BACKUP_FILE, DATA_FILE); } catch {}
    backup.activity ||= [];
    backup.activity.unshift({ id: uid('log'), level: 'warning', title: '已从安全备份恢复', detail: '主数据文件损坏或不可读，请检查磁盘和异常关机记录', at: now() });
    return normalizeState(backup);
  }
  if (fs.existsSync(DATA_FILE) || fs.existsSync(BACKUP_FILE)) {
    const stamp = Date.now();
    for (const file of [DATA_FILE, BACKUP_FILE]) if (fs.existsSync(file)) try { fs.copyFileSync(file, `${file}.corrupt-${stamp}`); } catch {}
  }
  return initialState();
}
let state = applyTestOverrides(loadState());
let lastPersistedState = structuredClone(state);

function saveState() {
  const candidate = structuredClone(state); candidate.lastSavedAt = now();
  try { writeStateSnapshot(candidate); }
  catch (error) { state = structuredClone(lastPersistedState); throw error; }
  state.lastSavedAt = candidate.lastSavedAt;
  lastPersistedState = structuredClone(candidate);
}
function writeStateSnapshot(snapshot) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const serialized = JSON.stringify(snapshot, null, 2);
  fs.writeFileSync(TEMP_FILE, serialized, 'utf8');
  const handle = fs.openSync(TEMP_FILE, 'r');
  try { fs.fsyncSync(handle); } catch (error) { if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error; } finally { fs.closeSync(handle); }
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);
  fs.renameSync(TEMP_FILE, DATA_FILE);
  if (!fs.existsSync(BACKUP_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);
}
// State normalization is also a schema migration. Commit it before opening the
// API so a cold restart cannot show a migrated value in memory but retain an
// incompatible value on disk for the next restart or export.
saveState();
function commitStateSnapshot(next) {
  const committed = structuredClone(next); committed.lastSavedAt = now();
  try { writeStateSnapshot(committed); }
  catch (error) { state = structuredClone(lastPersistedState); throw error; }
  state = committed; lastPersistedState = structuredClone(committed); return state;
}
function addActivityTo(target, level, title, detail) { target.activity.unshift({ id: uid('log'), level, title, detail, at: now() }); target.activity = target.activity.slice(0, 120); }
function publicState() {
  const safe = structuredClone(state);
  delete safe.settings.aiApiKey;
  safe.settings.aiCredentialConfigured = CREDENTIALS.has();
  safe.settings.visionCredentialConfigured = VISION_CREDENTIALS.has();
  for (const kind of ['text', 'vision', 'image']) {
    const activeId = kind === 'vision' ? safe.settings.activeVisionProfileId : kind === 'image' ? safe.settings.activeImageProfileId : safe.settings.activeTextProfileId;
    profileListFrom(safe.settings, kind).forEach((profile) => {
      profile.credentialConfigured = profileCredentialStore(kind, profile.id).has();
      profile.active = profile.id === activeId;
      delete profile.apiKey;
    });
  }
  safe.runtime = {
    workflowRunning: Boolean(workflowPromise), workflowCancelling: Boolean(workflowPromise && !state.settings.masterEnabled), collectionRunning: ['小红书', '小红书后台', '小红书登录', '小红书检查', '小红书链接导入', '抖音', '抖音链接导入', '抖音登录'].some((key) => collectionLocks.has(key)), aiReady: aiReady(), visionReady: visionReady(), imageReady: imageReady(), analysisReady: analysisReady(),
    activeCollectors: activeCollectors.size,
    imageJobsRunning: imageJobLocks.size,
    creationJobsRunning: creationJobLocks.size,
    nextAutomaticRunAt: state.settings.workflowAutoEnabled ? nextAutomaticRunAt() : null,
    targetSummary: `手动抓${state.settings.manualRawLimit}留${state.settings.manualFinalLimit} · 自动${state.settings.autoMorningTime}/${state.settings.autoAfternoonTime}抓${state.settings.automaticRawLimit}留${state.settings.automaticFinalLimit}`,
    enterpriseProductionReady: enterpriseProductionReadiness(state.enterpriseProfiles.find((item) => item.id === state.activeEnterpriseProfileId))?.ready === true
  };
  return safe;
}
function addActivity(level, title, detail) { state.activity.unshift({ id: uid('log'), level, title, detail, at: now() }); state.activity = state.activity.slice(0, 120); }
function setAgent(id, patch) { const agent = state.agents.find((item) => item.id === id); if (agent) Object.assign(agent, patch, { lastHeartbeat: now() }); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function resetDailyUsageIfNeeded() {
  if (state.settings.usageDate === DAY()) return;
  state.settings.usageDate = DAY();
  state.settings.spentToday = 0;
  state.settings.visionSpentToday = 0;
  state.settings.imageSpentToday = 0;
  state.settings.candidatesToday = 0;
  state.settings.analysesToday = 0;
  state.settings.generationsToday = 0;
  state.settings.imageGenerationsToday = 0;
  addActivity('info', '每日额度已重置', '候选、分析、生成和预算计数从零开始');
}
function finiteNumber(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}
function safeText(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function promptText(value, max = 6000) { return String(value ?? '').slice(0, max); }
function activeWorkflowReferencesCandidate(candidateId) { return state.workflowRuns.some((run) => ['preflight', 'queued', 'running', 'waiting_human'].includes(run.status) && run.candidateIds?.includes(candidateId)); }
function activeWorkflowReferencesVariant(variant) {
  return state.workflowRuns.some((run) => ['preflight', 'queued', 'running', 'waiting_human'].includes(run.status) && (run.id === variant.workflowRunId || run.candidateIds?.includes(variant.candidateId)));
}
function protectedVariant(variant) {
  return Boolean(variant && (['approved', 'exported', 'published'].includes(variant.status) || variant.metrics || state.publications.some((item) => item.variantId === variant.id) || state.materials.some((item) => item.sourceVariantId === variant.id)));
}
function deleteVariantRecords(variantIds) {
  const ids = new Set(variantIds);
  const removed = state.variants.filter((item) => ids.has(item.id));
  const affectedCandidateIds = new Set(removed.map((item) => item.candidateId).filter(Boolean));
  state.variants = state.variants.filter((item) => !ids.has(item.id));
  state.publications = state.publications.filter((item) => !ids.has(item.variantId));
  state.materials = state.materials.filter((item) => !ids.has(item.sourceVariantId));
  let restoredCandidates = 0;
  for (const candidate of state.candidates) {
    if (!affectedCandidateIds.has(candidate.id) || candidate.status !== 'generated' || state.variants.some((item) => item.candidateId === candidate.id)) continue;
    candidate.status = 'selected';
    candidate.creationTask = { status:'idle', attempts:0, lastError:'', nextRetryAt:'', updatedAt:now() };
    restoredCandidates += 1;
  }
  return { deleted:removed.length, restoredCandidates, generatedFiles:generatedImageFilesFromVariants(removed) };
}
function deleteCandidateRecords(candidateIds) {
  const ids = new Set(candidateIds);
  const variantIds = state.variants.filter((item) => ids.has(item.candidateId)).map((item) => item.id);
  const variantResult = deleteVariantRecords(variantIds);
  const before = state.candidates.length;
  state.candidates = state.candidates.filter((item) => !ids.has(item.id));
  state.workflowRuns.forEach((run) => { run.candidateIds = (run.candidateIds || []).filter((id) => !ids.has(id)); });
  return { candidatesDeleted:before - state.candidates.length, variantsDeleted:variantResult.deleted, generatedFiles:variantResult.generatedFiles };
}
function normalizeKeywords(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\r\n,，]+/);
  return [...new Set(source.map((item) => safeText(item, 60)).filter(Boolean))].slice(0, 30);
}
function normalizeTextList(value, maxItems = 30, maxLength = 300) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\r\n]+/);
  return [...new Set(source.map((item) => safeText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}
function normalizeImageRules(value = {}) {
  // OpenAI-compatible Images APIs expose fixed canvases. Keep the label, pixel
  // size and visual-QA contract identical instead of pretending that the
  // provider-native 1024x1536 canvas is 3:4 or 9:16.
  const requestedRatio = value.imageAspectRatio || value.aspectRatio;
  const legacyRatio = ['3:4', '4:5', '9:16'].includes(requestedRatio) ? '2:3' : requestedRatio;
  const ratio = ['1:1', '2:3', '3:2'].includes(legacyRatio) ? legacyRatio : '2:3';
  const sizes = { '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024' };
  return {
    textMode: ['free', 'exact', 'suggest', 'no_text'].includes(value.imageTextMode || value.textMode) ? (value.imageTextMode || value.textMode) : (value.imageTextMode || value.textMode) === 'with_text' ? 'suggest' : (value.imageTextMode || value.textMode) === 'no_text' ? 'no_text' : 'free',
    style: ['realistic', 'illustration', '3d', 'animated'].includes(value.imageStyle || value.style) ? (value.imageStyle || value.style) : 'realistic',
    aspectRatio: ratio,
    size: sizes[ratio],
    imageCount: finiteNumber(value.imageCount, 4, 2, 12),
    singleTimeoutMs: finiteNumber(value.imageSingleTimeoutSeconds, 180, 30, 900) * 1000,
    jobTimeoutMs: finiteNumber(value.imageJobTimeoutMinutes, 15, 2, 120) * 60 * 1000,
    maxConcurrentJobs: finiteNumber(value.imageMaxConcurrentJobs, 4, 1, 8),
    qualityReviewEnabled: value.imageQualityReviewEnabled !== false,
    qualityThreshold: finiteNumber(value.imageQualityThreshold, 78, 50, 100),
    autoRetryCount: finiteNumber(value.imageAutoRetryCount, 1, 0, 2),
    brandColors: normalizeTextList(value.brandColors, 8, 60),
    mustShow: normalizeTextList(value.mustShow, 12, 160),
    prohibitedElements: normalizeTextList(value.prohibitedElements, 20, 160)
  };
}
function normalizeImageJob(value = {}, variantId = '') {
  const allowed = ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'];
  return {
    id: safeText(value.id, 120) || '', variantId: safeText(value.variantId || variantId, 120), requestKey: safeText(value.requestKey, 500), status: allowed.includes(value.status) ? value.status : 'interrupted',
    targetPageIds: normalizeTextList(value.targetPageIds, 20, 120), total: finiteNumber(value.total, 0, 0, 20), completed: finiteNumber(value.completed, 0, 0, 20), failed: finiteNumber(value.failed, 0, 0, 20), currentPageId: safeText(value.currentPageId, 120), currentPageIndex: finiteNumber(value.currentPageIndex, 0, 0, 20),
    startedAt: safeText(value.startedAt, 80), updatedAt: safeText(value.updatedAt, 80), finishedAt: safeText(value.finishedAt, 80), deadlineAt: safeText(value.deadlineAt, 80), error: safeText(value.error, 1000), message: safeText(value.message, 500),
    cost: finiteNumber(value.cost, 0, 0, 1000000), duplicateRequests: finiteNumber(value.duplicateRequests, 0, 0, 1000000), referencePolicy: ['auto', 'required', 'disabled'].includes(value.referencePolicy) ? value.referencePolicy : 'auto', referenceMode: ['reference_edit', 'reference_generation_json'].includes(value.referenceMode) ? value.referenceMode : 'text_only', referenceAssetIds: normalizeTextList(value.referenceAssetIds, 4, 120)
  };
}
function normalizeImagePage(value = {}, index = 0) {
  const asset = value?.asset && typeof value.asset === 'object' ? { file: safeText(value.asset.file, 500), mime: safeText(value.asset.mime, 80), generatedAt: safeText(value.asset.generatedAt, 80), source: safeText(value.asset.source, 80), revisedPrompt: safeText(value.asset.revisedPrompt, 6000), referenceMode: ['reference_edit', 'reference_generation_json'].includes(value.asset.referenceMode) ? value.asset.referenceMode : 'text_only', referenceAssetIds: normalizeTextList(value.asset.referenceAssetIds, 4, 120) } : null;
  const copy = safeText(value.copy ?? value.page ?? '', 800);
  const imagePrompt = promptText(value.imagePrompt ?? value.prompt ?? '', 6000);
  if (!copy && !imagePrompt && !asset?.file) return null;
  const quality = value?.quality && typeof value.quality === 'object' ? { score: finiteNumber(value.quality.score, 0, 0, 100), passed: Boolean(value.quality.passed), summary: safeText(value.quality.summary, 800), strengths: normalizeTextList(value.quality.strengths, 8, 200), problems: normalizeTextList(value.quality.problems, 10, 240), retryPrompt: safeText(value.quality.retryPrompt, 6000), checkedAt: safeText(value.quality.checkedAt, 80), model: safeText(value.quality.model, 160), attempts: finiteNumber(value.quality.attempts, 0, 0, 10) } : null;
  const textMode = ['inherit', 'free', 'exact', 'suggest', 'no_text'].includes(value.textMode) ? value.textMode : 'inherit';
  return { id: safeText(value.id, 120) || uid('page'), index: finiteNumber(value.index, index + 1, 1, 20), role: safeText(value.role, 80), purpose: safeText(value.purpose, 240), copy, imagePrompt, textMode, asset, generationError:safeText(value.generationError, 800), quality };
}
function normalizeEnterpriseProfile(value = {}) {
  return {
    id: safeText(value.id, 120) || uid('enterprise'),
    name: safeText(value.name, 120),
    brandName: safeText(value.brandName, 120),
    productName: safeText(value.productName, 160),
    category: safeText(value.category, 120),
    positioning: safeText(value.positioning, 1200),
    audience: safeText(value.audience, 800),
    brandVoice: safeText(value.brandVoice, 800),
    productFacts: normalizeTextList(value.productFacts, 40, 500),
    sellingPoints: normalizeTextList(value.sellingPoints, 30, 300),
    proofPoints: normalizeTextList(value.proofPoints, 30, 500),
    forbiddenClaims: normalizeTextList(value.forbiddenClaims, 40, 300),
    visualRules: normalizeTextList(value.visualRules, 30, 300),
    imageAssets: (Array.isArray(value.imageAssets) ? value.imageAssets : []).map(normalizeEnterpriseImageAsset).filter(Boolean).slice(0, 30),
    referenceLinks: normalizeTextList(value.referenceLinks, 30, 2000).filter((item) => { try { const url = new URL(item); return ['http:', 'https:'].includes(url.protocol); } catch { return false; } }),
    notes: safeText(value.notes, 3000),
    status: value.status === 'archived' ? 'archived' : 'active',
    createdAt: value.createdAt || now(),
    updatedAt: now()
  };
}
function normalizeEnterpriseImageAsset(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const id = safeText(value.id, 120);
  const file = safeText(value.file, 500);
  if (!id || !file) return null;
  const kind = ['product', 'scene', 'brand', 'reference'].includes(value.kind) ? value.kind : 'reference';
  return {
    id, file, kind,
    name: safeText(value.name, 160) || '未命名图片素材',
    description: safeText(value.description, 1200),
    immutableNotes: safeText(value.immutableNotes, 800),
    mime: ['image/jpeg', 'image/png', 'image/webp'].includes(value.mime) ? value.mime : 'image/jpeg',
    size: finiteNumber(value.size, 0, 0, 10 * 1024 * 1024),
    createdAt: safeText(value.createdAt, 80) || now()
  };
}
function enterpriseAssetPath(file) {
  const resolved = path.resolve(ENTERPRISE_ASSET_DIR, safeText(file, 500));
  const relative = path.relative(ENTERPRISE_ASSET_DIR, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('企业图片文件路径不正确');
  return resolved;
}
function detectImageMime(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return '';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}
function imageBytesMatchMime(bytes, mime) { return detectImageMime(bytes) === mime; }
function imageExtension(mime) { return mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png'; }
function stageEnterpriseImageRemoval(asset) {
  const source = enterpriseAssetPath(asset.file);
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new Error('企业图片存储对象不是普通文件，已拒绝删除以保护资料库');
  const trash = path.join(ENTERPRISE_ASSET_DIR, '.trash', `${uid('enterprise-image-delete')}${path.extname(source)}`);
  fs.mkdirSync(path.dirname(trash), { recursive:true });
  fs.renameSync(source, trash);
  return { source, trash };
}
function rollbackEnterpriseImageRemoval(stage) { fs.renameSync(stage.trash, stage.source); }
function finalizeEnterpriseImageRemoval(stage) { fs.rmSync(stage.trash, { force:true }); }
function enterpriseAssetSummary(asset) {
  return {
    id: asset.id, kind: asset.kind, name: asset.name,
    description: asset.description,
    immutableNotes: asset.immutableNotes,
    // 只给模型业务描述，绝不暴露本机文件路径。
    usable: Boolean(asset.description)
  };
}
function meaningfulEnterpriseLine(value) {
  const text = safeText(value, 1200).trim();
  if (text.length < 2) return false;
  return !/^(?:\d+|测试|占位(?:信息|内容)?|暂无|无|未填写|待补充|未知|null|none|n\/?a)[。.!！?？\s]*$/i.test(text);
}
function sanitizeEnterpriseProfile(profile = {}) {
  const cleanList = (values) => normalizeTextList(values, 40, 500).filter(meaningfulEnterpriseLine);
  return {
    ...profile,
    brandName: meaningfulEnterpriseLine(profile.brandName) ? safeText(profile.brandName, 120) : '',
    productName: meaningfulEnterpriseLine(profile.productName) ? safeText(profile.productName, 160) : '',
    positioning: meaningfulEnterpriseLine(profile.positioning) ? safeText(profile.positioning, 1200) : '',
    audience: meaningfulEnterpriseLine(profile.audience) ? safeText(profile.audience, 800) : '',
    brandVoice: meaningfulEnterpriseLine(profile.brandVoice) ? safeText(profile.brandVoice, 800) : '',
    productFacts: cleanList(profile.productFacts),
    sellingPoints: cleanList(profile.sellingPoints),
    proofPoints: cleanList(profile.proofPoints),
    forbiddenClaims: cleanList(profile.forbiddenClaims),
    visualRules: cleanList(profile.visualRules),
    imageAssets: (profile.imageAssets || []).filter((asset) => meaningfulEnterpriseLine(asset.description))
  };
}
function enterpriseProductionReadiness(profile) {
  if (!profile || profile.status !== 'active') return { ready:false, reason:'请先建立并启用企业素材库' };
  const clean = sanitizeEnterpriseProfile(profile);
  const hasIdentity = Boolean(clean.brandName || clean.productName);
  const hasGrounding = Boolean(clean.productName || clean.positioning || clean.productFacts.length || clean.sellingPoints.length || clean.proofPoints.length);
  if (!hasIdentity || !hasGrounding) return { ready:false, reason:'企业素材库资料不足：请至少填写真实品牌或产品，并补充产品/服务、定位、事实、卖点或证据中的一项' };
  return { ready:true, profile:clean };
}
function containsInternalProductionLanguage(value) {
  return /(?:企业素材库|企业资料库|资料库当前|素材库当前|占位信息|占位内容|未提供(?:具体|有效|相关)?(?:产品|企业|品牌|资料|信息|素材)|系统配置|模型配置|提示词|AI\s*工作流|内部状态)/i.test(safeText(value, 10000));
}
function exportFileName(value, fallback = '资料库') {
  const text = safeText(value, 120).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  return text.slice(0, 80) || fallback;
}
function exportEnterpriseProfile(profile, directory) {
  const base = safeText(directory, 2000);
  if (!base || !path.isAbsolute(base)) return { ok:false, message:'请填写本机绝对导出文件夹路径' };
  const snapshotId = uid('enterprise-export');
  const folder = path.resolve(base, `企业资料库-${exportFileName(profile.name)}-${snapshotId}`);
  const relative = path.relative(path.resolve(base), folder);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok:false, message:'导出目录不正确' };
  const assets = (profile.imageAssets || []).map((asset, index) => {
    const source = enterpriseAssetPath(asset.file);
    if (!fs.existsSync(source)) throw new Error(`企业图片文件缺失：${asset.name}`);
    const extension = imageExtension(asset.mime);
    return { asset, source, outputFile:`images/${String(index + 1).padStart(2, '0')}-${exportFileName(asset.name, '企业图片')}${extension}` };
  });
  const temporary = `${folder}.tmp`;
  try {
    fs.mkdirSync(path.join(temporary, 'images'), { recursive:true });
    for (const item of assets) fs.copyFileSync(item.source, path.join(temporary, item.outputFile));
    const snapshot = { format:'contentops-enterprise-library-v1', exportedAt:now(), profile:{ ...profile, imageAssets:assets.map(({ asset, outputFile }) => ({ ...asset, file:outputFile })) } };
    fs.writeFileSync(path.join(temporary, '企业资料库.json'), JSON.stringify(snapshot, null, 2), 'utf8');
    fs.writeFileSync(path.join(temporary, '说明.txt'), `企业素材库快照\n名称：${profile.name}\n导出时间：${snapshot.exportedAt}\n图片：${assets.length} 张\n\n本包包含企业资料库.json 与 images 文件夹。图片说明、用途分类和限制说明均保存在 JSON 清单中。\n`, 'utf8');
    fs.renameSync(temporary, folder);
  } catch (error) {
    try { fs.rmSync(temporary, { recursive:true, force:true }); } catch {}
    return { ok:false, message:`企业资料库导出失败：${error.message}` };
  }
  const beforeLog = structuredClone(state);
  try { addActivity('success', '企业资料库已导出', `${profile.name} · ${assets.length}张图片 · ${folder}`); saveState(); }
  catch { state = beforeLog; }
  if (!SELF_TEST && !process.env.CONTENTOPS_TEST_ALLOW_UNVERIFIED && process.env.CONTENTOPS_OPEN_EXPORT_FOLDER !== '0') try { spawn('explorer.exe', [folder], { detached:true, stdio:'ignore' }).unref(); } catch {}
  return { ok:true, path:folder, imageCount:assets.length, warning: state === beforeLog ? '快照已生成，但运行日志未能保存；无需重复导出。' : '' };
}
function normalizeClock(value, fallback) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : fallback;
}
function normalizePerformanceSampleHours(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,，]+/);
  const defaults = [2, 24, 72];
  const normalized = [...new Set(source.map((item) => finiteNumber(item, 0, 1, 720)).filter(Boolean))].sort((a, b) => a - b).slice(0, 6);
  return normalized.length ? normalized : defaults;
}
function normalizePerformanceSnapshot(value = {}, source = 'creator_center') {
  const capturedAt = safeText(value.capturedAt || value.recordedAt, 80) || now();
  return {
    capturedAt,
    source: safeText(value.source || source, 80),
    title: safeText(value.title, 180),
    publishedAtRaw: safeText(value.publishedAtRaw, 120),
    exposure: finiteNumber(value.exposure, 0),
    views: finiteNumber(value.views ?? value.exposure, 0),
    coverClickRate: value.coverClickRate === null || value.coverClickRate === undefined || value.coverClickRate === '' ? null : finiteNumber(value.coverClickRate, 0, 0, 100),
    likes: finiteNumber(value.likes, 0),
    comments: finiteNumber(value.comments, 0),
    saves: finiteNumber(value.saves, 0),
    followers: finiteNumber(value.followers, 0),
    shares: finiteNumber(value.shares, 0),
    averageViewSeconds: value.averageViewSeconds === null || value.averageViewSeconds === undefined || value.averageViewSeconds === '' ? null : finiteNumber(value.averageViewSeconds, 0, 0, 86400),
    danmaku: finiteNumber(value.danmaku, 0),
    link: safeText(value.link, 2000)
  };
}
function performanceMetricsFromSnapshot(snapshot) {
  return { source:snapshot.source, exposure: snapshot.exposure, likes: snapshot.likes, saves: snapshot.saves, comments: snapshot.comments, shares: snapshot.shares, followers: snapshot.followers, coverClickRate: snapshot.coverClickRate, views: snapshot.views, averageViewSeconds: snapshot.averageViewSeconds, link: snapshot.link, recordedAt: snapshot.capturedAt };
}
function localDay(date = new Date()) { return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); }
function localClock(date = new Date()) { return date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' }); }
function automaticSlots() { return [state.settings.autoMorningTime, state.settings.autoAfternoonTime].map((value) => normalizeClock(value, '10:00')).sort(); }
function dueAutomaticSlot(date = new Date()) { const clock = localClock(date); return automaticSlots().filter((slot) => slot <= clock).at(-1) || ''; }
function nextAutomaticRunAt(date = new Date()) {
  const day = localDay(date); const clock = localClock(date); const next = automaticSlots().find((slot) => slot > clock);
  const targetDay = next ? day : localDay(new Date(date.getTime() + 86400000)); const targetClock = next || automaticSlots()[0];
  return new Date(`${targetDay}T${targetClock}:00+08:00`).toISOString();
}
function budgetRemaining() { resetDailyUsageIfNeeded(); return Number(state.settings.dailyBudget) - Number(state.settings.spentToday || 0); }
function visionBudgetRemaining() { resetDailyUsageIfNeeded(); return Number(state.settings.visionDailyBudget) - Number(state.settings.visionSpentToday || 0); }
function imageBudgetRemaining() { resetDailyUsageIfNeeded(); return Number(state.settings.imageDailyBudget) - Number(state.settings.imageSpentToday || 0); }
function aiReady() { const connection = activeConnection('text'); const profile = activeProfile('text'); return Boolean(connection.baseUrl && connection.model && connection.apiKey && (!profile || profile.lastTestOk)); }
function visionReady() { const connection = activeConnection('vision'); const profile = activeProfile('vision'); return Boolean(connection.baseUrl && connection.model && connection.apiKey && (!profile || profile.lastTestOk)); }
function imageReady() { const connection = activeConnection('image'); const profile = activeProfile('image'); return Boolean(connection.baseUrl && connection.model && connection.apiKey && (!profile || profile.lastTestOk)); }
function analysisReady() { return aiReady() && visionReady(); }
function profileCredentialStore(kind, id) {
  const key = `${kind}:${safeText(id, 100)}`;
  if (!PROFILE_CREDENTIAL_STORES.has(key)) PROFILE_CREDENTIAL_STORES.set(key, new CredentialStore(PROFILE_DIR, `${kind}-${safeText(id, 100)}.dpapi`));
  return PROFILE_CREDENTIAL_STORES.get(key);
}
function profileListFrom(settings, kind) { return kind === 'vision' ? settings.visionProfiles : kind === 'image' ? settings.imageProfiles : settings.textProfiles; }
function profileList(kind) { return profileListFrom(state.settings, kind); }
function activeProfile(kind) { const list = profileList(kind); const id = kind === 'vision' ? state.settings.activeVisionProfileId : kind === 'image' ? state.settings.activeImageProfileId : state.settings.activeTextProfileId; return list.find((item) => item.id === id) || null; }
function activeCredential(kind) { const profile = activeProfile(kind); if (profile) return profileCredentialStore(kind, profile.id).read(); if (kind === 'image') return ''; return kind === 'vision' ? VISION_CREDENTIALS.read() : CREDENTIALS.read(); }
function activeConnection(kind) { const profile = activeProfile(kind); if (profile) return { baseUrl: profile.baseUrl, model: profile.model, apiKey: activeCredential(kind), inputPricePerMillion: profile.inputPricePerMillion, outputPricePerMillion: profile.outputPricePerMillion, imageInputMode: kind === 'image' ? profile.imageInputMode : 'text_only', requestTimeoutMs: finiteNumber(profile.requestTimeoutSeconds, kind === 'image' ? 180 : 120, 10, 1800) * 1000 }; if (kind === 'image') return { baseUrl: '', model: '', apiKey: '', inputPricePerMillion: 0, outputPricePerMillion: 0, imageInputMode: 'text_only', requestTimeoutMs: 180000 }; return kind === 'vision' ? { baseUrl: state.settings.visionBaseUrl, model: state.settings.visionModel, apiKey: VISION_CREDENTIALS.read(), inputPricePerMillion: state.settings.visionInputPricePerMillion, outputPricePerMillion: state.settings.visionOutputPricePerMillion, requestTimeoutMs: 120000 } : { baseUrl: state.settings.aiBaseUrl, model: state.settings.aiModel, apiKey: CREDENTIALS.read(), inputPricePerMillion: state.settings.aiInputPricePerMillion, outputPricePerMillion: state.settings.aiOutputPricePerMillion, requestTimeoutMs: 60000 }; }
function activeModelFingerprint(kind) { const profile = activeProfile(kind); const connection = activeConnection(kind); return `${profile?.id || 'legacy'}|${connection.baseUrl}|${connection.model}`; }
function outputTokenLimit(kind, fallback) { return finiteNumber(activeProfile(kind)?.maxOutputTokens, fallback, 100, 20000); }
function profileShape(kind, body = {}, prior = null) { return { id: safeText(body.id, 120) || uid(`${kind}-profile`), name: safeText(body.name, 120) || `${kind === 'vision' ? '视觉' : kind === 'image' ? '生图' : '文本'}连接`, provider: safeText(body.provider, 120), baseUrl: safeText(body.baseUrl, 1000), model: safeText(body.model, 160), protocol: kind === 'image' ? 'images' : 'chat', imageInputMode: kind === 'image' && ['reference_edit', 'reference_generation_json'].includes(body.imageInputMode) ? body.imageInputMode : 'text_only', inputPricePerMillion: finiteNumber(body.inputPricePerMillion, prior?.inputPricePerMillion || 0, 0, 100000), outputPricePerMillion: finiteNumber(body.outputPricePerMillion, prior?.outputPricePerMillion || 0, 0, 100000), maxOutputTokens: finiteNumber(body.maxOutputTokens, prior?.maxOutputTokens || 4000, 100, 20000), requestTimeoutSeconds: finiteNumber(body.requestTimeoutSeconds, prior?.requestTimeoutSeconds || (kind === 'image' ? 180 : 120), 10, 1800), lastTestAt: prior?.lastTestAt || '', lastTestOk: Boolean(prior?.lastTestOk), lastTestError: safeText(prior?.lastTestError, 500), createdAt: prior?.createdAt || now(), updatedAt: now() }; }
function applyProfile(kind, profile) { if (kind === 'image') return; const text = kind === 'text'; state.settings[text ? 'aiBaseUrl' : 'visionBaseUrl'] = profile.baseUrl; state.settings[text ? 'aiModel' : 'visionModel'] = profile.model; state.settings[text ? 'aiInputPricePerMillion' : 'visionInputPricePerMillion'] = profile.inputPricePerMillion; state.settings[text ? 'aiOutputPricePerMillion' : 'visionOutputPricePerMillion'] = profile.outputPricePerMillion; if (text) state.settings.lastAiCheckOk = profile.lastTestOk; else state.settings.lastVisionCheckOk = profile.lastTestOk; }
function estimateCost(kind, usage = {}, connection = activeConnection(kind)) {
  const input = Number(usage.inputTokens || 0) / 1000000 * Number(connection.inputPricePerMillion || 0);
  const output = Number(usage.outputTokens || 0) / 1000000 * Number(connection.outputPricePerMillion || 0);
  return Number((input + output).toFixed(4));
}
function recordAiUsage(usage, purpose) {
  const cost = estimateCost('text', usage);
  state.settings.spentToday = Number((Number(state.settings.spentToday || 0) + cost).toFixed(4));
  addActivity('info', `${purpose} API 调用完成`, `输入 ${usage.inputTokens || 0} tokens · 输出 ${usage.outputTokens || 0} tokens · 计费 ¥${cost.toFixed(4)}`);
  return cost;
}
function recordVisionUsage(usage, purpose) {
  const cost = estimateCost('vision', usage);
  state.settings.visionSpentToday = Number((Number(state.settings.visionSpentToday || 0) + cost).toFixed(4));
  addActivity('info', `${purpose} API 调用完成`, `视觉输入 ${usage.inputTokens || 0} tokens · 输出 ${usage.outputTokens || 0} tokens · 计费 ¥${cost.toFixed(4)}`);
  return cost;
}
function recordImageUsage(usage, purpose) {
  const cost = Number((estimateCost('image', usage) + Number(state.settings.imageCostPerImage || 0)).toFixed(4));
  state.settings.imageSpentToday = Number((Number(state.settings.imageSpentToday || 0) + cost).toFixed(4));
  addActivity('info', `${purpose} API 调用完成`, `计费 ¥${cost.toFixed(4)}`);
  return cost;
}
function estimatedCallCost(kind, inputChars, maxOutputTokens) {
  const approximateInputTokens = Math.ceil(Number(inputChars || 0) / 2);
  const connection = activeConnection(kind);
  const inputPrice = Number(connection.inputPricePerMillion) || 0;
  const outputPrice = Number(connection.outputPricePerMillion) || 0;
  return approximateInputTokens / 1000000 * inputPrice + Number(maxOutputTokens || 0) / 1000000 * outputPrice;
}
function reserveCall(kind, inputChars, maxOutputTokens, purpose) {
  const remaining = kind === 'vision' ? visionBudgetRemaining() : kind === 'image' ? imageBudgetRemaining() : budgetRemaining();
  const estimate = estimatedCallCost(kind, inputChars, maxOutputTokens);
  if (estimate > remaining) return { ok: false, code: kind === 'vision' ? 'VISION_BUDGET_LIMIT' : kind === 'image' ? 'IMAGE_BUDGET_LIMIT' : 'TEXT_BUDGET_LIMIT', message: `${purpose}预计最高费用 ¥${estimate.toFixed(4)}，超过剩余预算 ¥${remaining.toFixed(4)}` };
  return { ok: true, estimate };
}
function workflowSteps() {
  return [
    { id: 'collect', name: '抓取', owner: '抓取 Agent', gate: false },
    { id: 'analyze', name: 'AI预选', owner: '爆款分析 Agent', gate: false },
    { id: 'select', name: '人工选款', owner: '人工', gate: true },
    { id: 'create', name: 'AI生产', owner: '图文生产 Agent', gate: false },
    { id: 'publish', name: '人工审核/发布', owner: '人工', gate: true },
    { id: 'performance', name: '数据分析', owner: '数据循环 Agent', gate: false },
    { id: 'scale', name: '人工确认二做', owner: '人工', gate: true }
  ];
}
function createWorkflowRun(trigger) {
  const automatic = trigger === 'scheduled'; const rawLimit = automatic ? state.settings.automaticRawLimit : state.settings.manualRawLimit; const finalLimit = automatic ? state.settings.automaticFinalLimit : state.settings.manualFinalLimit;
  const platforms = [['小红书', state.settings.xhsEnabled, state.settings.xhsKeywords], ['抖音', state.settings.douyinEnabled, state.settings.douyinKeywords]].filter(([, enabled]) => enabled).map(([platform, , keywords]) => ({ platform, keywords:[...keywords] }));
  const run = { id: uid('run'), trigger, status: 'queued', currentStep: 'collect', startedAt: now(), finishedAt: '', targets: { platform: platforms.map((item) => item.platform).join('、') || '未配置', platforms, contentType: '公开图文', keywords: platforms.flatMap((item) => item.keywords), rawLimit, finalLimit, filterMode: automatic ? '严格' : '标准' }, steps: workflowSteps().map((step) => ({ ...step, status: 'pending', detail: '' })), counts: { raw: 0, filtered: 0, collected: 0, analyzed: 0, selected: 0, generated: 0, approved: 0, published: 0, performanceAnalyzed: 0, scaled: 0 }, actualCost: 0, error: '' };
  state.workflowRuns.unshift(run); state.workflowRuns = state.workflowRuns.slice(0, 100); return run;
}
function patchRunStep(run, id, patch) { const step = run.steps.find((item) => item.id === id); if (step) Object.assign(step, patch); run.currentStep = id; }
function finishRun(run, status, detail = '') { run.status = status; run.finishedAt = now(); if (detail) run.error = detail; }
function cancelOpenRun(run, detail = '人工总控已停止') {
  if (!run || !['preflight', 'queued', 'running', 'waiting_human', 'paused', 'blocked'].includes(run.status)) return false;
  const currentIndex = run.steps?.findIndex((step) => step.id === run.currentStep) ?? -1;
  const current = currentIndex >= 0 ? run.steps[currentIndex] : null;
  if (current && ['pending', 'queued', 'running', 'waiting_human', 'blocked', 'failed'].includes(current.status)) Object.assign(current, { status: 'cancelled', detail });
  for (const step of (run.steps || []).slice(currentIndex + 1)) if (['pending', 'queued'].includes(step.status)) Object.assign(step, { status:'skipped', detail:'因人工停止未执行' });
  finishRun(run, 'cancelled', detail);
  return true;
}
function runForCandidate(candidateId) {
  return state.workflowRuns.find((run) => ['waiting_human', 'running', 'blocked'].includes(run.status) && run.candidateIds?.includes(candidateId) && (run.status !== 'blocked' || run.currentStep === 'create'))
    || state.workflowRuns.find((run) => ['waiting_human', 'running'].includes(run.status) && ['select', 'create'].includes(run.currentStep));
}
function runForVariant(variant) {
  if (!variant) return null;
  if (variant.workflowRunId) return state.workflowRuns.find((run) => run.id === variant.workflowRunId && ['waiting_human', 'running', 'blocked'].includes(run.status) && (run.status !== 'blocked' || run.currentStep === 'create')) || null;
  return runForCandidate(variant.candidateId);
}
function attachCandidateToRun(run, candidateId) {
  if (!run) return;
  run.candidateIds = Array.isArray(run.candidateIds) ? run.candidateIds : [];
  if (!run.candidateIds.includes(candidateId)) run.candidateIds.push(candidateId);
}
function reconcileRecoveredCreationRuns() {
  let changed = false;
  for (const run of state.workflowRuns.filter((item) => item.status === 'blocked' && item.currentStep === 'create')) {
    const candidateIds = new Set(run.candidateIds || []);
    const variants = state.variants.filter((variant) => candidateIds.has(variant.candidateId));
    if (!variants.length) continue;
    for (const variant of variants) if (!variant.workflowRunId) { variant.workflowRunId = run.id; changed = true; }
    run.counts ||= {};
    run.counts.generated = Math.max(Number(run.counts.generated || 0), variants.length);
    const approved = variants.filter((variant) => ['approved', 'exported', 'published'].includes(variant.status)).length;
    if (approved) {
      run.counts.approved = Math.max(Number(run.counts.approved || 0), approved);
      patchRunStep(run, 'create', { status:'completed', detail:`已生成 ${variants.length} 套策划稿` });
      patchRunStep(run, 'publish', { status:'waiting_human', detail:`${approved} 套已通过，等待人工发布并回填数据` });
    } else patchRunStep(run, 'create', { status:'waiting_human', detail:`已生成 ${variants.length} 套策划稿，等待人工编辑并确认生图` });
    run.status = 'waiting_human'; run.error = ''; run.finishedAt = ''; changed = true;
  }
  if (changed) { addActivity('info', '工作流状态已自动修复', '已将成功的一做结果重新绑定到原受阻任务，清除过期错误'); saveState(); }
  return changed;
}
reconcileRecoveredCreationRuns();
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

function selectSeed(platform) {
  const matching = candidateSeeds.filter((item) => !platform || item.platform === platform);
  const base = matching[Math.floor(Math.random() * matching.length)] || candidateSeeds[0];
  const bump = Math.floor(Math.random() * 900);
  return { ...base, id: uid('candidate'), title: `${base.title}${Math.random() > .5 ? '（新样本）' : ''}`, age: '刚刚发现', metrics: { likes: base.metrics.likes + bump, saves: base.metrics.saves + Math.floor(bump * .6), comments: base.metrics.comments + Math.floor(bump * .08) }, score: clamp(base.score + Math.floor(Math.random() * 5) - 2, 65, 98), growth: clamp(base.growth + Math.floor(Math.random() * 9) - 4, 10, 99), status: 'new', discoveredAt: now(), source: '演示采集', snapshots: 1, cover: Math.floor(Math.random() * 4), url: base.platform === '小红书' ? 'https://www.xiaohongshu.com/' : 'https://www.douyin.com/' };
}

const collectionLocks = new Map();
const imageJobLocks = new Map();
const creationJobLocks = new Map();
let workflowPromise = null;
let masterGeneration = 0;
function douyinBrowserBusy() {
  return ['抖音', '抖音链接导入', '抖音登录'].find((key) => collectionLocks.has(key)) || '';
}
function xhsBrowserBusy() {
  // 公开抓取、创作后台、登录检查和链接导入共用同一份小红书 Chrome 资料与调试端口。
  // 并发导航同一个浏览器会造成错页、命令超时和登录状态误判，必须严格串行。
  return ['小红书', '小红书后台', '小红书登录', '小红书检查', '小红书链接导入'].find((key) => collectionLocks.has(key)) || '';
}
function masterStopped(generation = masterGeneration) { return !state.settings.masterEnabled || generation !== masterGeneration; }
function stopResult(message = '人工总控已停止，工作流不会继续进入下一阶段') { return { ok: false, code: 'MASTER_STOPPED', message }; }
const activeCollectors = new Set();
async function withActiveCollector(factory, action) {
  const collector = factory();
  try { return await action(collector); }
  finally {
    activeCollectors.delete(collector);
    if (process.env.CONTENTOPS_COLLECTOR_HEADLESS === '1') {
      try { collector.closeBrowser(); } catch {}
    }
  }
}
function createXhsCollector() {
  const collector = new XiaohongshuCollector({
    chromePath: CHROME_PATH,
    chromeDiagnostic: CHROME_RUNTIME.diagnostic,
    profileDir: COLLECTOR_PROFILE_DIR,
    errorDir: COLLECTOR_ERROR_DIR,
    port: finiteNumber(process.env.CONTENTOPS_XHS_CHROME_PORT, finiteNumber(state.settings.xhsChromePort, 17841, 1025, 65535), 1025, 65535),
    headless: process.env.CONTENTOPS_COLLECTOR_HEADLESS === '1',
    searchBaseUrl: process.env.CONTENTOPS_XHS_SEARCH_BASE_URL
  });
  activeCollectors.add(collector);
  return collector;
}
function createDouyinCollector() {
  const collector = new DouyinCollector({
    chromePath: CHROME_PATH,
    chromeDiagnostic: CHROME_RUNTIME.diagnostic,
    profileDir: DOUYIN_COLLECTOR_PROFILE_DIR,
    errorDir: COLLECTOR_ERROR_DIR,
    port: finiteNumber(process.env.CONTENTOPS_DOUYIN_CHROME_PORT, state.settings.douyinChromePort, 1025, 65535),
    // The two URL overrides exist solely to let the isolated QA fixture exercise
    // the complete server-to-browser chain.  With normal launch settings both
    // are empty and the collector uses only official Douyin pages.
    headless: process.env.CONTENTOPS_COLLECTOR_HEADLESS === '1',
    detailBaseUrl: process.env.CONTENTOPS_DOUYIN_DETAIL_BASE_URL || undefined,
    searchBaseUrl: process.env.CONTENTOPS_DOUYIN_SEARCH_BASE_URL || undefined
  });
  activeCollectors.add(collector);
  return collector;
}
function createCreatorCenterCollector() {
  const collector = new XiaohongshuCreatorCenterCollector({
    chromePath: CHROME_PATH,
    chromeDiagnostic: CHROME_RUNTIME.diagnostic,
    profileDir: COLLECTOR_PROFILE_DIR,
    errorDir: COLLECTOR_ERROR_DIR,
    port: finiteNumber(process.env.CONTENTOPS_XHS_CHROME_PORT, finiteNumber(state.settings.xhsChromePort, 17841, 1025, 65535), 1025, 65535),
    headless: process.env.CONTENTOPS_COLLECTOR_HEADLESS === '1',
    creatorUrl: process.env.CONTENTOPS_XHS_CREATOR_URL
  });
  activeCollectors.add(collector);
  return collector;
}

function creatorRowToSnapshot(row, collectedAt) {
  const values = row?.values || {};
  const read = (...names) => names.map((name) => values[name]).find((value) => value !== undefined && value !== '');
  return normalizePerformanceSnapshot({
    capturedAt: collectedAt,
    source: 'xiaohongshu_creator_center',
    title: row?.title,
    publishedAtRaw: row?.publishedAtRaw,
    exposure: numberFromText(read('曝光')),
    views: numberFromText(read('观看')),
    coverClickRate: percentFromText(read('封面点击率')),
    likes: numberFromText(read('点赞')),
    comments: numberFromText(read('评论')),
    saves: numberFromText(read('收藏')),
    followers: numberFromText(read('涨粉')),
    shares: numberFromText(read('分享')),
    averageViewSeconds: secondsFromText(read('人均观看时长')),
    danmaku: numberFromText(read('弹幕'))
  }, 'xiaohongshu_creator_center');
}
function latestPerformanceSnapshot(variant) {
  const all = Array.isArray(variant?.performanceSnapshots) ? variant.performanceSnapshots : [];
  return all.at(-1) || null;
}
function snapshotAgeHours(variant, reference = Date.now()) {
  const publishedAt = new Date(variant?.publishedAt || variant?.metrics?.publishedAt || 0).getTime();
  return publishedAt ? Math.max(0, (reference - publishedAt) / 3600000) : 0;
}
function pendingPerformanceMilestones(variant, reference = Date.now()) {
  const age = snapshotAgeHours(variant, reference);
  const completed = new Set((variant.performanceSnapshots || []).map((item) => Number(item.milestoneHours)).filter(Boolean));
  return normalizePerformanceSampleHours(state.settings.performanceSampleHours).filter((hours) => age >= hours && !completed.has(hours));
}
function recordMissedPerformanceMilestones(variant, dueMilestones, collectedAt) {
  const latestDue = dueMilestones.at(-1);
  const missed = dueMilestones.slice(0, -1);
  if (!missed.length) return { missed: [], milestone: latestDue || 0 };
  variant.performanceSnapshots ||= [];
  for (const hours of missed) {
    if (variant.performanceSnapshots.some((snapshot) => Number(snapshot.milestoneHours) === hours)) continue;
    variant.performanceSnapshots.push({ capturedAt:collectedAt, source:'missed_schedule', milestoneHours:hours, missing:true, reason:`服务未在发布后${hours}小时运行，无法回补历史数据` });
  }
  variant.performanceSnapshots.sort((left, right) => Number(left.milestoneHours || 0) - Number(right.milestoneHours || 0));
  return { missed, milestone:latestDue || 0 };
}
function performanceBaseline(variant) {
  const peers = state.variants.filter((item) => item.id !== variant.id && item.platform === variant.platform && item.account === variant.account && latestPerformanceSnapshot(item)).slice(0, state.settings.performanceAccountBaselineNotes);
  if (!peers.length) return { sampleSize: 0, exposure: 0, saveRate: 0, interactionRate: 0, note: '账号历史样本不足，本次以绝对阈值与后续快照趋势为主' };
  const values = peers.map((item) => performanceMetricsFromSnapshot(latestPerformanceSnapshot(item)));
  const average = (key) => Math.round(values.reduce((sum, item) => sum + Number(item[key] || 0), 0) / values.length);
  const rate = (fn) => Number((values.reduce((sum, item) => sum + fn(item), 0) / values.length).toFixed(4));
  return { sampleSize: values.length, exposure: average('exposure'), saveRate: rate((item) => item.saves / Math.max(1, item.exposure)), interactionRate: rate((item) => (item.likes + item.saves + item.comments + item.shares) / Math.max(1, item.exposure)), note: '同账号、同平台历史已发布笔记的最近快照均值' };
}
function creatorRowKey(row = {}) {
  if (row.noteId) return `note:${safeText(row.noteId, 80).toLowerCase()}`;
  const href = safeText(row.stableHref || row.hrefs?.[0], 2000);
  if (href) return `href:${href}`;
  const cover = safeText(row.coverUrl, 2000).split('?')[0];
  return `fallback:${normalizeTitle(row.title)}|${safeText(row.publishedAtRaw, 120)}|${cover}`;
}
function validatedXhsPublicationUrl(value) {
  const text = safeText(value, 2000);
  let url;
  try { url = new URL(text); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !(host === 'xhslink.com' || host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com'))) return null;
  url.hash = '';
  return url.toString();
}
async function resolveXhsPublicationIdentity(value) {
  const originalUrl = validatedXhsPublicationUrl(value);
  if (!originalUrl) return { ok:false, message:'请粘贴有效的 HTTPS 小红书笔记链接（xiaohongshu.com 或 xhslink.com）' };
  let resolvedUrl = originalUrl; let noteId = noteIdFromUrl(originalUrl);
  if (!noteId && new URL(originalUrl).hostname.toLowerCase() === 'xhslink.com') {
    for (const method of ['HEAD', 'GET']) {
      try {
        const response = await fetch(originalUrl, { method, redirect:'follow', headers:{ 'user-agent':'Mozilla/5.0 ContentOpsAgent/1.4' }, signal:AbortSignal.timeout(10000) });
        const candidate = validatedXhsPublicationUrl(response.url);
        if (candidate) { resolvedUrl = candidate; noteId = noteIdFromUrl(candidate); }
        try { await response.body?.cancel(); } catch {}
        if (noteId) break;
      } catch {}
    }
  }
  return { ok:true, originalUrl, resolvedUrl, noteId };
}
function publicationDateToken(value) {
  const text = safeText(value, 120);
  const full = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (full) return `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}
function publicationMinuteToken(value) {
  const match = safeText(value, 120).match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?[ T](\d{1,2}):(\d{2})/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')} ${match[4].padStart(2, '0')}:${match[5]}` : '';
}
function matchCreatorRows(rows, variants) {
  const indexed = new Map(); const byNoteId = new Map(); const byRowKey = new Map();
  for (const row of rows || []) {
    row.noteId = safeText(row.noteId || (row.hrefs || []).map(noteIdFromUrl).find(Boolean), 80).toLowerCase();
    row.creatorRowKey = creatorRowKey(row);
    const key = normalizeTitle(row.title); if (key) { const list = indexed.get(key) || []; list.push(row); indexed.set(key, list); }
    if (row.noteId) { const list = byNoteId.get(row.noteId) || []; list.push(row); byNoteId.set(row.noteId, list); }
    if (row.creatorRowKey) { const list = byRowKey.get(row.creatorRowKey) || []; list.push(row); byRowKey.set(row.creatorRowKey, list); }
  }
  const variantTitleCounts = new Map();
  for (const variant of variants) { const key = normalizeTitle(variant.title); if (key) variantTitleCounts.set(key, (variantTitleCounts.get(key) || 0) + 1); }
  const matches = []; const missing = []; const ambiguous = []; const usedRows = new Set();
  for (const variant of variants) {
    const publicationNoteId = safeText(variant.publicationNoteId || noteIdFromUrl(variant.publicationUrl), 80).toLowerCase();
    const boundRows = variant.creatorRowKey ? (byRowKey.get(variant.creatorRowKey) || []).filter((row) => !usedRows.has(row)) : [];
    const idRows = publicationNoteId ? (byNoteId.get(publicationNoteId) || []).filter((row) => !usedRows.has(row)) : [];
    if (boundRows.length === 1) { usedRows.add(boundRows[0]); matches.push({ variant, row:boundRows[0], matchedBy:'creator_row_key', confidence:100 }); continue; }
    if (boundRows.length > 1) { ambiguous.push({ variant, rows:boundRows, reason:'duplicate_creator_row_key' }); continue; }
    if (idRows.length === 1) { usedRows.add(idRows[0]); matches.push({ variant, row:idRows[0], matchedBy:'note_id', confidence:100 }); continue; }
    if (idRows.length > 1) { ambiguous.push({ variant, rows:idRows, reason:'duplicate_note_id' }); continue; }
    const key = normalizeTitle(variant.title);
    let candidates = [...(indexed.get(key) || []), ...[...indexed.entries()].filter(([title]) => title && title !== key && (title.includes(key) || key.includes(title))).flatMap(([, list]) => list)].filter((row) => !usedRows.has(row));
    const publishedMinute = publicationMinuteToken(variant.publishedAt);
    const publishedDate = publicationDateToken(variant.publishedAt);
    if (publishedMinute && candidates.length) {
      const exactMinute = candidates.filter((row) => publicationMinuteToken(row.publishedAtRaw) === publishedMinute);
      if (exactMinute.length) candidates = exactMinute;
    } else if (publishedDate && candidates.length > 1) {
      const dated = candidates.filter((row) => publicationDateToken(row.publishedAtRaw) === publishedDate);
      if (dated.length) candidates = dated;
    }
    if (variantTitleCounts.get(key) > 1 && candidates.length) ambiguous.push({ variant, rows:candidates, reason:'duplicate_variant_title' });
    else if (candidates.length === 1) { usedRows.add(candidates[0]); matches.push({ variant, row:candidates[0], matchedBy:publishedMinute ? 'title_and_minute' : publishedDate ? 'title_and_date' : 'unique_title', confidence:publishedMinute ? 98 : publishedDate ? 90 : 70 }); }
    else if (candidates.length > 1) ambiguous.push({ variant, rows:candidates });
    else missing.push(variant);
  }
  return { matches, missing, ambiguous };
}
async function notifyPerformanceFailure(result) {
  if (!state.settings.feishuWebhook) return;
  const key = `${safeText(result.code, 80)}:${safeText(result.message, 400)}`;
  const lastAt = new Date(state.settings.performanceLastAlertAt || 0).getTime();
  if (state.settings.performanceLastAlertKey === key && Date.now() - lastAt < 60 * 60 * 1000) return;
  await sendFeishu(`【图文爆款Agent】小红书创作后台数据采集已暂停：${result.message}${result.screenshot ? `\n现场截图：${result.screenshot}` : ''}`);
  state.settings.performanceLastAlertKey = key;
  state.settings.performanceLastAlertAt = now();
  saveState();
}
function performanceAutoAttemptAllowed(reference = Date.now()) {
  if (state.settings.performancePausedCode) return false;
  const next = new Date(state.settings.performanceNextAttemptAt || 0).getTime();
  return !next || reference >= next;
}
function deferPerformanceAttempt(minutes = 30) { state.settings.performanceNextAttemptAt = new Date(Date.now() + minutes * 60000).toISOString(); }
function clearPerformancePause() { state.settings.performancePausedCode = ''; state.settings.performanceNextAttemptAt = ''; state.settings.performanceLastAlertKey = ''; state.settings.performanceLastAlertAt = ''; }
async function analyzePublishedPerformance(item, snapshot, { milestoneHours = 0, manual = false } = {}) {
  const generation = masterGeneration;
  if (masterStopped(generation)) return stopResult('人工总控处于停止状态，二次分析不会启动');
  const run = runForVariant(item);
  const metrics = performanceMetricsFromSnapshot(snapshot);
  const baseline = performanceBaseline(item);
  const finalHours = Math.max(...normalizePerformanceSampleHours(state.settings.performanceSampleHours));
  // 人工登记/补录只保存数据与供人查看，绝不绕过最终真实后台观察节点触发二做。
  const final = !manual && milestoneHours >= finalHours && snapshot.source === 'xiaohongshu_creator_center';
  if (run && !manual) { run.status = 'running'; patchRunStep(run, 'performance', { status:'running', detail:`正在二次分析${milestoneHours ? `${milestoneHours}小时` : '最新'}数据` }); }
  let analysisResult = null;
  if (!manual) {
    try { analysisResult = await analyzePerformanceWithAi(item, metrics, baseline, { final }); }
    catch (error) { addActivity('warning', '二次分析模型失败，已使用规则判断', error.message); }
  }
  if (masterStopped(generation)) return stopResult('人工总控已停止，二次分析结果不会写入');
  const preserveAnalysis = manual && ['observation', 'final'].includes(item.performanceAnalysis?.stage);
  const decision = preserveAnalysis ? item.decision : final ? (analysisResult?.analysis?.decision || calculateDecision(metrics, baseline, true)) : 'test';
  item.metrics = metrics;
  item.performanceAnalysis = preserveAnalysis ? { ...item.performanceAnalysis, latestRefreshAt:now() } : final && analysisResult?.analysis ? analysisResult.analysis : { decision, reason: manual ? '人工登记/初始快照仅作记录，不能触发二做；到达观察节点后再读取真实后台数据。' : (final ? '模型不可用，按后台数据与账号基线规则判断' : '阶段性采样，继续观察后续数据节点'), winningElements: [], nextDirections: [], keep: [], change: [], evidence: [], baseline, stage: final ? 'final' : (manual ? 'manual_record' : 'observation'), confidence: 0 };
  item.decision = decision;
  item.status = 'published';
  const publication = state.publications.find((entry) => entry.variantId === item.id);
  const record = publication || { id:uid('pub'), variantId:item.id, workflowRunId:run?.id || item.workflowRunId || '', platform:item.platform, account:item.account, createdAt:now(), snapshots:[] };
  record.metrics = metrics; record.decision = decision; record.analysis = item.performanceAnalysis; record.updatedAt = now(); record.publishedAt = item.publishedAt; record.publicationUrl = item.publicationUrl; record.publicationNoteId = item.publicationNoteId; record.creatorRowKey = item.creatorRowKey; record.creatorMatchedBy = item.creatorMatchedBy; record.creatorMatchConfidence = item.creatorMatchConfidence;
  record.snapshots = Array.isArray(record.snapshots) ? record.snapshots : [];
  record.snapshots = item.performanceSnapshots;
  if (!publication) state.publications.unshift(record);
  if (run && !manual) {
    run.counts.performanceAnalyzed = (run.counts.performanceAnalyzed || 0) + 1;
    run.actualCost += analysisResult?.cost || 0;
    patchRunStep(run, 'performance', { status:'completed', detail: final ? `二次分析结论：${decision}` : `已记录${milestoneHours}小时阶段性数据，继续观察` });
    if (final && decision === 'scale') { patchRunStep(run, 'scale', { status:'waiting_human', detail:'二次分析建议二做，等待人工确认' }); run.status = 'waiting_human'; }
    else if (final) { patchRunStep(run, 'scale', { status:'skipped', detail:decision === 'test' ? '继续观察或补充小批测试，本轮不进入二做' : '表现不足，本轮停止放大' }); finishRun(run, 'completed'); }
    else run.status = 'waiting_human';
  }
  setAgent('data-agent', { status:'healthy', detail: final ? `最新二次分析：${decision}` : `已采集${milestoneHours}小时数据，等待下一观察节点` });
  addActivity(final && decision === 'scale' ? 'success' : 'info', final ? '二次分析完成' : '发布数据快照已保存', `${item.title} · ${manual ? '人工登记/补录' : `${milestoneHours}小时观察`}`);
  saveState();
  return { ok:true, decision, analysis:item.performanceAnalysis, final, aiAnalyzed:Boolean(analysisResult?.ok), metrics };
}
async function collectCreatorPerformance({ variantIds = [], manual = false } = {}) {
  const allowed = new Set((variantIds || []).map((id) => safeText(id, 120)).filter(Boolean));
  const unsupported = allowed.size
    ? state.variants.find((item) => allowed.has(item.id) && item.platform !== '小红书')
    : null;
  if (unsupported) return { ok:false, code:'PLATFORM_PERFORMANCE_NOT_IMPLEMENTED', message:'抖音创作者后台数据采集尚未接入；当前不会把抖音作品误交给小红书后台分析' };
  const variants = state.variants.filter((item) => item.platform === '小红书' && item.status === 'published' && (allowed.size ? allowed.has(item.id) : (manual || pendingPerformanceMilestones(item).length)));
  const probeOnly = manual && !variants.length;
  const generation = masterGeneration;
  const startedWhileMasterEnabled = state.settings.masterEnabled;
  if (!probeOnly && masterStopped(generation)) return stopResult('人工总控处于停止状态，后台数据采集不会启动');
  const browserTask = xhsBrowserBusy();
  if (browserTask) return { ok:false, code:'ALREADY_RUNNING', message:`小红书专用浏览器正在执行“${browserTask}”，后台数据采集稍后再试` };
  const task = (async () => {
    setAgent('data-agent', { status:'running', detail:variants.length ? `正在读取${variants.length}条小红书后台数据` : '正在检查小红书创作后台登录与数据页' });
    const result = await withActiveCollector(createCreatorCenterCollector, (collector) => variants.length ? collector.collect() : collector.probe());
    if (masterStopped(generation) && (!probeOnly || startedWhileMasterEnabled)) return stopResult(probeOnly ? '人工总控已停止，本次创作后台登录检查结果不会覆盖停止状态' : '人工总控已停止，后台数据不会写入或进入二次分析');
    if (!result.ok) {
      const status = result.code === 'LOGIN_REQUIRED' ? 'needs_login' : result.code === 'CAPTCHA' ? 'verification_required' : 'warning';
      if (['LOGIN_REQUIRED', 'CAPTCHA'].includes(result.code)) state.settings.performancePausedCode = result.code;
      if (!manual && !state.settings.performancePausedCode) deferPerformanceAttempt(30);
      setAgent('data-agent', { status, detail:result.message, errorCode:result.code, screenshot:result.screenshot || '' });
      addActivity('warning', '小红书后台数据采集已暂停', result.message); saveState(); await notifyPerformanceFailure(result); return result;
    }
    if (manual) clearPerformancePause();
    if (!variants.length) { const message = manual ? '创作后台登录有效；目前没有已登记发布的小红书笔记可采样' : '创作后台登录有效；目前没有到达采样时间的已发布笔记'; setAgent('data-agent', { status:'ready', detail:message, errorCode:'', screenshot:'' }); addActivity('success', '小红书创作后台状态检查完成', message); saveState(); return { ok:true, sampled:0, loginReady:true, message }; }
    const matched = matchCreatorRows(result.rows, variants); const outcomes = [];
    for (const { variant, row, matchedBy, confidence } of matched.matches) {
      if (masterStopped(generation)) return stopResult('人工总控已停止，后台数据不会写入或进入二次分析');
      variant.publicationNoteId = safeText(variant.publicationNoteId || row.noteId || noteIdFromUrl(variant.publicationUrl), 80).toLowerCase();
      variant.creatorRowKey = creatorRowKey(row);
      variant.creatorMatchedBy = matchedBy;
      variant.creatorMatchConfidence = confidence;
      const snapshot = creatorRowToSnapshot(row, result.collectedAt); const due = pendingPerformanceMilestones(variant);
      const milestone = due.at(-1) || 0;
      snapshot.milestoneHours = milestone || undefined;
      // “manual”只表示人工强制现在读取。只要到达真实观察节点，仍应按创作后台快照执行二次分析；
      // 未到节点时才作为初始快照保存，避免人工按钮提前触发放大。
      const outcome = await analyzePublishedPerformance(variant, snapshot, { milestoneHours:milestone, manual:manual && !milestone });
      if (!outcome.ok) return outcome;
      const { missed } = milestone ? recordMissedPerformanceMilestones(variant, due, result.collectedAt) : { missed:[] };
      variant.performanceSnapshots ||= [];
      variant.performanceSnapshots.push(snapshot); variant.performanceSnapshots = variant.performanceSnapshots.slice(-120);
      if (missed.length) addActivity('warning', '发布数据节点已标记缺失', `${variant.title} · ${missed.join(' / ')}小时未采到历史数据，不伪造回补`);
      outcomes.push(outcome);
    }
    if (matched.missing.length) addActivity('warning', '后台未匹配到部分已发布笔记', `${matched.missing.length}条；请检查发布标题是否被平台截断或尚未出现在数据表`);
    if (matched.ambiguous.length) addActivity('warning', '后台数据匹配存在歧义', `${matched.ambiguous.length}条标题相同或截断相同，已拒绝写入，请人工确认`);
    if (!manual) deferPerformanceAttempt(30);
    setAgent('data-agent', { status:'healthy', detail:`后台采集完成：匹配${matched.matches.length}条，未匹配${matched.missing.length}条，歧义${matched.ambiguous.length}条` }); saveState();
    return { ok:true, sampled:matched.matches.length, missing:matched.missing.map((item) => ({ id:item.id, title:item.title })), ambiguous:matched.ambiguous.map(({ variant, rows }) => ({ id:variant.id, title:variant.title, candidates:rows.length })), outcomes, headers:result.headers };
  })();
  collectionLocks.set('小红书后台', task);
  try { return await task; }
  finally { collectionLocks.delete('小红书后台'); }
}

function deriveGrowth(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return null;
  const prior = Number(snapshots[snapshots.length - 2]?.metrics?.likes || 0);
  const latest = Number(snapshots[snapshots.length - 1]?.metrics?.likes || 0);
  return prior > 0 ? Math.round(((latest - prior) / prior) * 100) : null;
}

function mergeCollectedItems(items) {
  let added = 0; let updated = 0; const candidateIds = []; let lastCandidate = null;
  for (const item of items) {
    const collectedAt = item.collectedAt || now();
    const metrics = {
      likes: finiteNumber(item.likes, 0),
      saves: item.saves === null || item.saves === undefined ? null : finiteNumber(item.saves, 0),
      comments: item.comments === null || item.comments === undefined ? null : finiteNumber(item.comments, 0)
    };
    const detail = {
      parserVersion: 'xhs-detail-v1',
      status: safeText(item.detailStatus, 40) || 'unavailable',
      body: safeText(item.body, 10000),
      tags: (Array.isArray(item.tags) ? item.tags : []).map((tag) => safeText(tag, 80)).filter(Boolean).slice(0, 30),
      publishedAt: safeText(item.publishedAt, 80),
      publishedAtRaw: safeText(item.publishedAtRaw, 160),
      imageUrls: (Array.isArray(item.imageUrls) ? item.imageUrls : []).map((url) => safeText(url, 2000)).filter(Boolean).slice(0, 20),
      contentType: safeText(item.contentType, 40) || 'unknown'
    };
    const snapshot = { collectedAt, keyword: safeText(item.keyword, 60), metrics, detail: { ...detail, imageCount: detail.imageUrls.length }, raw: { likeText: safeText(item.likeText, 40) } };
    const existing = state.candidates.find((candidate) => candidate.platform === '小红书' && candidate.sourceId === item.id);
    if (existing) {
      existing.title = safeText(item.title, 180) || existing.title;
      existing.author = safeText(item.author, 80) || existing.author;
      existing.url = safeText(item.url, 2000) || existing.url;
      existing.coverUrl = safeText(item.coverUrl, 2000) || existing.coverUrl;
      existing.keyword = safeText(item.keyword, 60) || existing.keyword;
      existing.lastCollectedAt = collectedAt;
      existing.metrics = metrics;
      existing.body = detail.body || existing.body || '';
      existing.tags = detail.tags.length ? detail.tags : (existing.tags || []);
      existing.publishedAt = detail.publishedAt || existing.publishedAt || '';
      existing.publishedAtRaw = detail.publishedAtRaw || existing.publishedAtRaw || '';
      existing.imageUrls = detail.imageUrls.length ? detail.imageUrls : (existing.imageUrls || []);
      existing.imageCount = detail.imageUrls.length || existing.imageCount || 0;
      existing.contentType = detail.contentType;
      existing.detailStatus = detail.status;
      existing.parserVersion = detail.parserVersion;
      existing.snapshots = Array.isArray(existing.snapshots) ? existing.snapshots : [];
      existing.snapshots.push(snapshot);
      existing.snapshots = existing.snapshots.slice(-120);
      existing.growth = deriveGrowth(existing.snapshots);
      updated += 1; lastCandidate = existing;
      continue;
    }
    const candidateId = uid('candidate'); candidateIds.push(candidateId);
    const candidate = {
      id: candidateId, platform: '小红书', sourceId: safeText(item.id, 240), url: safeText(item.url, 2000), title: safeText(item.title, 180), author: safeText(item.author, 80) || '未知作者',
      coverUrl: safeText(item.coverUrl, 2000), keyword: safeText(item.keyword, 60), metrics, status: 'new', discoveredAt: collectedAt, lastCollectedAt: collectedAt,
      rawText: Array.isArray(item.rawText) ? item.rawText.slice(0, 12) : [], source: '真实浏览器采集', snapshots: [snapshot], score: null, growth: null,
      tags: detail.tags.length ? detail.tags : ['公开图文', `关键词：${safeText(item.keyword, 40)}`], structure: [], analysis: null, analysisStatus: 'pending', cover: Math.floor(Math.random() * 4),
      body: detail.body, publishedAt: detail.publishedAt, publishedAtRaw: detail.publishedAtRaw, imageUrls: detail.imageUrls, imageCount: detail.imageUrls.length,
      contentType: detail.contentType, detailStatus: detail.status, parserVersion: detail.parserVersion, localQualityScore: finiteNumber(item.localQualityScore, 0, 0, 100), localRelevanceScore: finiteNumber(item.localRelevanceScore, 0, 0, 100), localFilterMode: safeText(item.localFilterMode, 40)
    }; state.candidates.unshift(candidate);
    added += 1; lastCandidate = candidate;
  }
  state.settings.candidatesToday += added;
  return { added, updated, total: items.length, candidateIds, candidate:lastCandidate };
}

function stableCollectedImageIdentity(value) {
  const raw = safeText(value, 2000);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    // 抖音 CDN 的签名 query 与 p3/p6 等边缘域名会轮换；作品图片本体的路径才是稳定身份。
    return decodeURIComponent(parsed.pathname || '').replace(/~tplv-[^/]+$/i, '') || raw.split(/[?#]/, 1)[0];
  } catch { return raw.split(/[?#]/, 1)[0]; }
}

function douyinContentFingerprint(item) {
  return crypto.createHash('sha256').update(JSON.stringify({
    title:item.title || '',
    body:item.body || '',
    imageUrls:(Array.isArray(item.imageUrls) ? item.imageUrls : []).map(stableCollectedImageIdentity).filter(Boolean)
  })).digest('hex');
}

function mergeDouyinLinkItem(item) {
  const collectedAt = item.collectedAt || now();
  const metrics = { likes: finiteNumber(item.likes, 0), saves: item.saves === null || item.saves === undefined ? null : finiteNumber(item.saves, 0), comments: item.comments === null || item.comments === undefined ? null : finiteNumber(item.comments, 0), shares: item.shares === null || item.shares === undefined ? null : finiteNumber(item.shares, 0) };
  const imageUrls = (Array.isArray(item.imageUrls) ? item.imageUrls : []).map((url) => safeText(url, 2000)).filter(Boolean).slice(0, 30);
  const detail = { parserVersion:safeText(item.parserVersion, 80) || 'douyin-browser-link-v1', status:safeText(item.detailStatus, 40) || 'enriched', body:safeText(item.body, 10000), tags:normalizeTextList(item.tags, 30, 80), publishedAt:safeText(item.publishedAt,80), publishedAtRaw:safeText(item.publishedAtRaw,160), imageUrls, contentType:'image_text', sourceMethod:safeText(item.sourceMethod,80) || 'user_submitted_browser' };
  const snapshot = { collectedAt, keyword:safeText(item.keyword, 60) || '人工提交链接', metrics, detail:{ ...detail, imageCount:imageUrls.length }, raw:{ diagnostic:item.diagnostic || {} } };
  const existing = state.candidates.find((candidate) => candidate.platform === '抖音' && candidate.sourceId === safeText(item.id, 240));
  if (existing) {
    const priorContentFingerprint = douyinContentFingerprint(existing);
    Object.assign(existing, { title:safeText(item.title,180) || existing.title, author:safeText(item.author,80) || existing.author, url:safeText(item.url,2000) || existing.url, coverUrl:imageUrls[0] || existing.coverUrl || '', metrics, body:detail.body || existing.body || '', tags:detail.tags.length ? detail.tags : existing.tags, publishedAt:detail.publishedAt || existing.publishedAt || '', publishedAtRaw:detail.publishedAtRaw || existing.publishedAtRaw || '', imageUrls:imageUrls.length ? imageUrls : existing.imageUrls || [], imageCount:imageUrls.length || existing.imageCount || 0, contentType:'image_text', detailStatus:detail.status, parserVersion:detail.parserVersion, lastCollectedAt:collectedAt, source:'抖音公开链接导入' });
    const nextContentFingerprint = douyinContentFingerprint(existing);
    if (priorContentFingerprint !== nextContentFingerprint) Object.assign(existing, {
      score:null,
      analysis:null,
      textAnalysis:null,
      visionAnalysis:null,
      analysisStatus:'pending',
      visionImageCount:0,
      textFingerprint:'',
      visionFingerprint:'',
      textAnalyzedAt:'',
      visionAnalyzedAt:'',
      analyzedAt:'',
      analysisTask:{},
      structure:[]
    });
    existing.snapshots = Array.isArray(existing.snapshots) ? existing.snapshots : []; existing.snapshots.push(snapshot); existing.snapshots = existing.snapshots.slice(-120); existing.growth = deriveGrowth(existing.snapshots); return { added:0, updated:1, candidate:existing };
  }
  const candidate = { id:uid('candidate'), platform:'抖音', sourceId:safeText(item.id,240), url:safeText(item.url,2000), title:safeText(item.title,180), author:safeText(item.author,80) || '未知作者', coverUrl:imageUrls[0] || '', keyword:'人工提交链接', metrics, status:'new', discoveredAt:collectedAt, lastCollectedAt:collectedAt, rawText:Array.isArray(item.rawText) ? item.rawText.slice(0,12) : [], source:'抖音公开链接导入', snapshots:[snapshot], score:null, growth:null, tags:detail.tags.length ? detail.tags : ['公开图文','抖音'], structure:[], analysis:null, analysisStatus:'pending', cover:Math.floor(Math.random()*4), body:detail.body, publishedAt:detail.publishedAt, publishedAtRaw:detail.publishedAtRaw, imageUrls, imageCount:imageUrls.length, contentType:'image_text', detailStatus:detail.status, parserVersion:detail.parserVersion, localQualityScore:0, localRelevanceScore:0, localFilterMode:'manual_link' };
  state.candidates.unshift(candidate); return { added:1, updated:0, candidate };
}

function mergeDouyinCollectedItems(items) {
  let added = 0; let updated = 0; const candidateIds = [];
  for (const item of items) {
    const result = mergeDouyinLinkItem(item);
    added += result.added; updated += result.updated;
    if (result.candidate?.id) candidateIds.push(result.candidate.id);
    const candidate = result.candidate;
    if (candidate) {
      candidate.keyword = safeText(item.keyword, 60) || candidate.keyword;
      candidate.source = '抖音真实浏览器采集';
      candidate.localQualityScore = finiteNumber(item.localQualityScore, 0, 0, 100);
      candidate.localRelevanceScore = finiteNumber(item.localRelevanceScore, 0, 0, 100);
      candidate.localFilterMode = safeText(item.localFilterMode, 40) || 'manual_standard';
    }
  }
  state.settings.candidatesToday += added;
  return { added, updated, total:items.length, candidateIds };
}

function normalizeAnalysis(data) {
  return {
    summary: safeText(data?.summary, 500), hooks: (Array.isArray(data?.hooks) ? data.hooks : []).map((item) => safeText(item, 120)).filter(Boolean).slice(0, 3),
    valuePoints: (Array.isArray(data?.valuePoints) ? data.valuePoints : []).map((item) => safeText(item, 160)).filter(Boolean).slice(0, 3),
    concerns: (Array.isArray(data?.concerns) ? data.concerns : []).map((item) => safeText(item, 160)).filter(Boolean).slice(0, 3),
    risks: (Array.isArray(data?.risks) ? data.risks : []).map((item) => safeText(item, 160)).filter(Boolean).slice(0, 4), recommended: Boolean(data?.recommended)
  };
}

function normalizeVisionAnalysis(data) {
  return {
    visualScore: finiteNumber(data?.visualScore, 0, 0, 100), coverHook: safeText(data?.coverHook, 500), visualSummary: safeText(data?.visualSummary, 800),
    pages: (Array.isArray(data?.pages) ? data.pages : []).slice(0, 20).map((page, index) => ({ index: finiteNumber(page?.index, index + 1, 1, 30), visibleText: safeText(page?.visibleText, 3000), scene: safeText(page?.scene, 800), layout: safeText(page?.layout, 800), colors: safeText(page?.colors, 500), role: safeText(page?.role, 800) })),
    sequence: (Array.isArray(data?.sequence) ? data.sequence : []).map((item) => safeText(item, 500)).filter(Boolean).slice(0, 12),
    visualHooks: (Array.isArray(data?.visualHooks) ? data.visualHooks : []).map((item) => safeText(item, 500)).filter(Boolean).slice(0, 6),
    generationHints: (Array.isArray(data?.generationHints) ? data.generationHints : []).map((item) => safeText(item, 1000)).filter(Boolean).slice(0, 12),
    risks: (Array.isArray(data?.risks) ? data.risks : []).map((item) => safeText(item, 500)).filter(Boolean).slice(0, 10),
    lowConfidencePages: (Array.isArray(data?.lowConfidencePages) ? data.lowConfidencePages : []).map((item) => finiteNumber(item, 0, 0, 30)).filter(Boolean)
  };
}

function visualFingerprint(candidate) {
  return crypto.createHash('sha256').update(JSON.stringify({ model: activeModelFingerprint('vision'), urls: (candidate.imageUrls || []).slice(0, state.settings.visionMaxImages) })).digest('hex');
}

function isTransientApiError(error) {
  const message = String(error?.message || error || '');
  return /timeout|timed out|abort|fetch failed|ECONN|ENET|socket|network|HTTP (408|409|425|429|500|502|503|504)|资源不足|upstream/i.test(message);
}
function retryAt(attempt) { return new Date(Date.now() + Math.min(60000, 1500 * (2 ** Math.max(0, attempt - 1)))).toISOString(); }
async function withApiRetry(candidate, stage, action) {
  const maximum = finiteNumber(state.settings.analysisAutoRetryCount, 2, 0, 3);
  let attempt = 0;
  while (true) {
    try { return await action(); }
    catch (error) {
      attempt += 1;
      candidate.analysisTask ||= {};
      candidate.analysisTask[stage] = { status: attempt <= maximum && isTransientApiError(error) ? 'retrying' : 'failed', attempts:attempt, lastError:safeText(error.message, 800), nextRetryAt:attempt <= maximum && isTransientApiError(error) ? retryAt(attempt) : '', updatedAt:now() };
      saveState();
      if (attempt > maximum || !isTransientApiError(error)) throw error;
      addActivity('warning', `${stage}临时失败，自动重试`, `${candidate.title} · 第${attempt}/${maximum}次：${error.message}`);
      await sleep(Math.min(60000, 1500 * (2 ** (attempt - 1))));
    }
  }
}

async function analyzeCandidate(candidate) {
  const generation = masterGeneration; if (masterStopped(generation)) return stopResult();
  if (candidate.detailStatus !== 'enriched' || (!String(candidate.body || '').trim() && !(candidate.imageUrls || []).length)) return { ok: false, code: 'DETAIL_REQUIRED', message: '该素材没有可分析的正文或图片详情' };
  if (!aiReady()) return { ok: false, code: 'TEXT_AI_NOT_CONFIGURED', message: '还需配置并验证文本模型 API' };
  if (!visionReady()) return { ok: false, code: 'VISION_AI_NOT_CONFIGURED', message: '还需配置并验证视觉模型 API' };
  if (state.settings.analysesToday >= state.settings.aiAnalysisLimit) return { ok: false, code: 'AI_LIMIT', message: '今日 AI 预选上限已达到' };
  if (budgetRemaining() <= 0) return { ok: false, code: 'TEXT_BUDGET_LIMIT', message: '今日文本模型预算已耗尽' };
  if (visionBudgetRemaining() <= 0) return { ok: false, code: 'VISION_BUDGET_LIMIT', message: '今日视觉模型预算已耗尽' };
  setAgent('analyst', { status: 'running', detail: `并行文本与视觉分析：${candidate.title}` }); candidate.analysisStatus = 'analyzing'; candidate.analysisTask ||= {}; saveState();
  const textPrompt = candidateTextAnalysisPrompt(candidate);
  const fingerprint = visualFingerprint(candidate);
  const images = (candidate.imageUrls || []).slice(0, finiteNumber(state.settings.visionMaxImages, 12, 1, 20));
  const textWork = async () => {
    if (candidate.textAnalysis && candidate.textFingerprint === crypto.createHash('sha256').update(`${activeModelFingerprint('text')}|${textPrompt}`).digest('hex')) return { cost:0, cached:true };
    const reservation = reserveCall('text', textPrompt.length + SYSTEM.length, 2500, '候选文本初析'); if (!reservation.ok) throw new Error(reservation.message);
    const result = await withApiRetry(candidate, 'text', () => callJson({ ...activeConnection('text'), system:SYSTEM, prompt:textPrompt, maxOutputTokens:Math.min(outputTokenLimit('text', 2500), 2500), timeoutMs:activeConnection('text').requestTimeoutMs }));
    if (masterStopped(generation)) return stopResult(); candidate.textAnalysis = result.data; candidate.textFingerprint = crypto.createHash('sha256').update(`${activeModelFingerprint('text')}|${textPrompt}`).digest('hex'); candidate.textAnalyzedAt = now(); candidate.analysisTask.text = { status:'completed', attempts:Number(candidate.analysisTask.text?.attempts || 0), updatedAt:now() }; return { cost:recordAiUsage(result.usage, '候选文本初析') };
  };
  const visionWork = async () => {
    if (candidate.visionAnalysis && candidate.visionFingerprint === fingerprint) return { cost:0, cached:true };
    const visionPrompt = candidateVisionPrompt(candidate, images.length); const reservation = reserveCall('vision', visionPrompt.length + images.length * 2000, 3500, '候选视觉拆解'); if (!reservation.ok) throw new Error(reservation.message);
    const result = await withApiRetry(candidate, 'vision', () => callVisionJson({ ...activeConnection('vision'), prompt:visionPrompt, imageUrls:images, maxOutputTokens:Math.min(outputTokenLimit('vision', 3500), 3500), timeoutMs:activeConnection('vision').requestTimeoutMs }));
    if (masterStopped(generation)) return stopResult(); candidate.visionAnalysis = normalizeVisionAnalysis(result.data); candidate.visionFingerprint = fingerprint; candidate.visionAnalyzedAt = now(); candidate.visionImageCount = result.imageCount; candidate.analysisTask.vision = { status:'completed', attempts:Number(candidate.analysisTask.vision?.attempts || 0), updatedAt:now() }; return { cost:recordVisionUsage(result.usage, '候选视觉拆解') };
  };
  const [textDone, visionDone] = await Promise.all([textWork(), visionWork()]);
  if (textDone?.code === 'MASTER_STOPPED' || visionDone?.code === 'MASTER_STOPPED') return stopResult();
  const textCost = textDone?.cost || 0; const visionCost = visionDone?.cost || 0;
  setAgent('analyst', { status: 'running', detail: `综合复审：${candidate.title}` }); candidate.analysisStatus = 'synthesizing'; saveState();
  if (masterStopped(generation)) return stopResult(); const synthesisPrompt = candidateSynthesisPrompt(candidate, candidate.textAnalysis, candidate.visionAnalysis); const synthesisReservation = reserveCall('text', synthesisPrompt.length + SYSTEM.length, 4000, '候选综合复审'); if (!synthesisReservation.ok) return synthesisReservation;
  const synthesis = await callJson({ baseUrl: activeConnection('text').baseUrl, apiKey: activeConnection('text').apiKey, model: activeConnection('text').model, system: SYSTEM, prompt: synthesisPrompt, timeoutMs: 90000, maxOutputTokens: Math.min(outputTokenLimit('text', 4000), 4000) });
  if (masterStopped(generation)) return stopResult(); candidate.score = finiteNumber(synthesis.data?.score, 0, 0, 100);
  candidate.tags = (Array.isArray(synthesis.data?.tags) ? synthesis.data.tags : []).map((item) => safeText(item, 60)).filter(Boolean).slice(0, 4);
  candidate.structure = (Array.isArray(synthesis.data?.structure) ? synthesis.data.structure : []).map((item) => safeText(item, 120)).filter(Boolean).slice(0, 6);
  candidate.analysis = { ...normalizeAnalysis(synthesis.data), productionBlueprint: synthesis.data?.productionBlueprint || {} };
  candidate.analysisStatus = 'completed'; candidate.analyzedAt = now(); state.settings.analysesToday += 1;
  const synthesisCost = recordAiUsage(synthesis.usage, '候选综合复审'); const cost = textCost + visionCost + synthesisCost;
  setAgent('analyst', { status: 'healthy', detail: `最近完成：${candidate.title} · ${candidate.score}分` }); saveState();
  return { ok: true, candidate, cost, textCost: textCost + synthesisCost, visionCost };
}

async function analyzePendingCandidates(limit = 20, candidateIds = null) {
  const allowed = Array.isArray(candidateIds) ? new Set(candidateIds) : null;
  const pending = state.candidates.filter((item) => (!allowed || allowed.has(item.id)) && !['ignored'].includes(item.status) && item.analysisStatus !== 'completed');
  for (const candidate of pending) {
    if (candidate.detailStatus !== 'enriched' || !(candidate.imageUrls || []).length) candidate.analysisStatus = 'waiting_detail_or_vision';
  }
  const targets = pending.filter((item) => item.detailStatus === 'enriched' && (item.imageUrls || []).length).slice(0, Math.max(1, Math.min(50, limit)));
  const concurrency = finiteNumber(state.settings.analysisConcurrency, 3, 1, 5);
  let cursor = 0; const results = [];
  const worker = async () => {
    while (cursor < targets.length && !masterStopped()) {
      const candidate = targets[cursor++];
      try { results.push({ candidate, result:await analyzeCandidate(candidate) }); }
      catch (error) {
        candidate.analysisStatus = 'retryable_failed'; candidate.analysisTask ||= {}; candidate.analysisTask.lastFailure = { status:'retryable_failed', lastError:safeText(error.message, 800), updatedAt:now() };
        addActivity('warning', '候选分析待重试', `${candidate.title} · ${error.message}`); results.push({ candidate, error }); saveState();
      }
    }
  };
  await Promise.all(Array.from({ length:Math.min(concurrency, targets.length) }, worker));
  const stopped = masterStopped();
  const analyzed = results.filter((item) => item.result?.ok).length;
  const cost = results.reduce((sum, item) => sum + Number(item.result?.cost || 0), 0);
  const failures = results.filter((item) => item.error || (item.result && !item.result.ok)).map((item) => item.error ? { code:'AI_ERROR', message:item.error.message, candidateId:item.candidate.id } : { ...item.result, candidateId:item.candidate.id });
  if (stopped) failures.push(stopResult());
  saveState(); return { ok: !stopped, analyzed, cost: Number(cost.toFixed(4)), failures, retryable:failures.filter((item) => item.code !== 'MASTER_STOPPED').length, concurrency };
}

async function runWorkflow(trigger = 'manual') {
  if (!state.settings.masterEnabled) return stopResult('人工总控处于停止状态，请先点击“开始总控”');
  if (!analysisReady() && process.env.CONTENTOPS_TEST_ALLOW_UNVERIFIED !== '1') return { ok: false, code: 'ANALYSIS_NOT_READY', message: '请先保存并分别验证文本模型与视觉模型 Key，再启动完整工作流' };
  if (workflowPromise) return { ok: false, code: 'WORKFLOW_RUNNING', message: '已有一轮工作流正在运行' };
  const run = createWorkflowRun(trigger); setAgent('orchestrator', { status: 'running', detail: `${trigger === 'manual' ? '人工' : '定时'}触发 · 正在准备抓取` }); saveState();
  workflowPromise = (async () => {
    run.status = 'running'; patchRunStep(run, 'collect', { status: 'running', detail: `正在采集已启用平台` }); saveState();
    const platforms = [['小红书', state.settings.xhsEnabled], ['抖音', state.settings.douyinEnabled]].filter(([, enabled]) => enabled).map(([platform]) => platform);
    if (!platforms.length) { const collected = { ok:false, code:'NO_PLATFORM', message:'请至少启用一个采集平台' }; patchRunStep(run, 'collect', { status:'blocked', detail:collected.message }); finishRun(run, 'blocked', collected.message); saveState(); return { ok:false, run, ...collected }; }
    const collectionResults = []; const platformFailures = [];
    for (const platform of platforms) {
      const collected = await runCollection(platform, { manual: trigger === 'manual', workflowTrigger: trigger });
      if (collected.code === 'MASTER_STOPPED' || run.status === 'cancelled') return { ok:false, run, ...collected };
      if (!collected.ok) { platformFailures.push({ platform, code:collected.code || 'COLLECTOR_ERROR', message:collected.message }); continue; }
      collectionResults.push(collected);
    }
    if (!collectionResults.length) { const failure = platformFailures[0] || { code:'COLLECTOR_ERROR', message:'所有已启用平台均未完成采集' }; patchRunStep(run, 'collect', { status:'blocked', detail:`${failure.platform || '采集'}：${failure.message}` }); finishRun(run, 'blocked', failure.message); setAgent('orchestrator', { status:'warning', detail:failure.message }); saveState(); return { ok:false, run, ...failure }; }
    if (platformFailures.length) addActivity('warning', '部分平台采集暂停', platformFailures.map((item) => `${item.platform}：${item.message}`).join('；'));
    const collected = { ok:true, added:collectionResults.reduce((sum, item) => sum + Number(item.added || 0), 0), updated:collectionResults.reduce((sum, item) => sum + Number(item.updated || 0), 0), candidateIds:collectionResults.flatMap((item) => item.candidateIds || []), filterStats:{ raw:collectionResults.reduce((sum, item) => sum + Number(item.filterStats?.raw || 0), 0) }, filtered:collectionResults.reduce((sum, item) => sum + Number(item.filtered || 0), 0), platformFailures };
    run.candidateIds = [...(collected.candidateIds || [])]; run.counts.raw = Number(collected.filterStats?.raw || 0); run.counts.filtered = Number(collected.filtered || 0); run.counts.collected = Number(collected.added || 0) + Number(collected.updated || 0); patchRunStep(run, 'collect', { status: 'completed', detail: `原始${run.counts.raw} · 过筛${run.counts.filtered} · 入选${run.counts.collected}` });
    patchRunStep(run, 'analyze', { status: 'running', detail: '正在调用模型进行爆款预选' }); saveState();
    if (!analysisReady() && process.env.CONTENTOPS_TEST_ALLOW_UNVERIFIED !== '1') { const message = !aiReady() ? '文本模型 API 未配置' : '视觉模型 API 未配置'; patchRunStep(run, 'analyze', { status: 'blocked', detail: message }); finishRun(run, 'blocked', `抓取已完成，但${message}`); setAgent('orchestrator', { status: 'warning', detail: `抓取完成，等待配置${message}` }); saveState(); return { ok: false, code: !aiReady() ? 'TEXT_AI_NOT_CONFIGURED' : 'VISION_AI_NOT_CONFIGURED', message: `抓取已完成；${message}`, run, collection: collected }; }
    const analyzed = await analyzePendingCandidates(Math.min(state.settings.aiAnalysisLimit, run.targets.finalLimit), collected.candidateIds);
    run.counts.analyzed = analyzed.analyzed; run.actualCost += analyzed.cost || 0;
    if (analyzed.failures.some((failure) => failure.code === 'MASTER_STOPPED') || run.status === 'cancelled') return { ok: false, code:'MASTER_STOPPED', message:'人工总控已停止', run };
    patchRunStep(run, 'analyze', { status: analyzed.failures.length ? 'partial' : 'completed', detail: `完成${analyzed.analyzed}条预选${analyzed.failures.length ? `，${analyzed.failures.length}条待重试` : ''}` });
    if (analyzed.failures.length) addActivity('warning', '本轮分析部分待重试', `${analyzed.analyzed}条完成，${analyzed.failures.length}条未完成；其余候选与工作流继续执行`);
    run.candidateIds = (collected.candidateIds || []).filter((id) => state.candidates.some((item) => item.id === id && item.analysisStatus === 'completed' && item.status === 'new')).slice(0, run.targets.finalLimit);
    if (!run.candidateIds.length) { patchRunStep(run, 'select', { status: 'skipped', detail: '本轮没有达到门槛的新候选' }); finishRun(run, 'completed'); setAgent('orchestrator', { status: 'idle', detail: '本轮筛选完成，没有值得进入人工选款的新素材' }); addActivity('info', '本轮宁缺毋滥', `运行 ${run.id} · 没有新增高质量候选`); saveState(); return { ok: true, run, collection: collected, analysis: analyzed }; }
    patchRunStep(run, 'select', { status: 'waiting_human', detail: '等待人工确认值得生产的方向' }); run.status = 'waiting_human'; run.currentStep = 'select'; setAgent('orchestrator', { status: analyzed.failures.length ? 'warning' : 'idle', detail: `本轮完成${analyzed.analyzed}条AI预选${analyzed.failures.length ? `，另有${analyzed.failures.length}条待重试` : ''}` }); addActivity('success', '工作流到达人工闸门', `运行 ${run.id} · 等待人工选款`); saveState();
    return { ok: true, run, collection: collected, analysis: analyzed };
  })();
  try { return await workflowPromise; }
  finally {
    // workflowPromise is part of the public runtime state. Persist once after
    // clearing it so polling clients immediately observe the settled state.
    workflowPromise = null;
    saveState();
  }
}

async function resumeBlockedWorkflow() {
  if (!state.settings.masterEnabled) return stopResult('人工总控处于停止状态，请先点击开始总控');
  const run = state.workflowRuns.find((item) => item.status === 'blocked' && ['collect', 'analyze'].includes(item.currentStep));
  if (!run) return { ok: false, code: 'NO_RESUMABLE_RUN', message: '没有可继续的受阻工作流，请启动新一轮' };
  if (workflowPromise) return { ok: false, code: 'WORKFLOW_RUNNING', message: '已有一轮工作流正在运行' };
  workflowPromise = (async () => {
    let resumePlatformFailures = [];
    run.error = ''; run.finishedAt = ''; run.status = 'running'; setAgent('orchestrator', { status: 'running', detail: `正在继续运行 ${run.id}` });
    if (run.currentStep === 'collect') {
      const configuredPlatforms = Array.isArray(run.targets?.platforms) && run.targets.platforms.length ? run.targets.platforms.map((item) => item.platform) : [run.targets?.platform || '小红书'];
      const platforms = [...new Set(configuredPlatforms.filter((platform) => ['小红书','抖音'].includes(platform)))];
      if (!platforms.length) { const failure={ ok:false, code:'NO_PLATFORM', message:'该历史任务缺少可恢复的平台配置', run }; patchRunStep(run, 'collect', { status:'blocked', detail:failure.message }); finishRun(run, 'blocked', failure.message); setAgent('orchestrator', { status:'warning', detail:failure.message }); saveState(); return failure; }
      patchRunStep(run, 'collect', { status: 'running', detail: `正在重新执行${platforms.join('、')}抓取` }); saveState();
      const results = []; const platformFailures = [];
      for (const platform of platforms) {
        const collected = await runCollection(platform, { manual: true, workflowTrigger: run.trigger });
        if (collected.code === 'MASTER_STOPPED' || run.status === 'cancelled') return { ok:false, run, ...collected };
        if (!collected.ok) { platformFailures.push({ platform, code:collected.code || 'COLLECTOR_ERROR', message:collected.message }); continue; }
        results.push(collected);
      }
      if (!results.length) {
        const failure = platformFailures[0] || { code:'COLLECTOR_ERROR', message:'所有已启用平台均未完成采集' };
        patchRunStep(run, 'collect', { status:'blocked', detail:`${failure.platform || '采集'}：${failure.message}` }); finishRun(run, 'blocked', failure.message); setAgent('orchestrator', { status:'warning', detail:`恢复任务失败：${failure.message}` }); saveState(); return { ok:false, run, ...failure };
      }
      resumePlatformFailures = platformFailures;
      if (platformFailures.length) addActivity('warning', '恢复任务时部分平台采集暂停', platformFailures.map((item) => `${item.platform}：${item.message}`).join('；'));
      const collected = {
        ok:true,
        added:results.reduce((sum, item) => sum + Number(item.added || 0), 0),
        updated:results.reduce((sum, item) => sum + Number(item.updated || 0), 0),
        candidateIds:results.flatMap((item) => item.candidateIds || []),
        raw:results.reduce((sum, item) => sum + Number(item.filterStats?.raw || 0), 0),
        filtered:results.reduce((sum, item) => sum + Number(item.filtered || 0), 0),
        platformFailures
      };
      run.counts.raw = Number(run.counts.raw || 0) + collected.raw;
      run.counts.filtered = Number(run.counts.filtered || 0) + collected.filtered;
      run.counts.collected = Number(run.counts.collected || 0) + Number(collected.added || 0) + Number(collected.updated || 0);
      patchRunStep(run, 'collect', { status: platformFailures.length ? 'partial' : 'completed', detail: `新增${collected.added || 0} · 更新${collected.updated || 0}${platformFailures.length ? ` · ${platformFailures.length}个平台待处理` : ''}` });
      if (masterStopped()) { patchRunStep(run, 'analyze', { status: 'blocked', detail: '人工总控已停止' }); finishRun(run, 'blocked', '人工总控已停止'); saveState(); return stopResult(); }
      run.candidateIds = [...(collected.candidateIds || [])];
    }
    if (!analysisReady() && process.env.CONTENTOPS_TEST_ALLOW_UNVERIFIED !== '1') { const message = !aiReady() ? '文本模型 API 未配置' : '视觉模型 API 未配置'; patchRunStep(run, 'analyze', { status: 'blocked', detail: message }); finishRun(run, 'blocked', message); setAgent('orchestrator', { status:'warning', detail:`恢复任务等待配置：${message}` }); saveState(); return { ok: false, code: !aiReady() ? 'TEXT_AI_NOT_CONFIGURED' : 'VISION_AI_NOT_CONFIGURED', message: `请先配置并测试${message}`, run }; }
    patchRunStep(run, 'analyze', { status: 'running', detail: '正在继续 AI 爆款预选' }); saveState();
    const finalLimit = finiteNumber(run.targets?.finalLimit, state.settings.manualFinalLimit, 1, 50);
    const analyzed = await analyzePendingCandidates(Math.min(state.settings.aiAnalysisLimit, finalLimit), run.candidateIds);
    run.counts.analyzed = Number(run.counts.analyzed || 0) + analyzed.analyzed; run.actualCost = Number(run.actualCost || 0) + Number(analyzed.cost || 0);
    if (analyzed.failures.some((failure) => failure.code === 'MASTER_STOPPED') || run.status === 'cancelled') return { ok:false, code:'MASTER_STOPPED', message:'人工总控已停止', run };
    patchRunStep(run, 'analyze', { status: analyzed.failures.length ? 'partial' : 'completed', detail: `累计完成${run.counts.analyzed}条预选${analyzed.failures.length ? `，${analyzed.failures.length}条待重试` : ''}` });
    if (analyzed.failures.length) addActivity('warning', '恢复任务时分析部分待重试', `${analyzed.analyzed}条完成，${analyzed.failures.length}条未完成；已完成结果继续进入人工关卡`);
    run.candidateIds = (run.candidateIds || []).filter((id) => state.candidates.some((item) => item.id === id && item.analysisStatus === 'completed' && item.status === 'new')).slice(0, finalLimit);
    const hasPartialFailure = Boolean(resumePlatformFailures.length || analyzed.failures.length);
    if (!run.candidateIds.length) { patchRunStep(run, 'select', { status:'skipped', detail:'本轮没有达到门槛的新候选' }); finishRun(run, 'completed'); setAgent('orchestrator', { status:hasPartialFailure ? 'warning' : 'idle', detail:hasPartialFailure ? '恢复任务已完成，但有平台或分析任务待处理' : '恢复任务已完成，没有值得进入人工选款的新素材' }); addActivity('info', '受阻工作流恢复完成', `${run.id} · 没有新增高质量候选`); saveState(); return { ok:true, resumed:true, run, analysis:analyzed, platformFailures:resumePlatformFailures }; }
    patchRunStep(run, 'select', { status: 'waiting_human', detail: '等待人工确认值得生产的方向' }); run.status = 'waiting_human'; setAgent('orchestrator', { status:hasPartialFailure ? 'warning' : 'idle', detail:hasPartialFailure ? '已继续到人工选款关卡；另有平台或分析任务待处理' : '已继续到人工选款关卡' }); addActivity('success', '受阻工作流已继续', `${run.id} · 等待人工选款`); saveState();
    return { ok: true, resumed: true, run, platformFailures:resumePlatformFailures };
  })();
  try { return await workflowPromise; }
  finally {
    workflowPromise = null;
    saveState();
  }
}

async function notifyCollectorFailure(result) {
  if (!state.settings.feishuWebhook) return;
  await sendFeishu(`【图文爆款Agent】${result.platform || '小红书'}采集已暂停：${result.message}${result.screenshot ? `\n截图：${result.screenshot}` : ''}`);
}

async function runCollection(platform, { manual = false, workflowTrigger = manual ? 'manual' : 'scheduled' } = {}) {
  const generation = masterGeneration;
  if (!state.settings.masterEnabled) return stopResult('人工总控处于停止状态，抓取不会启动');
  resetDailyUsageIfNeeded();
  if (!['小红书', '抖音'].includes(platform)) return { ok: false, message: '不支持的平台' };
  if (!manual && !state.settings.collectionEnabled) return { ok: false, code: 'AUTOMATION_DISABLED', message: '24小时自动工作流已关闭' };
  const currentAgent = state.agents.find((item) => item.id === (platform === '抖音' ? 'douyin-collector' : 'xhs-collector'));
  if (!manual && ['needs_login', 'verification_required'].includes(currentAgent?.status)) return { ok: false, code: currentAgent.status === 'needs_login' ? 'LOGIN_REQUIRED' : 'CAPTCHA', message: currentAgent.detail || '小红书需要人工处理后才能恢复定时采集' };
  const enabled = platform === '小红书' ? state.settings.xhsEnabled : state.settings.douyinEnabled;
  if (!enabled) return { ok: false, message: `${platform}采集已关闭` };
  if (platform === '抖音' && douyinBrowserBusy()) return { ok: false, code: 'ALREADY_RUNNING', message: '抖音专用浏览器正在执行另一项采集、链接导入或登录任务，请等待完成' };
  if (platform === '小红书' && xhsBrowserBusy()) return { ok:false, code:'ALREADY_RUNNING', message:'小红书专用浏览器正在执行登录检查、链接导入或后台采样，请等待完成' };
  if (collectionLocks.has(platform)) return { ok: false, code: 'ALREADY_RUNNING', message: `${platform}采集任务正在运行，请勿重复启动` };
  if (SELF_TEST && !process.env.CONTENTOPS_XHS_SEARCH_BASE_URL) {
    if (Number(state.settings.candidatesToday || 0) >= Number(state.settings.dailyCandidateLimit || 0)) {
      addActivity('warning', '候选新增额度已满', '本轮不新增候选；真实采集仍会继续更新已存在候选的历史快照'); saveState();
      return { ok: true, added: 0, updated: 0, total: 0, capped: true, testMode: true };
    }
    const candidate = selectSeed(platform); state.candidates.unshift(candidate); state.settings.candidatesToday += 1; saveState(); return { ok: true, candidate, added: 1, updated: 0, total: 1, testMode: true };
  }
  if (platform === '抖音') {
    const task = (async () => {
      setAgent('douyin-collector', { status:'running', detail:'正在低频搜索公开抖音图文' }); addActivity('info', '抖音开始采集', `关键词：${state.settings.douyinKeywords.join('、')}`); saveState();
      const automatic = workflowTrigger === 'scheduled'; const rawLimit = automatic ? state.settings.automaticRawLimit : state.settings.manualRawLimit; const finalLimit = automatic ? state.settings.automaticFinalLimit : state.settings.manualFinalLimit;
      const result = await withActiveCollector(createDouyinCollector, (collector) => collector.collect({ keywords:state.settings.douyinKeywords, rawLimit, detailLimit:automatic ? Math.min(rawLimit, Math.max(finalLimit * 3, 20)) : Math.min(rawLimit, Math.max(finalLimit * 2, 10)), finalLimit, strict:automatic, delayMs:state.settings.douyinDelayMs, shouldStop:() => masterStopped(generation), onProgress:({ keyword, stage, count, detailIndex, detailTotal }) => { if (masterStopped(generation)) return; setAgent('douyin-collector', { status:'running', detail:stage === 'detail' ? `正在读取图文：${keyword} · ${Number(detailIndex || 0) + 1}/${detailTotal || 0}` : stage === 'done' ? `${keyword} 已识别 ${count} 条` : `正在搜索：${keyword}` }); } }));
      if (masterStopped(generation)) return stopResult('人工总控已停止，抖音抓取结果不会写入');
      if (!result.ok) { const status = result.code === 'MASTER_STOPPED' ? 'idle' : result.code === 'LOGIN_REQUIRED' ? 'needs_login' : result.code === 'CAPTCHA' ? 'verification_required' : 'warning'; setAgent('douyin-collector', { status, detail:result.message, errorCode:result.code, screenshot:result.screenshot || '' }); addActivity(result.code === 'MASTER_STOPPED' ? 'info' : 'warning', result.code === 'MASTER_STOPPED' ? '抖音采集已停止' : '抖音采集已暂停', result.message); saveState(); if (result.code !== 'MASTER_STOPPED') await notifyCollectorFailure({ ...result, platform:'抖音' }); return result; }
      const existingIds = new Set(state.candidates.filter((candidate) => candidate.platform === '抖音').map((candidate) => candidate.sourceId)); let allowance = Math.max(0, Number(state.settings.dailyCandidateLimit) - Number(state.settings.candidatesToday || 0));
      const accepted = result.items.filter((item) => existingIds.has(item.id) || allowance-- > 0); const summary = mergeDouyinCollectedItems(accepted); const filtered = Number(result.filterStats?.raw || 0) - Number(result.filterStats?.qualified || 0);
      setAgent('douyin-collector', { status:'ready', detail:`最近采集：新增 ${summary.added} 条，更新 ${summary.updated} 条`, errorCode:'', screenshot:'' }); addActivity('success', '抖音采集完成', `${automatic ? '自动严格模式' : '手动标准模式'} · 原始 ${result.filterStats?.raw || 0} 条，淘汰 ${Math.max(0, filtered)} 条，入选 ${summary.total} 条`); saveState(); return { ok:true, ...summary, message:result.message || '', filtered:Math.max(0, filtered), enriched:accepted.length, filterStats:result.filterStats, warnings:result.warnings || [] };
    })();
    collectionLocks.set(platform, task); try { return await task; } catch (error) { const result={ ok:false, code:'COLLECTOR_ERROR', message:error.message }; setAgent('douyin-collector',{ status:'warning', detail:error.message, errorCode:result.code }); saveState(); return result; } finally { collectionLocks.delete(platform); }
  }
  const task = (async () => {
    setAgent('xhs-collector', { status: 'running', detail: '正在低频采集公开图文' }); addActivity('info', '小红书开始采集', `关键词：${state.settings.xhsKeywords.join('、')}`); saveState();
    const automatic = workflowTrigger === 'scheduled';
    const rawLimit = automatic ? state.settings.automaticRawLimit : state.settings.manualRawLimit;
    const finalLimit = automatic ? state.settings.automaticFinalLimit : state.settings.manualFinalLimit;
    const result = await withActiveCollector(createXhsCollector, (collector) => collector.collect({
      keywords: state.settings.xhsKeywords,
      maxPerKeyword: Math.min(500, Math.max(state.settings.xhsMaxPerKeyword, Math.ceil(rawLimit / state.settings.xhsKeywords.length))),
      rawLimit,
      detailLimit: automatic ? Math.min(rawLimit, Math.max(finalLimit * 4, 40)) : Math.min(rawLimit, Math.max(finalLimit * 3, 20)),
      finalLimit,
      strict: automatic,
      scrollRounds: automatic ? Math.max(8, state.settings.xhsScrollRounds) : Math.max(4, state.settings.xhsScrollRounds),
      delayMs: state.settings.xhsDelayMs,
      shouldStop: () => masterStopped(generation),
      onProgress: ({ keyword, stage, count, detailIndex, detailTotal }) => {
        if (masterStopped(generation)) return;
        const detail = stage === 'done' ? `${keyword} 已识别 ${count} 条`
          : stage === 'detail' ? `正在读取正文：${keyword} · ${Number(detailIndex || 0) + 1}/${detailTotal || 0}`
            : `正在搜索：${keyword}`;
        setAgent('xhs-collector', { status: 'running', detail });
      }
    }));
    if (masterStopped(generation)) return stopResult('人工总控已停止，抓取结果不会写入');
    if (!result.ok) {
      const status = result.code === 'MASTER_STOPPED' ? 'idle' : result.code === 'LOGIN_REQUIRED' ? 'needs_login' : result.code === 'CAPTCHA' ? 'verification_required' : 'warning';
      setAgent('xhs-collector', { status, detail: result.message, errorCode: result.code, screenshot: result.screenshot || '' });
      const technical = result.technicalMessage && result.technicalMessage !== result.message ? ` · 技术原因：${result.technicalMessage}` : '';
      addActivity(result.code === 'MASTER_STOPPED' ? 'info' : 'warning', result.code === 'MASTER_STOPPED' ? '小红书采集已停止' : '小红书采集已暂停', `${result.message}${technical}${result.screenshot ? ` · 已保存现场截图` : ''}`); saveState(); if (result.code !== 'MASTER_STOPPED') await notifyCollectorFailure(result); return result;
    }
    const remaining = Math.max(0, Number(state.settings.dailyCandidateLimit) - Number(state.settings.candidatesToday || 0));
    const existingIds = new Set(state.candidates.filter((candidate) => candidate.platform === '小红书').map((candidate) => candidate.sourceId));
    let newAllowance = remaining;
    const accepted = result.items.filter((item) => {
      if (existingIds.has(item.id)) return true;
      if (newAllowance <= 0) return false;
      newAllowance -= 1; return true;
    });
    const summary = mergeCollectedItems(accepted);
    if (!remaining && summary.updated) addActivity('info', '候选上限已满，仍完成历史快照更新', `更新 ${summary.updated} 条，不再新增候选`);
    else if (!remaining && !summary.updated) addActivity('warning', '候选额度已熔断', `今日已达到 ${state.settings.dailyCandidateLimit} 条上限，本轮没有可更新的历史候选`);
    const browserRecoveries = (result.warnings || []).filter((warning) => warning.code === 'BROWSER_SESSION_RECOVERED').length;
    setAgent('xhs-collector', { status: 'ready', detail: `最近采集：新增 ${summary.added} 条，更新 ${summary.updated} 条${browserRecoveries ? ` · 浏览器自动恢复${browserRecoveries}次` : ''}`, errorCode: '', screenshot: '' });
    const enriched = accepted.filter((item) => item.detailStatus === 'enriched').length;
    const filtered = Number(result.filterStats?.raw || 0) - Number(result.filterStats?.qualified || 0);
    addActivity('success', '小红书采集完成', `${automatic ? '自动严格模式' : '手动标准模式'} · 原始 ${result.filterStats?.raw || 0} 条，淘汰 ${Math.max(0, filtered)} 条，入选 ${summary.total} 条${browserRecoveries ? ` · 浏览器自动恢复${browserRecoveries}次` : ''}`); saveState();
    return { ok: true, ...summary, filtered: Math.max(0, filtered), enriched, browserRecoveries, filterStats: result.filterStats, warnings: result.warnings || [] };
  })();
  collectionLocks.set(platform, task);
  try { return await task; } catch (error) {
    const result = { ok: false, code: 'COLLECTOR_ERROR', message: error.message };
    setAgent('xhs-collector', { status: 'warning', detail: error.message, errorCode: result.code }); addActivity('warning', '小红书采集异常', error.message); saveState(); await notifyCollectorFailure(result); return result;
  } finally { collectionLocks.delete(platform); }
}

function buildVariants(candidate) {
  const structure = Array.isArray(candidate.structure) && candidate.structure.length ? candidate.structure : ['标题钩子待分析', '正文结构待分析'];
  const tags = Array.isArray(candidate.tags) && candidate.tags.length ? candidate.tags : ['待分析'];
  const hooks = ['我后悔现在才知道', '为什么你一直做不出结果', '亲测有效的低成本方法', '别再用老办法了', '从0开始最关键的一步', '大多数人都忽略了', '把复杂事情做简单', '一张图讲清楚', '真正拉开差距的是', '建议反复看这份清单'];
  const formats = ['清单型', '案例型', '避坑型', '对比型', '步骤型']; const accounts = ['品牌主号', '运营方法号', '案例分享号', '新手成长号', '测评观察号'];
  return hooks.map((hook, index) => ({
    id: uid('variant'), candidateId: candidate.id, index: index + 1, platform: candidate.platform || '小红书', account: accounts[index % accounts.length], format: formats[index % formats.length],
    title: `${hook}：${candidate.title.replace(/[？?！!（(].*$/, '').slice(0, 24)}`,
    body: `先说结论：真正值得复制的不是原文，而是它解决问题的顺序。\n\n01 先把用户最着急的问题说清楚\n02 给出可验证、可执行的方法\n03 用一个具体例子降低理解成本\n04 最后只保留一个行动建议\n\n这套内容沿用了“${structure.join(' → ')}”的结构，但表达、案例和标题均为重新生成。`,
    pages: [`${hook}\n${tags[0] || '实用方法'}`, '你可能正在经历\n内容发了很多却没有稳定反馈', `关键不是照搬\n而是拆出“${structure[0]}”`, '第一步\n先确认用户最想解决的问题', '第二步\n只提供一个清晰的方法路径', '第三步\n用事实或案例完成证明', '最后\n用数据决定是否继续放大'],
    status: 'pending', createdAt: now(), similarity: 28 + (index % 4) * 4, quality: 84 + (index % 5) * 2, metrics: null, decision: null, parentVariantId: null
  }));
}
function calculateDecision(m, baseline = {}, isFinal = false) {
  const exposure = Math.max(1, Number(m.exposure || 0)); const likeRate = Number(m.likes || 0) / exposure; const saveRate = Number(m.saves || 0) / exposure; const commentRate = Number(m.comments || 0) / exposure; const shareRate = Number(m.shares || 0) / exposure;
  const score = likeRate * 30 + saveRate * 45 + commentRate * 25 + shareRate * 20;
  const baselineBeaten = baseline.sampleSize >= 3 && (saveRate >= baseline.saveRate * 1.25 || exposure >= baseline.exposure * 1.2);
  if ((isFinal || exposure >= 10000) && exposure >= 1000 && (saveRate >= .045 || score >= 3.8 || baselineBeaten)) return 'scale';
  if (exposure >= 500 && (saveRate >= .02 || score >= 1.8 || (!isFinal && baselineBeaten))) return 'test';
  return isFinal ? 'stop' : 'test';
}

async function sendFeishu(text) {
  if (!state.settings.feishuWebhook) return { ok: false, message: '尚未配置飞书机器人 Webhook' };
  let url;
  try { url = new URL(state.settings.feishuWebhook); } catch { return { ok: false, message: '飞书 Webhook 格式不正确' }; }
  if (url.protocol !== 'https:' || url.hostname !== 'open.feishu.cn' || !url.pathname.startsWith('/open-apis/bot/v2/hook/')) return { ok: false, message: '只允许官方飞书机器人 HTTPS Webhook' };
  try { const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg_type: 'text', content: { text } }), signal: AbortSignal.timeout(10000) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return { ok: true, message: '飞书消息已发送' }; }
  catch (error) { return { ok: false, message: `发送失败：${error.message}` }; }
}

function supervisorCheck({ persist = true } = {}) {
  const time = Date.now();
  let changed = false;
  for (const agent of state.agents) {
    if (agent.id === 'supervisor' || agent.status === 'disabled') continue;
    const staleFor = time - new Date(agent.lastHeartbeat).getTime();
    if (agent.status === 'running' && staleFor > 5 * 60 * 1000) { agent.status = 'warning'; agent.detail = '任务运行超时，等待人工或主管重启'; addActivity('warning', `${agent.name}疑似卡死`, '运行超过5分钟没有完成心跳'); changed = true; }
  }
  const issues = state.agents.filter((agent) => agent.id !== 'supervisor' && ['warning', 'needs_login', 'verification_required'].includes(agent.status) && !(agent.id === 'xhs-collector' && !state.settings.xhsEnabled) && !(agent.id === 'douyin-collector' && !state.settings.douyinEnabled));
  const supervisor = state.agents.find((agent) => agent.id === 'supervisor');
  const nextStatus = issues.length ? 'warning' : 'healthy';
  const nextDetail = issues.length ? `${issues.length}个模块状态需要处理` : '刚刚完成全局巡检';
  if (supervisor && (supervisor.status !== nextStatus || supervisor.detail !== nextDetail)) { Object.assign(supervisor, { status:nextStatus, detail:nextDetail, lastHeartbeat:now() }); changed = true; }
  if (persist && changed) saveState();
  return { changed, issues:issues.length };
}

function normalizeGeneratedVariants(candidate, variants, count) {
  const rules = normalizeImageRules(state.settings);
  const allowLegacyTestGrounding = TEST_ENTERPRISE_IMAGE_BYPASS;
  return variants.slice(0, count).map((item, index) => ({
    id: uid('variant'), candidateId: candidate.id, index: index + 1, platform: candidate.platform || '小红书', account: safeText(item.account, 80) || `内容账号${index + 1}`, format: safeText(item.format, 80) || '图文', audience: safeText(item.audience, 120),
    title: safeText(item.title, 180), body: safeText(item.body, 8000), tags: normalizeTextList(item.tags, 12, 60), productionWarnings: containsInternalProductionLanguage(`${item.title || ''}\n${item.body || ''}`) ? ['标题或正文可能含有内部生产术语，请在工作台人工确认并修改'] : [],
    visualStrategy: item.visualStrategy && typeof item.visualStrategy === 'object' ? { concept:safeText(item.visualStrategy.concept, 500), coverHook:safeText(item.visualStrategy.coverHook, 500), continuity:safeText(item.visualStrategy.continuity, 800), palette:normalizeTextList(item.visualStrategy.palette, 8, 80), avoidGeneric:normalizeTextList(item.visualStrategy.avoidGeneric, 10, 200) } : {},
    enterpriseGrounding: item.enterpriseGrounding && typeof item.enterpriseGrounding === 'object' ? {
      productAngle: safeText(item.enterpriseGrounding.productAngle, 500),
      factsUsed: normalizeTextList(item.enterpriseGrounding.factsUsed, 8, 500),
      sellingPointsUsed: normalizeTextList(item.enterpriseGrounding.sellingPointsUsed, 6, 300),
      proofPointsUsed: normalizeTextList(item.enterpriseGrounding.proofPointsUsed, 4, 500),
      assetIds: normalizeTextList(item.enterpriseGrounding.assetIds, 8, 120),
      assetUsage: normalizeTextList(item.enterpriseGrounding.assetUsage, 8, 500)
    } : {},
    imagePages: (Array.isArray(item.imagePages) ? item.imagePages : Array.isArray(item.pages) ? item.pages.map((copy) => ({ copy, imagePrompt: '' })) : []).map((page, pageIndex) => normalizeImagePage(page, pageIndex)).filter(Boolean).slice(0, rules.imageCount),
    status: 'draft', createdAt: now(), similarity: null, quality: null, metrics: null, decision: null, parentVariantId: null, source: 'AI API 生成', imageRules: rules, imageReferencePolicy:'auto', imageTextMode:rules.textMode, imageStatus: 'draft', imageJob:null
  })).map((item) => ({ ...item, pages: item.imagePages.map((page) => page.copy).filter(Boolean) })).filter((item) => item.title && item.body && (allowLegacyTestGrounding || (item.enterpriseGrounding.productAngle && item.enterpriseGrounding.factsUsed.some(meaningfulEnterpriseLine))) && item.imagePages.length === rules.imageCount && item.imagePages.every((page) => meaningfulEnterpriseLine(page.copy) && page.imagePrompt));
}

async function generateWithAi(candidate, count = state.settings.generationCount, context = '', { requireMaster = true } = {}) {
  const generation = masterGeneration; if (requireMaster && masterStopped(generation)) return stopResult();
  if (!aiReady() && process.env.CONTENTOPS_TEST_ALLOW_UNVERIFIED !== '1') return { ok: false, code: 'AI_NOT_CONFIGURED', message: '还需配置并验证模型 API' };
  if (budgetRemaining() <= 0) return { ok: false, code: 'BUDGET_LIMIT', message: '今日 AI 预算已耗尽' };
  const enterprise = state.enterpriseProfiles.find((item) => item.id === state.activeEnterpriseProfileId && item.status === 'active');
  if (!enterprise) return { ok: false, code: 'ENTERPRISE_PROFILE_REQUIRED', message: '请先建立并启用企业素材库，才能开始一做' };
  const readiness = enterpriseProductionReadiness(enterprise);
  if (!readiness.ready) return { ok:false, code:'ENTERPRISE_PROFILE_INSUFFICIENT', message:readiness.reason };
  const productionEnterprise = readiness.profile;
  const usableAssets = productionEnterprise.imageAssets;
  const imageRules = normalizeImageRules(state.settings);
  setAgent('creator', { status: 'running', detail: `正在策划 ${count} 套原创图文与生图提示词` });
  const prompt = generationPrompt(candidate, count, context, { ...productionEnterprise, imageAssets:usableAssets.map(enterpriseAssetSummary) }, imageRules);
  const maxOutputTokens = outputTokenLimit('text', 12000); const reservation = reserveCall('text', prompt.length + SYSTEM.length, maxOutputTokens, '图文策划'); if (!reservation.ok) return reservation;
  const maximum = finiteNumber(state.settings.creationAutoRetryCount, 2, 0, 3);
  let attempt = 0; let result;
  while (true) {
    try {
      result = await callJson({ ...activeConnection('text'), system: `${SYSTEM}\n你还负责原创图文生产，必须避免复制来源内容和虚构案例。`, prompt, temperature: 0.75, timeoutMs: activeConnection('text').requestTimeoutMs, maxOutputTokens });
      break;
    } catch (error) {
      attempt += 1;
      const retrying = attempt <= maximum && isTransientApiError(error);
      candidate.creationTask ||= {};
      Object.assign(candidate.creationTask, { status:retrying ? 'retrying' : 'retryable_failed', attempts:attempt, lastError:safeText(error.message, 800), nextRetryAt:retrying ? retryAt(attempt) : '', updatedAt:now() });
      setAgent('creator', { status:retrying ? 'running' : 'warning', detail:retrying ? `一做暂时失败，正在第${attempt}/${maximum}次自动重试` : `一做待重试：${safeText(error.message, 180)}` });
      saveState();
      if (!retrying) throw error;
      addActivity('warning', '一做策划临时失败，自动重试', `${candidate.title} · 第${attempt}/${maximum}次：${error.message}`);
      await sleep(Math.min(60000, 1500 * (2 ** (attempt - 1))));
      if (requireMaster && masterStopped(generation)) return stopResult();
    }
  }
  if (requireMaster && masterStopped(generation)) return stopResult(); const rawVariants = Array.isArray(result.data?.variants) ? result.data.variants : []; const variants = normalizeGeneratedVariants(candidate, rawVariants, count);
  if (variants.length !== count) {
    const diagnostics = rawVariants.slice(0, count).map((item, index) => { const pages = Array.isArray(item?.imagePages) ? item.imagePages : []; const grounding = item?.enterpriseGrounding || {}; const reasons = []; if (!safeText(item?.title, 180)) reasons.push('缺标题'); if (!safeText(item?.body, 8000)) reasons.push('缺正文'); if (containsInternalProductionLanguage(`${item?.title || ''}\n${item?.body || ''}`)) reasons.push('正文含内部生产术语'); if (!safeText(grounding.productAngle, 500)) reasons.push('缺企业表达角度'); if (!normalizeTextList(grounding.factsUsed, 8, 500).some(meaningfulEnterpriseLine)) reasons.push('缺企业事实依据'); if (pages.length !== imageRules.imageCount) reasons.push(`图片页${pages.length}/${imageRules.imageCount}`); if (pages.some((page) => !meaningfulEnterpriseLine(page?.copy))) reasons.push('存在空白上图文案'); if (pages.some((page) => !promptText(page?.imagePrompt, 6000).trim())) reasons.push('存在空白生图提示词'); return `第${index + 1}套：${reasons.join('、') || '字段归一化失败'}`; });
    throw new Error(`模型应返回 ${count} 套完整图文，实际可用 ${variants.length} 套；${diagnostics.join('；') || `接口未返回 variants 数组（实际类型 ${typeof result.data?.variants}）`}`);
  }
  const assetIds = new Set(usableAssets.map((asset) => asset.id));
  if (variants.some((variant) => (variant.enterpriseGrounding?.assetIds || []).some((id) => !assetIds.has(id)))) throw new Error('模型返回了不存在的企业图片素材编号，结果未写入；请重试一做');
  const cost = recordAiUsage(result.usage, '图文策划'); state.settings.generationsToday += variants.length;
  candidate.creationTask ||= {}; Object.assign(candidate.creationTask, { status:'completed', attempts:attempt + 1, lastError:'', nextRetryAt:'', completedAt:now(), updatedAt:now() });
  setAgent('creator', { status: 'idle', detail: `最近完成 ${variants.length} 套策划稿，等待人工编辑和生图` }); return { ok: true, variants, cost };
}

async function analyzePerformanceWithAi(variant, metrics, baseline = {}, options = {}) {
  if (!aiReady()) return { ok: false, code: 'AI_NOT_CONFIGURED', message: 'AI API 未配置，已保留公式判断' };
  const snapshots = (variant.performanceSnapshots || []).slice(-8).map((item) => ({ capturedAt:item.capturedAt, milestoneHours:item.milestoneHours || null, exposure:item.exposure, views:item.views, coverClickRate:item.coverClickRate, likes:item.likes, saves:item.saves, comments:item.comments, followers:item.followers, shares:item.shares, averageViewSeconds:item.averageViewSeconds }));
  const prompt = performancePrompt(variant, metrics, baseline, snapshots, options); const maxOutputTokens = Math.min(outputTokenLimit('text', 2400), 2400); const reservation = reserveCall('text', prompt.length + SYSTEM.length, maxOutputTokens, '二次分析'); if (!reservation.ok) return reservation;
  const result = await callJson({ baseUrl: activeConnection('text').baseUrl, apiKey: activeConnection('text').apiKey, model: activeConnection('text').model, system: `${SYSTEM}\n你负责发布数据复盘，必须基于给定数据判断。`, prompt, temperature: 0.2, maxOutputTokens });
  const allowed = ['scale', 'test', 'stop']; const fallback = calculateDecision(metrics, baseline, Boolean(options.final)); const decision = allowed.includes(result.data?.decision) ? result.data.decision : fallback;
  const analysis = { decision: options.final ? decision : (decision === 'scale' ? 'test' : decision), reason: safeText(result.data?.reason, 800), winningElements: (Array.isArray(result.data?.winningElements) ? result.data.winningElements : []).map((item) => safeText(item, 160)).slice(0, 5), nextDirections: (Array.isArray(result.data?.nextDirections) ? result.data.nextDirections : []).map((item) => safeText(item, 180)).slice(0, 5), keep: normalizeTextList(result.data?.keep, 5, 180), change: normalizeTextList(result.data?.change, 5, 180), evidence: normalizeTextList(result.data?.evidence, 6, 220), baseline, stage: options.final ? 'final' : 'observation', confidence: finiteNumber(result.data?.confidence, 0, 0, 100) };
  const cost = recordAiUsage(result.usage, '二次分析'); return { ok: true, analysis, cost };
}

async function generateForSelectedCandidate(candidate) {
  const generation = masterGeneration;
  if (masterStopped(generation)) return stopResult('人工总控处于停止状态，一做策划不会启动');
  const existing = state.variants.filter((item) => item.candidateId === candidate.id);
  if (existing.length) return { ok: true, existing: true, count: existing.length };
  const run = runForCandidate(candidate.id);
  attachCandidateToRun(run, candidate.id);
  if (run) { run.status = 'running'; run.error = ''; run.finishedAt = ''; patchRunStep(run, 'create', { status: 'running', detail: `正在为“${candidate.title}”生成内容` }); }
  candidate.creationTask ||= {}; Object.assign(candidate.creationTask, { status:'running', attempts:Number(candidate.creationTask.attempts || 0), lastError:'', nextRetryAt:'', startedAt:now(), updatedAt:now() }); saveState();
  try {
    const generated = await generateWithAi(candidate, state.settings.generationCount);
    if (masterStopped(generation)) return stopResult('人工总控已停止，一做结果不会写入');
    if (!generated?.ok || !Array.isArray(generated.variants)) {
      const failure = new Error(generated?.message || '图文生产未返回可用版本');
      failure.code = generated?.code || 'AI_ERROR';
      throw failure;
    }
    const variants = generated.variants.map((variant) => ({ ...variant, workflowRunId: run?.id || '' }));
    state.variants.unshift(...variants); candidate.status = 'generated';
    if (run) { run.counts.generated += generated.variants.length; patchRunStep(run, 'create', { status: 'waiting_human', detail: `已生成 ${generated.variants.length} 套策划稿，等待人工编辑并确认生图` }); run.currentStep = 'create'; run.status = 'waiting_human'; run.error = ''; run.finishedAt = ''; run.actualCost += generated.cost || 0; }
    setAgent('orchestrator', { status:'idle', detail:'等待人工选款或图文审核' }); addActivity('success', `${generated.variants.length}套一做策划稿生成完成`, `来源：${candidate.title} · 尚未调用生图模型`); saveState(); return { ok: true, count: generated.variants.length };
  } catch (error) {
    if (run?.status === 'cancelled' || masterStopped(generation)) { candidate.creationTask ||= {}; Object.assign(candidate.creationTask, { status:'cancelled', lastError:'人工总控已停止；未写入在途结果', nextRetryAt:'', updatedAt:now() }); saveState(); return stopResult('人工总控已停止，一做结果不会写入'); }
    candidate.creationTask ||= {}; Object.assign(candidate.creationTask, { status:'retryable_failed', lastError:safeText(error.message,800), nextRetryAt:'', updatedAt:now() });
    if (run) { patchRunStep(run, 'create', { status: 'blocked', detail: `一做待重试：${error.message}` }); finishRun(run, 'blocked', error.message); }
    setAgent('creator', { status: 'warning', detail: error.message }); setAgent('orchestrator', { status: 'warning', detail: `AI生产受阻：${error.message}` }); addActivity('warning', '图文生产失败', error.message); saveState(); return { ok: false, code: safeText(error.code, 80) || 'AI_ERROR', message: error.message };
  }
}

function enqueueFirstCreation(candidate) {
  if (creationJobLocks.has(candidate.id)) return { ok:true, accepted:true, existing:true, message:'该方向的一做策划任务正在后台执行；可关闭页面，进度会持续保存' };
  const task = generateForSelectedCandidate(candidate);
  creationJobLocks.set(candidate.id, task);
  task.catch((error) => {
    candidate.creationTask ||= {};
    Object.assign(candidate.creationTask, { status:'retryable_failed', lastError:safeText(error.message,800), nextRetryAt:'', updatedAt:now() });
    setAgent('creator', { status:'warning', detail:`一做待重试：${safeText(error.message,180)}` });
    addActivity('warning', '一做后台任务异常', error.message); saveState();
  }).finally(() => creationJobLocks.delete(candidate.id));
  return { ok:true, accepted:true, message:'一做策划任务已接单；可继续浏览，自动重试和进度会持续保存' };
}

function renderCards(item, folder) {
  const renderer = [process.env.CONTENTOPS_CARD_RENDERER, path.join(ROOT, 'CardRenderer.exe'), path.join(ROOT, '成品', 'CardRenderer.exe')]
    .map((file) => safeText(file, 2000))
    .find((file) => file && fs.existsSync(file));
  if (!renderer) throw new Error('没有找到本地图卡渲染器');
  item.pages.forEach((page, index) => {
    const output = path.join(folder, `${String(index + 1).padStart(2, '0')}.png`);
    const args = [output, Buffer.from(page, 'utf8').toString('base64'), String(index + 1), String(item.pages.length), Buffer.from(item.account || '', 'utf8').toString('base64')];
    const result = spawnSync(renderer, args, { windowsHide: true, encoding: 'utf8', timeout: 20000 });
    if (result.status !== 0 || !fs.existsSync(output)) throw new Error(`第${index + 1}张图卡渲染失败：${result.stderr || '未知错误'}`);
  });
}

function imageAssetPath(file) {
  const resolved = path.resolve(GENERATED_IMAGE_DIR, safeText(file, 500));
  const relative = path.relative(GENERATED_IMAGE_DIR, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('图片文件路径不正确');
  return resolved;
}
function generatedImageFilesFromVariants(variants) {
  return [...new Set((variants || []).flatMap((variant) => (variant.imagePages || []).map((page) => safeText(page.asset?.file, 500)).filter(Boolean)))];
}
function referencedGeneratedImageFiles() {
  return new Set(generatedImageFilesFromVariants(state.variants));
}
function restoreGeneratedImageCleanup(transaction) {
  if (!transaction?.moves?.length) return;
  for (const move of [...transaction.moves].reverse()) {
    try {
      if (!fs.existsSync(move.trash)) continue;
      fs.mkdirSync(path.dirname(move.source), { recursive:true });
      if (fs.existsSync(move.source)) fs.rmSync(move.trash, { force:true });
      else fs.renameSync(move.trash, move.source);
    } catch {}
  }
  try { fs.rmSync(transaction.root, { recursive:true, force:true }); } catch {}
}
function stageGeneratedImageCleanup(files) {
  const referenced = referencedGeneratedImageFiles();
  const candidates = [...new Set((files || []).map((file) => safeText(file, 500)).filter(Boolean))].filter((file) => !referenced.has(file));
  if (!candidates.length) return null;
  const root = path.join(GENERATED_IMAGE_DIR, '.trash', uid('cleanup'));
  const transaction = { root, moves:[] };
  try {
    for (const relative of candidates) {
      const source = imageAssetPath(relative);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
      const trash = path.join(root, relative);
      fs.mkdirSync(path.dirname(trash), { recursive:true });
      fs.renameSync(source, trash);
      transaction.moves.push({ source, trash });
    }
    return transaction;
  } catch (error) {
    restoreGeneratedImageCleanup(transaction);
    throw error;
  }
}
function finalizeGeneratedImageCleanup(transaction) {
  if (!transaction) return;
  try { fs.rmSync(transaction.root, { recursive:true, force:true }); } catch {}
}
function saveStateWithGeneratedImageCleanup(files) {
  const transaction = stageGeneratedImageCleanup(files);
  try { saveState(); }
  catch (error) { restoreGeneratedImageCleanup(transaction); throw error; }
  finalizeGeneratedImageCleanup(transaction);
}
function discardGeneratedImageFile(file) {
  if (!file) return;
  try { fs.rmSync(imageAssetPath(file), { force:true }); } catch {}
}
function recoverGeneratedImageStorage() {
  fs.mkdirSync(GENERATED_IMAGE_DIR, { recursive:true });
  const referenced = referencedGeneratedImageFiles();
  const trashRoot = path.join(GENERATED_IMAGE_DIR, '.trash');
  if (fs.existsSync(trashRoot)) {
    for (const transactionName of fs.readdirSync(trashRoot)) {
      const transactionRoot = path.join(trashRoot, transactionName);
      if (!fs.statSync(transactionRoot).isDirectory()) continue;
      const pending = [transactionRoot];
      while (pending.length) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes:true })) {
          const file = path.join(current, entry.name);
          if (entry.isDirectory()) pending.push(file);
          else {
            const relative = path.relative(transactionRoot, file).replace(/\\/g, '/');
            const original = imageAssetPath(relative);
            if (referenced.has(relative) && !fs.existsSync(original)) {
              fs.mkdirSync(path.dirname(original), { recursive:true });
              fs.renameSync(file, original);
            } else fs.rmSync(file, { force:true });
          }
        }
      }
      try { fs.rmSync(transactionRoot, { recursive:true, force:true }); } catch {}
    }
  }
  const pending = [GENERATED_IMAGE_DIR];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes:true })) {
      if (current === GENERATED_IMAGE_DIR && entry.name === '.trash') continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else {
        const relative = path.relative(GENERATED_IMAGE_DIR, file).replace(/\\/g, '/');
        if (!referenced.has(relative) && /\.(?:png|jpe?g|webp)$/i.test(entry.name)) try { fs.rmSync(file, { force:true }); } catch {}
      }
    }
  }
}
recoverGeneratedImageStorage();
async function readImageResponseBytes(response, maxBytes = 25 * 1024 * 1024) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) throw new Error('供应商返回图片超过 25MB 安全上限');
  const chunks = []; let total = 0;
  if (!response.body) throw new Error('供应商返回图片为空');
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk); total += bytes.length;
    if (total > maxBytes) throw new Error('供应商返回图片超过 25MB 安全上限');
    chunks.push(bytes);
  }
  if (!total) throw new Error('供应商返回图片为空');
  return Buffer.concat(chunks, total);
}
async function resolveGeneratedImageBytes(result, timeoutMs = 180000) {
  let bytes;
  if (result.b64) {
    const raw = String(result.b64).trim().replace(/^data:image\/(?:png|jpeg|webp);base64,/i, '');
    bytes = Buffer.from(raw, 'base64');
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('供应商返回图片为空或超过 25MB 安全上限');
  } else if (result.url) {
    let url;
    try { url = new URL(result.url); } catch { throw new Error('生图供应商返回的图片 URL 不合法'); }
    if (url.protocol !== 'https:') throw new Error('生图供应商返回的图片 URL 必须使用 HTTPS，不能保存不安全资源');
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`下载生图供应商返回的图片失败：HTTP ${response.status}`);
    bytes = await readImageResponseBytes(response);
  } else throw new Error('生图模型没有返回 b64_json 或图片 URL');
  const mime = detectImageMime(bytes);
  if (!mime) throw new Error('生图供应商返回的数据不是有效的 PNG、JPG 或 WebP 图片');
  return { bytes, mime, extension:imageExtension(mime) };
}
async function persistGeneratedImage(variant, page, result, timeoutMs = 180000) {
  const resolved = await resolveGeneratedImageBytes(result, timeoutMs);
  const dir = path.join(GENERATED_IMAGE_DIR, variant.id);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${String(page.index).padStart(2, '0')}-${Date.now()}${resolved.extension}`;
  const file = path.join(dir, filename);
  fs.writeFileSync(file, resolved.bytes);
  return { file: path.relative(GENERATED_IMAGE_DIR, file).replace(/\\/g, '/'), mime: resolved.mime, generatedAt: now(), source: 'AI API 生成', revisedPrompt: safeText(result.revisedPrompt, 2000), referenceMode: ['reference_edit', 'reference_generation_json'].includes(result.referenceMode) ? result.referenceMode : 'text_only', referenceAssetIds: normalizeTextList(result.referenceAssetIds, 4, 120) };
}
function localImageDataUrl(asset) {
  if (!asset?.file) return '';
  const file = imageAssetPath(asset.file);
  if (!fs.existsSync(file)) return '';
  return `data:${asset.mime || 'image/png'};base64,${fs.readFileSync(file).toString('base64')}`;
}
function imageRequestKey(item, targetPageIds) {
  const pages = item.imagePages.filter((page) => targetPageIds.includes(page.id)).map((page) => ({ id:page.id, prompt:page.imagePrompt, copy:page.copy, textMode:page.textMode || 'inherit', role:page.role, purpose:page.purpose }));
  return crypto.createHash('sha256').update(JSON.stringify({ variantId:item.id, model:activeModelFingerprint('image'), imageReferencePolicy:item.imageReferencePolicy || 'auto', imageTextMode:item.imageTextMode || 'free', rules:item.imageRules, pages })).digest('hex');
}
function currentImageJobs() { return state.variants.filter((variant) => ['queued', 'running'].includes(variant.imageJob?.status)); }
function selectedEnterpriseImageAssets(item, enterprise) {
  const selectedIds = normalizeTextList(item.enterpriseGrounding?.assetIds, 4, 120);
  const assetById = new Map((enterprise.imageAssets || []).map((asset) => [asset.id, asset]));
  return selectedIds.map((id) => assetById.get(id)).filter((asset) => asset?.file && asset?.description).slice(0, 4);
}
function enterpriseReferenceImages(item, enterprise) {
  return selectedEnterpriseImageAssets(item, enterprise).map((asset) => {
    const file = enterpriseAssetPath(asset.file);
    if (!fs.existsSync(file)) throw new Error(`企业参考图文件不存在：${asset.name}`);
    return { assetId:asset.id, name:path.basename(file), mime:asset.mime, bytes:fs.readFileSync(file) };
  });
}
function enrichImagePrompt(item, page, rules, enterprise, referenceMode = 'text_only') {
  // 人工在工作台确认后的提示词是唯一生图指令。后端只负责传输，不追加任何隐藏创作要求。
  return String(page.imagePrompt ?? '');
}
async function reviewGeneratedImage(item, page, rules, enterprise) {
  if (!rules.qualityReviewEnabled || !visionReady()) return null;
  const imageUrl = localImageDataUrl(page.asset);
  if (!imageUrl) return null;
  const prompt = imageQualityPrompt(item, page, rules, enterprise);
  const connection = activeConnection('vision');
  const result = await callVisionJson({ ...connection, prompt, imageUrls:[imageUrl], allowDataImages:true, timeoutMs:Math.min(connection.requestTimeoutMs || 120000, rules.singleTimeoutMs), maxOutputTokens:Math.min(outputTokenLimit('vision', 1800), 1800) });
  recordVisionUsage(result.usage, `第${page.index}页视觉质检`);
  const data = result.data || {};
  const score = finiteNumber(data.score, 0, 0, 100);
  return { score, passed:Boolean(data.passed) && score >= rules.qualityThreshold, summary:safeText(data.summary, 800), strengths:normalizeTextList(data.strengths, 8, 200), problems:normalizeTextList(data.problems, 10, 240), retryPrompt:safeText(data.retryPrompt, 6000), checkedAt:now(), model:activeConnection('vision').model, attempts:finiteNumber(page.quality?.attempts, 0, 0, 10) + 1 };
}
function failImageJob(item, status, message) {
  item.imageJob = normalizeImageJob({ ...(item.imageJob || {}), status, error:message, message, finishedAt:now(), updatedAt:now(), currentPageId:'', currentPageIndex:0 }, item.id);
  item.imageStatus = item.imagePages.every((page) => page.asset?.file) ? 'ready' : item.imagePages.some((page) => page.asset?.file) ? 'partial' : status === 'cancelled' ? 'draft' : status;
  setAgent('creator', { status: status === 'cancelled' ? 'idle' : 'warning', detail:message });
  saveState();
}
function startVariantImageJob(item, pageIds = [], options = {}) {
  const generation = masterGeneration;
  if (masterStopped(generation)) return stopResult('人工总控处于停止状态，生图不会启动');
  if (!imageReady()) return { ok: false, code: 'IMAGE_AI_NOT_CONFIGURED', message: '请先保存、测试并启用生图模型连接档案' };
  const pages = Array.isArray(item.imagePages) ? item.imagePages : [];
  const requested = pageIds.length ? pages.filter((page) => pageIds.includes(page.id)) : pages.filter((page) => !page.asset?.file || options.force);
  // 普通“单页生成”只补没有成图的页面；已有图片必须显式 force 才能重做，防止误点重复扣费。
  const targets = requested.filter((page) => options.force || !page.asset?.file);
  if (!targets.length) return { ok: false, message: '没有可生成的图片页' };
  const rules = normalizeImageRules(item.imageRules || state.settings);
  const running = imageJobLocks.get(item.id);
  if (running || ['queued', 'running'].includes(item.imageJob?.status)) { if (item.imageJob) { item.imageJob.duplicateRequests = Number(item.imageJob.duplicateRequests || 0) + 1; item.imageJob.updatedAt = now(); saveState(); } return { ok:true, existing:true, code:'IMAGE_JOB_RUNNING', job:item.imageJob, message:`图片任务正在运行：${item.imageJob?.completed || 0}/${item.imageJob?.total || targets.length}` }; }
  if (currentImageJobs().length >= rules.maxConcurrentJobs) return { ok:false, code:'IMAGE_CONCURRENCY_LIMIT', message:`当前已有${currentImageJobs().length}个图片任务运行；并发上限为${rules.maxConcurrentJobs}，请等待完成` };
  const perImage = Number(state.settings.imageCostPerImage || 0);
  if (perImage * targets.length > imageBudgetRemaining()) return { ok: false, code: 'IMAGE_BUDGET_LIMIT', message: `本次生图预计 ¥${(perImage * targets.length).toFixed(4)}，超过剩余图片预算 ¥${imageBudgetRemaining().toFixed(4)}` };
  const requestKey = imageRequestKey(item, targets.map((page) => page.id));
  const startedAt = now();
  item.imageJob = normalizeImageJob({ id:uid('imagejob'), variantId:item.id, requestKey, status:'queued', targetPageIds:targets.map((page)=>page.id), total:targets.length, completed:0, failed:0, startedAt, updatedAt:startedAt, deadlineAt:new Date(Date.now()+rules.jobTimeoutMs).toISOString(), message:'图片任务已进入队列' }, item.id);
  item.imageStatus = 'queued'; saveState();
  const task = (async () => {
    const enterprise = state.enterpriseProfiles.find((entry) => entry.id === state.activeEnterpriseProfileId && entry.status === 'active') || {};
    const connection = activeConnection('image');
    const policy = ['auto', 'required', 'disabled'].includes(item.imageReferencePolicy) ? item.imageReferencePolicy : 'auto';
    let availableReferences = [];
    try { availableReferences = policy === 'disabled' ? [] : enterpriseReferenceImages(item, enterprise); }
    catch (error) { failImageJob(item, 'failed', `${error.message}；本次没有调用生图 API，请修复企业素材库后重试`); return; }
    let effectiveInputMode = 'text_only';
    if (policy === 'required') {
      if (!['reference_edit', 'reference_generation_json'].includes(connection.imageInputMode)) { failImageJob(item, 'failed', '本套内容要求使用企业原图，但当前生图连接档案未启用参考图模式；为避免假装使用企业图，本次没有调用生图 API'); return; }
      if (!availableReferences.length) { failImageJob(item, 'failed', '本套内容要求使用企业原图，但一做策划没有选中可用的企业图片；请补充企业图片并重新生成一做策划'); return; }
      effectiveInputMode = connection.imageInputMode;
    } else if (policy === 'auto' && ['reference_edit', 'reference_generation_json'].includes(connection.imageInputMode) && availableReferences.length) {
      effectiveInputMode = connection.imageInputMode;
    }
    const referenceImages = effectiveInputMode !== 'text_only' ? availableReferences : [];
    const referenceAssetIds = referenceImages.map((image) => image.assetId);
    item.imageJob.referencePolicy = policy;
    item.imageJob.referenceMode = effectiveInputMode;
    item.imageJob.referenceAssetIds = referenceAssetIds;
    let cost = 0;
    try {
      item.imageJob.status = 'running'; item.imageJob.message = `正在生成 0/${targets.length}`; item.imageJob.updatedAt = now(); item.imageStatus = 'generating'; setAgent('creator', { status:'running', detail:`${item.title} · 图片 0/${targets.length}` }); saveState();
      let pageCursor = 0;
      const runPage = async (page) => {
        if (masterStopped(generation)) { failImageJob(item, 'cancelled', '人工总控已停止；已完成图片保留，未完成页不会继续调用'); return; }
        if (Date.now() >= new Date(item.imageJob.deadlineAt).getTime()) { failImageJob(item, 'failed', `整组图片任务超过${Math.round(rules.jobTimeoutMs/60000)}分钟，已停止后续调用；已完成页保留`); return; }
        item.imageJob.currentPageId = page.id; item.imageJob.currentPageIndex = page.index; item.imageJob.message = `正在生成第${page.index}页 · 已完成${item.imageJob.completed}/${targets.length}`; item.imageJob.updatedAt = now(); setAgent('creator', { status:'running', detail:`${item.title} · 第${page.index}页 · 已完成${item.imageJob.completed}/${targets.length}` }); saveState();
        try {
          let prompt = enrichImagePrompt(item, page, rules, enterprise, effectiveInputMode);
          let accepted = false;
          for (let attempt = 0; attempt <= rules.autoRetryCount; attempt += 1) {
            const reservation = reserveCall('image', prompt.length, 0, `第${page.index}页生图`); if (!reservation.ok) throw new Error(reservation.message);
            const result = await generateImage({ ...connection, inputMode:effectiveInputMode, referenceImages, prompt, size:rules.size, timeoutMs:Math.min(connection.requestTimeoutMs || rules.singleTimeoutMs, rules.singleTimeoutMs) });
            result.referenceMode = effectiveInputMode; result.referenceAssetIds = referenceAssetIds;
            if (masterStopped(generation)) { failImageJob(item, 'cancelled', '人工总控已停止；当前返回图片不会写入'); return; }
            const priorAsset = page.asset;
            const generatedAsset = await persistGeneratedImage(item, page, result, Math.min(connection.requestTimeoutMs || rules.singleTimeoutMs, rules.singleTimeoutMs));
            page.asset = generatedAsset; page.generationError = ''; cost += recordImageUsage(result.usage, `第${page.index}页生图`); state.settings.imageGenerationsToday += 1;
            try { saveStateWithGeneratedImageCleanup([priorAsset?.file]); }
            catch (error) { discardGeneratedImageFile(generatedAsset.file); throw error; }
            page.quality = await reviewGeneratedImage(item, page, rules, enterprise).catch((error) => ({ score:0, passed:false, summary:`视觉质检失败：${error.message}`, strengths:[], problems:['视觉模型未能完成质检'], retryPrompt:'', checkedAt:now(), model:activeConnection('vision').model, attempts:Number(page.quality?.attempts || 0)+1 }));
            if (!rules.qualityReviewEnabled || !page.quality || page.quality.passed) { accepted = true; break; }
            if (attempt < rules.autoRetryCount) { prompt = String(page.imagePrompt ?? ''); const rejectedAsset = page.asset; page.asset = null; saveStateWithGeneratedImageCleanup([rejectedAsset?.file]); continue; }
            accepted = true;
          }
          if (!accepted) throw new Error(`第${page.index}页没有得到可保存图片`);
          item.imageJob.completed += 1;
        } catch (error) {
          page.generationError = safeText(error.message, 800); item.imageJob.failed += 1; addActivity('warning', '单页生图待重试', `${item.title} · 第${page.index}页：${error.message}`);
        }
        item.imageJob.cost = cost; item.imageJob.message = `已处理 ${item.imageJob.completed + item.imageJob.failed}/${targets.length}`; item.imageJob.updatedAt = now(); item.imageJob.currentPageId = ''; item.imageJob.currentPageIndex = 0; saveState();
      };
      const pageWorker = async () => { while (pageCursor < targets.length && !masterStopped(generation)) { const page = targets[pageCursor++]; await runPage(page); } };
      await Promise.all(Array.from({ length:Math.min(rules.maxConcurrentJobs, targets.length) }, pageWorker));
      if (masterStopped(generation)) return;
      const failedQuality = targets.filter((page) => page.quality && !page.quality.passed).length;
      const failedPages = targets.filter((page) => !page.asset?.file || page.generationError).length;
      item.imageJob.status = failedQuality || failedPages ? 'partial' : 'completed'; item.imageJob.failed = Math.max(item.imageJob.failed, failedQuality, failedPages); item.imageJob.finishedAt = now(); item.imageJob.updatedAt = now(); item.imageJob.message = failedQuality || failedPages ? `${item.imageJob.completed}张完成，${item.imageJob.failed}张待重试；不会重做已成功页面` : `${targets.length}张图片与视觉质检已完成`;
      item.imageStatus = item.imagePages.every((page) => page.asset?.file) ? (failedQuality ? 'needs_review' : 'ready') : 'partial'; item.updatedAt = now(); setAgent('creator', { status:failedQuality ? 'warning' : 'idle', detail:item.imageJob.message }); addActivity(failedQuality ? 'warning' : 'success', '图片任务完成', `${item.title} · ${item.imageJob.message}`); saveState();
    } catch (error) { failImageJob(item, 'failed', error.message); addActivity('warning', '图片任务失败', `${item.title} · ${error.message}`); }
  })().finally(() => imageJobLocks.delete(item.id));
  imageJobLocks.set(item.id, task);
  return { ok:true, accepted:true, count:targets.length, job:item.imageJob, message:`图片任务已启动，共${targets.length}张；可关闭弹窗，进度会持续保存` };
}

function exportVariant(item) {
  const base = SELF_TEST ? path.join(DATA_DIR, 'exports') : (safeText(item.exportDirectory, 2000) || path.join(os.homedir(), 'Downloads'));
  const folder = path.join(base, `ContentOps发布包-${item.id}`);
  fs.mkdirSync(folder, { recursive: true });
  const generatedPages = (item.imagePages || []).filter((page) => page.asset?.file);
  if (SELF_TEST && (item.pages || []).length) renderCards(item, folder);
  else if (generatedPages.length === (item.imagePages || []).length && generatedPages.length) {
    for (const page of generatedPages) fs.copyFileSync(imageAssetPath(page.asset.file), path.join(folder, `${String(page.index).padStart(2, '0')}${imageExtension(page.asset.mime)}`));
  } else return { ok:false, message:'图片尚未全部生成，不能导出发布包' };
  fs.writeFileSync(path.join(folder, '标题.txt'), item.title, 'utf8');
  fs.writeFileSync(path.join(folder, '正文.txt'), item.body, 'utf8');
  fs.writeFileSync(path.join(folder, '标签.txt'), (item.tags || []).map((tag) => `#${tag.replace(/^#/, '')}`).join(' '), 'utf8');
  fs.writeFileSync(path.join(folder, '图卡文案.txt'), (item.imagePages?.length ? item.imagePages.map((page) => `${page.index}. ${page.copy}`) : item.pages.map((page, index) => `${index + 1}. ${page}`)).join('\n\n'), 'utf8');
  fs.writeFileSync(path.join(folder, '图片提示词.txt'), (item.imagePages || []).map((page) => `${page.index}. ${page.imagePrompt}`).join('\n\n'), 'utf8');
  fs.writeFileSync(path.join(folder, '发布清单.json'), JSON.stringify(item, null, 2), 'utf8');
  if (item.status === 'approved') item.status = 'exported';
  addActivity('success', '发布包已导出', `${folder} · ${generatedPages.length || item.pages.length}张图片`);
  saveState();
  // 只有真实桌面运行才打开目录。测试/隔离数据目录会在脚本结束时被删除，
  // 若仍让 Explorer 异步打开就会弹出“位置不可用”。
  const shouldOpenFolder = !SELF_TEST && !process.env.CONTENTOPS_TEST_ALLOW_UNVERIFIED && process.env.CONTENTOPS_OPEN_EXPORT_FOLDER !== '0';
  if (shouldOpenFolder) try { spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  return { ok: true, path: folder };
}

async function handleAction(route, body) {
  const profileKind = (value) => ['text', 'vision', 'image'].includes(value) ? value : 'text';
  const activeProfileKey = (kind) => kind === 'vision' ? 'activeVisionProfileId' : kind === 'image' ? 'activeImageProfileId' : 'activeTextProfileId';
  if (route === '/api/model-profile/save') { const kind = profileKind(body.kind); const list = profileList(kind); const prior = list.find((item) => item.id === safeText(body.id, 120)); const profile = profileShape(kind, body, prior); if (!profile.baseUrl || !profile.model) return { ok: false, message: '连接档案必须填写接口地址和模型名称' }; const keyChanged = Boolean(body.apiKey); const changed = keyChanged || !prior || ['baseUrl', 'model', 'protocol', 'imageInputMode'].some((key) => prior[key] !== profile[key]); if (changed) { profile.lastTestOk = false; profile.lastTestAt = ''; profile.lastTestError = ''; } if (prior) Object.assign(prior, profile); else list.push(profile); const store = profileCredentialStore(kind, profile.id); if (body.apiKey) store.save(body.apiKey); if (state.settings[activeProfileKey(kind)] === profile.id && changed) { if (kind === 'vision') state.settings.lastVisionCheckOk = false; else if (kind === 'text') state.settings.lastAiCheckOk = false; } addActivity('info', prior ? '模型连接档案已更新' : '模型连接档案已创建', `${profile.name} · ${profile.model}`); saveState(); return { ok: true, profile: { ...profile, credentialConfigured: store.has() } }; }
  if (route === '/api/model-profile/test') { const kind = profileKind(body.kind); const profile = profileList(kind).find((item) => item.id === safeText(body.id, 120)); if (!profile) return { ok: false, message: '未找到连接档案' }; const store = profileCredentialStore(kind, profile.id); if (body.apiKey) { store.save(body.apiKey); profile.lastTestOk = false; } if (!store.has()) return { ok: false, message: '该连接档案尚未保存 Key' }; const isActive = profile.id === state.settings[activeProfileKey(kind)]; try { const timeoutMs = finiteNumber(profile.requestTimeoutSeconds, kind === 'image' ? 180 : 120, 10, 1800) * 1000; const result = kind === 'vision' ? await callVisionJson({ baseUrl: profile.baseUrl, apiKey: store.read(), model: profile.model, prompt: '观察测试图片，只返回严格的 json object：{"ok":true,"message":"连接成功"}', imageUrls: [VISION_TEST_IMAGE_URL], allowTrustedTestImage: true, maxOutputTokens: Math.min(profile.maxOutputTokens, 200), timeoutMs }) : kind === 'image' ? await generateImage({ baseUrl: profile.baseUrl, apiKey: store.read(), model: profile.model, inputMode:profile.imageInputMode, referenceImages:profile.imageInputMode !== 'text_only' ? [{ bytes:IMAGE_REFERENCE_TEST_PNG, mime:'image/png', name:'reference-capability-test.png' }] : [], prompt:profile.imageInputMode !== 'text_only' ? '基于上传的测试参考图生成纯白背景图片，无文字，无水印' : '一张纯白背景上的黑色圆点，无文字，无水印', size: '1024x1024', timeoutMs }) : await callJson({ baseUrl: profile.baseUrl, apiKey: store.read(), model: profile.model, system: '只返回 json object。', prompt: '返回严格的 json object：{"ok":true,"message":"连接成功"}', maxOutputTokens: Math.min(profile.maxOutputTokens, 200), timeoutMs }); if (kind === 'image' && result.url && !result.b64) { const remote = new URL(result.url); if (remote.protocol !== 'https:') throw new Error('生图供应商返回的图片 URL 必须使用 HTTPS'); const imageResponse = await fetch(remote, { signal: AbortSignal.timeout(timeoutMs) }); if (!imageResponse.ok) throw new Error(`生图供应商返回的图片 URL 无法下载：HTTP ${imageResponse.status}`); const bytes = await imageResponse.arrayBuffer(); if (!bytes.byteLength || bytes.byteLength > 25 * 1024 * 1024) throw new Error('生图供应商返回的图片为空或超过 25MB 安全上限'); } profile.lastTestAt = now(); profile.lastTestOk = kind === 'image' ? Boolean(result.b64 || result.url) : Boolean(result.data?.ok); profile.lastTestError = profile.lastTestOk ? '' : kind === 'image' ? '该供应商没有返回 b64_json 或 HTTPS 图片 URL，不能用于本地保存与导出。' : '模型返回不符合预期'; profile.updatedAt = now(); if (isActive) { if (kind === 'vision') state.settings.lastVisionCheckOk = profile.lastTestOk; else if (kind === 'text') state.settings.lastAiCheckOk = profile.lastTestOk; } saveState(); return { ok: profile.lastTestOk, message: profile.lastTestOk ? '连接测试成功，可启用此档案' : profile.lastTestError, usage: result.usage }; } catch (error) { profile.lastTestAt = now(); profile.lastTestOk = false; profile.lastTestError = error.message; if (isActive) { if (kind === 'vision') state.settings.lastVisionCheckOk = false; else if (kind === 'text') state.settings.lastAiCheckOk = false; } saveState(); return { ok: false, message: error.message }; } }
  if (route === '/api/model-profile/activate') { const kind = profileKind(body.kind); const profile = profileList(kind).find((item) => item.id === safeText(body.id, 120)); if (!profile) return { ok: false, message: '未找到连接档案' }; if (!profile.lastTestOk) return { ok: false, message: '连接档案必须先测试成功才能启用' }; const store = profileCredentialStore(kind, profile.id); if (!store.has()) return { ok: false, message: '连接档案缺少 Key' }; applyProfile(kind, profile); state.settings[activeProfileKey(kind)] = profile.id; addActivity('success', '模型连接档案已启用', `${profile.name} · ${profile.model}`); saveState(); return { ok: true, profile }; }
  if (route === '/api/master/start') { if (!analysisReady() && !(SELF_TEST && aiReady() && visionReady()) && process.env.CONTENTOPS_TEST_ALLOW_UNVERIFIED !== '1') return { ok: false, code: 'ANALYSIS_NOT_READY', message: '请先保存并分别测试文本模型与视觉模型 Key' }; state.settings.masterEnabled = true; masterGeneration += 1; addActivity('success', '人工总控已开始', '允许手动工作流和24小时调度执行'); setAgent('orchestrator', { status: 'idle', detail: '人工总控已开启，等待启动工作流' }); if (state.agents.find((item) => item.id === 'analyst')?.status === 'idle') setAgent('analyst', { status:'healthy', detail:'评分队列为空' }); if (state.agents.find((item) => item.id === 'creator')?.status === 'idle') setAgent('creator', { status:'idle', detail:'等待人工选款' }); saveState(); return { ok: true }; }
  if (route === '/api/master/stop') { state.settings.masterEnabled = false; state.settings.workflowAutoEnabled = false; state.settings.collectionEnabled = false; masterGeneration += 1; let cancelledRuns = 0; for (const run of state.workflowRuns) if (cancelOpenRun(run)) cancelledRuns += 1; for (const candidate of state.candidates.filter((item) => ['text_analyzing','vision_analyzing','synthesizing'].includes(item.analysisStatus))) candidate.analysisStatus = 'pending'; setAgent('orchestrator', { status: 'idle', detail: '人工总控已停止，所有未结束任务均已取消' }); setAgent('analyst', { status: 'idle', detail: '人工总控已停止' }); setAgent('creator', { status: 'idle', detail: '人工总控已停止' }); for (const [agentId, detail] of [['xhs-collector', '人工总控已停止，当前抓取结果将被丢弃'], ['douyin-collector', '人工总控已停止，当前抓取结果将被丢弃'], ['data-agent', '人工总控已停止，当前后台数据结果将被丢弃']]) if (state.agents.find((item) => item.id === agentId)?.status === 'running') setAgent(agentId, { status: 'idle', detail }); const message = `已关闭24小时调度并取消${cancelledRuns}个未结束任务；在途网络结果不会写入`; addActivity('warning', '人工总控已停止', message); saveState(); return { ok: true, cancelledRuns, message }; }
  if (route === '/api/enterprise-profile/save') {
    const mode = body.mode === 'edit' ? 'edit' : 'create';
    const requestedId = safeText(body.id, 120);
    if (mode === 'create' && requestedId) return { ok: false, message: '新建资料库不能携带已有资料库标识，请关闭窗口后重新新建' };
    if (mode === 'edit' && !requestedId) return { ok: false, message: '编辑资料库缺少标识，请重新打开该资料库后保存' };
    const incoming = normalizeEnterpriseProfile(mode === 'create' ? { ...body, id: '', imageAssets:[] } : body);
    if (!incoming.name) return { ok: false, message: '请填写资料库名称' };
    const next = structuredClone(state); const existing = mode === 'edit' ? next.enterpriseProfiles.find((item) => item.id === incoming.id) : null;
    if (mode === 'edit' && !existing) return { ok: false, message: '未找到要编辑的资料库；为保护原有资料，系统没有新建或覆盖任何资料库' };
    if (existing) Object.assign(existing, incoming, { createdAt: existing.createdAt, imageAssets: existing.imageAssets, status: existing.status });
    else next.enterpriseProfiles.unshift(incoming);
    const savedProfile = existing || incoming;
    if ((!next.activeEnterpriseProfileId || body.makeActive === true) && savedProfile.status === 'active') next.activeEnterpriseProfileId = savedProfile.id;
    addActivityTo(next, existing ? 'info' : 'success', existing ? '企业素材库已更新' : '企业素材库已创建', `${incoming.name} · ${incoming.brandName || incoming.productName}`);
    const committed = commitStateSnapshot(next); const persisted = committed.enterpriseProfiles.find((item) => item.id === savedProfile.id);
    return { ok: true, profile: persisted, active: committed.activeEnterpriseProfileId === savedProfile.id };
  }
  if (route === '/api/enterprise-profile/export') {
    const profile = state.enterpriseProfiles.find((item) => item.id === safeText(body.profileId, 120));
    if (!profile) return { ok:false, message:'未找到企业素材库' };
    return exportEnterpriseProfile(profile, body.directory);
  }
  if (route === '/api/enterprise-image/upload') {
    const profile = state.enterpriseProfiles.find((item) => item.id === safeText(body.profileId, 120) && item.status === 'active');
    if (!profile) return { ok:false, message:'请先选择一个有效的企业素材库' };
    const mime = safeText(body.mime, 80);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return { ok:false, message:'仅支持 JPG、PNG、WebP 图片' };
    const data = safeText(body.data, 14 * 1024 * 1024);
    const match = data.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match || match[1] !== mime) return { ok:false, message:'图片数据格式不正确' };
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) return { ok:false, message:'单张图片必须在 10MB 以内' };
    if (!imageBytesMatchMime(bytes, mime)) return { ok:false, message:'图片文件内容与所选格式不一致，请重新选择有效的 JPG、PNG 或 WebP 图片' };
    const asset = normalizeEnterpriseImageAsset({ id:uid('enterprise-image'), kind:body.kind, name:body.name, description:body.description, immutableNotes:body.immutableNotes, mime, size:bytes.length, createdAt:now(), file:'pending' });
    const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
    const relative = `${profile.id}/${asset.id}${ext}`;
    asset.file = relative;
    const target = enterpriseAssetPath(relative); const temporary = `${target}.${uid('upload')}.tmp`; fs.mkdirSync(path.dirname(target), { recursive:true });
    try { fs.writeFileSync(temporary, bytes, { flag:'wx' }); fs.renameSync(temporary, target); const next = structuredClone(state); const nextProfile = next.enterpriseProfiles.find((item) => item.id === profile.id); nextProfile.imageAssets.push(asset); nextProfile.updatedAt = now(); addActivityTo(next, 'success', '企业图片素材已入库', `${profile.name} · ${asset.name}`); commitStateSnapshot(next); return { ok:true, asset }; }
    catch (error) { try { fs.rmSync(temporary, { force:true }); fs.rmSync(target, { force:true }); } catch {} return { ok:false, message:`企业图片未保存：${error.message}` }; }
  }
  if (route === '/api/enterprise-image/delete') {
    const profile = state.enterpriseProfiles.find((item) => item.id === safeText(body.profileId, 120));
    if (!profile) return { ok:false, message:'未找到企业素材库' };
    const index = profile.imageAssets.findIndex((asset) => asset.id === safeText(body.assetId, 120));
    if (index < 0) return { ok:false, message:'未找到企业图片素材' };
    const asset = profile.imageAssets[index]; let stage;
    if (asset.file !== `${profile.id}/${asset.id}${imageExtension(asset.mime)}`) return { ok:false, message:'企业图片归属校验失败，已拒绝删除以保护其他资料库' };
    try { stage = stageEnterpriseImageRemoval(asset); } catch (error) { return { ok:false, message:`企业图片未删除：${error.message}` }; }
    const previousUpdatedAt = profile.updatedAt; const previousActivity = state.activity.slice();
    profile.imageAssets.splice(index, 1); profile.updatedAt = now(); addActivity('info', '企业图片素材已删除', `${profile.name} · ${asset.name}`);
    try { saveState(); } catch (error) {
      profile.imageAssets.splice(index, 0, asset); profile.updatedAt = previousUpdatedAt; state.activity = previousActivity;
      try { rollbackEnterpriseImageRemoval(stage); } catch {}
      return { ok:false, message:`企业图片未删除：保存资料库失败，已回滚：${error.message}` };
    }
    try { finalizeEnterpriseImageRemoval(stage); } catch (error) { addActivity('warning', '企业图片待清理', `${profile.name} · ${asset.name}：${error.message}`); saveState(); }
    return { ok:true };
  }
  if (route === '/api/enterprise-profile/activate') {
    const profile = state.enterpriseProfiles.find((item) => item.id === safeText(body.id, 120));
    if (!profile) return { ok: false, message: '未找到企业素材库' };
    if (profile.status !== 'active') return { ok: false, message: '已停用的资料库不能用于生产' };
    state.activeEnterpriseProfileId = profile.id; addActivity('success', '已切换生产资料库', profile.name); saveState(); return { ok: true };
  }
  if (route === '/api/enterprise-profile/archive') {
    const profile = state.enterpriseProfiles.find((item) => item.id === safeText(body.id, 120));
    if (!profile) return { ok: false, message: '未找到企业素材库' };
    profile.status = 'archived'; profile.updatedAt = now();
    if (state.activeEnterpriseProfileId === profile.id) state.activeEnterpriseProfileId = state.enterpriseProfiles.find((item) => item.id !== profile.id && item.status === 'active')?.id || '';
    addActivity('warning', '企业素材库已停用', profile.name); saveState(); return { ok: true };
  }
  if (route === '/api/enterprise-profile/restore') {
    const profile = state.enterpriseProfiles.find((item) => item.id === safeText(body.id, 120));
    if (!profile) return { ok: false, message: '未找到企业素材库' };
    profile.status = 'active'; profile.updatedAt = now();
    if (!state.activeEnterpriseProfileId) state.activeEnterpriseProfileId = profile.id;
    addActivity('info', '企业素材库已恢复', profile.name); saveState(); return { ok: true };
  }
  if (route === '/api/collection/run') return runCollection(body.platform, { manual: Boolean(body.manual) });
  if (route === '/api/workflow/run') {
    if (!state.settings.masterEnabled) return stopResult('人工总控处于停止状态，请先点击“开始总控”');
    if (!analysisReady() && process.env.CONTENTOPS_TEST_ALLOW_UNVERIFIED !== '1') return { ok:false, code:'ANALYSIS_NOT_READY', message:'请先保存并分别验证文本模型与视觉模型 Key' };
    if (workflowPromise) return { ok:false, code:'WORKFLOW_RUNNING', message:'已有一轮工作流正在运行' };
    runWorkflow('manual').catch((error) => { addActivity('warning', '后台工作流异常', error.message); setAgent('orchestrator', { status:'warning', detail:error.message }); saveState(); });
    return { ok:true, accepted:true, message:'工作流已接单，抓取与分析将在后台执行；可继续浏览工作台查看实时进度' };
  }
  if (route === '/api/workflow/resume') return resumeBlockedWorkflow();
  if (route === '/api/workflow/pause-auto') { state.settings.workflowAutoEnabled = false; state.settings.collectionEnabled = false; addActivity('warning', '24小时工作流已暂停', '由人工在工作台暂停'); saveState(); return { ok: true }; }
  if (route === '/api/collector/xhs/open-login') {
    if (xhsBrowserBusy()) return { ok:false, code:'ALREADY_RUNNING', message:'小红书专用浏览器正在执行另一项任务，请等待完成后再打开登录窗口' };
    const task = (async () => { try {
      const result = await withActiveCollector(createXhsCollector, (collector) => collector.openLogin());
      setAgent('xhs-collector', { status:'idle', detail:'登录窗口已打开；完成登录后点击“检查登录状态”', errorCode:'', screenshot:'' });
      addActivity('info', '已打开小红书登录窗口', '完成登录或安全验证后回到工作台点击“检查登录状态”'); saveState(); return result;
    } catch (error) {
      setAgent('xhs-collector', { status:'warning', detail:error.message, errorCode:error.code || 'BROWSER_START_FAILED' });
      addActivity('warning', '小红书浏览器启动失败', error.message); saveState(); return { ok:false, code:error.code || 'BROWSER_START_FAILED', message:error.message };
    } })();
    collectionLocks.set('小红书登录', task); try { return await task; } finally { collectionLocks.delete('小红书登录'); }
  }
  if (route === '/api/collector/xhs/probe') {
    if (!state.settings.xhsEnabled) return { ok:false, code:'PLATFORM_DISABLED', message:'请先启用小红书并保存关键词' };
    if (xhsBrowserBusy()) return { ok:false, code:'ALREADY_RUNNING', message:'小红书专用浏览器正在执行另一项任务，请等待完成后再检查' };
    const task = (async () => {
      const result = await withActiveCollector(createXhsCollector, (collector) => collector.probe(state.settings.xhsKeywords?.[0] || '内容运营'));
      const status = result.ok ? 'ready' : result.code === 'LOGIN_REQUIRED' ? 'needs_login' : result.code === 'CAPTCHA' ? 'verification_required' : 'warning';
      setAgent('xhs-collector', { status, detail:result.message, errorCode:result.ok ? '' : result.code || 'COLLECTOR_ERROR', screenshot:result.screenshot || '' });
      addActivity(result.ok ? 'success' : 'warning', result.ok ? '小红书登录状态检查通过' : '小红书登录状态检查未通过', result.message); saveState(); return result;
    })();
    collectionLocks.set('小红书检查', task); try { return await task; } finally { collectionLocks.delete('小红书检查'); }
  }
  if (route === '/api/collector/xhs-creator/open-login') {
    if (xhsBrowserBusy()) return { ok:false, code:'ALREADY_RUNNING', message:'小红书专用浏览器正在执行另一项任务，请等待完成后再打开创作后台' };
    const task = (async () => { try {
      const result = await withActiveCollector(createCreatorCenterCollector, (collector) => collector.openLogin());
      const status = result.ok ? 'ready' : result.code === 'LOGIN_REQUIRED' ? 'needs_login' : result.code === 'CAPTCHA' ? 'verification_required' : 'warning';
      setAgent('data-agent', { status, detail:result.message, errorCode:result.code || '', screenshot:'' });
      addActivity(result.ok ? 'success' : 'info', result.ok ? '小红书创作后台登录有效' : '已打开小红书创作后台登录窗口', result.message); saveState(); return result;
    } catch (error) {
      setAgent('data-agent', { status:'warning', detail:error.message, errorCode:'BROWSER_START_FAILED' }); addActivity('warning', '创作后台浏览器启动失败', error.message); saveState(); return { ok:false, code:'BROWSER_START_FAILED', message:error.message };
    } })();
    collectionLocks.set('小红书后台', task); try { return await task; } finally { collectionLocks.delete('小红书后台'); }
  }
  if (route === '/api/performance/collect') return collectCreatorPerformance({ variantIds:Array.isArray(body.variantIds) ? body.variantIds : [], manual:Boolean(body.manual) });
  if (route === '/api/supervisor/inspect') {
    supervisorCheck();
    const warnings = state.agents.filter((agent) => ['warning', 'needs_login', 'verification_required'].includes(agent.status) && !(agent.id === 'xhs-collector' && !state.settings.xhsEnabled) && !(agent.id === 'douyin-collector' && !state.settings.douyinEnabled));
    return { ok: true, warnings: warnings.length, agents: warnings.map((agent) => agent.id) };
  }
  if (route === '/api/collector/douyin/open-login') {
    if (douyinBrowserBusy()) return { ok:false, code:'ALREADY_RUNNING', message:'抖音专用浏览器正在执行另一项任务，请等待完成后再打开登录窗口' };
    const task = (async () => { try { const result = await withActiveCollector(createDouyinCollector, (collector) => collector.openLogin()); setAgent('douyin-collector', { status:'needs_login', detail:'抖音专用浏览器已打开，等待人工扫码登录后导入公开图文链接', errorCode:'', screenshot:'' }); saveState(); return result; } catch (error) { setAgent('douyin-collector', { status:'warning', detail:error.message, errorCode:'BROWSER_START_FAILED' }); saveState(); return { ok:false, code:'BROWSER_START_FAILED', message:error.message }; } })();
    collectionLocks.set('抖音登录', task); try { return await task; } finally { collectionLocks.delete('抖音登录'); }
  }
  if (route === '/api/source/add') {
    const platform = safeText(body.platform, 10) || (String(body.url).includes('xiaohongshu') ? '小红书' : '抖音');
    if (!['小红书', '抖音'].includes(platform)) return { ok:false, message:'平台不正确' };
    const url = safeText(body.url, 2000); let parsed; try { parsed = new URL(url); } catch { return { ok:false, message:'内容链接格式不正确' }; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return { ok:false, message:'只支持 HTTP/HTTPS 链接' };
    const allowed = platform === '小红书' ? ['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com'] : ['douyin.com', 'www.douyin.com', 'v.douyin.com'];
    let localFixtureHost = ''; try { localFixtureHost = new URL(process.env.CONTENTOPS_XHS_SEARCH_BASE_URL || '').hostname; } catch {}
    // Only the isolated collector test explicitly points the XHS search base at a local fixture.
    // A normal production process never has that local base URL, so it still accepts official links only.
    const testLocalSource = process.env.CONTENTOPS_TEST_ALLOW_LOCAL_SOURCE === '1' && ['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.hostname === localFixtureHost;
    if (!testLocalSource && !allowed.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) return { ok:false, message:`只允许${platform}官方公开链接` };
    if (!state.settings.masterEnabled) return stopResult(`人工总控处于停止状态，${platform}公开链接不会导入`);
    const lockKey = `${platform}链接导入`; if (platform === '抖音' && douyinBrowserBusy()) return { ok:false, code:'ALREADY_RUNNING', message:'抖音专用浏览器正在执行另一项采集、链接导入或登录任务，请等待完成' }; if (platform === '小红书' && xhsBrowserBusy()) return { ok:false, code:'ALREADY_RUNNING', message:'小红书专用浏览器正在执行采集、登录检查或后台采样，请等待完成' }; if (collectionLocks.has(lockKey)) return { ok:false, code:'ALREADY_RUNNING', message:`已有一条${platform}公开链接正在导入，请等待完成` };
    const generation = masterGeneration;
    const task = (async () => {
      const agentId = platform === '小红书' ? 'xhs-collector' : 'douyin-collector'; const collectorFactory = platform === '小红书' ? createXhsCollector : createDouyinCollector;
      setAgent(agentId, { status:'running', detail:'正在读取人工提交的公开图文链接', errorCode:'' }); addActivity('info',`${platform}图文链接开始导入`,url); saveState();
      const result = await withActiveCollector(collectorFactory, (collector) => collector.importLink(url));
      if (masterStopped(generation)) return stopResult(`人工总控已停止，${platform}链接读取结果不会写入`);
      if (!result.ok) { const status = result.code === 'LOGIN_REQUIRED' ? 'needs_login' : result.code === 'CAPTCHA' ? 'verification_required' : 'warning'; setAgent(agentId, { status, detail:result.message, errorCode:result.code, screenshot:result.screenshot || '' }); addActivity('warning',`${platform}图文链接导入失败`,result.message); saveState(); return result; }
      const merged = platform === '小红书' ? mergeCollectedItems([result.item]) : mergeDouyinLinkItem(result.item);
      // mergeCollectedItems 已经负责小红书候选的新增计数；抖音合并函数没有，故仅在抖音这里累计。
      if (platform === '抖音') state.settings.candidatesToday += Number(merged.added || 0);
      setAgent(agentId, { status:'ready', detail:`链接已读取：${result.item.imageCount || result.item.imageUrls?.length || 0}张图 · ${(result.item.title || '').slice(0,30)}`, errorCode:'', screenshot:'' }); addActivity('success',`${platform}图文链接导入完成`,`${result.item.title} · 已进入候选池等待分析`); saveState();
      return { ok:true, candidate:merged.candidate, added:merged.added, updated:merged.updated, item:{ id:result.item.id, imageCount:result.item.imageCount || result.item.imageUrls?.length || 0, contentType:result.item.contentType } };
    })();
    collectionLocks.set(lockKey, task); try { return await task; } finally { collectionLocks.delete(lockKey); }
  }
  if (route === '/api/candidate/delete') { const id = safeText(body.id, 120); const item = state.candidates.find((candidate) => candidate.id === id); if (!item) return { ok: false, message: '未找到候选内容' }; if (activeWorkflowReferencesCandidate(id)) return { ok: false, message: '该候选仍属于进行中的工作流，暂时不能删除' }; const related = state.variants.filter((variant) => variant.candidateId === id); if (related.some(protectedVariant)) return { ok: false, message: '该候选已有审核通过、已导出、已发布或成功沉淀的内容，不能级联删除' }; const result = deleteCandidateRecords([id]); addActivity('warning', '候选已人工删除', `${item.title} · 同步清理${result.variantsDeleted}个未发布版本`); saveStateWithGeneratedImageCleanup(result.generatedFiles); return { ok: true, candidatesDeleted:result.candidatesDeleted, variantsDeleted:result.variantsDeleted }; }
  if (route === '/api/candidate/cleanup') { const matched = state.candidates.filter((item) => body.scope === 'all_unselected' ? !['selected', 'generated'].includes(item.status) : item.status === 'ignored'); const blockedByWorkflow = []; const blockedByProtectedContent = []; const removable = matched.filter((item) => { const workflowBlocked = activeWorkflowReferencesCandidate(item.id); const related = state.variants.filter((variant) => variant.candidateId === item.id); const protectedContent = related.some(protectedVariant); if (workflowBlocked) blockedByWorkflow.push(item.id); if (protectedContent) blockedByProtectedContent.push(item.id); return !workflowBlocked && !protectedContent; }); const result = deleteCandidateRecords(removable.map((item) => item.id)); const blocked = matched.length - result.candidatesDeleted; const message = result.candidatesDeleted ? `删除${result.candidatesDeleted}条候选，关联未发布版本${result.variantsDeleted}个${blocked ? `；另有${blocked}条受保护未删除` : ''}` : matched.length ? `${matched.length}条候选均受未结束任务或已发布内容保护，未删除` : '没有符合清理条件的候选'; addActivity(result.candidatesDeleted ? 'warning' : 'info', '候选池批量清理完成', message); saveStateWithGeneratedImageCleanup(result.generatedFiles); return { ok: true, matched: matched.length, blocked, blockedByWorkflow: blockedByWorkflow.length, blockedByProtectedContent: blockedByProtectedContent.length, message, candidatesDeleted:result.candidatesDeleted, variantsDeleted:result.variantsDeleted }; }
  if (route === '/api/candidate/analyze') { const item = state.candidates.find((x) => x.id === safeText(body.id, 120)); if (!item) return { ok: false, message: '未找到候选内容' }; try { const result = await analyzeCandidate(item); return result; } catch (error) { item.analysisStatus = 'retryable_failed'; item.analysisTask ||= {}; item.analysisTask.lastFailure = { status:'retryable_failed', lastError:safeText(error.message,800), updatedAt:now() }; setAgent('analyst', { status: 'warning', detail: error.message }); addActivity('warning', '候选分析待重试', `${item.title} · ${error.message}`); saveState(); return { ok: false, code: 'AI_ERROR', message: error.message }; } }
  if (route === '/api/candidate/status') {
    const item = state.candidates.find((x) => x.id === safeText(body.id, 120));
    if (!item) return { ok: false, message: '未找到候选内容' };
    if (!['selected', 'ignored'].includes(body.status)) return { ok: false, message: '候选状态不正确' };
    if (!SELF_TEST && body.status === 'selected' && item.analysisStatus !== 'completed') return { ok: false, message: '请先完成 AI 分析，再人工选款' };
    const unchanged = item.status === body.status;
    item.status = body.status;
    const waitingRun = state.workflowRuns.find((run) => run.status === 'waiting_human' && ['select', 'create'].includes(run.currentStep) && run.candidateIds?.includes(item.id))
      || state.workflowRuns.find((run) => run.status === 'waiting_human' && run.currentStep === 'select');
    if (waitingRun && body.status === 'selected') {
      attachCandidateToRun(waitingRun, item.id);
      waitingRun.counts.selected = waitingRun.candidateIds.filter((id) => state.candidates.some((candidate) => candidate.id === id && ['selected', 'generated'].includes(candidate.status))).length;
      patchRunStep(waitingRun, 'select', { status: 'completed', detail: `已确认 ${waitingRun.counts.selected} 条方向` });
      patchRunStep(waitingRun, 'create', { status: 'waiting_human', detail: '等待人工确认开始一做策划' });
    }
    if (!unchanged) addActivity(body.status === 'selected' ? 'success' : 'info', body.status === 'selected' ? '人工确认选款' : '候选已忽略', item.title);
    saveState();
    return { ok: true, existing: unchanged, selected: body.status === 'selected', message: body.status === 'selected' ? '已选款；请在图文生产中心人工确认开始一做' : '已忽略' };
  }
  if (route === '/api/variant/generate') { resetDailyUsageIfNeeded(); const candidate = state.candidates.find((x) => x.id === safeText(body.candidateId, 120)); if (!candidate) return { ok: false, message: '未找到候选内容' }; if (!['selected', 'generated'].includes(candidate.status)) return { ok: false, message: '请先人工确认这个方向' }; const existing = state.variants.filter((x) => x.candidateId === candidate.id); if (existing.length) return { ok: true, existing: true, count: existing.length, message: '该方向已经生成过，不重复计费' }; if (budgetRemaining() <= 0) return { ok: false, code: 'BUDGET_LIMIT', message: '今日AI预算不足，已自动熔断' }; if (SELF_TEST && !aiReady()) { const run = runForCandidate(candidate.id); attachCandidateToRun(run, candidate.id); const variants = buildVariants(candidate).map((variant) => ({ ...variant, workflowRunId: run?.id || '' })); state.variants.unshift(...variants); candidate.status = 'generated'; state.settings.generationsToday += variants.length; if (run) { run.counts.generated += variants.length; patchRunStep(run, 'create', { status: 'completed', detail: `已生成 ${variants.length} 套` }); patchRunStep(run, 'publish', { status: 'waiting_human', detail: '等待人工审核、发布与回填' }); run.status = 'waiting_human'; } saveState(); return { ok: true, count: variants.length, testMode: true }; } return process.env.CONTENTOPS_TEST_ALLOW_UNVERIFIED === '1' && process.env.CONTENTOPS_TEST_ASYNC_CREATION !== '1' ? generateForSelectedCandidate(candidate) : enqueueFirstCreation(candidate); }
  if (route === '/api/variant/status') {
    const item = state.variants.find((x) => x.id === safeText(body.id, 120));
    if (!item) return { ok: false, message: '未找到图文版本' };
    if (!['pending', 'approved', 'rejected'].includes(body.status)) return { ok: false, message: '图文状态不正确' };
    if (!['draft', 'pending', 'approved', 'rejected'].includes(item.status)) return { ok: false, message: '当前状态不能重新审核' };
    if (item.status === body.status) return { ok:true, existing:true, message:'状态已经是目标值，无需重复提交' };
    const testBypassImageGate = process.env.CONTENTOPS_TEST_BYPASS_IMAGE_GATE === '1';
    if (!testBypassImageGate && ['pending', 'approved'].includes(body.status) && item.imagePages?.length && !item.imagePages.every((page) => page.asset?.file)) return { ok: false, message: '请先生齐全部图片，再提交人工审核' };
    item.status = body.status;
    const run = runForVariant(item);
    if (run && body.status === 'approved') { run.counts.approved = (run.counts.approved || 0) + 1; patchRunStep(run, 'publish', { status: 'waiting_human', detail: `${run.counts.approved} 套已通过，等待人工发布并回填数据` }); run.status = 'waiting_human'; run.error = ''; run.finishedAt = ''; }
    addActivity(body.status === 'approved' ? 'success' : 'info', body.status === 'approved' ? '图文审核通过' : body.status === 'pending' ? '图文已提交人工审核' : '图文已退回', item.title);
    saveState(); return { ok: true };
  }
  if (route === '/api/variant/update') { const item = state.variants.find((x) => x.id === safeText(body.id, 120)); if (!item) return { ok: false, message: '未找到图文版本' }; if (!['draft', 'pending', 'rejected'].includes(item.status)) return { ok: false, message: '当前状态不允许修改' }; if (['queued', 'running'].includes(item.imageJob?.status)) return { ok:false, code:'IMAGE_JOB_RUNNING', message:'图片任务正在运行。请等待完成、超时或停止总控后再修改页面，避免生成目标与编辑内容不一致' }; const title = safeText(body.title, 160); const content = safeText(body.body, 8000); const tags = normalizeTextList(body.tags, 12, 60); const imageReferencePolicy = ['auto', 'required', 'disabled'].includes(body.imageReferencePolicy) ? body.imageReferencePolicy : 'auto'; const policyChanged = (item.imageReferencePolicy || 'auto') !== imageReferencePolicy; if (Array.isArray(body.imagePages) && body.imagePages.some((page) => String(page?.imagePrompt ?? page?.prompt ?? '').length > 6000)) return { ok:false, message:'单页生图提示词不能超过6000个字符，请精简后保存' }; const imagePages = Array.isArray(body.imagePages) ? body.imagePages.map((page, index) => normalizeImagePage(page, index)).filter(Boolean).slice(0, 12) : []; if (!title || !content || imagePages.length < 2 || imagePages.some((page) => !page.imagePrompt)) return { ok: false, message: '标题、正文、至少2张图片和每页图片提示词不能为空' }; const oldPages = item.imagePages || []; const prior = new Map(oldPages.map((page) => [page.id, page])); let invalidated = 0; item.title = title; item.body = content; item.tags = tags; item.imageReferencePolicy = imageReferencePolicy; item.imagePages = imagePages.map((page) => { const before = prior.get(page.id); const unchanged = !policyChanged && before && before.copy === page.copy && before.imagePrompt === page.imagePrompt; if (before?.asset && !unchanged) invalidated += 1; return { ...page, asset: unchanged ? before.asset : null }; }); const retainedFiles = new Set(item.imagePages.map((page) => page.asset?.file).filter(Boolean)); const removedFiles = oldPages.map((page) => page.asset?.file).filter((file) => file && !retainedFiles.has(file)); item.pages = item.imagePages.map((page) => page.copy); item.status = 'draft'; item.imageStatus = item.imagePages.every((page) => page.asset?.file) ? 'ready' : 'draft'; if (policyChanged) item.imageJob = null; item.updatedAt = now(); addActivity('info', '一做工作台已保存', invalidated ? `${item.title} · ${invalidated}张图片因企业图片策略、提示词或上图文案变更而需要重做` : item.title); saveStateWithGeneratedImageCleanup(removedFiles); return { ok: true, invalidated, policyChanged }; }
  if (route === '/api/variant/image/generate') { const item = state.variants.find((x) => x.id === safeText(body.id, 120)); if (!item) return { ok: false, message: '未找到图文版本' }; if (!['draft', 'pending', 'rejected'].includes(item.status)) return { ok: false, message: '当前状态不允许生成或重做图片' }; return startVariantImageJob(item, normalizeTextList(body.pageIds, 20, 120), { force:Boolean(body.force) }); }
  if (route === '/api/variant/export-directory') { const item = state.variants.find((x) => x.id === safeText(body.id, 120)); if (!item) return { ok: false, message: '未找到图文版本' }; const directory = safeText(body.directory, 2000); if (!directory || !path.isAbsolute(directory)) return { ok: false, message: '请填写本机绝对导出文件夹路径' }; try { fs.mkdirSync(directory, { recursive: true }); } catch (error) { return { ok: false, message: `无法使用导出文件夹：${error.message}` }; } item.exportDirectory = directory; item.updatedAt = now(); saveState(); return { ok: true, directory }; }
  if (route === '/api/variant/delete') { const id = safeText(body.id, 120); const item = state.variants.find((variant) => variant.id === id); if (!item) return { ok: false, message: '未找到图文版本' }; const family = [item, ...state.variants.filter((variant) => variant.parentVariantId === id)]; if (family.some(activeWorkflowReferencesVariant)) return { ok: false, message: '该版本仍属于进行中的工作流，暂时不能删除' }; if (family.some(protectedVariant)) return { ok: false, message: '该版本或其二做子版本已有审核、导出、发布或成功沉淀记录，不能删除' }; const result = deleteVariantRecords(family.map((variant) => variant.id)); addActivity('warning', '图文版本已删除', `${item.title} · 共清理${result.deleted}个未发布版本`); saveStateWithGeneratedImageCleanup(result.generatedFiles); return { ok: true, deleted:result.deleted }; }
  if (route === '/api/variant/cleanup') { const ids = state.variants.filter((item) => ['pending', 'rejected'].includes(item.status) && !activeWorkflowReferencesVariant(item) && !protectedVariant(item) && !state.variants.some((child) => child.parentVariantId === item.id)).map((item) => item.id); const result = deleteVariantRecords(ids); addActivity('warning', '待审核区批量清理完成', `删除${result.deleted}个不属于进行中任务的待审或退回版本`); saveStateWithGeneratedImageCleanup(result.generatedFiles); return { ok: true, deleted:result.deleted }; }
  if (route === '/api/workflow/cleanup') { const before = state.workflowRuns.length; state.workflowRuns = state.workflowRuns.filter((run) => !['completed', 'failed', 'cancelled'].includes(run.status)); const deleted = before - state.workflowRuns.length; addActivity('info', '历史任务记录已整理', `清理${deleted}条已结束记录，进行中和受阻记录保留`); saveState(); return { ok: true, deleted }; }
  if (route === '/api/variant/export') { const item = state.variants.find((x) => x.id === safeText(body.id, 120)); if (!item) return { ok: false, message: '未找到图文版本' }; if (!['approved', 'exported', 'published'].includes(item.status)) return { ok: false, message: '只有审核通过的内容才能导出' }; return exportVariant(item); }
  if (route === '/api/metrics/save') {
    if (!state.settings.masterEnabled) return stopResult('人工总控处于停止状态，发布登记与二次分析不会启动');
    const item = state.variants.find((x) => x.id === safeText(body.variantId, 120)); if (!item) return { ok:false, message:'未找到图文版本' };
    if (!['approved','exported','published'].includes(item.status)) return { ok:false, message:'只有审核通过的内容才能登记为已发布笔记' };
    if (item.platform !== '小红书') return { ok:false, code:'PLATFORM_PERFORMANCE_NOT_IMPLEMENTED', message:'抖音创作者后台数据采集尚未接入；当前不会把抖音作品误交给小红书后台分析' };
    const identity = await resolveXhsPublicationIdentity(body.link); if (!identity.ok) return identity;
    const link = identity.resolvedUrl;
    const metricFields = ['exposure', 'likes', 'saves', 'comments'];
    const manualMetricsProvided = metricFields.every((field) => body[field] !== undefined && body[field] !== null && String(body[field]).trim() !== '');
    const manualSnapshot = manualMetricsProvided ? normalizePerformanceSnapshot({ ...body, capturedAt:now(), source:'manual', views:body.views ?? body.exposure, shares:body.shares, followers:body.followers, coverClickRate:body.coverClickRate, averageViewSeconds:body.averageViewSeconds }) : null;
    if (manualSnapshot && (manualSnapshot.likes > manualSnapshot.exposure || manualSnapshot.saves > manualSnapshot.exposure || manualSnapshot.comments > manualSnapshot.exposure)) return { ok:false, message:'互动数不能高于曝光/播放量' };
    item.publicationOriginalUrl = identity.originalUrl; item.publicationUrl = link; item.publicationNoteId = identity.noteId; item.creatorRowKey = ''; item.creatorMatchedBy = ''; item.creatorMatchConfidence = 0; item.publishedAt = safeText(body.publishedAt, 80) || item.publishedAt || now(); item.status = 'published'; item.performanceSnapshots ||= [];
    const run = runForVariant(item); if (run) { run.counts.published = (run.counts.published || 0) + 1; patchRunStep(run, 'publish', { status:'completed', detail:`已登记发布 ${run.counts.published} 条，已开启后台自动跟踪` }); patchRunStep(run, 'performance', { status:'waiting_human', detail:'已登记发布链接，等待小红书创作后台自动采样' }); run.status = 'waiting_human'; }
    addActivity('success', '已登记发布链接', `${item.title} · ${item.publishedAt} · 将立即尝试采样，并按2/24/72小时自动跟踪`); saveState();
    if (manualSnapshot) {
      item.performanceSnapshots.push(manualSnapshot); saveState();
      const result = await analyzePublishedPerformance(item, manualSnapshot, { manual:true });
      return { ...result, noteId:item.publicationNoteId, matchedBy:item.creatorMatchedBy, matchConfidence:item.creatorMatchConfidence, message:'已登记发布链接和人工兜底快照；后台仍会按节点自动采样' };
    }
    const sampled = await collectCreatorPerformance({ variantIds:[item.id], manual:true });
    if (!sampled.ok && !['LOGIN_REQUIRED', 'CAPTCHA', 'PAGE_UNRECOGNIZED'].includes(sampled.code)) return sampled;
    const matched = Number(sampled.sampled || 0) > 0;
    return { ok:true, tracked:true, sampled:matched, noteId:item.publicationNoteId, matchedBy:item.creatorMatchedBy, matchConfidence:item.creatorMatchConfidence, message: matched ? '发布链接已登记，已读取创作后台初始快照；后续将自动跟踪' : '发布链接已登记，等待创作后台出现数据；后续将按2/24/72小时自动跟踪' };
  }
  if (route === '/api/variant/scale') { const generation = masterGeneration; if (masterStopped(generation)) return stopResult('人工总控处于停止状态，二做不会启动'); const parent = state.variants.find((x) => x.id === safeText(body.id, 120)); if (!parent) return { ok: false, message: '未找到图文版本' }; if (parent.decision === 'scaled') return { ok: true, existing: true, count: state.variants.filter((x) => x.parentVariantId === parent.id).length, message: '已经进入放大循环' }; if (parent.decision !== 'scale') return { ok: false, message: '只有系统判断为“建议放大”的内容才能进入下一轮' }; const candidate = state.candidates.find((x) => x.id === parent.candidateId); if (!candidate) return { ok: false, message: '没有找到母版来源' }; const run = runForVariant(parent); if (run) { run.status = 'running'; patchRunStep(run, 'scale', { status: 'running', detail: '人工已确认，正在生成二做版本' }); } try { const context = `这是基于已发布胜出版本的二次生产。胜出元素：${JSON.stringify(parent.performanceAnalysis?.winningElements || [])}。下一方向：${JSON.stringify(parent.performanceAnalysis?.nextDirections || [])}`; const scaleCount = state.settings.scaleGenerationCount; const generated = SELF_TEST && !aiReady() ? { ok: true, variants: buildVariants(candidate).slice(0, scaleCount), cost: 0 } : await generateWithAi(candidate, scaleCount, context); if (masterStopped(generation)) return stopResult('人工总控已停止，二做结果不会写入'); if (!generated?.ok || !Array.isArray(generated.variants)) return generated?.code === 'MASTER_STOPPED' ? generated : { ok: false, code: generated?.code || 'AI_ERROR', message: generated?.message || '二做没有返回可用版本' }; const children = generated.variants.map((item, index) => ({ ...item, workflowRunId: run?.id || parent.workflowRunId || '', parentVariantId: parent.id, title: item.title || `${parent.title} · 放大实验${index + 1}` })); state.variants.unshift(...children); parent.decision = 'scaled'; if (run) { run.counts.scaled = (run.counts.scaled || 0) + children.length; run.actualCost += generated.cost || 0; patchRunStep(run, 'scale', { status: 'completed', detail: `已生成 ${children.length} 套二做版本，转入新一轮人工审核` }); finishRun(run, 'completed'); } if (!state.materials.some((x) => x.sourceVariantId === parent.id)) state.materials.unshift({ id: uid('mat'), sourceVariantId: parent.id, type: '胜出内容', name: parent.title, uses: 1, status: '已验证', score: parent.performanceAnalysis?.confidence || 85 }); addActivity('success', '进入二次生产循环', `新增${children.length}个受控变体，母版：${parent.title}`); saveState(); return { ok: true, count: children.length }; } catch (error) { if (run?.status === 'cancelled' || masterStopped(generation)) return stopResult('人工总控已停止，二做结果不会写入'); if (run) { patchRunStep(run, 'scale', { status: 'blocked', detail: error.message }); finishRun(run, 'blocked', error.message); saveState(); } return { ok: false, code: 'AI_ERROR', message: error.message }; } }
  if (route === '/api/agent/restart' && body.id === 'data-agent') {
    if (xhsBrowserBusy()) return { ok:false, code:'ALREADY_RUNNING', message:'小红书专用浏览器正在执行另一项任务，数据循环检查稍后再试' };
    const agent = state.agents.find((item) => item.id === 'data-agent'); if (!agent) return { ok:false, message:'未找到模块' };
    agent.restarts++;
    const task = (async () => { const result = await withActiveCollector(createCreatorCenterCollector, (collector) => collector.probe()); const status = result.ok ? 'ready' : result.code === 'LOGIN_REQUIRED' ? 'needs_login' : result.code === 'CAPTCHA' ? 'verification_required' : 'warning'; setAgent('data-agent', { status, detail:result.message, errorCode:result.code || '', screenshot:'' }); addActivity(result.ok ? 'success' : 'warning', '重新检查 数据循环 Agent', result.message); saveState(); return result; })();
    collectionLocks.set('小红书后台', task); try { return await task; } finally { collectionLocks.delete('小红书后台'); }
  }
  if (route === '/api/agent/restart') { const agent = state.agents.find((x) => x.id === body.id); if (!agent) return { ok: false, message: '未找到模块' }; if (agent.status === 'disabled') return { ok: false, message: '该模块尚未接入，不能伪装成已重启' }; if (agent.id === 'douyin-collector') { if (douyinBrowserBusy()) return { ok:false, code:'ALREADY_RUNNING', message:'抖音专用浏览器正在执行另一项任务，暂时不能重新检查' }; agent.restarts++; const task=(async()=>{ try { const result = await withActiveCollector(createDouyinCollector, (collector) => collector.openLogin()); setAgent('douyin-collector', { status:'needs_login', detail:'抖音专用浏览器已打开；请完成登录或安全验证后，再按关键词测试采集', errorCode:'', screenshot:'' }); addActivity('info','重新检查 抖音抓取 Agent',result.message); saveState(); return result; } catch (error) { setAgent('douyin-collector',{ status:'warning', detail:error.message, errorCode:'BROWSER_START_FAILED' }); saveState(); return { ok:false, code:'BROWSER_START_FAILED', message:error.message }; } })(); collectionLocks.set('抖音登录',task); try { return await task; } finally { collectionLocks.delete('抖音登录'); } } if (['needs_login', 'verification_required'].includes(agent.status)) return { ok: false, message: '该状态需要人工登录或验证，主管不会自动绕过' }; agent.status = 'running'; agent.detail = '主管正在重新检查模块'; agent.restarts++; addActivity('warning', `检查 ${agent.name}`, '由值班主管执行'); saveState(); await sleep(450); agent.status = agent.id === 'xhs-collector' ? 'needs_login' : 'healthy'; agent.detail = agent.id === 'xhs-collector' ? '请通过“检查登录状态”快速确认，不必先跑完整采集' : '检查完成，心跳正常'; agent.lastHeartbeat = now(); saveState(); return { ok: true }; }
  if (route === '/api/settings/save') { const imageRules = normalizeImageRules(body); const requestedAutomation = Boolean(body.workflowAutoEnabled ?? body.collectionEnabled); const automationEnabled = state.settings.masterEnabled && requestedAutomation; const next = { collectionEnabled: automationEnabled, workflowAutoEnabled: automationEnabled, xhsEnabled: Boolean(body.xhsEnabled), douyinEnabled: Boolean(body.douyinEnabled), xhsKeywords: normalizeKeywords(body.xhsKeywords), douyinKeywords: normalizeKeywords(body.douyinKeywords), xhsMaxPerKeyword: finiteNumber(body.xhsMaxPerKeyword, state.settings.xhsMaxPerKeyword, 1, 500), xhsScrollRounds: finiteNumber(body.xhsScrollRounds, state.settings.xhsScrollRounds, 0, 12), xhsDelayMs: finiteNumber(body.xhsDelayMs, state.settings.xhsDelayMs, 1000, 30000), douyinDelayMs: finiteNumber(body.douyinDelayMs, state.settings.douyinDelayMs, 1500, 30000), autoMorningTime: normalizeClock(body.autoMorningTime, state.settings.autoMorningTime), autoAfternoonTime: normalizeClock(body.autoAfternoonTime, state.settings.autoAfternoonTime), manualRawLimit: finiteNumber(body.manualRawLimit, state.settings.manualRawLimit, 30, 50), automaticRawLimit: finiteNumber(body.automaticRawLimit, state.settings.automaticRawLimit, 50, 500), manualFinalLimit: finiteNumber(body.manualFinalLimit, state.settings.manualFinalLimit, 1, 10), automaticFinalLimit: finiteNumber(body.automaticFinalLimit, state.settings.automaticFinalLimit, 1, 10), dailyCandidateLimit: finiteNumber(body.dailyCandidateLimit, state.settings.dailyCandidateLimit, 1, 100000), aiAnalysisLimit: finiteNumber(body.aiAnalysisLimit, state.settings.aiAnalysisLimit, 1, 100000), analysisConcurrency: finiteNumber(body.analysisConcurrency, state.settings.analysisConcurrency, 1, 5), analysisAutoRetryCount: finiteNumber(body.analysisAutoRetryCount, state.settings.analysisAutoRetryCount, 0, 3), generationCount: finiteNumber(body.generationCount, state.settings.generationCount, 1, 20), scaleGenerationCount: finiteNumber(body.scaleGenerationCount, state.settings.scaleGenerationCount, 1, 20), performanceAutoEnabled: body.performanceAutoEnabled !== false, performanceSampleHours: normalizePerformanceSampleHours(body.performanceSampleHours), performanceAccountBaselineNotes: finiteNumber(body.performanceAccountBaselineNotes, state.settings.performanceAccountBaselineNotes, 3, 100), imageCount: imageRules.imageCount, imageAspectRatio: imageRules.aspectRatio, imageSize: imageRules.size, imageTextMode: imageRules.textMode, imageStyle: imageRules.style, imageSingleTimeoutSeconds: Math.round(imageRules.singleTimeoutMs / 1000), imageJobTimeoutMinutes: Math.round(imageRules.jobTimeoutMs / 60000), imageMaxConcurrentJobs: imageRules.maxConcurrentJobs, imageQualityReviewEnabled: imageRules.qualityReviewEnabled, imageQualityThreshold: imageRules.qualityThreshold, imageAutoRetryCount: imageRules.autoRetryCount, imagePipelineVersion: 3, brandColors: imageRules.brandColors, mustShow: imageRules.mustShow, prohibitedElements: imageRules.prohibitedElements, imageDailyBudget: finiteNumber(body.imageDailyBudget, state.settings.imageDailyBudget, 0, 1000000), imageCostPerImage: finiteNumber(body.imageCostPerImage, state.settings.imageCostPerImage, 0, 1000000), dailyBudget: finiteNumber(body.dailyBudget, state.settings.dailyBudget, 0, 1000000), visionDailyBudget: finiteNumber(body.visionDailyBudget, state.settings.visionDailyBudget, 0, 1000000), visionMaxImages: finiteNumber(body.visionMaxImages, state.settings.visionMaxImages, 1, 20), feishuWebhook: safeText(body.feishuWebhook, 2000) };
    next.imagePipelineVersion = 3;
    // 保留旧 API 的兼容入口：历史自动化或已部署的调用方仍可传单套连接；新页面不会再写这些字段。
    if (Object.prototype.hasOwnProperty.call(body, 'aiBaseUrl')) Object.assign(next, { aiBaseUrl: safeText(body.aiBaseUrl, 1000), aiModel: safeText(body.aiModel, 120), aiInputPricePerMillion: finiteNumber(body.aiInputPricePerMillion, state.settings.aiInputPricePerMillion, 0, 100000), aiOutputPricePerMillion: finiteNumber(body.aiOutputPricePerMillion, state.settings.aiOutputPricePerMillion, 0, 100000) });
    if (Object.prototype.hasOwnProperty.call(body, 'visionBaseUrl')) Object.assign(next, { visionBaseUrl: safeText(body.visionBaseUrl, 1000), visionModel: safeText(body.visionModel, 120), visionInputPricePerMillion: finiteNumber(body.visionInputPricePerMillion, state.settings.visionInputPricePerMillion, 0, 100000), visionOutputPricePerMillion: finiteNumber(body.visionOutputPricePerMillion, state.settings.visionOutputPricePerMillion, 0, 100000) });
    if (!next.xhsEnabled && !next.douyinEnabled) return { ok: false, message: '请至少启用一个采集平台' }; if (next.xhsEnabled && !next.xhsKeywords.length) return { ok: false, message: '请至少填写一个小红书关键词' }; if (next.douyinEnabled && !next.douyinKeywords.length) return { ok: false, message: '请至少填写一个抖音关键词' }; if (next.autoMorningTime === next.autoAfternoonTime) return { ok: false, message: '上午和下午自动运行时间不能相同' }; Object.assign(state.settings, next, { aiCredentialConfigured: CREDENTIALS.has(), visionCredentialConfigured: VISION_CREDENTIALS.has() }); const schedulingDetail = requestedAutomation && !automationEnabled ? '人工总控处于停止状态，本次只保存参数，24小时调度仍保持关闭' : '抓取目标、预算与调度将在下一任务生效；模型连接由档案独立管理'; addActivity('info', '系统设置已更新', schedulingDetail); saveState(); return { ok: true, automationEnabled, message: schedulingDetail }; }
  if (route === '/api/ai/credential/save') { try { CREDENTIALS.save(body.apiKey); state.settings.aiCredentialConfigured = true; state.settings.lastAiCheckOk = false; addActivity('success', 'AI 凭据已安全保存', '凭据由当前 Windows 用户加密，不写入业务状态'); saveState(); return { ok: true, message: 'API Key 已由 Windows 加密保存' }; } catch (error) { return { ok: false, message: error.message }; } }
  if (route === '/api/ai/credential/clear') { CREDENTIALS.clear(); state.settings.aiCredentialConfigured = false; state.settings.lastAiCheckOk = false; saveState(); return { ok: true }; }
  if (route === '/api/ai/test') { try { const prompt = '返回 {"ok":true,"message":"连接成功"}'; const reservation = reserveCall('text', prompt.length + 20, 100, '文本模型连接测试'); if (!reservation.ok) return reservation; const result = await callJson({ baseUrl: activeConnection('text').baseUrl, apiKey: activeConnection('text').apiKey, model: activeConnection('text').model, system: '你是连接测试助手，只返回 JSON。', prompt, temperature: 0, timeoutMs: 30000, maxOutputTokens: 100 }); state.settings.lastAiCheckAt = now(); state.settings.lastAiCheckOk = Boolean(result.data?.ok); state.settings.aiCredentialConfigured = CREDENTIALS.has(); recordAiUsage(result.usage, '文本模型连接测试'); addActivity(state.settings.lastAiCheckOk ? 'success' : 'warning', 'AI 接口连接测试', state.settings.lastAiCheckOk ? '模型接口可用' : '模型返回不符合预期'); saveState(); return { ok: state.settings.lastAiCheckOk, message: state.settings.lastAiCheckOk ? '模型 API 已联通' : '模型返回不符合预期' }; } catch (error) { state.settings.lastAiCheckAt = now(); state.settings.lastAiCheckOk = false; addActivity('warning', 'AI 接口连接失败', error.message); saveState(); return { ok: false, message: error.message }; } }
  if (route === '/api/vision/credential/save') { try { VISION_CREDENTIALS.save(body.apiKey); state.settings.visionCredentialConfigured = true; state.settings.lastVisionCheckOk = false; addActivity('success', '视觉模型凭据已安全保存', '视觉 Key 与文本 Key 分开加密保存'); saveState(); return { ok: true, message: '视觉 API Key 已由 Windows 加密保存' }; } catch (error) { return { ok: false, message: error.message }; } }
  if (route === '/api/vision/credential/clear') { VISION_CREDENTIALS.clear(); state.settings.visionCredentialConfigured = false; state.settings.lastVisionCheckOk = false; saveState(); return { ok: true }; }
  if (route === '/api/vision/test') { try { const prompt = '观察测试图片，只返回JSON：{"ok":true,"summary":"一句话描述图片"}'; const reservation = reserveCall('vision', prompt.length + 2000, 200, '视觉模型连接测试'); if (!reservation.ok) return reservation; const result = await callVisionJson({ baseUrl: activeConnection('vision').baseUrl, apiKey: activeConnection('vision').apiKey, model: activeConnection('vision').model, prompt, imageUrls: [VISION_TEST_IMAGE_URL], allowTrustedTestImage: true, timeoutMs: 60000, maxOutputTokens: 200 }); state.settings.lastVisionCheckAt = now(); state.settings.lastVisionCheckOk = Boolean(result.data?.ok); state.settings.visionCredentialConfigured = VISION_CREDENTIALS.has(); recordVisionUsage(result.usage, '视觉模型连接测试'); addActivity(state.settings.lastVisionCheckOk ? 'success' : 'warning', '视觉模型连接测试', state.settings.lastVisionCheckOk ? '视觉模型可以读取图片' : '视觉模型返回不符合预期'); saveState(); return { ok: state.settings.lastVisionCheckOk, message: state.settings.lastVisionCheckOk ? '视觉模型已联通并能读取图片' : '视觉模型返回不符合预期' }; } catch (error) { state.settings.lastVisionCheckAt = now(); state.settings.lastVisionCheckOk = false; addActivity('warning', '视觉模型连接失败', error.message); saveState(); return { ok: false, message: error.message }; } }
  if (route === '/api/feishu/test') { const result = await sendFeishu('【图文爆款Agent】值班主管测试消息：系统当前运行正常。'); addActivity(result.ok ? 'success' : 'warning', '飞书联通测试', result.message); saveState(); return result; }
  if (route === '/api/data/reset') { const generatedFiles = generatedImageFilesFromVariants(state.variants); const keepSettings = SELF_TEST ? null : structuredClone(state.settings); const keepEnterpriseProfiles = SELF_TEST ? [] : structuredClone(state.enterpriseProfiles || []); const keepActiveProfileId = SELF_TEST ? '' : state.activeEnterpriseProfileId; state = initialState(); if (keepSettings) { Object.assign(state.settings, keepSettings, { candidatesToday: 0, analysesToday: 0, generationsToday: 0, spentToday: 0, visionSpentToday: 0, usageDate: DAY() }); state.materials = []; state.enterpriseProfiles = keepEnterpriseProfiles; state.activeEnterpriseProfileId = keepActiveProfileId; } state.candidates = []; state.variants = []; state.publications = []; addActivity('info', '已清空本地业务数据', keepSettings ? '采集设置、企业素材库与专用浏览器登录资料均已保留' : '测试状态已恢复初始值'); saveStateWithGeneratedImageCleanup(generatedFiles); return { ok: true }; }
  return { ok: false, message: '未知操作' };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const STATIC_FILES = new Set(['index.html', 'styles.css', 'app.js']);
function json(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }); res.end(body); }
function bodyError(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; return error; }
function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (declaredLength > maxBytes) { req.resume(); reject(bodyError(`请求内容超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 上限`, 413)); return; }
    let raw = ''; let received = 0; let settled = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (settled) return;
      received += Buffer.byteLength(chunk, 'utf8');
      if (received > maxBytes) { settled = true; reject(bodyError(`请求内容超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 上限`, 413)); return; }
      raw += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(bodyError('请求 JSON 格式不正确', 400)); }
    });
    req.on('error', (error) => { if (!settled) reject(error); });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === '/health') return json(res, 200, { ok: true, appId: APP_ID, mode: state.mode, root: ROOT });
  if (url.pathname.startsWith('/api/')) {
    const origin = req.headers.origin;
    const allowedOrigins = [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`];
    if (origin && !allowedOrigins.includes(origin)) return json(res, 403, { ok: false, message: '来源被拒绝' });
  }
  if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, publicState());
  if (url.pathname === '/api/collector/status' && req.method === 'GET') return json(res, 200, { ok: true, running: ['小红书', '小红书后台', '小红书登录', '小红书检查', '小红书链接导入', '抖音', '抖音链接导入', '抖音登录'].some((key) => collectionLocks.has(key)), agents: state.agents.filter((agent) => ['xhs-collector', 'douyin-collector'].includes(agent.id)) });
  if (url.pathname.startsWith('/api/image/') && req.method === 'GET') {
    const match = url.pathname.match(/^\/api\/image\/([^/]+)\/(\d+)$/);
    const item = match && state.variants.find((variant) => variant.id === decodeURIComponent(match[1]));
    const page = item?.imagePages?.find((candidate) => Number(candidate.index) === Number(match[2]));
    if (!page?.asset?.file) { res.writeHead(404); return res.end('Not found'); }
    try { const file = imageAssetPath(page.asset.file); if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'content-type': page.asset.mime || 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return fs.createReadStream(file).pipe(res); } catch { res.writeHead(404); return res.end('Not found'); }
  }
  const enterpriseImageMatch = url.pathname.match(/^\/api\/enterprise-image\/([^/]+)$/);
  if (enterpriseImageMatch && req.method === 'GET') {
    const assetId = decodeURIComponent(enterpriseImageMatch[1]);
    const profile = state.enterpriseProfiles.find((entry) => entry.imageAssets?.some((asset) => asset.id === assetId));
    const asset = profile?.imageAssets.find((entry) => entry.id === assetId);
    if (!asset) { res.writeHead(404); return res.end('Not found'); }
    try { const file = enterpriseAssetPath(asset.file); if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'content-type':asset.mime, 'cache-control':'no-store', 'x-content-type-options':'nosniff' }); return fs.createReadStream(file).pipe(res); } catch { res.writeHead(404); return res.end('Not found'); }
  }
  if (url.pathname.startsWith('/api/') && req.method === 'POST') {
    try {
      const maxBodyBytes = url.pathname === '/api/enterprise-image/upload' ? 15 * 1024 * 1024 : 1024 * 1024;
      return json(res, 200, await handleAction(url.pathname, await readBody(req, maxBodyBytes)));
    }
    catch (error) { return json(res, Number(error.statusCode) || 500, { ok: false, message: error.message || '接口执行失败' }); }
  }
  if (url.pathname.startsWith('/api/')) return json(res, 405, { ok: false, message: '请求方法不允许' });
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  if (!STATIC_FILES.has(relative)) { res.writeHead(404); return res.end('Not found'); }
  const file = path.resolve(ROOT, relative);
  const relativeToRoot = path.relative(ROOT, file);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
  });
  fs.createReadStream(file).pipe(res);
});

try { createLock(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(0); }
server.listen(PORT, HOST, async () => {
  addActivity('success', '后台服务已启动', `http://${HOST}:${PORT}`); supervisorCheck();
  if (!SELF_TEST) return;
  // 离线自检显式开启总控，只覆盖测试进程；生产默认仍保持人工停止。
  try {
    const post = async (route, payload = {}) => {
      const response = await fetch(`http://${HOST}:${PORT}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return response.json();
    };
    if (!process.env.CONTENTOPS_TEST_OVERRIDES) await post('/api/data/reset');
    // 数据重置会恢复默认的人工停止状态；自检必须在重置后显式开启总控。
    state.settings.masterEnabled = true;
    masterGeneration += 1;
    if (process.env.CONTENTOPS_TEST_RECOVERY_CHECK) {
      const recovered = testHadRecovery;
      process.stdout.write(`${JSON.stringify({ ok: recovered, recovered }, null, 2)}\n`);
      return server.close(() => process.exit(recovered ? 0 : 1));
    }
    const scan = await post('/api/collection/run', { platform: '小红书', manual: !process.env.CONTENTOPS_TEST_EXPECT_BLOCK });
    if (process.env.CONTENTOPS_TEST_EXPECT_BLOCK) {
      if (scan.ok) throw new Error('预期熔断但采集仍然执行');
      process.stdout.write(`${JSON.stringify({ ok: true, blocked: true, message: scan.message }, null, 2)}\n`);
      return server.close();
    }
    if (!scan.ok) throw new Error(`采集自检失败：${scan.message}`);
    if (scan.capped) {
      process.stdout.write(`${JSON.stringify({ ok: true, capped: true, candidates: 0, message: '停止新增，但真实采集仍允许更新历史候选快照' }, null, 2)}\n`);
      return server.close(() => process.exit(0));
    }
    await post('/api/candidate/status', { id: scan.candidate.id, status: 'selected' });
    const generated = await post('/api/variant/generate', { candidateId: scan.candidate.id });
    if (process.env.CONTENTOPS_TEST_EXPECT_BUDGET_BLOCK) {
      if (generated.ok) throw new Error('预期预算熔断但仍然生成');
      process.stdout.write(`${JSON.stringify({ ok: true, blocked: true, message: generated.message }, null, 2)}\n`);
      return server.close();
    }
    if (!generated.ok) throw new Error(`生成自检失败：${generated.message}`);
    const repeatedGeneration = await post('/api/variant/generate', { candidateId: scan.candidate.id });
    if (!repeatedGeneration.ok || !repeatedGeneration.existing) throw new Error('重复生成幂等自检失败');
    let current = await fetch(`http://${HOST}:${PORT}/api/state`).then((response) => response.json());
    const variant = state.variants.find((item) => item.candidateId === scan.candidate.id);
    if (!variant) throw new Error('未生成图文版本');
    // 旧式离线图卡没有 AI 图片资产；自检在本地渲染器导出前只验证状态流，不模拟线上图片门禁。
    variant.status = 'approved';
    saveState();
    const exported = await post('/api/variant/export', { id: variant.id });
    const exportedPngCount = exported.ok && exported.path && fs.existsSync(exported.path) ? fs.readdirSync(exported.path).filter((name) => name.endsWith('.png')).length : -1;
    if (!exported.ok || exportedPngCount !== variant.pages.length) throw new Error(`PNG图卡导出自检失败：${JSON.stringify({ exported, exportedPngCount, expected:variant.pages.length })}`);
    const metrics = await post('/api/metrics/save', { variantId: variant.id, publishedAt: now(), exposure: 10000, likes: 900, saves: 700, comments: 180, link: 'https://www.xiaohongshu.com/explore/64f123456789abcdef123456' });
    if (!metrics.ok || metrics.decision !== 'test') throw new Error(`人工登记门禁异常：${JSON.stringify(metrics)}`);
    variant.decision = 'scale';
    const scaled = await post('/api/variant/scale', { id: variant.id });
    if (!scaled.ok || scaled.count !== 5) throw new Error('放大循环自检失败');
    const repeatedScale = await post('/api/variant/scale', { id: variant.id });
    if (!repeatedScale.ok || !repeatedScale.existing || repeatedScale.count !== 5) throw new Error('重复放大幂等自检失败');
    current = await fetch(`http://${HOST}:${PORT}/api/state`).then((response) => response.json());
    const summary = { ok: true, candidates: current.candidates.length, variants: current.variants.length, pngCards: variant.pages.length, materials: current.materials.length, agents: current.agents.length, decision: metrics.decision, scaledVariants: scaled.count, generationIdempotent: true, scaleIdempotent: true };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    server.close(() => { cleanupSelfTestData(); process.exit(0); });
  } catch (error) {
    process.stderr.write(`SELF_TEST_FAILED: ${error.stack || error.message}\n`);
    server.close(() => { cleanupSelfTestData(); process.exit(1); });
  }
});
server.on('error', (error) => { process.stderr.write(`SERVER_START_FAILED: ${error.message}\n`); releaseLock(); process.exit(error.code === 'EADDRINUSE' ? 0 : 1); });

function runScheduled(platform) { runCollection(platform).catch((error) => { setAgent(platform === '小红书' ? 'xhs-collector' : 'douyin-collector', { status: 'warning', detail: error.message }); addActivity('warning', `${platform}定时扫描失败`, error.message); saveState(); }); }
const scheduleTimer = setInterval(() => {
  supervisorCheck({ persist:false });
  if (state.settings.masterEnabled && state.settings.performanceAutoEnabled && performanceAutoAttemptAllowed() && !xhsBrowserBusy()) {
    const due = state.variants.some((item) => item.platform === '小红书' && item.status === 'published' && pendingPerformanceMilestones(item).length);
    if (due) collectCreatorPerformance({ manual:false }).catch((error) => { setAgent('data-agent', { status:'warning', detail:error.message }); addActivity('warning', '小红书后台自动采样失败', error.message); saveState(); });
  }
  if (!state.settings.masterEnabled || !state.settings.workflowAutoEnabled) return;
  const slot = dueAutomaticSlot(); if (!slot) return;
  const slotKey = `${localDay()}@${slot}`; if (state.settings.lastAutomaticSlot === slotKey) return;
  if (workflowPromise) { setAgent('orchestrator', { status: 'idle', detail: `自动时段 ${slot} 等待当前任务结束后补跑` }); return; }
  runWorkflow('scheduled').then((result) => { if (result.code !== 'WORKFLOW_RUNNING') { state.settings.lastAutomaticSlot = slotKey; saveState(); } }).catch((error) => { setAgent('orchestrator', { status: 'warning', detail: error.message }); addActivity('warning', '定时工作流失败', error.message); saveState(); });
}, 60 * 1000);
if (SELF_TEST) scheduleTimer.unref();

process.on('uncaughtException', (error) => { try { addActivity('warning', '后台发生未捕获异常', error.message); saveState(); } catch {} releaseLock(); process.stderr.write(`${error.stack || error.message}\n`); process.exit(1); });
process.on('unhandledRejection', (error) => { try { addActivity('warning', '后台异步任务失败', String(error?.message || error)); saveState(); } catch {} releaseLock(); process.stderr.write(`${error?.stack || error}\n`); process.exit(1); });
function shutdownCollectors() { for (const collector of activeCollectors) try { collector.closeBrowser(); } catch {}; activeCollectors.clear(); }
process.on('SIGTERM', () => { shutdownCollectors(); releaseLock(); process.exit(0); });
process.on('SIGINT', () => { shutdownCollectors(); releaseLock(); process.exit(0); });
process.on('exit', releaseLock);
