'use strict';
// 图文版本、审核与发布登记
// 这些处理函数从 server.cjs 的 handleAction 原样搬来；ctx 约定见 docs/ARCHITECTURE.md。

const { normalizeTextList, now, safeText } = require('../util.cjs');

module.exports = function register(ctx) {
    const { SELF_TEST, imageJobLocks, activeWorkflowReferencesVariant, addActivity, aiReady, analyzePublishedPerformance, attachCandidateToRun, budgetRemaining, buildVariants, collectCreatorPerformance, creatorRowKey, deleteVariantRecords, enqueueFirstCreation, exportVariant, fs, generateForSelectedCandidate, normalizeImagePage, normalizePerformanceSnapshot, patchRunStep, path, protectedVariant, resetDailyUsageIfNeeded, resolveXhsPublicationIdentity, runForCandidate, runForVariant, saveState, saveStateWithGeneratedImageCleanup, startVariantImageJob, stopResult } = ctx;

  return {
  '/api/variant/generate': async (body) => {
    const state = ctx.state;
resetDailyUsageIfNeeded(); const candidate = state.candidates.find((x) => x.id === safeText(body.candidateId, 120)); if (!candidate) return { ok: false, message: '未找到候选内容' }; if (!['selected', 'generated'].includes(candidate.status)) return { ok: false, message: '请先人工确认这个方向' }; const existing = state.variants.filter((x) => x.candidateId === candidate.id); if (existing.length) return { ok: true, existing: true, count: existing.length, message: '该方向已经生成过，不重复计费' }; if (budgetRemaining() <= 0) return { ok: false, code: 'BUDGET_LIMIT', message: '今日AI预算不足，已自动熔断' }; if (SELF_TEST && !aiReady()) { const run = runForCandidate(candidate.id); attachCandidateToRun(run, candidate.id); const variants = buildVariants(candidate).map((variant) => ({ ...variant, workflowRunId: run?.id || '' })); state.variants.unshift(...variants); candidate.status = 'generated'; state.settings.generationsToday += variants.length; if (run) { run.counts.generated += variants.length; patchRunStep(run, 'create', { status: 'completed', detail: `已生成 ${variants.length} 套` }); patchRunStep(run, 'publish', { status: 'waiting_human', detail: '等待人工审核、发布与回填' }); run.status = 'waiting_human'; } saveState(); return { ok: true, count: variants.length, testMode: true }; } return process.env.CONTENTOPS_TEST_ALLOW_UNVERIFIED === '1' && process.env.CONTENTOPS_TEST_ASYNC_CREATION !== '1' ? generateForSelectedCandidate(candidate) : enqueueFirstCreation(candidate);
  },
  '/api/variant/status': async (body) => {
    const state = ctx.state;
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
  },
  '/api/variant/update': async (body) => {
    const state = ctx.state;
const item = state.variants.find((x) => x.id === safeText(body.id, 120)); if (!item) return { ok: false, message: '未找到图文版本' }; if (!['draft', 'pending', 'rejected'].includes(item.status)) return { ok: false, message: '当前状态不允许修改' }; if (['queued', 'running'].includes(item.imageJob?.status)) return { ok:false, code:'IMAGE_JOB_RUNNING', message:'图片任务正在运行。请等待完成、超时或停止总控后再修改页面，避免生成目标与编辑内容不一致' }; const title = safeText(body.title, 160); const content = safeText(body.body, 8000); const tags = normalizeTextList(body.tags, 12, 60); const imageReferencePolicy = ['auto', 'required', 'disabled'].includes(body.imageReferencePolicy) ? body.imageReferencePolicy : 'auto'; const policyChanged = (item.imageReferencePolicy || 'auto') !== imageReferencePolicy; if (Array.isArray(body.imagePages) && body.imagePages.some((page) => String(page?.imagePrompt ?? page?.prompt ?? '').length > 6000)) return { ok:false, message:'单页生图提示词不能超过6000个字符，请精简后保存' }; const imagePages = Array.isArray(body.imagePages) ? body.imagePages.map((page, index) => normalizeImagePage(page, index)).filter(Boolean).slice(0, 12) : []; if (!title || !content || imagePages.length < 2 || imagePages.some((page) => !page.imagePrompt)) return { ok: false, message: '标题、正文、至少2张图片和每页图片提示词不能为空' }; const oldPages = item.imagePages || []; const prior = new Map(oldPages.map((page) => [page.id, page])); let invalidated = 0; item.title = title; item.body = content; item.tags = tags; item.imageReferencePolicy = imageReferencePolicy; item.imagePages = imagePages.map((page) => { const before = prior.get(page.id); const unchanged = !policyChanged && before && before.copy === page.copy && before.imagePrompt === page.imagePrompt; if (before?.asset && !unchanged) invalidated += 1; return { ...page, asset: unchanged ? before.asset : null }; }); const retainedFiles = new Set(item.imagePages.map((page) => page.asset?.file).filter(Boolean)); const removedFiles = oldPages.map((page) => page.asset?.file).filter((file) => file && !retainedFiles.has(file)); item.pages = item.imagePages.map((page) => page.copy); item.status = 'draft'; item.imageStatus = item.imagePages.every((page) => page.asset?.file) ? 'ready' : 'draft'; if (policyChanged) item.imageJob = null; item.updatedAt = now(); addActivity('info', '一做工作台已保存', invalidated ? `${item.title} · ${invalidated}张图片因参考图策略、提示词或上图文案变更而需要重做` : item.title); saveStateWithGeneratedImageCleanup(removedFiles); return { ok: true, invalidated, policyChanged };
  },
  '/api/variant/image/generate': async (body) => {
    const state = ctx.state;
const item = state.variants.find((x) => x.id === safeText(body.id, 120)); if (!item) return { ok: false, message: '未找到图文版本' }; if (!['draft', 'pending', 'rejected'].includes(item.status)) return { ok: false, message: '当前状态不允许生成或重做图片' }; return startVariantImageJob(item, normalizeTextList(body.pageIds, 20, 120), { force:Boolean(body.force) });
  },
  '/api/variant/export-directory': async (body) => {
    const state = ctx.state;
const item = state.variants.find((x) => x.id === safeText(body.id, 120)); if (!item) return { ok: false, message: '未找到图文版本' }; const directory = safeText(body.directory, 2000); if (!directory || !path.isAbsolute(directory)) return { ok: false, message: '请填写本机绝对导出文件夹路径' }; try { fs.mkdirSync(directory, { recursive: true }); } catch (error) { return { ok: false, message: `无法使用导出文件夹：${error.message}` }; } item.exportDirectory = directory; item.updatedAt = now(); saveState(); return { ok: true, directory };
  },
  '/api/variant/delete': async (body) => {
    const state = ctx.state;
const id = safeText(body.id, 120); const item = state.variants.find((variant) => variant.id === id); if (!item) return { ok: false, message: '未找到图文版本' }; const family = [item, ...state.variants.filter((variant) => variant.parentVariantId === id)]; if (family.some(activeWorkflowReferencesVariant)) return { ok: false, message: '该版本仍属于进行中的工作流，暂时不能删除' };
    // 运行中的生图任务持有该版本的引用，删掉会留下孤儿异步任务并继续计费。
    if (family.some((variant) => imageJobLocks.has(variant.id) || ['queued', 'running'].includes(variant.imageJob?.status))) return { ok: false, code: 'IMAGE_JOB_RUNNING', message: '该版本还有生图任务在运行；请等它结束或先停止总控，再删除' }; if (family.some(protectedVariant)) return { ok: false, message: '该版本或其二做子版本已有审核、导出、发布或成功沉淀记录，不能删除' }; const result = deleteVariantRecords(family.map((variant) => variant.id)); addActivity('warning', '图文版本已删除', `${item.title} · 共清理${result.deleted}个未发布版本`); saveStateWithGeneratedImageCleanup(result.generatedFiles); return { ok: true, deleted:result.deleted };
  },
  '/api/variant/cleanup': async (body) => {
    const state = ctx.state;
const ids = state.variants.filter((item) => ['pending', 'rejected'].includes(item.status) && !activeWorkflowReferencesVariant(item) && !protectedVariant(item) && !imageJobLocks.has(item.id) && !['queued', 'running'].includes(item.imageJob?.status) && !state.variants.some((child) => child.parentVariantId === item.id)).map((item) => item.id); const result = deleteVariantRecords(ids); addActivity('warning', '待审核区批量清理完成', `删除${result.deleted}个不属于进行中任务的待审或退回版本`); saveStateWithGeneratedImageCleanup(result.generatedFiles); return { ok: true, deleted:result.deleted };
  },
  '/api/variant/export': async (body) => {
    const state = ctx.state;
const item = state.variants.find((x) => x.id === safeText(body.id, 120)); if (!item) return { ok: false, message: '未找到图文版本' }; if (!['approved', 'exported', 'published'].includes(item.status)) return { ok: false, message: '只有审核通过的内容才能导出' }; return exportVariant(item);
  },
  '/api/metrics/save': async (body) => {
    const state = ctx.state;
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
  },
  };
};
