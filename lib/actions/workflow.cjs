'use strict';
// 工作流、采集与发布后数据
// 这些处理函数从 server.cjs 的 handleAction 原样搬来；ctx 约定见 docs/ARCHITECTURE.md。



module.exports = function register(ctx) {
    const { addActivity, collectCreatorPerformance, collectionLocks, createCreatorCenterCollector, createDouyinCollector, createXhsCollector, douyinBrowserBusy, runCollection, saveState, setAgent, withActiveCollector, xhsBrowserBusy } = ctx;

  return {
  '/api/collection/run': async (body) => {
return runCollection(body.platform, { manual: Boolean(body.manual) });
  },
  '/api/workflow/pause-auto': async (body) => {
    const state = ctx.state;
state.settings.workflowAutoEnabled = false; state.settings.collectionEnabled = false; addActivity('warning', '24小时工作流已暂停', '由人工在工作台暂停'); saveState(); return { ok: true };
  },
  '/api/collector/xhs/open-login': async (body) => {
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
  },
  '/api/collector/xhs/probe': async (body) => {
    const state = ctx.state;
if (!state.settings.xhsEnabled) return { ok:false, code:'PLATFORM_DISABLED', message:'请先启用小红书并保存关键词' };
    if (xhsBrowserBusy()) return { ok:false, code:'ALREADY_RUNNING', message:'小红书专用浏览器正在执行另一项任务，请等待完成后再检查' };
    const task = (async () => {
      const result = await withActiveCollector(createXhsCollector, (collector) => collector.probe(state.settings.xhsKeywords?.[0] || '内容运营'));
      const status = result.ok ? 'ready' : result.code === 'LOGIN_REQUIRED' ? 'needs_login' : result.code === 'CAPTCHA' ? 'verification_required' : 'warning';
      setAgent('xhs-collector', { status, detail:result.message, errorCode:result.ok ? '' : result.code || 'COLLECTOR_ERROR', screenshot:result.screenshot || '' });
      addActivity(result.ok ? 'success' : 'warning', result.ok ? '小红书登录状态检查通过' : '小红书登录状态检查未通过', result.message); saveState(); return result;
    })();
    collectionLocks.set('小红书检查', task); try { return await task; } finally { collectionLocks.delete('小红书检查'); }
  },
  '/api/collector/xhs-creator/open-login': async (body) => {
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
  },
  '/api/performance/collect': async (body) => {
return collectCreatorPerformance({ variantIds:Array.isArray(body.variantIds) ? body.variantIds : [], manual:Boolean(body.manual) });
  },
  '/api/collector/douyin/open-login': async (body) => {
if (douyinBrowserBusy()) return { ok:false, code:'ALREADY_RUNNING', message:'抖音专用浏览器正在执行另一项任务，请等待完成后再打开登录窗口' };
    const task = (async () => { try { const result = await withActiveCollector(createDouyinCollector, (collector) => collector.openLogin()); setAgent('douyin-collector', { status:'needs_login', detail:'抖音专用浏览器已打开，等待人工扫码登录后导入公开图文链接', errorCode:'', screenshot:'' }); saveState(); return result; } catch (error) { setAgent('douyin-collector', { status:'warning', detail:error.message, errorCode:'BROWSER_START_FAILED' }); saveState(); return { ok:false, code:'BROWSER_START_FAILED', message:error.message }; } })();
    collectionLocks.set('抖音登录', task); try { return await task; } finally { collectionLocks.delete('抖音登录'); }
  },
  '/api/workflow/cleanup': async (body) => {
    const state = ctx.state;
const before = state.workflowRuns.length; state.workflowRuns = state.workflowRuns.filter((run) => !['completed', 'failed', 'cancelled'].includes(run.status)); const deleted = before - state.workflowRuns.length; addActivity('info', '历史任务记录已整理', `清理${deleted}条已结束记录，进行中和受阻记录保留`); saveState(); return { ok: true, deleted };
  },
  };
};
