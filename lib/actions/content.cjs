'use strict';
// 素材来源与候选内容
// 这些处理函数从 server.cjs 的 handleAction 原样搬来；ctx 约定见 docs/ARCHITECTURE.md。

const { now, safeText } = require('../util.cjs');

module.exports = function register(ctx) {
    const { SELF_TEST, imageJobLocks, activeWorkflowReferencesCandidate, addActivity, analyzeCandidate, attachCandidateToRun, deleteCandidateRecords, patchRunStep, protectedVariant, saveState, saveStateWithGeneratedImageCleanup, setAgent } = ctx;

  return {
  '/api/candidate/delete': async (body) => {
    const state = ctx.state;
const id = safeText(body.id, 120); const item = state.candidates.find((candidate) => candidate.id === id); if (!item) return { ok: false, message: '未找到候选内容' }; if (activeWorkflowReferencesCandidate(id)) return { ok: false, message: '该候选仍属于进行中的工作流，暂时不能删除' };
    // 候选下面可能挂着正在生图的版本，级联删除同样要挡住。
    if (state.variants.some((variant) => variant.candidateId === id && (imageJobLocks.has(variant.id) || ['queued', 'running'].includes(variant.imageJob?.status)))) return { ok: false, code: 'IMAGE_JOB_RUNNING', message: '该候选下有版本正在生图；请等它结束或先停止总控，再删除' }; const related = state.variants.filter((variant) => variant.candidateId === id); if (related.some(protectedVariant)) return { ok: false, message: '该候选已有审核通过、已导出、已发布或成功沉淀的内容，不能级联删除' }; const result = deleteCandidateRecords([id]); addActivity('warning', '候选已人工删除', `${item.title} · 同步清理${result.variantsDeleted}个未发布版本`); saveStateWithGeneratedImageCleanup(result.generatedFiles); return { ok: true, candidatesDeleted:result.candidatesDeleted, variantsDeleted:result.variantsDeleted };
  },
  '/api/candidate/cleanup': async (body) => {
    const state = ctx.state;
const matched = state.candidates.filter((item) => body.scope === 'all_unselected' ? !['selected', 'generated'].includes(item.status) : item.status === 'ignored'); const blockedByWorkflow = []; const blockedByProtectedContent = []; const removable = matched.filter((item) => { const workflowBlocked = activeWorkflowReferencesCandidate(item.id); const related = state.variants.filter((variant) => variant.candidateId === item.id); const protectedContent = related.some(protectedVariant) || related.some((variant) => imageJobLocks.has(variant.id) || ['queued', 'running'].includes(variant.imageJob?.status)); if (workflowBlocked) blockedByWorkflow.push(item.id); if (protectedContent) blockedByProtectedContent.push(item.id); return !workflowBlocked && !protectedContent; }); const result = deleteCandidateRecords(removable.map((item) => item.id)); const blocked = matched.length - result.candidatesDeleted; const message = result.candidatesDeleted ? `删除${result.candidatesDeleted}条候选，关联未发布版本${result.variantsDeleted}个${blocked ? `；另有${blocked}条受保护未删除` : ''}` : matched.length ? `${matched.length}条候选均受未结束任务或已发布内容保护，未删除` : '没有符合清理条件的候选'; addActivity(result.candidatesDeleted ? 'warning' : 'info', '候选池批量清理完成', message); saveStateWithGeneratedImageCleanup(result.generatedFiles); return { ok: true, matched: matched.length, blocked, blockedByWorkflow: blockedByWorkflow.length, blockedByProtectedContent: blockedByProtectedContent.length, message, candidatesDeleted:result.candidatesDeleted, variantsDeleted:result.variantsDeleted };
  },
  '/api/candidate/analyze': async (body) => {
    const state = ctx.state;
const item = state.candidates.find((x) => x.id === safeText(body.id, 120)); if (!item) return { ok: false, message: '未找到候选内容' }; try { const result = await analyzeCandidate(item); return result; } catch (error) { item.analysisStatus = 'retryable_failed'; item.analysisTask ||= {}; item.analysisTask.lastFailure = { status:'retryable_failed', lastError:safeText(error.message,800), updatedAt:now() }; setAgent('analyst', { status: 'warning', detail: error.message }); addActivity('warning', '候选分析待重试', `${item.title} · ${error.message}`); saveState(); return { ok: false, code: 'AI_ERROR', message: error.message }; }
  },
  '/api/candidate/status': async (body) => {
    const state = ctx.state;
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
  },
  };
};
