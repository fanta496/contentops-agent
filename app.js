(() => {
  const api = window.contentOps || (location.protocol.startsWith('http') ? createHttpApi() : createBrowserFallback());
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value = '') => String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  const compact = (value = 0) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value));
  const timeAgo = (date) => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
    return `${Math.floor(seconds / 86400)}天前`;
  };

  const viewNames = {
    dashboard: ['总控台', '内容工作流控制台'], runs: ['任务记录', '查看每一轮真实执行'], radar: ['候选与选款', 'AI预选后由人工确认方向'], creation: ['图文生产', '使用真实模型生成原创内容'],
    produced: ['已生产内容库', '集中管理所有一做与二做成品'],
    review: ['发布与数据', '人工审核、发布和数据回填'], loop: ['分析与二做', '让真实表现决定下一轮'], materials: ['成功素材库', '保存真正被数据验证的东西'],
    enterprise: ['企业素材库', '管理“做”阶段必须使用的企业真实资料'],
    supervisor: ['值班主管', '整套系统的管理者'], settings: ['接入与设置', '配置抓取目标、模型、成本与告警']
  };

  let state = null;
  let activeView = 'dashboard';
  let selectedCandidateId = null;
  let platformFilter = '全部';
  let candidateSearch = '';
  let candidateSort = 'score';
  let producedFilter = 'all';
  let producedSearch = '';
  let serviceOnline = true;
  let pollFailures = 0;
  let settingsDirty = false;
  let lastFocusedElement = null;
  let collectionBatchRunning = false;
  let advancedSettingsVisible = false;
  let activeVariantModalId = null;
  let activeVariantModalSignature = '';

  function variantModalStateSignature(item) {
    if (!item) return '';
    return JSON.stringify({
      status: item.status,
      updatedAt: item.updatedAt,
      imageStatus: item.imageStatus,
      imageReferencePolicy: item.imageReferencePolicy || 'auto',
      imageJob: item.imageJob ? {
        id: item.imageJob.id,
        status: item.imageJob.status,
        completed: item.imageJob.completed,
        failed: item.imageJob.failed,
        total: item.imageJob.total,
        currentPageId: item.imageJob.currentPageId,
        currentPageIndex: item.imageJob.currentPageIndex,
        message: item.imageJob.message,
        error: item.imageJob.error,
        referencePolicy: item.imageJob.referencePolicy,
        referenceMode: item.imageJob.referenceMode,
        referenceAssetIds: item.imageJob.referenceAssetIds
      } : null,
      pages: (item.imagePages || []).map((page) => ({ id: page.id, file: page.asset?.file || '', generatedAt: page.asset?.generatedAt || '', generationError: page.generationError || '', qualityScore: page.quality?.score ?? null, qualityPassed: page.quality?.passed ?? null }))
    });
  }

  async function init() {
    bindNavigation();
    bindGlobalActions();
    state = await api.getState();
    state.enterpriseProfiles ||= [];
    state.activeEnterpriseProfileId ||= '';
    serviceOnline = true;
    selectedCandidateId = state.candidates[0]?.id || null;
    render();
    api.onStateChanged?.((next) => {
      const modalId = activeVariantModalId;
      const modalWasOpen = Boolean(modalId && $('#variantModal')?.classList.contains('open'));
      const previousModalSignature = activeVariantModalSignature;
      state = next; state.enterpriseProfiles ||= []; state.activeEnterpriseProfileId ||= ''; serviceOnline = true; pollFailures = 0; render();
      if (modalWasOpen && modalId) {
        const refreshedVariant = state.variants.find((variant) => variant.id === modalId);
        if (refreshedVariant && variantModalStateSignature(refreshedVariant) !== previousModalSignature) openVariant(modalId);
      }
    }, () => { serviceOnline = false; pollFailures += 1; renderConnectionState(); });
  }

  function render() {
    if (!state) return;
    renderSidebar();
    renderDashboard();
    renderRuns();
    renderRadar();
    renderCreation();
    renderProduced();
    renderReview();
    renderLoop();
    renderEnterprise();
    renderMaterials();
    renderSupervisor();
    if (activeView === 'settings' && !settingsDirty) renderSettings();
    renderConnectionState();
  }

  function bindNavigation() {
    $$('.nav-item[data-view]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
    document.addEventListener('click', (event) => {
      const go = event.target.closest('[data-go]');
      if (go) navigate(go.dataset.go);
    });
  }

  function navigate(view) {
    if (activeView === 'settings' && view !== 'settings' && settingsDirty) {
      if (!confirm('设置尚未保存，离开后本次修改会丢失。确定离开吗？')) return false;
      settingsDirty = false;
    }
    activeView = view;
    $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
    $$('.nav-item[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
    $('#breadcrumb').textContent = viewNames[view][0];
    $('#pageTitle').textContent = viewNames[view][1];
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (view === 'settings') { settingsDirty = false; renderSettings(); }
    return true;
  }

  function bindGlobalActions() {
    $('#refreshState').addEventListener('click', async () => { try { state = await api.getState(); serviceOnline = true; pollFailures = 0; render(); toast('状态已刷新'); } catch (error) { serviceOnline = false; renderConnectionState(); toast('刷新失败', error.message, true); } });
    $('#quickCollect').addEventListener('click', () => startWorkflow());
    $('#masterStart').addEventListener('click', startMaster);
    $('#masterStop').addEventListener('click', stopMaster);
    $('#startWorkflow').addEventListener('click', () => startWorkflow());
    $('#collectOnly').addEventListener('click', () => runEnabledScans());
    $('#saveAutoMode').addEventListener('click', saveAutoMode);
    $('#resumeWorkflow').addEventListener('click', resumeWorkflow);
    $('#scanBothButton').addEventListener('click', () => runEnabledScans());
    $('#cleanupCandidates').addEventListener('click', cleanupCandidates);
    $('#cleanupVariants').addEventListener('click', cleanupVariants);
    $('#cleanupRuns').addEventListener('click', cleanupRuns);
    $('#addSourceButton').addEventListener('click', () => openModal('sourceModal'));
    $('#addEnterpriseProfile').addEventListener('click', () => openEnterpriseProfile());
    $$('.modal-close').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
    $$('.modal-layer').forEach((layer) => layer.addEventListener('click', (event) => { if (event.target === layer) closeModal(layer.id); }));

    $('#sourceForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try { if (!(await ensureMasterForExplicitAction())) return; const data = Object.fromEntries(new FormData(event.currentTarget)); const result = await api.addSource(data); if (result.ok) { state = await api.getState(); closeModal('sourceModal'); event.currentTarget.reset(); selectedCandidateId = result.candidate.id; render(); navigate('radar'); toast(`${data.platform}图文已导入候选池`, `已读取 ${result.item?.imageCount || 0} 张图与正文，等待 AI 分析`); } else toast('导入失败', result.message, true); }
      catch (error) { toast('加入失败', error.message, true); }
    });

    $('#metricsForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try { const data = Object.fromEntries(new FormData(event.currentTarget)); const result = await api.saveMetrics(data); if (result.ok) { state = await api.getState(); render(); closeModal('metricsModal'); toast('已登记发布并开启自动跟踪', result.message || '后台将按设定节点自动采样'); } else toast('保存失败', result.message, true); }
      catch (error) { toast('保存失败', error.message, true); }
    });
    $('#enterpriseForm').addEventListener('submit', saveEnterpriseProfile);
    $('#enterpriseImageForm').addEventListener('submit', saveEnterpriseImage);
    $('#enterpriseExportForm').addEventListener('submit', saveEnterpriseExport);

    $('#settingsForm').addEventListener('submit', saveSettings);
    $('#settingsForm').addEventListener('input', () => { settingsDirty = true; });
    $('#settingsForm').addEventListener('change', () => { settingsDirty = true; });
    window.addEventListener('beforeunload', (event) => { if (settingsDirty) { event.preventDefault(); event.returnValue = ''; } });
    $('#addTextProfile').addEventListener('click', () => openModelProfile('text'));
    $('#addVisionProfile').addEventListener('click', () => openModelProfile('vision'));
    $('#addImageProfile').addEventListener('click', () => openModelProfile('image'));
    $('#modelProfileForm').addEventListener('submit', saveModelProfile);
    $('#testModelProfile').addEventListener('click', testModelProfile);
    $('#testFeishu').addEventListener('click', testFeishu);
    $('#testFeishuTop').addEventListener('click', testFeishu);
    $('#openXhsLogin').addEventListener('click', openXhsLogin);
    $('#checkXhsLogin').addEventListener('click', checkXhsLogin);
    $('#openDouyinLogin').addEventListener('click', openDouyinLogin);
    $('#testXhsCollection').addEventListener('click', () => runXhsScan({ saveFirst: true }));
    $('#testDouyinCollection').addEventListener('click', () => runDouyinScan({ saveFirst: true }));
    $('#scanDouyinButton').addEventListener('click', () => runDouyinScan());
    $('#openCreatorLogin').addEventListener('click', openCreatorLogin);
    $('#collectPerformanceNow').addEventListener('click', collectPerformanceNow);
    $('#openCreatorLoginFromSettings').addEventListener('click', openCreatorLogin);
    $('#testPerformanceCollection').addEventListener('click', collectPerformanceNow);
    $('#producedFilter').addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      producedFilter = button.dataset.filter;
      $$('#producedFilter button').forEach((item) => item.classList.toggle('active', item === button));
      renderProduced();
    });
    $('#producedSearch').addEventListener('input', (event) => { producedSearch = event.target.value.trim().toLowerCase(); renderProduced(); });
    $('#toggleAdvancedSettings').addEventListener('click', toggleAdvancedSettings);
    $('#quickStartPrimary').addEventListener('click', (event) => runQuickStartAction(event.currentTarget.dataset.action));
    $('#quickStartSecondary').addEventListener('click', (event) => runQuickStartAction(event.currentTarget.dataset.action));
    $('#inspectAll').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await api.inspectSupervisor();
        if (!result.ok) return toast('巡检失败', result.message || '主管 Agent 未返回有效结果', true);
        state = await api.getState(); render();
        const restartTargets = state.agents.filter((agent) => platformAgentEnabled(agent) && agent.status === 'warning' && !['xhs-collector', 'douyin-collector'].includes(agent.id));
        for (const agent of restartTargets) await api.restartAgent(agent.id);
        if (restartTargets.length) { state = await api.getState(); render(); }
        const remainingIssues = state.agents.filter((agent) => platformAgentEnabled(agent) && ['warning', 'needs_login', 'verification_required'].includes(agent.status));
        if (remainingIssues.length) return toast('巡检完成，仍需处理', remainingIssues.map((agent) => `${agent.name}：${agentStatusText(agent.status)}`).join('；'), true);
        toast('巡检完成', restartTargets.length ? `已唤醒${restartTargets.length}个异常模块，当前状态正常` : '所有已启用模块心跳正常');
      } catch (error) {
        toast('巡检失败', error.message, true);
      } finally {
        button.disabled = false;
      }
    });
    $('#resetDemo').addEventListener('click', async () => {
      if (!confirm('确定清空全部本地候选、生成和发布记录吗？采集设置与专用浏览器登录资料会保留。')) return;
      try { await api.resetDemo(); state = await api.getState(); selectedCandidateId = state.candidates[0]?.id; render(); toast('本地业务数据已清空'); }
      catch (error) { toast('重置失败', error.message, true); }
    });

    $$('#platformFilter button').forEach((button) => button.addEventListener('click', () => {
      platformFilter = button.dataset.filter;
      $$('#platformFilter button').forEach((item) => item.classList.toggle('active', item === button));
      renderRadar();
    }));
    $('#candidateSearch').addEventListener('input', (event) => { candidateSearch = event.target.value.trim().toLowerCase(); renderRadar(); });
    $('#candidateSort').addEventListener('change', (event) => { candidateSort = event.target.value; renderRadar(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { const open = $('.modal-layer.open'); if (open) closeModal(open.id); } });
  }

  function platformAgentEnabled(agent) {
    if (agent?.id === 'xhs-collector') return Boolean(state.settings.xhsEnabled);
    if (agent?.id === 'douyin-collector') return Boolean(state.settings.douyinEnabled);
    return true;
  }

  function platformStatusLabel(agent, enabled) {
    return enabled ? (agentStatusText(agent?.status) || '状态未知') : '未启用';
  }

  function platformKeywordLabel(enabled, keywords = []) {
    if (!enabled) return '未启用';
    return keywords.length ? keywords.map(escapeHtml).join('、') : '未配置';
  }

  function collectorReadiness(agent, enabled) {
    if (!enabled) return { status: 'idle', detail: '未启用' };
    if (['ready', 'healthy', 'running'].includes(agent?.status)) return { status: 'ready', detail: agentStatusText(agent.status) };
    if (['needs_login', 'verification_required', 'warning'].includes(agent?.status)) return { status: 'warning', detail: agentStatusText(agent.status) };
    return { status: 'blocked', detail: agentStatusText(agent?.status) || '状态未知' };
  }

  function setQuickStartButton(button, action, label, hidden = false) {
    button.hidden = hidden;
    button.dataset.action = action || '';
    button.textContent = label || '';
  }

  function renderQuickStartGuide() {
    const runtime = state.runtime || {};
    const collector = state.agents.find((item) => item.id === 'xhs-collector');
    const targetReady = Boolean(state.settings.xhsEnabled && (state.settings.xhsKeywords || []).length);
    const collectorReady = targetReady && ['ready', 'healthy', 'running'].includes(collector?.status);
    const analysisReady = Boolean(runtime.aiReady && runtime.visionReady);
    const enterpriseExists = Boolean(state.activeEnterpriseProfileId && state.enterpriseProfiles?.some((item) => item.id === state.activeEnterpriseProfileId && item.status === 'active'));
    const enterpriseReady = Boolean(enterpriseExists && runtime.enterpriseProductionReady);
    const productionReady = Boolean(enterpriseReady && runtime.imageReady);
    const steps = [
      ['1', '抓取目标', targetReady, targetReady ? `${state.settings.xhsKeywords.length}个关键词` : '启用小红书并填写关键词'],
      ['2', '登录检查', collectorReady, collectorReady ? '专用浏览器可用' : agentStatusText(collector?.status) || '尚未检查'],
      ['3', '分析模型', analysisReady, analysisReady ? '文本＋视觉已就绪' : `${runtime.aiReady ? '文本已好' : '缺文本'} · ${runtime.visionReady ? '视觉已好' : '缺视觉'}`],
      ['4', '生产资料', productionReady, productionReady ? '企业库＋生图已就绪' : !enterpriseExists ? '尚未建立企业素材库' : !enterpriseReady ? '企业库资料不足，请补充真实品牌、产品或卖点' : '还需配置并测试生图模型']
    ];
    $('#quickStartSteps').innerHTML = steps.map(([index, name, ready, detail]) => `<div class="quick-step ${ready ? 'done' : 'pending'}"><i>${ready ? '✓' : index}</i><span><b>${escapeHtml(name)}</b><small>${escapeHtml(detail)}</small></span></div>`).join('');
    const primary = $('#quickStartPrimary'); const secondary = $('#quickStartSecondary');
    if (!targetReady) {
      $('#quickStartTitle').textContent = '第一步：填写小红书关键词';
      $('#quickStartDetail').textContent = '只需要先确定“抓什么”，其他高级参数使用默认值。';
      setQuickStartButton(primary, 'target', '填写抓取目标'); setQuickStartButton(secondary, '', '', true);
    } else if (!collectorReady) {
      const needsLogin = collector?.status === 'needs_login';
      $('#quickStartTitle').textContent = needsLogin ? '第二步：登录小红书' : '第二步：检查小红书登录状态';
      $('#quickStartDetail').textContent = needsLogin ? '打开专用浏览器完成人工登录；系统不会读取密码，也不会绕过验证。' : '快速检查只确认登录和页面可用性，不会抓取30～50条内容。';
      setQuickStartButton(primary, needsLogin ? 'open_xhs_login' : 'check_xhs_login', needsLogin ? '打开登录窗口' : '检查登录状态');
      setQuickStartButton(secondary, needsLogin ? 'check_xhs_login' : 'open_xhs_login', needsLogin ? '我已登录，立即检查' : '重新打开登录窗口');
    } else if (!analysisReady) {
      const missingText = !runtime.aiReady;
      $('#quickStartTitle').textContent = '第三步：连接分析模型';
      $('#quickStartDetail').textContent = '抓取后的分析需要文本模型和视觉模型；生图模型暂时不用配置。';
      setQuickStartButton(primary, missingText ? 'text_model' : 'vision_model', missingText ? '配置文本模型' : '配置视觉模型');
      setQuickStartButton(secondary, missingText && !runtime.visionReady ? 'vision_model' : '', missingText && !runtime.visionReady ? '同时配置视觉模型' : '', !(missingText && !runtime.visionReady));
    } else {
      $('#quickStartTitle').textContent = '基础链路已就绪，可以直接跑一轮';
      $('#quickStartDetail').textContent = productionReady ? '点击后会自动开启人工总控，执行抓取和AI分析，到人工选款处暂停。' : '先验证抓取和AI分析；企业素材库与生图连接不会阻止这一轮。';
      setQuickStartButton(primary, 'run_workflow', '开始抓取并分析');
      setQuickStartButton(secondary, productionReady ? '' : 'production_setup', productionReady ? '' : '补齐生产资料', productionReady);
    }
  }

  async function runQuickStartAction(action) {
    if (action === 'target') { navigate('settings'); $('#basicSettingsCard')?.scrollIntoView({ behavior:'smooth', block:'start' }); return; }
    if (action === 'open_xhs_login') return openXhsLogin();
    if (action === 'check_xhs_login') return checkXhsLogin();
    if (action === 'text_model') return openModelProfile('text');
    if (action === 'vision_model') return openModelProfile('vision');
    if (action === 'production_setup') {
      if (!state.runtime?.enterpriseProductionReady) { navigate('enterprise'); return; }
      navigate('settings');
      if (!state.runtime?.imageReady) openModelProfile('image');
      return;
    }
    if (action === 'run_workflow') return startWorkflow();
  }

  function toggleAdvancedSettings() {
    advancedSettingsVisible = !advancedSettingsVisible;
    $('#settingsForm').classList.toggle('show-advanced', advancedSettingsVisible);
    $('#toggleAdvancedSettings').textContent = advancedSettingsVisible ? '收起高级参数' : '显示高级参数';
  }

  function collectionActionButtons() {
    return ['quickCollect', 'quickStartPrimary', 'quickStartSecondary', 'startWorkflow', 'collectOnly', 'scanBothButton', 'scanDouyinButton', 'checkXhsLogin', 'testXhsCollection', 'testDouyinCollection'].map((id) => $(`#${id}`)).filter(Boolean);
  }

  function syncCollectionActionButtons() {
    const busy = collectionBatchRunning || Boolean(state?.runtime?.workflowRunning) || Boolean(state?.runtime?.collectionRunning);
    collectionActionButtons().forEach((button) => {
      if (busy) {
        if (!button.disabled) button.dataset.runtimeLocked = 'true';
        button.disabled = true;
      } else if (button.dataset.runtimeLocked === 'true') {
        button.disabled = false;
        delete button.dataset.runtimeLocked;
      }
    });
  }

  function lockButtons(buttons) {
    const previous = buttons.map((button) => [button, button.disabled]);
    buttons.forEach((button) => { button.disabled = true; });
    return () => { previous.forEach(([button, disabled]) => { button.disabled = disabled; }); syncCollectionActionButtons(); };
  }

  function renderSidebar() {
    const pendingCandidates = state.candidates.filter((item) => item.status === 'new').length;
    const pendingReviews = state.variants.filter((item) => item.status === 'pending').length;
    $('#candidateNavCount').textContent = pendingCandidates;
    $('#producedNavCount').textContent = state.variants.length;
    $('#reviewNavCount').textContent = pendingReviews;
    const hasWarnings = state.agents.some((agent) => platformAgentEnabled(agent) && ['warning', 'needs_login', 'verification_required'].includes(agent.status));
    $('#supervisorDot').style.background = hasWarnings ? 'var(--gold)' : 'var(--green)';
    $('#lastSaved').textContent = serviceOnline ? `${timeAgo(state.lastSavedAt)}保存` : '后台连接中断';
  }

  function renderDashboard() {
    const runtime = state.runtime || {}; const masterEnabled = Boolean(state.settings.masterEnabled);
    renderQuickStartGuide();
    const workflowCancelling = Boolean(runtime.workflowCancelling);
    $('#masterControl').classList.toggle('running', masterEnabled); $('#masterControlTitle').textContent = workflowCancelling ? '正在停止当前任务' : masterEnabled ? '系统允许运行' : '系统已人工停止'; $('#masterControlDetail').textContent = workflowCancelling ? '人工总控已经关闭；正在等待在途网页或模型请求返回，结果不会写入，也不会进入下一阶段。' : masterEnabled ? '手动工作流与24小时调度可以执行；点击立即停止可阻止进入后续阶段。' : '不会启动抓取、分析或生产；重启程序后仍保持停止。'; $('#masterStart').disabled = masterEnabled || Boolean(runtime.workflowRunning); $('#masterStop').disabled = !masterEnabled;
    const collector = state.agents.find((item) => item.id === 'xhs-collector');
    const douyinCollector = state.agents.find((item) => item.id === 'douyin-collector');
    const current = state.workflowRuns?.[0] || null;
    const enabledPlatforms = [
      { name: '小红书', enabled: Boolean(state.settings.xhsEnabled), agent: collector, keywords: state.settings.xhsKeywords || [] },
      { name: '抖音', enabled: Boolean(state.settings.douyinEnabled), agent: douyinCollector, keywords: state.settings.douyinKeywords || [] }
    ].filter((item) => item.enabled);
    const targetReady = enabledPlatforms.length > 0 && enabledPlatforms.every((item) => item.keywords.length > 0);
    const scheduleRequested = Boolean(state.settings.workflowAutoEnabled);
    const scheduleActive = masterEnabled && scheduleRequested;
    const xhsReadiness = collectorReadiness(collector, Boolean(state.settings.xhsEnabled));
    const douyinReadiness = collectorReadiness(douyinCollector, Boolean(state.settings.douyinEnabled));
    const readiness = [
      ['小红书采集', xhsReadiness.status, xhsReadiness.detail],
      ['抓取目标', targetReady ? 'ready' : 'blocked', enabledPlatforms.length ? enabledPlatforms.map((item) => `${item.name}${item.keywords.length}个`).join(' · ') : '未启用采集平台'],
      ['文本模型API', runtime.aiReady ? 'ready' : 'blocked', runtime.aiReady ? '可用' : '未配置'],
      ['视觉模型API', runtime.visionReady ? 'ready' : 'blocked', runtime.visionReady ? '可用' : '未配置'],
      ['24小时调度', scheduleActive ? 'running' : scheduleRequested ? 'warning' : 'idle', scheduleActive ? '已开启' : scheduleRequested ? '人工总控已停止，调度未运行' : '已关闭'],
      ['抖音采集', douyinReadiness.status, douyinReadiness.detail]
    ];
    $('#readinessStrip').innerHTML = readiness.map(([name,status,detail]) => `<div class="readiness-item ${status}"><i></i><span><b>${name}</b><small>${escapeHtml(detail || '')}</small></span></div>`).join('');
    const enabledCollectorsReady = targetReady && enabledPlatforms.every((item) => ['ready','healthy','running'].includes(item.agent?.status));
    const workflowReady = masterEnabled && runtime.aiReady && runtime.visionReady && enabledCollectorsReady;
    $('#readinessPill').textContent = workflowCancelling ? '当前工作流正在停止' : runtime.workflowRunning ? '当前工作流执行中' : scheduleActive && workflowReady ? '24小时调度已启用' : scheduleActive ? '24小时调度已开启但当前受阻' : workflowReady ? '手动阶段可运行' : '仍有接入项待处理';
    $('#workflowStateBadge').textContent = workflowStatusText(current?.status || 'idle'); $('#workflowStateBadge').className = `state-badge ${current?.status || 'idle'}`;
    $('#resumeWorkflow').disabled = !(current?.status === 'blocked' && ['collect','analyze'].includes(current.currentStep));
    $('#autoWorkflowToggle').checked = scheduleActive; $('#autoInterval').textContent = `${state.settings.autoMorningTime} / ${state.settings.autoAfternoonTime}`; $('#nextRunAt').textContent = scheduleActive ? (runtime.nextAutomaticRunAt ? new Date(runtime.nextAutomaticRunAt).toLocaleString('zh-CN') : '等待调度计算') : '未启用';
    $('#targetSummary').textContent = enabledPlatforms.length ? `${enabledPlatforms.map((item) => item.name).join('、')} · 手动每平台抓${state.settings.manualRawLimit}留${state.settings.manualFinalLimit}` : '未启用采集平台';
    $('#targetDetails').innerHTML = `<dl><div><dt>平台</dt><dd>小红书 · ${platformStatusLabel(collector, state.settings.xhsEnabled)}；抖音 · ${platformStatusLabel(douyinCollector, state.settings.douyinEnabled)}</dd></div><div><dt>手动模式</dt><dd>每个平台原始${state.settings.manualRawLimit}条 → 本地去屎 → 最多${state.settings.manualFinalLimit}条</dd></div><div><dt>自动模式</dt><dd>${scheduleActive ? '已开启' : '已关闭'}；${state.settings.autoMorningTime}、${state.settings.autoAfternoonTime}；每个平台原始${state.settings.automaticRawLimit}条 → 严格筛选 → 最多${state.settings.automaticFinalLimit}条</dd></div><div><dt>关键词</dt><dd>小红书：${platformKeywordLabel(state.settings.xhsEnabled, state.settings.xhsKeywords)}；抖音：${platformKeywordLabel(state.settings.douyinEnabled, state.settings.douyinKeywords)}</dd></div><div><dt>筛选方式</dt><dd>相关性、互动强度、详情完整度、视频过滤、ID与内容指纹去重</dd></div><div><dt>保存原则</dt><dd>只保存合格候选；淘汰内容仅记录数量和原因</dd></div></dl>`;
    const fallbackSteps = [{id:'collect',name:'抓取',owner:'抓取 Agent'},{id:'analyze',name:'AI预选',owner:'分析 Agent'},{id:'select',name:'人工选款',owner:'人工'},{id:'create',name:'AI生产',owner:'生产 Agent'},{id:'publish',name:'审核/发布/回填',owner:'人工'},{id:'performance',name:'AI分析',owner:'数据 Agent'},{id:'scale',name:'确认二做',owner:'人工'}];
    const steps = current?.steps || fallbackSteps.map((step) => ({...step,status:'pending',detail:''}));
    $('#pipeline').innerHTML = steps.map((step,index) => `<article class="workflow-step ${step.status || 'pending'}"><header><span>${String(index+1).padStart(2,'0')}</span><em>${escapeHtml(step.owner)}</em></header><h3>${escapeHtml(step.name)}</h3><p>${escapeHtml(step.detail || stageStatusText(step.status))}</p></article>`).join('');
    $('#pipelineSummary').textContent = current ? `${workflowStatusText(current.status)} · ${current.trigger === 'manual' ? '人工触发' : '定时触发'}` : '暂无运行';
    const priorities = [];
    for (const [platform, agent, enabled] of [['小红书', collector, state.settings.xhsEnabled], ['抖音', douyinCollector, state.settings.douyinEnabled]]) {
      if (!enabled) continue;
      if (['needs_login','verification_required'].includes(agent?.status)) priorities.push({ title: agent.status === 'needs_login' ? `登录${platform}专用浏览器` : `完成${platform}安全验证`, detail:agent.detail, action:'settings' });
    }
    const analyzed = state.candidates.filter((item) => item.analysisStatus === 'completed' && item.status === 'new'); if (analyzed.length) priorities.push({title:`${analyzed.length}条候选等待选款`,detail:'AI预选已经完成，需要人工确认方向',action:'radar'});
    const pending = state.variants.filter((item) => item.status === 'pending'); if (pending.length) priorities.push({title:`${pending.length}套内容等待审核`,detail:'审核通过后由人工发布',action:'review'});
    const scale = state.variants.filter((item) => item.decision === 'scale'); if (scale.length) priorities.push({title:`${scale.length}个方向等待确认二做`,detail:'确认后才调用模型生成下一轮',action:'loop'});
    $('#priorityList').innerHTML = priorities.length ? priorities.map((item) => `<div class="queue-row"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div><button data-go="${item.action}" type="button">去处理</button></div>`).join('') : '<div class="queue-empty">当前没有等待人工处理的事项</div>';
    $('#currentRunPanel').innerHTML = current ? `<dl class="run-summary"><div><dt>运行ID</dt><dd>${escapeHtml(current.id)}</dd></div><div><dt>触发方式</dt><dd>${current.trigger === 'manual' ? '人工启动' : '定时调度'}</dd></div><div><dt>当前阶段</dt><dd>${escapeHtml(current.steps?.find((step)=>step.id===current.currentStep)?.name || '--')}</dd></div><div><dt>开始时间</dt><dd>${new Date(current.startedAt).toLocaleString('zh-CN')}</dd></div><div><dt>本轮成本</dt><dd>${costText(current.actualCost)}</dd></div><div><dt>下一次调度</dt><dd>${runtime.nextAutomaticRunAt ? new Date(runtime.nextAutomaticRunAt).toLocaleString('zh-CN') : '未启用'}</dd></div><div><dt>结果</dt><dd>${escapeHtml(current.error || workflowStatusText(current.status))}</dd></div></dl>` : '<div class="queue-empty">还没有运行记录。先检查接入状态，再启动一轮。</div>';
    $('#activityFeed').innerHTML = state.activity.slice(0, 8).map((item) => `<div class="activity-item"><span class="activity-dot ${item.level}"></span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div><time>${timeAgo(item.at)}</time></div>`).join('');
    syncCollectionActionButtons();
  }

  function renderRuns() {
    const runs = state.workflowRuns || [];
    $('#runTable').innerHTML = runs.length ? `<div class="run-table-head"><span>运行ID</span><span>触发</span><span>状态</span><span>当前阶段</span><span>抓取/分析</span><span>成本</span><span>开始时间</span></div>${runs.map((run)=>`<div class="run-table-row"><code>${escapeHtml(run.id)}</code><span>${run.trigger === 'manual' ? '人工' : '定时'}</span><span class="state-badge ${run.status}">${workflowStatusText(run.status)}</span><span>${escapeHtml(run.steps?.find((step)=>step.id===run.currentStep)?.name || '--')}</span><span>${run.counts?.collected || 0} / ${run.counts?.analyzed || 0}</span><span>${costText(run.actualCost)}</span><time>${new Date(run.startedAt).toLocaleString('zh-CN')}</time></div>`).join('')}` : '<div class="empty-state"><h3>还没有工作流记录</h3><p>人工启动或定时调度后会在这里留下完整审计记录。</p></div>';
  }

  function getFilteredCandidates() {
    const items = state.candidates.filter((item) => ['new', 'selected'].includes(item.status)).filter((item) => platformFilter === '全部' || item.platform === platformFilter).filter((item) => {
      if (!candidateSearch) return true;
      return [item.title, item.author, ...(item.tags || [])].join(' ').toLowerCase().includes(candidateSearch);
    });
    return items.sort((a, b) => candidateSort === 'growth' ? Number(b.growth ?? -Infinity) - Number(a.growth ?? -Infinity) : candidateSort === 'newest' ? new Date(b.discoveredAt) - new Date(a.discoveredAt) : Number(b.score ?? -Infinity) - Number(a.score ?? -Infinity));
  }

  function renderRadar() {
    const items = getFilteredCandidates();
    if (!items.some((item) => item.id === selectedCandidateId)) selectedCandidateId = items[0]?.id || null;
    $('#candidateList').innerHTML = items.length ? items.map((item) => `
      <article class="candidate-card ${item.id === selectedCandidateId ? 'selected' : ''}" data-candidate-id="${item.id}">
        <div class="candidate-cover" data-cover="${item.cover}">${escapeHtml(item.tags?.[0] || '待分析')}<br>${escapeHtml(item.platform)}</div>
        <div class="candidate-info"><span class="candidate-platform ${item.platform === '抖音' ? 'douyin' : ''}">${escapeHtml(item.platform)}</span><span class="status-chip candidate-status ${item.status}">${candidateStatusText(item.status)}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.author)} · ${escapeHtml(item.age || timeAgo(item.discoveredAt))} · ${escapeHtml(item.source)}</p><div class="candidate-tags">${(item.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div></div>
        <div class="candidate-score"><strong>${item.score ?? '--'}</strong><small>${item.score == null ? '等待后续分析' : '爆款潜力分'}</small><i>${item.growth == null ? '等待下一次快照' : `↑ ${item.growth}% 增长`}</i></div>
      </article>`).join('') : '<div class="empty-state"><span>◎</span><h3>没有符合条件的候选</h3><p>调整平台或搜索条件后再试。</p></div>';
    $$('.candidate-card').forEach((card) => card.addEventListener('click', () => { selectedCandidateId = card.dataset.candidateId; renderRadar(); }));
    renderCandidateInspector(state.candidates.find((item) => item.id === selectedCandidateId));
  }

  function renderCandidateInspector(item) {
    if (!item) { $('#candidateInspector').innerHTML = '<div class="inspector-empty"><span>◎</span><p>选择一条候选查看分析</p></div>'; return; }
    const selected = ['selected', 'generated'].includes(item.status);
    $('#candidateInspector').innerHTML = `
      <div class="inspector-head"><div><span class="candidate-platform ${item.platform === '抖音' ? 'douyin' : ''}">${escapeHtml(item.platform)}</span><h3>${escapeHtml(item.title)}</h3><p class="variant-meta">${escapeHtml(item.author)} · ${Array.isArray(item.snapshots) ? item.snapshots.length : Number(item.snapshots || 0)}次数据快照</p></div><div class="score-ring" style="--score:${item.score || 0}"><b>${item.score ?? '--'}</b><small>潜力分</small></div></div>
      <div class="metric-row"><div class="mini-metric"><b>${metricValue(item.metrics?.likes)}</b><small>点赞</small></div><div class="mini-metric"><b>${metricValue(item.metrics?.saves)}</b><small>收藏</small></div><div class="mini-metric"><b>${metricValue(item.metrics?.comments)}</b><small>评论</small></div></div>
      <div class="inspector-block"><h4>AI识别的内容结构</h4><div class="structure-flow">${(item.structure || []).length ? (item.structure || []).map((step, index) => `${index ? '<i>→</i>' : ''}<span>${escapeHtml(step)}</span>`).join('') : '<p class="panel-copy">当前只完成真实采集，结构分析将在下一阶段接入。</p>'}</div></div>
      ${item.textAnalysis ? `<div class="inspector-block"><h4>文本模型初析</h4><p class="panel-copy">${escapeHtml(item.textAnalysis.summary || '')}</p><div class="analysis-score-row"><span>文本分 ${item.textAnalysis.textScore ?? '--'}</span><span>${escapeHtml((item.textAnalysis.textStrengths || []).slice(0, 2).join(' · '))}</span></div></div>` : ''}
      ${item.visionAnalysis ? `<div class="inspector-block"><h4>视觉模型拆解</h4><p class="panel-copy">${escapeHtml(item.visionAnalysis.visualSummary || '')}</p><div class="analysis-score-row"><span>视觉分 ${item.visionAnalysis.visualScore ?? '--'}</span><span>已看 ${item.visionImageCount || item.visionAnalysis.pages?.length || 0} 张图</span></div><div class="structure-flow">${(item.visionAnalysis.visualHooks || []).map((hook) => `<span>${escapeHtml(hook)}</span>`).join('')}</div></div>` : ''}
      ${item.analysis?.productionBlueprint ? `<div class="inspector-block"><h4>综合生产蓝图</h4><p class="panel-copy"><b>${escapeHtml(item.analysis.productionBlueprint.topic || '待确定方向')}</b> · ${escapeHtml(item.analysis.productionBlueprint.audience || '受众待确认')} · ${escapeHtml(item.analysis.productionBlueprint.tone || '')}</p><div class="structure-flow">${(item.analysis.productionBlueprint.imagePlan || []).slice(0, 8).map((page) => `<span>第${page.index || '?'}页：${escapeHtml(page.purpose || page.copy || '')}</span>`).join('')}</div>${(item.analysis.productionBlueprint.mustVerify || []).length ? `<p class="panel-copy">需核实：${escapeHtml(item.analysis.productionBlueprint.mustVerify.join('；'))}</p>` : ''}</div>` : ''}
      <div class="inspector-block"><h4>抓取 Agent 已保存</h4><p class="panel-copy">${item.detailStatus === 'enriched' ? `已读取正文、${item.tags?.length || 0}个话题、发布时间、${item.imageCount || 0}张图片引用和公开赞藏评。` : '已保存搜索卡片与原文链接；本条详情未能识别，等待下次重试。'} 缺失字段显示“--”，不会伪造。</p></div>
      ${item.body ? `<div class="inspector-block"><h4>正文摘录</h4><p class="panel-copy candidate-body">${escapeHtml(item.body.slice(0, 800))}</p></div>` : ''}
      ${item.analysisStatus !== 'completed' ? `<div class="inspector-block"><h4>分析任务状态</h4><p class="panel-copy">${escapeHtml(item.analysisTask?.lastFailure?.lastError || item.analysisTask?.vision?.lastError || '该候选尚未完成分析')}</p><button class="secondary-button" id="retryCandidateAnalysis" type="button">重试本条分析</button></div>` : ''}
      <div class="inspector-actions">
        <button class="secondary-button" id="openCandidateSource" type="button">打开原文</button>
        <button class="danger-text-button" id="deleteCandidate" type="button">删除</button>
        <button class="secondary-button" id="ignoreCandidate" type="button">忽略</button>
        <button class="primary-button" id="selectCandidate" type="button">${selected ? '已确认 · 去生产' : '确认值得做'}</button>
      </div>`;
    $('#openCandidateSource').addEventListener('click', () => window.open(item.url, '_blank', 'noopener,noreferrer'));
    $('#retryCandidateAnalysis')?.addEventListener('click', async (event) => { const button = event.currentTarget; button.disabled = true; button.textContent = '正在重试…'; try { const result = await api.analyzeCandidate(item.id); state = await api.getState(); render(); toast(result.ok ? '本条分析已完成' : '本条分析仍待重试', result.message || '请查看任务状态', !result.ok); } catch (error) { toast('重试失败', error.message, true); } });
    $('#deleteCandidate').addEventListener('click', async () => { if (!confirm('确认永久删除这条候选吗？若存在未发布生成版本也会一并清理。')) return; const result = await api.deleteCandidate(item.id); if (!result.ok) return toast('删除失败', result.message, true); state = await api.getState(); selectedCandidateId = state.candidates[0]?.id || null; render(); toast('候选已删除', result.variantsDeleted ? `同时清理${result.variantsDeleted}个关联版本` : ''); });
    $('#ignoreCandidate').addEventListener('click', async () => { try { const result = await api.setCandidateStatus(item.id, 'ignored'); if (!result.ok) return toast('忽略失败', result.message, true); state = await api.getState(); selectedCandidateId = state.candidates.find((candidate) => candidate.status !== 'ignored')?.id || state.candidates[0]?.id || null; render(); toast('候选已忽略', result.message || '可使用“删除已忽略”批量清理'); } catch (error) { toast('操作失败', error.message, true); } });
    $('#selectCandidate').addEventListener('click', async () => {
      if (!selected) { try { const result = await api.setCandidateStatus(item.id, 'selected'); toast(result.ok ? '已确认方向并进入AI生产' : '选款后生产受阻', result.message || (result.ok ? '生成完成后会进入人工审核' : '请检查模型API与预算'), !result.ok); } catch (error) { toast('操作失败', error.message, true); } }
      else navigate('creation');
    });
  }

  function renderCreation() {
    const selected = state.candidates.filter((item) => item.status === 'selected' && !state.variants.some((variant) => variant.candidateId === item.id));
    const running = selected.filter((item) => ['queued', 'running', 'retrying'].includes(item.creationTask?.status)).length;
    const retryable = selected.filter((item) => item.creationTask?.status === 'retryable_failed').length;
    $('#studioSummary').innerHTML = [
      [selected.length, '等待一做'], [running, '正在生产'], [retryable, '可以重试']
    ].map(([value, label]) => `<div class="summary-card"><b>${value}</b><span>${label}</span></div>`).join('');

    if (!selected.length) {
      $('#variantBoard').innerHTML = state.variants.length
        ? '<div class="empty-state"><span>✓</span><h3>待生产队列已处理完</h3><p>已生成内容已转入独立内容库，不会继续占用本页。</p><button class="primary-button" data-go="produced" type="button">打开已生产内容库</button></div>'
        : '<div class="empty-state"><span>✦</span><h3>先确认一个爆款方向</h3><p>系统会先生成可编辑文案与每页生图提示词；图片需人工确认后才会调用生图模型。</p><button class="primary-button" data-go="radar" type="button">前往候选与选款</button></div>';
      return;
    }
    const blocks = selected.map((candidate) => {
      const task = candidate.creationTask || {};
      const active = ['queued','running','retrying'].includes(task.status);
      const failed = task.status === 'retryable_failed';
      const taskText = active ? `一做进行中：第${task.attempts || 1}次${task.nextRetryAt ? '，正在自动重试' : ''}` : failed ? `一做待重试：${task.lastError || '临时失败，可直接重试，不会重抓或重分析'}` : '先生成文案 + 每页生图提示词，不会直接生图';
      return `<article class="variant-card"><div class="variant-top"><div><span class="candidate-platform ${candidate.platform === '抖音' ? 'douyin' : ''}">${candidate.platform}</span><h3>${escapeHtml(candidate.title)}</h3><p class="variant-meta">结构：${escapeHtml((candidate.structure || []).length ? candidate.structure.join(' → ') : '等待后续分析')}</p></div><span class="quality-badge">${active ? '一做中' : failed ? '待重试' : '已选款'}</span></div><div class="variant-footer"><small>${escapeHtml(taskText)}</small><button class="mini-button primary generate-variants" data-id="${candidate.id}" type="button" ${active ? 'disabled' : ''}>${failed ? '重试一做策划' : active ? '一做进行中…' : '开始一做策划'}</button></div></article>`;
    }).join('');
    $('#variantBoard').innerHTML = blocks;
    $$('.generate-variants').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true; button.textContent = '正在生成…';
      try { const result = await api.generateVariants(button.dataset.id); if (result.ok) { state = await api.getState(); render(); toast(result.existing ? '已经生成过' : result.accepted ? '一做策划已接单' : '一做策划完成', result.message || (result.accepted ? '可关闭页面，后台会自动重试并持续保存进度' : '请进入工作台编辑，再确认生成图片')); } else toast('生成失败', result.message, true); }
      catch (error) { toast('生成失败', error.message, true); }
      finally { button.disabled = false; }
    }));
  }

  function renderProduced() {
    const all = state.variants || [];
    const items = all.filter((item) => {
      const matchesFilter = producedFilter === 'all' || (producedFilter === 'scaled' ? Boolean(item.parentVariantId) : item.status === producedFilter);
      if (!matchesFilter) return false;
      if (!producedSearch) return true;
      return [item.title, item.body, item.account, ...(item.tags || [])].join(' ').toLowerCase().includes(producedSearch);
    });
    $('#producedSummary').innerHTML = [
      [all.length, '全部成品'],
      [all.filter((item) => ['draft', 'pending', 'rejected'].includes(item.status)).length, '制作/审核中'],
      [all.filter((item) => ['approved', 'exported', 'published'].includes(item.status)).length, '可发布/已发布'],
      [all.filter((item) => item.parentVariantId).length, '二做版本']
    ].map(([value, label]) => `<div class="summary-card"><b>${value}</b><span>${label}</span></div>`).join('');
    $('#producedBoard').innerHTML = items.length ? items.map(variantCard).join('') : `<div class="empty-state"><span>▤</span><h3>${all.length ? '没有符合筛选的成品' : '还没有已生产内容'}</h3><p>${all.length ? '可以切换状态或修改搜索词。' : '确认候选并完成一做后，成品会自动进入这里。'}</p>${all.length ? '' : '<button class="primary-button" data-go="creation" type="button">前往待生产队列</button>'}</div>`;
    bindVariantActions($('#producedBoard'));
  }

  function variantCard(item) {
    const pages = item.imagePages?.length ? item.imagePages : (item.pages || []).map((copy, index) => ({ index: index + 1, copy }));
    const ready = pages.filter((page) => page.asset?.file).length;
    return `<article class="variant-card"><div class="variant-top"><div><span class="status-chip ${item.status}">${statusText(item.status)}</span><h3>${escapeHtml(item.title)}</h3><p class="variant-meta">${escapeHtml(item.platform)} · ${escapeHtml(item.account)} · ${escapeHtml(item.format)}</p></div><span class="quality-badge">图片 ${ready}/${pages.length}</span></div><div class="variant-preview">${pages.slice(0, 5).map((page) => `<div class="page-thumb ${page.asset?.file ? 'image-ready' : ''}">${page.asset?.file ? `<img src="/api/image/${encodeURIComponent(item.id)}/${page.index}" alt="第${page.index}张图片">` : escapeHtml((page.copy || '待制作图片').slice(0, 20))}</div>`).join('')}</div><div class="variant-footer"><small>${item.tags?.length ? item.tags.map((tag) => `#${tag}`).join(' ') : '可编辑文案与图片提示词'} · ${pages.length}张</small><div class="card-actions"><button class="mini-button view-variant" data-id="${item.id}" type="button">进入工作台</button>${!item.metrics && ['draft','pending','rejected'].includes(item.status) ? `<button class="mini-button delete-variant" data-id="${item.id}" type="button">删除</button>` : ''}${item.status === 'pending' ? `<button class="mini-button primary approve-variant" data-id="${item.id}" type="button">审核通过</button>` : ''}</div></div></article>`;
  }

  function bindVariantActions(root = document) {
    $$('.view-variant', root).forEach((button) => button.addEventListener('click', () => openVariant(button.dataset.id)));
    $$('.approve-variant', root).forEach((button) => button.addEventListener('click', async () => { try { const result = await api.setVariantStatus(button.dataset.id, 'approved'); result.ok ? toast('审核通过', '已进入发布区') : toast('审核失败', result.message, true); } catch (error) { toast('审核失败', error.message, true); } }));
    $$('.delete-variant', root).forEach((button) => button.addEventListener('click', async () => { if (!confirm('确认删除这个未发布版本吗？')) return; const result = await api.deleteVariant(button.dataset.id); if (!result.ok) return toast('删除失败', result.message, true); state = await api.getState(); render(); toast('版本已删除'); }));
  }

  function openVariant(id) {
    const item = state.variants.find((variant) => variant.id === id);
    if (!item) return;
    activeVariantModalId = id;
    activeVariantModalSignature = variantModalStateSignature(item);
    const editable = ['draft', 'pending', 'rejected'].includes(item.status);
    const imageJob = item.imageJob || null;
    const imageJobActive = ['queued', 'running'].includes(imageJob?.status);
    const imageJobLabel = imageJob ? `${imageJob.status === 'running' ? '图片任务进行中' : imageJob.status === 'queued' ? '图片任务排队中' : imageJob.status === 'completed' ? '图片任务已完成' : imageJob.status === 'partial' ? '图片任务部分完成' : imageJob.status === 'interrupted' ? '图片任务已中断' : '图片任务失败'} · ${imageJob.completed || 0}/${imageJob.total || 0}${imageJob.currentPageIndex ? ` · 正在第${imageJob.currentPageIndex}页` : ''}` : '尚未创建图片任务';
    const imageJobDetail = imageJob?.error || imageJob?.message || '关闭窗口不会停止后台图片任务；再次打开时会从这里恢复进度。';
    const pages = item.imagePages?.length ? item.imagePages : (item.pages || []).map((copy, index) => ({ id: `legacy_${index}`, index: index + 1, copy, imagePrompt: '' }));
    const source = state.candidates.find((candidate) => candidate.id === item.candidateId);
    const rows = pages.map((page) => { const pageRunning = imageJobActive && imageJob.currentPageId === page.id; const qualityFailed = page.quality && !page.quality.passed; const pageState = pageRunning ? '正在生成中…' : qualityFailed ? `质检 ${page.quality.score || 0} 分，待重做` : page.asset?.file ? '图片已完成' : '尚未生成图片'; return `<article class="studio-page" data-page-id="${escapeHtml(page.id)}"><div class="studio-page-head"><b>第 ${page.index} 张 · ${escapeHtml(pageState)}</b><div><button class="mini-button move-page-up" type="button" title="上移" ${imageJobActive ? 'disabled' : ''}>↑</button><button class="mini-button move-page-down" type="button" title="下移" ${imageJobActive ? 'disabled' : ''}>↓</button><button class="mini-button remove-page" type="button" ${imageJobActive ? 'disabled' : ''}>删除</button></div></div><div class="studio-image-frame">${page.asset?.file ? `<img src="/api/image/${encodeURIComponent(item.id)}/${page.index}" alt="第${page.index}张生成图">` : `<span>${escapeHtml(pageState)}</span>`}</div>${qualityFailed ? `<small class="profile-error">${escapeHtml(page.quality.summary || (page.quality.problems || []).join('；') || '未通过视觉质检')}</small>` : ''}<label class="editor-field"><span>上图文案</span><textarea class="page-copy" rows="3" ${editable && !imageJobActive ? '' : 'disabled'}>${escapeHtml(page.copy || '')}</textarea></label><label class="editor-field"><span>本页生图提示词</span><textarea class="page-prompt" rows="5" maxlength="6000" ${editable && !imageJobActive ? '' : 'disabled'}>${escapeHtml(page.imagePrompt || '')}</textarea></label>${editable ? `<button class="secondary-button generate-one-image" type="button" data-page-id="${escapeHtml(page.id)}" data-force="${page.asset?.file ? 'true' : 'false'}" ${imageJobActive ? 'disabled' : ''}>${pageRunning ? '本页生成中…' : page.asset?.file ? '强制重做本页图片' : '生成本页图片'}</button>` : ''}</article>`; }).join('');
    const grounding = item.enterpriseGrounding || {}; const activeEnterprise = state.enterpriseProfiles?.find((profile) => profile.id === state.activeEnterpriseProfileId);
    const activeImageProfile = (state.settings.imageProfiles || []).find((profile) => profile.id === state.settings.activeImageProfileId);
    const referencePolicy = ['auto', 'required', 'disabled'].includes(item.imageReferencePolicy) ? item.imageReferencePolicy : 'auto';
    const selectedAssetCount = (grounding.assetIds || []).length;
    const profileSupportsReference = ['reference_edit', 'reference_generation_json'].includes(activeImageProfile?.imageInputMode);
    const actualProtocolLabel = item.imageJob?.referenceMode === 'reference_generation_json' ? 'Generations JSON image 数组' : item.imageJob?.referenceMode === 'reference_edit' ? 'Edits multipart 文件' : '纯文字 Generations';
    const imageJobFinished = ['completed', 'partial'].includes(item.imageJob?.status);
    const imageJobActiveReference = ['queued', 'running'].includes(item.imageJob?.status);
    const actualReferenceNotice = !item.imageJob ? '' : item.imageJob.referenceMode !== 'text_only'
      ? imageJobFinished
        ? `最近完成任务实际通过 ${actualProtocolLabel} 传入企业原图：${(item.imageJob.referenceAssetIds || []).join('、') || '已传入'}`
        : imageJobActiveReference
          ? `当前任务正在通过 ${actualProtocolLabel} 传入企业原图：${(item.imageJob.referenceAssetIds || []).join('、') || '已配置'}`
          : `最近任务配置为 ${actualProtocolLabel}，请结合任务错误确认是否完成传图`
      : imageJobFinished ? `最近完成任务使用${actualProtocolLabel}，未传入企业原图` : `当前任务使用${actualProtocolLabel}，不会传入企业原图`;
    const policyNotice = referencePolicy === 'disabled' ? '本套明确不使用企业图，将走纯文字生图' : referencePolicy === 'required' ? (!profileSupportsReference ? '本套要求企业原图，但当前生图档案不支持；生成会被阻止' : !selectedAssetCount ? '本套要求企业原图，但策划未选中可用图片；生成会被阻止' : `本套必须传入 ${selectedAssetCount} 张已选企业图`) : (profileSupportsReference && selectedAssetCount ? `自动模式可用：将传入 ${selectedAssetCount} 张已选企业图` : '自动模式将走纯文字生图（当前档案不支持参考图或本套未选图）');
    const groundingSummary = `<div class="enterprise-grounding"><b>企业依据（本套内容必须围绕它制作）</b><span>角度：${escapeHtml(grounding.productAngle || '未记录')}</span><span>事实：${escapeHtml((grounding.factsUsed || []).join('；') || '未记录')}</span><span>图片：${escapeHtml((grounding.assetUsage || []).join('；') || '未记录')}</span><span>当前判断：${escapeHtml(policyNotice)}</span>${actualReferenceNotice ? `<span>执行记录：${escapeHtml(actualReferenceNotice)}</span>` : ''}</div>`;
    $('#variantModalContent').innerHTML = `<button class="modal-close" id="closeVariantModal" type="button">×</button><form id="variantEditForm" class="studio-workbench"><section class="studio-editor"><div class="studio-context"><span class="section-kicker">一做工作台 / ${escapeHtml(item.platform)}</span><b>参考爆款：${escapeHtml(source?.title || '已选方向')}</b><small>企业素材库：${escapeHtml(activeEnterprise?.name || '未配置')}</small></div>${groundingSummary}<div class="inspector-block"><h4>${escapeHtml(imageJobLabel)}</h4><p class="panel-copy">${escapeHtml(imageJobDetail)}</p></div><label class="editor-field"><span>企业图片使用方式</span><select name="imageReferencePolicy" ${editable && !imageJobActive ? '' : 'disabled'}><option value="auto" ${referencePolicy === 'auto' ? 'selected' : ''}>自动使用（推荐）</option><option value="required" ${referencePolicy === 'required' ? 'selected' : ''}>必须使用企业原图</option><option value="disabled" ${referencePolicy === 'disabled' ? 'selected' : ''}>不使用企业图</option></select><small>切换后会废弃旧生成图，防止“图片说用了企业原图、实际却没传”的假记录。</small></label><label class="editor-field"><span>标题</span><input name="title" value="${escapeHtml(item.title)}" ${editable && !imageJobActive ? '' : 'disabled'}></label><label class="editor-field"><span>发布正文</span><textarea name="body" rows="12" ${editable && !imageJobActive ? '' : 'disabled'}>${escapeHtml(item.body)}</textarea></label><label class="editor-field"><span>标签（空格或换行分隔）</span><input name="tags" value="${escapeHtml((item.tags || []).map((tag) => `#${tag}`).join(' '))}" ${editable && !imageJobActive ? '' : 'disabled'}></label><div class="studio-toolbar">${editable ? `<button class="secondary-button" id="addImagePage" type="button" ${imageJobActive ? 'disabled' : ''}>+ 添加图片页</button><button class="secondary-button" id="saveVariantEdit" type="submit" ${imageJobActive ? 'disabled' : ''}>保存修改</button><button class="primary-button" id="generateAllImages" type="button" ${imageJobActive ? 'disabled' : ''}>${imageJobActive ? `任务进行中 ${imageJob.completed || 0}/${imageJob.total || 0}` : '生成未完成图片'}</button>${!imageJobActive && imageJob?.status === 'partial' ? '<button class="secondary-button" id="retryFailedImages" type="button">重做未通过图片</button>' : ''}` : ''}</div><div class="studio-pages-editor">${rows}</div></section><aside class="studio-preview"><div class="preview-top"><b>${escapeHtml(item.platform)}图文预览</b><small>实时预览</small></div><div class="xhs-note"><div class="xhs-images" id="xhsPreviewImages"></div><h2 id="xhsPreviewTitle"></h2><p id="xhsPreviewBody"></p><div id="xhsPreviewTags" class="xhs-tags"></div></div><div class="export-box"><b>导出发布包</b><p>审核通过后可导出图片、标题、正文、标签、提示词与来源记录。</p><label class="editor-field"><span>指定导出文件夹</span><input id="variantExportDirectory" value="${escapeHtml(item.exportDirectory || '')}" placeholder="例如 D:\\内容成品"></label>${['approved','exported','published'].includes(item.status) ? '<button class="primary-button" id="exportFromStudio" type="button">导出到指定文件夹</button>' : `<small>当前状态：${statusText(item.status)}。请生成图片、人工审核通过后导出。</small>`}</div></aside></form>`;
    if (item.productionWarnings?.length) $('#variantEditForm .studio-context')?.insertAdjacentHTML('afterend', `<div class="inspector-block"><h4>人工检查提醒</h4><p class="profile-error">${escapeHtml(item.productionWarnings.join('；'))}</p></div>`);
    openModal('variantModal');
    $('#closeVariantModal').addEventListener('click', () => closeModal('variantModal'));
    const syncPreview = () => { const form = $('#variantEditForm'); $('#xhsPreviewTitle').textContent = form.elements.title.value || '笔记标题'; $('#xhsPreviewBody').textContent = form.elements.body.value || '正文会在这里预览'; $('#xhsPreviewTags').textContent = form.elements.tags.value || '#话题'; $('#xhsPreviewImages').innerHTML = $$('.studio-page').map((row, index) => { const image = $('img', row); return image ? `<img src="${image.src}" alt="第${index + 1}张">` : `<div class="xhs-image-placeholder">第${index + 1}张<br>待生成</div>`; }).join(''); };
    syncPreview(); $('#variantEditForm').addEventListener('input', syncPreview);
    if (editable) {
      const draftPayload = () => ({ id, imageReferencePolicy:$('#variantEditForm').elements.imageReferencePolicy.value, title: $('#variantEditForm').elements.title.value, body: $('#variantEditForm').elements.body.value, tags: $('#variantEditForm').elements.tags.value.split(/[\s#]+/).filter(Boolean), imagePages: $$('.studio-page').map((row, index) => ({ id: row.dataset.pageId, index: index + 1, copy: $('.page-copy', row).value, imagePrompt: $('.page-prompt', row).value })) });
      $('#variantEditForm').addEventListener('submit', async (event) => { event.preventDefault(); const result = await api.updateVariant(draftPayload()); if (result.ok) { state = await api.getState(); render(); toast('工作台已保存', '文案、标签与图片提示词已保存'); } else toast('保存失败', result.message, true); });
      $('#addImagePage').addEventListener('click', () => { const page = document.createElement('article'); page.className = 'studio-page'; page.dataset.pageId = `new_${Date.now()}`; page.innerHTML = `<div class="studio-page-head"><b>新图片页</b><div><button class="mini-button move-page-up" type="button">↑</button><button class="mini-button move-page-down" type="button">↓</button><button class="mini-button remove-page" type="button">删除</button></div></div><div class="studio-image-frame"><span>尚未生成图片</span></div><label class="editor-field"><span>上图文案</span><textarea class="page-copy" rows="3"></textarea></label><label class="editor-field"><span>本页生图提示词</span><textarea class="page-prompt" rows="5" maxlength="6000"></textarea></label><button class="secondary-button generate-one-image" type="button" data-page-id="${page.dataset.pageId}">生成本页图片</button>`; $('.studio-pages-editor').appendChild(page); bindPageControls(); syncPreview(); });
      const startImageTask = async (pageIds = [], force = false) => { const saved = await api.updateVariant(draftPayload()); if (!saved.ok) return toast('请先补全工作台内容', saved.message, true); const result = await api.generateVariantImages(id, pageIds, force); state = await api.getState(); render(); openVariant(id); if (result.ok) toast(result.existing ? '图片任务仍在进行' : '图片任务已启动', result.message || '可关闭窗口，进度将持续保存'); else toast('图片任务未启动', result.message, true); };
      const bindPageControls = () => { $$('.remove-page').forEach((button) => button.onclick = () => { if ($$('.studio-page').length <= 2) return toast('至少保留两张图片', '', true); button.closest('.studio-page').remove(); syncPreview(); }); $$('.move-page-up').forEach((button) => button.onclick = () => { const row = button.closest('.studio-page'); row.previousElementSibling && row.parentElement.insertBefore(row, row.previousElementSibling); syncPreview(); }); $$('.move-page-down').forEach((button) => button.onclick = () => { const row = button.closest('.studio-page'); row.nextElementSibling && row.parentElement.insertBefore(row.nextElementSibling, row); syncPreview(); }); $$('.generate-one-image').forEach((button) => button.onclick = async () => { if (button.dataset.force === 'true' && !confirm('确认强制重做这一页吗？这会再次调用生图模型并产生费用。')) return; await startImageTask([button.dataset.pageId], button.dataset.force === 'true'); }); }; bindPageControls();
      $('#generateAllImages').addEventListener('click', () => startImageTask());
      $('#retryFailedImages')?.addEventListener('click', () => { const failed = pages.filter((page) => page.quality && !page.quality.passed).map((page) => page.id); if (failed.length) startImageTask(failed, true); });
    }
    $('#exportFromStudio')?.addEventListener('click', async () => { const directory = $('#variantExportDirectory').value.trim(); if (directory) { const saved = await api.setExportDirectory(id, directory); if (!saved.ok) return toast('导出路径无效', saved.message, true); } const result = await api.exportVariant(id); result.ok ? toast('发布包已导出', result.path) : toast('导出失败', result.message, true); });
  }

  function renderReview() {
    const counts = ['draft', 'pending', 'approved', 'exported', 'published'].map((status) => state.variants.filter((item) => item.status === status).length);
    $('#reviewStats').innerHTML = [['制作中', counts[0]], ['待审核', counts[1]], ['已通过', counts[2]], ['已导出', counts[3]], ['已发布', counts[4]]].map(([label, value]) => `<div class="review-stat"><b>${value}</b><span>${label}</span></div>`).join('');
    const items = state.variants;
    $('#reviewList').innerHTML = items.length ? items.map((item) => { const total = item.imagePages?.length || item.pages.length; const ready = (item.imagePages || []).filter((page) => page.asset?.file).length; return `<article class="review-row"><div><span class="status-chip ${item.status}">${statusText(item.status)}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.platform)} · ${escapeHtml(item.account)} · 图片${ready}/${total} · ${item.tags?.map((tag) => `#${tag}`).join(' ') || '待补标签'}</p></div><div class="review-checks"><span>事实待人工确认</span><span>${ready === total ? '图片已完成' : '图片未完成'}</span><span>结构原创</span></div><div class="card-actions"><button class="mini-button view-variant" data-id="${item.id}" type="button">${['draft','pending','rejected'].includes(item.status) ? '工作台/修改' : '预览'}</button>${item.status === 'draft' && ready === total ? `<button class="mini-button primary submit-review" data-id="${item.id}" type="button">提交审核</button>` : ''}${item.status === 'pending' ? `<button class="mini-button primary approve-variant" data-id="${item.id}" type="button">通过</button>` : ''}${['approved','exported','published'].includes(item.status) ? `<button class="mini-button export-variant" data-id="${item.id}" type="button">导出发布包</button>` : ''}${['approved','exported'].includes(item.status) ? `<button class="mini-button metrics-variant" data-id="${item.id}" type="button">登记发布链接</button>` : ''}${item.status === 'published' ? '<button class="mini-button primary" data-go="loop" type="button">查看跟踪与分析</button>' : ''}</div></article>`; }).join('') : '<div class="empty-state"><span>✓</span><h3>暂无待审核内容</h3><p>先去图文生产中心生成内容。</p></div>';
    bindVariantActions($('#reviewList'));
    $$('.submit-review').forEach((button) => button.addEventListener('click', async () => { const result = await api.setVariantStatus(button.dataset.id, 'pending'); result.ok ? toast('已提交人工审核') : toast('提交失败', result.message, true); }));
    $$('.export-variant').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; try { const result = await api.exportVariant(button.dataset.id); result.ok ? toast('发布包已导出', result.path) : toast('导出失败', result.message, true); } catch (error) { toast('导出失败', error.message, true); } finally { button.disabled = false; } }));
    $$('.metrics-variant').forEach((button) => button.addEventListener('click', () => openMetrics(button.dataset.id)));
  }

  function openMetrics(id) {
    const item = state.variants.find((variant) => variant.id === id);
    if (!item) return;
    if (item.platform !== '小红书') return toast('抖音二次分析尚未接入', '当前1.3不会把抖音作品误交给小红书创作后台', true);
    $('#metricsVariantTitle').textContent = item.title;
    const form = $('#metricsForm'); form.reset(); form.elements.variantId.value = id;
    form.elements.link.value = item.publicationUrl || item.metrics?.link || '';
    if (item.metrics) ['exposure', 'likes', 'saves', 'comments'].forEach((name) => { form.elements[name].value = item.metrics[name] ?? ''; });
    const published = item.publishedAt ? new Date(item.publishedAt) : new Date();
    form.elements.publishedAt.value = Number.isNaN(published.getTime()) ? '' : new Date(published.getTime() - published.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    openModal('metricsModal');
  }

  function renderLoop() {
    const items = state.variants.filter((item) => ['approved', 'exported', 'published'].includes(item.status) || item.performanceSnapshots?.length || item.performanceAnalysis || item.decision);
    const dataAgent = state.agents.find((agent) => agent.id === 'data-agent');
    const sampleHours = [...new Set((state.settings.performanceSampleHours || [2, 24, 72]).map(Number).filter((value) => value > 0))].sort((a, b) => a - b);
    $('#loopGrid').innerHTML = items.length ? items.map((item) => {
      const m = item.metrics;
      const decision = item.decision;
      const snapshots = item.performanceSnapshots || [];
      const analysis = item.performanceAnalysis || {};
      const source = m?.source === 'xiaohongshu_creator_center' ? '小红书创作后台' : m ? '人工补录' : '';
      const binding = item.creatorMatchedBy ? `已精确绑定 · ${item.creatorMatchedBy === 'note_id' || item.creatorMatchedBy === 'creator_row_key' ? '笔记ID' : '标题＋发布时间'} · ${item.creatorMatchConfidence || 0}%` : item.publicationNoteId ? `已解析笔记ID：${item.publicationNoteId}` : item.publicationUrl ? '链接中未解析到ID，等待后台安全匹配' : '';
      const completedHours = new Set(snapshots.filter((snapshot) => !snapshot.missing).map((snapshot) => Number(snapshot.milestoneHours)).filter(Boolean));
      const settledHours = new Set(snapshots.map((snapshot) => Number(snapshot.milestoneHours)).filter(Boolean));
      const missedHours = sampleHours.filter((hour) => snapshots.some((snapshot) => Number(snapshot.milestoneHours) === hour && snapshot.missing));
      const nextHour = sampleHours.find((hour) => !settledHours.has(hour));
      const nextAt = nextHour && item.publishedAt ? new Date(new Date(item.publishedAt).getTime() + nextHour * 3600000) : null;
      const globalBlock = item.status === 'published' && ['needs_login', 'verification_required', 'warning'].includes(dataAgent?.status) ? dataAgent.detail : '';
      const trackingText = globalBlock || (item.status !== 'published' ? '尚未登记发布链接' : !m ? '已登记链接，等待创作后台首个数据快照' : analysis.stage === 'final' ? '最终观察节点已完成' : nextHour ? `下一观察节点：${nextHour}小时${nextAt && nextAt > new Date() ? ` · ${nextAt.toLocaleString('zh-CN')}` : ' · 已可立即读取'}` : '观察节点已采完，等待最终结论');
      const actions = item.status === 'published'
        ? `<button class="mini-button refresh-performance" data-id="${item.id}" type="button">立即读取本条数据</button><button class="mini-button check-performance-login" type="button">检查后台登录</button>`
        : `<button class="mini-button metrics-variant" data-id="${item.id}" type="button">登记发布链接</button>`;
      return `<article class="loop-card"><span class="status-chip ${item.status}">${escapeHtml(item.platform)} · ${escapeHtml(item.account)}</span><h3>${escapeHtml(item.title)}</h3><p>${m ? `${source} · ${snapshots.length}次快照 · 最近${timeAgo(m.recordedAt)}` : trackingText}</p>${binding ? `<small>${escapeHtml(binding)}</small>` : ''}<div class="tracking-state ${globalBlock ? 'blocked' : ''}"><b>${globalBlock ? '当前阻塞' : '跟踪状态'}</b><span>${escapeHtml(trackingText)}</span><small>已完成节点：${sampleHours.filter((hour) => completedHours.has(hour)).map((hour) => `${hour}h`).join(' / ') || '暂无'}${missedHours.length ? `；已错过：${missedHours.map((hour) => `${hour}h`).join(' / ')}` : ''}</small></div>${m ? `<div class="performance-grid"><div><b>${compact(m.exposure)}</b><small>曝光</small></div><div><b>${compact(m.views ?? 0)}</b><small>观看</small></div><div><b>${compact(m.saves)}</b><small>收藏</small></div><div><b>${m.coverClickRate == null ? '—' : `${m.coverClickRate}%`}</b><small>封面点击率</small></div></div><div class="snapshot-strip">${snapshots.map((snapshot) => `<span>${snapshot.missing ? '缺失' : snapshot.milestoneHours ? `${snapshot.milestoneHours}h` : '初始'} · ${snapshot.missing ? `${snapshot.milestoneHours}h未采到` : `${compact(snapshot.exposure)}曝光`}</span>`).join('') || '<span>等待后台首次快照</span>'}</div><div class="decision-box ${decision}"><div><strong>${decisionText(decision)}</strong><p>${escapeHtml(analysis.reason || decisionDescription(decision))}</p>${analysis.keep?.length ? `<small>二做保留：${escapeHtml(analysis.keep.join('；'))}</small>` : ''}${analysis.change?.length ? `<small>二做只改：${escapeHtml(analysis.change.join('；'))}</small>` : ''}</div>${decision === 'scale' ? `<button class="mini-button primary scale-variant" data-id="${item.id}" type="button">人工确认二做</button>` : ''}</div>` : ''}<div class="variant-footer"><small>${item.publicationUrl ? escapeHtml(item.publicationUrl) : '发布后粘贴链接，Agent 才能自动跟踪'}</small><div class="card-actions">${actions}</div></div></article>`;
    }).join('') : '<div class="empty-state"><span>↻</span><h3>循环尚未开始</h3><p>审核并发布第一条图文后，数据会在这里形成判断。</p></div>';
    $$('.metrics-variant', $('#loopGrid')).forEach((button) => button.addEventListener('click', () => openMetrics(button.dataset.id)));
    $$('.refresh-performance', $('#loopGrid')).forEach((button) => button.addEventListener('click', () => collectPerformanceNow(button.dataset.id, button)));
    $$('.check-performance-login', $('#loopGrid')).forEach((button) => button.addEventListener('click', () => checkPerformanceLogin(button)));
    $$('.scale-variant').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm(`确认让这个胜出方向进入下一轮放大，并生成${state.settings.scaleGenerationCount || 5}个受控变体吗？`)) return;
      button.disabled = true;
      try { const result = await api.scaleVariant(button.dataset.id); result.ok ? toast(result.existing ? '已经进入放大循环' : '放大循环已启动', result.message || `新增${result.count}个受控变体`) : toast('启动失败', result.message, true); }
      catch (error) { toast('启动失败', error.message, true); }
      finally { button.disabled = false; }
    }));
  }

  function renderMaterials() {
    $('#materialCount').textContent = state.materials.length;
    $('#materialGrid').innerHTML = state.materials.length ? state.materials.map((item) => `<article class="material-card"><div class="material-card-top"><span class="material-type">${escapeHtml(item.type)}</span><span class="material-score">${item.score}分</span></div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.status)} · 已复用${item.uses}次</p><div class="material-bar"><i style="width:${item.score}%"></i></div></article>`).join('') : '<div class="empty-state"><span>◇</span><h3>素材库还没有胜出资产</h3><p>第一条数据验证成功的内容会自动沉淀到这里。</p></div>';
  }

  function renderEnterprise() {
    const profiles = state.enterpriseProfiles || [];
    const active = profiles.find((item) => item.id === state.activeEnterpriseProfileId && item.status === 'active');
    $('#enterpriseSummary').innerHTML = active ? `<div><span>当前生产资料库</span><h3>${escapeHtml(active.name)}</h3><p>${escapeHtml(active.brandName || '未填写品牌')} · ${escapeHtml(active.productName || '未填写产品')} · ${active.productFacts.length}条事实 · ${active.sellingPoints.length}条卖点 · ${active.imageAssets?.length || 0}张企业图片</p></div><b>资料可持续增量维护</b>` : '<div><span>尚未配置</span><h3>先建立第一份企业资料库</h3><p>资料、图片均可后续增量补充；一做可先使用已有文字资料。</p></div><b>名称是唯一必填项</b>';
    $('#enterpriseGrid').innerHTML = profiles.length ? profiles.map((item) => `<article class="enterprise-card ${item.status === 'archived' ? 'archived' : ''}"><div class="enterprise-card-head"><span>${escapeHtml(item.category || '未分类')}</span><em>${item.id === state.activeEnterpriseProfileId && item.status === 'active' ? '当前使用' : item.status === 'active' ? '可使用' : '已停用'}</em></div><h3>${escapeHtml(item.name)}</h3><p><b>${escapeHtml(item.brandName || '未填写品牌')}</b> · ${escapeHtml(item.productName || '未填写产品')}</p><dl><div><dt>真实事实</dt><dd>${item.productFacts.length}</dd></div><div><dt>产品卖点</dt><dd>${item.sellingPoints.length}</dd></div><div><dt>证据资质</dt><dd>${item.proofPoints.length}</dd></div><div><dt>企业图片</dt><dd>${item.imageAssets?.length || 0}</dd></div></dl><footer><button class="mini-button edit-enterprise" data-id="${item.id}" type="button">编辑资料</button><button class="mini-button export-enterprise" data-id="${item.id}" type="button">导出资料库</button>${item.status === 'active' ? `<button class="mini-button add-enterprise-image" data-id="${item.id}" type="button">＋ 添加图片</button>` : ''}${item.status === 'active' && item.id !== state.activeEnterpriseProfileId ? `<button class="mini-button primary activate-enterprise" data-id="${item.id}" type="button">设为当前</button>` : ''}${item.status === 'active' ? `<button class="mini-button archive-enterprise" data-id="${item.id}" type="button">停用</button>` : `<button class="mini-button restore-enterprise" data-id="${item.id}" type="button">恢复</button>`}</footer></article>`).join('') : '<div class="empty-state"><span>▣</span><h3>还没有企业素材库</h3><p>它与成功素材库完全分开，由人工维护，是AI“抄着做”的真实原料。</p><button class="primary-button" id="emptyAddEnterprise" type="button">新建第一份资料库</button></div>';
    $('#emptyAddEnterprise')?.addEventListener('click', () => openEnterpriseProfile());
    $$('.edit-enterprise').forEach((button) => button.addEventListener('click', () => openEnterpriseProfile(button.dataset.id)));
    $$('.export-enterprise').forEach((button) => button.addEventListener('click', () => openEnterpriseExport(button.dataset.id)));
    $$('.add-enterprise-image').forEach((button) => button.addEventListener('click', () => openEnterpriseImageUpload(button.dataset.id)));
    $$('.activate-enterprise').forEach((button) => button.addEventListener('click', async () => { const result = await api.activateEnterpriseProfile(button.dataset.id); state = await api.getState(); render(); toast(result.ok ? '生产资料库已切换' : '切换失败', result.message || '', !result.ok); }));
    $$('.archive-enterprise').forEach((button) => button.addEventListener('click', async () => { if (!confirm('确认停用这份企业素材库吗？历史内容不会删除。')) return; const result = await api.archiveEnterpriseProfile(button.dataset.id); state = await api.getState(); render(); toast(result.ok ? '资料库已停用' : '停用失败', result.message || '', !result.ok); }));
    $$('.restore-enterprise').forEach((button) => button.addEventListener('click', async () => { const result = await api.restoreEnterpriseProfile(button.dataset.id); state = await api.getState(); render(); toast(result.ok ? '资料库已恢复' : '恢复失败', result.message || '', !result.ok); }));
  }

  function openEnterpriseProfile(id = '') {
    const form = $('#enterpriseForm'); form.reset(); form.elements.id.value = ''; form.dataset.mode = 'create'; form.elements.makeActive.checked = true;
    const profile = (state.enterpriseProfiles || []).find((item) => item.id === id);
    form.dataset.mode = profile ? 'edit' : 'create';
    $('#enterpriseModalTitle').textContent = profile ? '编辑企业素材库' : '新建企业素材库';
    if (profile) Object.entries(profile).forEach(([key, value]) => { const input = form.elements[key]; if (!input) return; input.value = Array.isArray(value) ? value.join('\n') : value ?? ''; });
    form.elements.makeActive.checked = !profile || profile.id === state.activeEnterpriseProfileId;
    renderEnterpriseImageList(profile?.imageAssets || [], profile?.id || '');
    $('#addEnterpriseImage').onclick = () => {
      if (!form.elements.id.value) return toast('请先保存资料库基本信息', '保存后即可上传企业图片', true);
      openEnterpriseImageUpload(form.elements.id.value);
    };
    openModal('enterpriseModal');
  }

  function openEnterpriseImageUpload(profileId) {
    const imageForm = $('#enterpriseImageForm'); imageForm.reset(); imageForm.dataset.profileId = profileId; openModal('enterpriseImageModal');
  }

  function openEnterpriseExport(profileId) {
    const profile = (state.enterpriseProfiles || []).find((item) => item.id === profileId);
    if (!profile) return toast('导出失败', '未找到企业素材库', true);
    const form = $('#enterpriseExportForm'); form.reset(); form.elements.profileId.value = profile.id;
    $('#enterpriseExportModalTitle').textContent = `导出：${profile.name}`;
    $('#enterpriseExportHint').textContent = `将导出“${profile.name}”的文字资料、${profile.imageAssets?.length || 0}张图片原文件、图片说明与清单；源资料不会被修改。`;
    openModal('enterpriseExportModal');
  }

  function renderEnterpriseImageList(assets = [], profileId = '') {
    const list = $('#enterpriseImageList');
    list.innerHTML = assets.length ? assets.map((asset) => `<article class="enterprise-image-card"><img src="/api/enterprise-image/${encodeURIComponent(asset.id)}" alt="${escapeHtml(asset.name)}"><div><b>${escapeHtml(asset.name)}</b><small>${escapeHtml({product:'产品实拍',scene:'使用/业务场景',brand:'品牌视觉',reference:'构图/风格参考'}[asset.kind] || '参考图')}</small><p>${escapeHtml(asset.description || '未填写说明：已本机归档，不会自动作为文字生产约束。')}</p>${asset.immutableNotes ? `<em>限制：${escapeHtml(asset.immutableNotes)}</em>` : ''}</div><button class="mini-button danger-outline delete-enterprise-image" data-id="${asset.id}" type="button">删除</button></article>`).join('') : '<div class="enterprise-image-empty">尚未上传企业图片。图片为可选资产；一做可仅用文字资料生产。</div>';
    $$('.delete-enterprise-image', list).forEach((button) => button.addEventListener('click', async () => { if (!profileId || !confirm('确认删除这张本机企业图片吗？')) return; const result = await api.deleteEnterpriseImage(profileId, button.dataset.id); if (!result.ok) return toast('删除失败', result.message, true); state = await api.getState(); const profile = state.enterpriseProfiles.find((item) => item.id === profileId); renderEnterpriseImageList(profile?.imageAssets || [], profileId); render(); toast('企业图片已删除'); }));
  }

  async function saveEnterpriseImage(event) {
    event.preventDefault();
    const form = event.currentTarget; const file = form.elements.file.files?.[0];
    if (!file) return toast('请选择图片', '', true);
    if (file.size > 10 * 1024 * 1024) return toast('图片过大', '单张图片不能超过 10MB', true);
    const extensionMime = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp' }[String(file.name || '').split('.').pop().toLowerCase()];
    const mime = ['image/jpeg','image/png','image/webp'].includes(file.type) ? file.type : extensionMime;
    if (!mime) return toast('图片格式不支持', '请选择 JPG、PNG 或 WebP 图片', true);
    try {
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); });
      const payload = Object.fromEntries(new FormData(form)); payload.profileId = form.dataset.profileId; payload.name = String(payload.name || '').trim() || file.name; payload.data = data; payload.mime = mime;
      const result = await api.uploadEnterpriseImage(payload); if (!result.ok) return toast('图片保存失败', result.message, true);
      state = await api.getState(); const profile = state.enterpriseProfiles.find((item) => item.id === payload.profileId); renderEnterpriseImageList(profile?.imageAssets || [], payload.profileId); render(); closeModal('enterpriseImageModal'); toast('企业图片已入库', payload.description ? '已作为可追溯企业约束' : '已本机归档；可在编辑资料中补充图片说明');
    } catch (error) { toast('图片保存失败', error.message, true); }
  }

  async function saveEnterpriseProfile(event) {
    event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form));
    ['productFacts','sellingPoints','proofPoints','forbiddenClaims','visualRules','referenceLinks'].forEach((name) => { data[name] = String(data[name] || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean); });
    data.makeActive = form.elements.makeActive.checked;
    data.mode = form.dataset.mode === 'edit' ? 'edit' : 'create';
    try { const result = await api.saveEnterpriseProfile(data); if (!result.ok) return toast('保存失败', result.message, true); closeModal('enterpriseModal'); state = await api.getState(); render(); toast('企业素材库已保存', result.active ? '已设为当前生产资料库' : '资料已更新'); }
    catch (error) { toast('保存失败', error.message, true); }
  }

  async function saveEnterpriseExport(event) {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
    try { const result = await api.exportEnterpriseProfile(data); if (!result.ok) return toast('导出失败', result.message, true); closeModal('enterpriseExportModal'); toast('企业资料库已导出', result.path); }
    catch (error) { toast('导出失败', error.message, true); }
  }

  async function cleanupCandidates() {
    const count = state.candidates.filter((item) => item.status === 'ignored').length;
    if (!count) return toast('没有可清理内容', '目前没有已忽略候选');
    if (!confirm(`确认清理 ${count} 条已忽略候选吗？进行中的工作流内容会自动保留。`)) return;
    const result = await api.cleanupCandidates('ignored'); if (!result.ok) return toast('清理失败', result.message, true);
    state = await api.getState(); selectedCandidateId = state.candidates[0]?.id || null; render();
    if (!result.candidatesDeleted) return toast('没有删除任何候选', result.message || `${result.blocked || count}条候选仍受保护`, true);
    toast('候选池已整理', result.message || `删除${result.candidatesDeleted}条`);
  }

  async function cleanupVariants() {
    const count = state.variants.filter((item) => ['pending','rejected'].includes(item.status) && !item.metrics).length;
    if (!count) return toast('没有可清理内容', '待审核区没有草稿或已退回版本');
    if (!confirm(`确认清理 ${count} 个待审核/已退回版本吗？已发布和已有数据的内容不会删除。`)) return;
    const result = await api.cleanupVariants(); if (!result.ok) return toast('清理失败', result.message, true);
    state = await api.getState(); render(); toast('生产区已整理', `删除${result.deleted}个版本`);
  }

  async function cleanupRuns() {
    const count = (state.workflowRuns || []).filter((run) => ['completed','failed','cancelled'].includes(run.status)).length;
    if (!count) return toast('没有可清理记录', '受阻和进行中的任务会一直保留');
    if (!confirm(`确认清理 ${count} 条已结束任务记录吗？业务内容、成本汇总和进行中任务不受影响。`)) return;
    const result = await api.cleanupRuns(); if (!result.ok) return toast('清理失败', result.message, true);
    state = await api.getState(); render(); toast('任务记录已整理', `清理${result.deleted}条`);
  }

  function renderSupervisor() {
    const healthy = state.agents.filter((item) => platformAgentEnabled(item) && ['healthy', 'idle', 'ready'].includes(item.status)).length;
    const warnings = state.agents.filter((item) => platformAgentEnabled(item) && ['warning', 'needs_login', 'verification_required'].includes(item.status)).length;
    $('#healthyCount').textContent = healthy;
    $('#warningCount').textContent = warnings;
    $('#restartCount').textContent = state.agents.reduce((sum, item) => sum + item.restarts, 0);
    const symbols = { supervisor: '♜', 'xhs-collector': '红', 'douyin-collector': '抖', analyst: '析', creator: '做', 'data-agent': '↻' };
    $('#agentGrid').innerHTML = state.agents.map((agent) => {
      const enabled = platformAgentEnabled(agent);
      const statusClass = enabled ? agent.status : 'idle';
      const statusLabel = enabled ? agentStatusText(agent.status) : '未启用';
      const detail = enabled ? agent.detail : `${agent.id === 'xhs-collector' ? '小红书' : '抖音'}未启用；不会参与抓取、自动调度或主管告警。`;
      const footer = enabled ? `<span>${timeAgo(agent.lastHeartbeat)}心跳 · 唤醒${agent.restarts}次</span>${agent.status === 'disabled' ? '<span>尚未接入</span>' : `<button class="restart-agent" data-id="${agent.id}" type="button">重新检查</button>`}` : '<span>在系统设置中启用后才会参与运行</span>';
      return `<article class="agent-card"><div class="agent-card-head"><span class="agent-symbol">${symbols[agent.id] || 'AI'}</span><span class="agent-state ${statusClass}"><i></i>${statusLabel}</span></div><h3>${escapeHtml(agent.name)}</h3><p>${escapeHtml(detail)}</p><footer>${footer}</footer></article>`;
    }).join('');
    $$('.restart-agent').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; try { const result = await api.restartAgent(button.dataset.id); state = await api.getState(); render(); result.ok ? toast('模块检查完成', result.message || '当前状态已刷新') : toast('检查未通过', result.message, true); } catch (error) { toast('检查失败', error.message, true); } finally { button.disabled = false; } }));
  }

  function renderSettings() {
    const form = $('#settingsForm');
    form.classList.toggle('show-advanced', advancedSettingsVisible);
    $('#toggleAdvancedSettings').textContent = advancedSettingsVisible ? '收起高级参数' : '显示高级参数';
    Object.entries(state.settings).forEach(([key, value]) => {
      const input = form.elements[key];
      if (!input) return;
      if (input.type === 'checkbox') input.checked = Boolean(value); else input.value = Array.isArray(value) ? value.join('\n') : value ?? '';
    });
    const collector = state.agents.find((agent) => agent.id === 'xhs-collector');
    if (collector) { $('#xhsCollectorStatus').textContent = platformStatusLabel(collector, state.settings.xhsEnabled); $('#xhsCollectorDetail').textContent = state.settings.xhsEnabled ? collector.detail : '小红书当前未启用，不参与手动或24小时工作流；启用并保存后可测试。'; }
    const douyinCollector = state.agents.find((item) => item.id === 'douyin-collector');
    if (douyinCollector) { $('#douyinCollectorStatus').textContent = platformStatusLabel(douyinCollector, state.settings.douyinEnabled); $('#douyinCollectorDetail').textContent = state.settings.douyinEnabled ? douyinCollector.detail : '抖音当前未启用，不参与手动或24小时工作流；启用并保存后可测试。'; }
    const performanceAgent = state.agents.find((agent) => agent.id === 'data-agent');
    if (performanceAgent) { $('#performanceCollectorStatus').textContent = agentStatusText(performanceAgent.status); $('#performanceCollectorDetail').textContent = performanceAgent.detail; }
    renderModelProfiles('text');
    renderModelProfiles('vision');
    renderModelProfiles('image');
  }

  function renderModelProfiles(kind) {
    const profiles = kind === 'vision' ? (state.settings.visionProfiles || []) : kind === 'image' ? (state.settings.imageProfiles || []) : (state.settings.textProfiles || []);
    const holder = kind === 'vision' ? $('#visionProfileList') : kind === 'image' ? $('#imageProfileList') : $('#textProfileList');
    const activeId = kind === 'vision' ? state.settings.activeVisionProfileId : kind === 'image' ? state.settings.activeImageProfileId : state.settings.activeTextProfileId;
    if (!profiles.length) {
      holder.innerHTML = '<div class="model-profile-empty">还没有连接档案。新建后保存 Key、测试成功，再设为当前。</div>';
      return;
    }
    holder.innerHTML = profiles.map((profile) => {
      const stateText = profile.lastTestOk ? '已测试成功' : profile.lastTestAt ? '测试失败' : '尚未测试';
      const error = profile.lastTestError ? `<small class="profile-error">${escapeHtml(profile.lastTestError)}</small>` : '';
      const imageCapability = kind === 'image' ? `<br><span class="profile-capability">${profile.imageInputMode === 'reference_generation_json' ? 'Generations JSON 参考图模式，企业原图会作为 image 数组传入' : profile.imageInputMode === 'reference_edit' ? 'Edits multipart 参考图模式，企业原图会作为文件传入' : '文生图模式，企业原图不传入'}</span>` : '';
      return `<article class="model-profile ${profile.id === activeId ? 'active' : ''}"><div><header><b>${escapeHtml(profile.name)}</b>${profile.id === activeId ? '<em>当前使用</em>' : ''}</header><p>${escapeHtml(profile.provider || '未标记供应商')} · ${escapeHtml(profile.model)}<br>${escapeHtml(profile.baseUrl)}${imageCapability}</p><footer><span class="profile-status ${profile.lastTestOk ? 'success' : 'pending'}">${stateText} · ${profile.credentialConfigured ? 'Key 已保存' : '缺少 Key'}</span>${error}</footer></div><div class="profile-actions"><button class="mini-button edit-model-profile" data-kind="${kind}" data-id="${profile.id}" type="button">编辑</button><button class="mini-button test-model-profile" data-kind="${kind}" data-id="${profile.id}" type="button">测试</button>${profile.id === activeId ? '' : `<button class="mini-button primary activate-model-profile" data-kind="${kind}" data-id="${profile.id}" type="button" ${profile.lastTestOk && profile.credentialConfigured ? '' : 'disabled'}>设为当前</button>`}</div></article>`;
    }).join('');
    $$('.edit-model-profile', holder).forEach((button) => button.addEventListener('click', () => openModelProfile(button.dataset.kind, button.dataset.id)));
    $$('.test-model-profile', holder).forEach((button) => button.addEventListener('click', () => testExistingModelProfile(button.dataset.kind, button.dataset.id, button)));
    $$('.activate-model-profile', holder).forEach((button) => button.addEventListener('click', () => activateModelProfile(button.dataset.kind, button.dataset.id, button)));
  }

  function openModelProfile(kind, id = '') {
    const form = $('#modelProfileForm'); form.reset();
    const profiles = kind === 'vision' ? (state.settings.visionProfiles || []) : kind === 'image' ? (state.settings.imageProfiles || []) : (state.settings.textProfiles || []);
    const profile = profiles.find((item) => item.id === id);
    form.elements.kind.value = kind;
    $('#imageInputModeField').hidden = kind !== 'image';
    form.elements.imageInputMode.disabled = kind !== 'image';
    if (kind === 'image') form.elements.imageInputMode.value = profile?.imageInputMode || 'text_only';
    const kindName = kind === 'vision' ? '视觉' : kind === 'image' ? '生图' : '文本';
    $('#modelProfileModalTitle').textContent = profile ? `编辑${kindName}连接档案` : `新建${kindName}连接档案`;
    $('#modelProfileTestStatus').textContent = profile?.lastTestOk ? '该档案上次测试成功；修改地址、模型后需要重新测试。' : (profile?.lastTestError || '保存后请先测试；测试成功才可设为当前。');
    if (profile) Object.entries(profile).forEach(([key, value]) => { const input = form.elements[key]; if (input && key !== 'apiKey') input.value = value ?? ''; });
    openModal('modelProfileModal');
  }

  function modelProfilePayload() {
    const form = $('#modelProfileForm'); const data = Object.fromEntries(new FormData(form));
    ['inputPricePerMillion', 'outputPricePerMillion', 'maxOutputTokens', 'requestTimeoutSeconds'].forEach((name) => { data[name] = Number(data[name]); });
    return data;
  }

  async function saveModelProfile(event) {
    event.preventDefault(); const result = await api.saveModelProfile(modelProfilePayload());
    if (!result.ok) return toast('档案保存失败', result.message, true);
    state = await api.getState(); settingsDirty = false; render(); closeModal('modelProfileModal'); toast('连接档案已保存', '下一步请测试；成功后再设为当前。');
  }

  async function testModelProfile() {
    const button = $('#testModelProfile'); button.disabled = true;
    try {
      const payload = modelProfilePayload(); const saved = await api.saveModelProfile(payload);
      if (!saved.ok) return toast('无法测试', saved.message, true);
      const result = await api.testModelProfile(payload.kind, saved.profile.id, payload.apiKey);
      state = await api.getState(); render();
      $('#modelProfileTestStatus').textContent = result.ok ? '测试成功，现在可以设为当前。' : result.message;
      toast(result.ok ? '连接测试成功' : '连接测试失败', result.message, !result.ok);
    } catch (error) { toast('连接测试失败', error.message, true); } finally { button.disabled = false; }
  }

  async function testExistingModelProfile(kind, id, button) {
    button.disabled = true;
    try { const result = await api.testModelProfile(kind, id); state = await api.getState(); render(); toast(result.ok ? '连接测试成功' : '连接测试失败', result.message, !result.ok); }
    catch (error) { toast('连接测试失败', error.message, true); } finally { button.disabled = false; }
  }

  async function activateModelProfile(kind, id, button) {
    button.disabled = true;
    try { const result = await api.activateModelProfile(kind, id); state = await api.getState(); settingsDirty = false; render(); toast(result.ok ? '当前模型已切换' : '切换失败', result.message || '后续调用将使用这个已验证档案。', !result.ok); }
    catch (error) { toast('切换失败', error.message, true); } finally { button.disabled = false; }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    ['workflowAutoEnabled', 'xhsEnabled', 'douyinEnabled', 'imageQualityReviewEnabled'].forEach((name) => { data[name] = form.elements[name].checked; });
    data.xhsKeywords = String(data.xhsKeywords || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    data.douyinKeywords = String(data.douyinKeywords || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    data.performanceAutoEnabled = form.elements.performanceAutoEnabled.checked;
    data.performanceSampleHours = String(data.performanceSampleHours || '').split(/[\s,，]+/).map((item) => Number(item)).filter(Boolean);
    ['brandColors', 'mustShow', 'prohibitedElements'].forEach((name) => { data[name] = String(data[name] || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean); });
    ['xhsMaxPerKeyword', 'xhsScrollRounds', 'xhsDelayMs', 'douyinDelayMs', 'manualRawLimit', 'automaticRawLimit', 'manualFinalLimit', 'automaticFinalLimit', 'dailyCandidateLimit', 'aiAnalysisLimit', 'analysisConcurrency', 'analysisAutoRetryCount', 'generationCount', 'scaleGenerationCount', 'performanceAccountBaselineNotes', 'imageCount', 'imageSingleTimeoutSeconds', 'imageJobTimeoutMinutes', 'imageMaxConcurrentJobs', 'imageQualityThreshold', 'imageAutoRetryCount', 'dailyBudget', 'visionDailyBudget', 'visionMaxImages', 'imageDailyBudget', 'imageCostPerImage'].forEach((name) => { data[name] = Number(data[name]); });
    try { const result = await api.saveSettings(data); if (result.ok) { settingsDirty = false; state = await api.getState(); render(); toast('设置已保存'); return true; } toast('保存失败', result.message, true); return false; }
    catch (error) { toast('保存失败', error.message, true); return false; }
  }

  async function saveAutoMode() {
    const enabled = $('#autoWorkflowToggle').checked;
    try { const result = await api.saveSettings({ ...state.settings, workflowAutoEnabled: enabled, xhsKeywords: state.settings.xhsKeywords }); if (!result.ok) return toast('保存失败', result.message, true); state = await api.getState(); render(); const active = Boolean(state.settings.workflowAutoEnabled); toast(active ? '24小时自动运行已开启' : '24小时自动运行未开启', active ? '自动阶段会按计划执行，人工关卡仍会暂停' : (enabled ? '人工总控仍处于停止状态；参数已保存，但调度没有启动' : '不会再创建新的定时工作流')); }
    catch (error) { toast('保存失败', error.message, true); }
  }

  async function openCreatorLogin() {
    const buttons = [$('#openCreatorLogin'), $('#openCreatorLoginFromSettings')].filter(Boolean); buttons.forEach((button) => { button.disabled = true; });
    try { const result = await api.openCreatorLogin(); state = await api.getState(); render(); toast(result.ok ? '创作后台已登录' : result.code === 'LOGIN_REQUIRED' ? '请在已打开窗口登录' : '后台检查未通过', result.message, !result.ok && result.code !== 'LOGIN_REQUIRED'); }
    catch (error) { toast('打开失败', error.message, true); }
    finally { buttons.forEach((button) => { button.disabled = false; }); }
  }

  async function collectPerformanceNow() {
    const variantId = typeof arguments[0] === 'string' ? arguments[0] : '';
    const triggerButton = arguments[1]?.nodeType === 1 ? arguments[1] : null;
    const buttons = triggerButton ? [triggerButton] : [$('#collectPerformanceNow'), $('#testPerformanceCollection')].filter(Boolean); buttons.forEach((button) => { button.disabled = true; });
    try { const result = await api.collectPerformance(variantId ? [variantId] : []); state = await api.getState(); render(); toast(result.ok ? (variantId ? '本条后台数据已读取' : '后台检查完成') : '读取暂停', result.message || (result.ok ? `匹配 ${result.sampled} 条，未匹配 ${result.missing?.length || 0} 条` : ''), !result.ok); }
    catch (error) { toast('读取失败', error.message, true); }
    finally { buttons.forEach((button) => { button.disabled = false; }); }
  }

  async function checkPerformanceLogin(button) {
    button.disabled = true;
    try { const result = await api.restartAgent('data-agent'); state = await api.getState(); render(); toast(result.ok ? '创作后台登录有效' : '后台检查未通过', result.message || '', !result.ok); }
    catch (error) { toast('后台检查失败', error.message, true); }
    finally { button.disabled = false; }
  }

  async function ensureMasterForExplicitAction() {
    if (state.settings.masterEnabled) return true;
    try {
      const result = await api.startMaster();
      state = await api.getState(); render();
      if (!result.ok) { toast('无法启动人工总控', result.message, true); return false; }
      toast('人工总控已自动开启', '这是你刚刚明确点击的任务；24小时自动运行仍保持原设置');
      return true;
    } catch (error) { toast('无法启动人工总控', error.message, true); return false; }
  }

  async function startWorkflow() {
    if (!serviceOnline) return toast('后台未连接', '请稍候或重新打开工作台', true);
    const releaseButtons = lockButtons(collectionActionButtons());
    toast('正在启动完整工作流', '总管 Agent 将先检查抓取登录与模型 API');
    try { if (!(await ensureMasterForExplicitAction())) return; const result = await api.runWorkflow(); state = await api.getState(); render(); if (result.ok) { toast('工作流已接单', result.message || '后台会并行执行抓取后的分析，请在运行记录查看进度'); navigate('runs'); } else toast(['AI_NOT_CONFIGURED','TEXT_AI_NOT_CONFIGURED','VISION_AI_NOT_CONFIGURED','ANALYSIS_NOT_READY'].includes(result.code) ? '分析模型尚未接好' : '工作流已暂停', result.message, true); }
    catch (error) { toast('工作流启动失败', error.message, true); }
    finally { releaseButtons(); }
  }

  async function startMaster() {
    const button=$('#masterStart'); button.disabled=true; try { const result=await api.startMaster(); state=await api.getState(); render(); toast(result.ok?'人工总控已开始':'无法开始',result.ok?'现在可以手动运行或开启24小时调度':result.message,!result.ok); if(!result.ok) navigate('settings'); } catch(error){toast('无法开始',error.message,true);} finally{button.disabled=false;}
  }

  async function stopMaster() {
    if (!confirm('确认立即停止整套工作流吗？24小时调度会关闭，当前阶段完成后也不会进入下一阶段。')) return;
    const button = $('#masterStop'); button.disabled = true;
    try { const result=await api.stopMaster(); state=await api.getState(); render(); toast(result.ok?'整套工作流已停止':'停止失败',result.message||'不会继续调用后续模型',!result.ok); }
    catch (error) { toast('停止失败', error.message, true); }
    finally { button.disabled = false; }
  }

  async function resumeWorkflow() {
    const button = $('#resumeWorkflow'); button.disabled = true;
    try { const result = await api.resumeWorkflow(); state = await api.getState(); render(); if (result.ok) { toast('工作流已继续', '已到达人工选款关卡'); navigate('radar'); } else toast('暂时无法继续', result.message, true); }
    catch (error) { toast('继续失败', error.message, true); }
  }

  async function testFeishu() {
    const form = $('#settingsForm');
    if (activeView === 'settings' && !(await saveSettings({ preventDefault() {}, currentTarget: form }))) return;
    try { const result = await api.testFeishu(); result.ok ? toast('飞书已联通', result.message) : toast('飞书未联通', result.message, true); }
    catch (error) { toast('飞书未联通', error.message, true); }
  }

  async function openXhsLogin() {
    const button = $('#openXhsLogin'); button.disabled = true;
    try { const result = await api.openXhsLogin(); state = await api.getState(); render(); toast(result.ok ? '登录窗口已打开' : '打开失败', result.ok ? '完成登录后回到这里点击“检查登录状态”' : result.message, !result.ok); }
    catch (error) { toast('打开失败', error.message, true); }
    finally { button.disabled = false; }
  }

  async function checkXhsLogin() {
    if (!serviceOnline) return toast('后台未连接', '请稍候或重新打开工作台', true);
    const buttons = [$('#checkXhsLogin'), $('#quickStartPrimary'), $('#quickStartSecondary')].filter(Boolean); buttons.forEach((button) => { button.disabled = true; });
    try {
      const result = await api.checkXhsLogin(); state = await api.getState(); render();
      const title = result.ok ? '小红书登录检查通过' : result.code === 'LOGIN_REQUIRED' ? '需要登录小红书' : result.code === 'CAPTCHA' ? '需要人工完成安全验证' : '登录检查未通过';
      toast(title, result.message, !result.ok);
    } catch (error) { toast('登录检查失败', error.message, true); }
    finally { buttons.forEach((button) => { button.disabled = false; }); }
  }

  async function openDouyinLogin() {
    const button = $('#openDouyinLogin'); button.disabled = true;
    try { const result = await api.openDouyinLogin(); state = await api.getState(); render(); toast(result.ok ? '抖音登录窗口已打开' : '打开失败', result.message, !result.ok); }
    catch (error) { toast('打开失败', error.message, true); }
    finally { button.disabled = false; }
  }

  async function runXhsScan({ saveFirst = false, manageButtons = true } = {}) {
    if (!serviceOnline) return toast('后台未连接', '请稍候或重新打开工作台', true);
    const releaseButtons = manageButtons ? lockButtons(collectionActionButtons()) : () => {};
    toast('开始采集', '正在通过专用Chrome低频读取小红书公开图文');
    try { if (saveFirst && activeView === 'settings' && !(await saveSettings({ preventDefault() {}, currentTarget: $('#settingsForm') }))) return; if (!(await ensureMasterForExplicitAction())) return; const result = await api.runCollection('小红书'); state = await api.getState(); render(); const failureTitle = result.code === 'LOGIN_REQUIRED' ? '需要登录' : result.code === 'CAPTCHA' ? '需要人工验证' : result.code === 'BROWSER_SESSION_RECOVERY_FAILED' ? '浏览器自动修复后仍未恢复' : result.code === 'ALREADY_RUNNING' ? '已有小红书任务在运行' : '采集未完成'; toast(result.ok ? '采集完成' : failureTitle, result.ok ? `新增 ${result.added || 0} 条，更新 ${result.updated || 0} 条${result.browserRecoveries ? `；浏览器自动恢复 ${result.browserRecoveries} 次` : ''}` : result.message, !result.ok); if (result.ok) navigate('radar'); }
    catch (error) { toast('扫描失败', error.message, true); }
    finally { releaseButtons(); }
  }

  async function runDouyinScan({ saveFirst = false, manageButtons = true } = {}) {
    if (!serviceOnline) return toast('后台未连接', '请稍候或重新打开工作台', true);
    const releaseButtons = manageButtons ? lockButtons(collectionActionButtons()) : () => {};
    toast('开始采集', '正在通过抖音专用 Chrome 低频读取公开图文');
    try { if (saveFirst && activeView === 'settings' && !(await saveSettings({ preventDefault() {}, currentTarget: $('#settingsForm') }))) return; if (!(await ensureMasterForExplicitAction())) return; const result = await api.runCollection('抖音'); state = await api.getState(); render(); const empty = result.ok && Number(result.total || 0) === 0; toast(result.ok ? (empty ? '本轮没有合格图文' : '抖音采集完成') : result.code === 'LOGIN_REQUIRED' ? '需要登录' : result.code === 'CAPTCHA' ? '需要人工验证' : result.code === 'PAGE_STRUCTURE_CHANGED' ? '抖音页面结构已变化' : '采集未完成', result.ok ? (empty ? (result.message || '搜索完成，但没有符合条件的公开图文') : `新增 ${result.added || 0} 条，更新 ${result.updated || 0} 条`) : result.message, !result.ok); if (result.ok) navigate('radar'); }
    catch (error) { toast('抖音扫描失败', error.message, true); }
    finally { releaseButtons(); }
  }

  async function runEnabledScans() {
    if (!serviceOnline) return toast('后台未连接', '请稍候或重新打开工作台', true);
    if (collectionBatchRunning) return toast('组合采集仍在进行', '请等待所有已启用平台完成', true);
    const platforms = [['小红书', state.settings.xhsEnabled], ['抖音', state.settings.douyinEnabled]].filter(([, enabled]) => enabled).map(([platform]) => platform);
    if (!platforms.length) return toast('未启用平台', '请先到系统设置启用至少一个平台', true);
    const releaseButtons = lockButtons(collectionActionButtons());
    collectionBatchRunning = true;
    try {
      for (const platform of platforms) {
        if (platform === '小红书') await runXhsScan({ manageButtons: false });
        else await runDouyinScan({ manageButtons: false });
      }
    } finally {
      collectionBatchRunning = false;
      releaseButtons();
    }
  }

  function openModal(id) { lastFocusedElement = document.activeElement; const modal = $(`#${id}`); modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); setTimeout(() => $('.modal-close, input, button, textarea', modal)?.focus(), 0); }
  function closeModal(id) { $(`#${id}`).classList.remove('open'); $(`#${id}`).setAttribute('aria-hidden', 'true'); if (id === 'variantModal') { activeVariantModalId = null; activeVariantModalSignature = ''; } lastFocusedElement?.focus?.(); }
  function toast(title, detail = '', error = false) {
    const node = document.createElement('div');
    node.className = `toast${error ? ' error' : ''}`;
    node.innerHTML = `<div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div>`;
    $('#toastStack').appendChild(node);
    setTimeout(() => node.remove(), 3600);
  }
  function statusText(status) { return ({ draft: '制作中', pending: '待审核', approved: '已通过', rejected: '已退回', exported: '已导出', published: '已发布' })[status] || status; }
  function candidateStatusText(status) { return ({ new: '待确认', selected: '已选款', generated: '已生产', ignored: '已忽略' })[status] || status; }
  function metricValue(value) { return value == null ? '--' : compact(value); }
  function costText(value) {
    const amount = Number(value || 0);
    const pricingConfigured = Number(state?.settings?.aiInputPricePerMillion || 0) > 0 || Number(state?.settings?.aiOutputPricePerMillion || 0) > 0;
    return amount > 0 ? `¥${amount.toFixed(4)}` : pricingConfigured ? '¥0.0000' : '未计量';
  }
  function agentStatusText(status) { return ({ healthy: '健康', idle: '待命', ready: '已就绪', warning: '异常', running: '运行中', needs_login: '需要登录', verification_required: '需要验证', disabled: '未接入' })[status] || status; }
  function workflowStatusText(status) { return ({ idle:'未运行', queued:'排队中', preflight:'启动检查中', running:'运行中', waiting_human:'等待人工', paused:'已暂停', blocked:'已阻塞', completed:'已完成', failed:'失败', cancelled:'已停止' })[status] || status; }
  function stageStatusText(status) { return ({ pending:'尚未开始', queued:'等待执行', running:'正在执行', waiting_human:'等待人工处理', completed:'已完成', blocked:'已阻塞', failed:'执行失败', skipped:'已跳过', cancelled:'已由人工停止' })[status] || '尚未开始'; }
  function decisionText(decision) { return ({ scale: '建议放大', test: '继续测试', stop: '建议停止', scaled: '已进入放大' })[decision] || '等待判断'; }
  function decisionDescription(decision) { return ({ scale: '表现超过阈值，等待人工确认下一轮', test: '有潜力但样本不足，建议继续小批测试', stop: '当前表现低于基线，暂停继续消耗', scaled: '已生成下一轮受控变体' })[decision] || ''; }

  function createBrowserFallback() {
    let fallback = null;
    const seed = () => ({ version: 2, mode: 'browser', lastSavedAt: new Date().toISOString(), runtime: { aiReady:false, workflowRunning:false, nextAutomaticRunAt:null, targetSummary:'手动抓50留10 · 自动10:00/17:00抓200留10' }, settings: { workflowAutoEnabled: false, autoMorningTime:'10:00', autoAfternoonTime:'17:00', manualRawLimit:50, automaticRawLimit:200, manualFinalLimit:10, automaticFinalLimit:10, dailyCandidateLimit: 500, aiAnalysisLimit: 20, generationCount:10, dailyBudget: 30, spentToday: 0, xhsEnabled: true, douyinEnabled: false, xhsKeywords: ['内容运营'], xhsMaxPerKeyword: 50, xhsScrollRounds: 2, xhsDelayMs: 2500, feishuWebhook: '', aiBaseUrl: '', aiModel: '', aiCredentialConfigured:false, lastAiCheckOk:false }, agents: [{ id:'orchestrator',name:'内容总管 Agent',status:'idle',detail:'等待启动',lastHeartbeat:new Date().toISOString(),restarts:0 }, { id: 'supervisor', name: '值班主管', status: 'healthy', detail: '浏览器预览模式', lastHeartbeat: new Date().toISOString(), restarts: 0 }, { id: 'xhs-collector', name: '抓取 Agent', status: 'needs_login', detail: '请运行桌面端打开专用登录窗口', lastHeartbeat: new Date().toISOString(), restarts: 0 }, { id: 'douyin-collector', name: '抖音采集器', status: 'disabled', detail: '真实图文采集尚未接入', lastHeartbeat: new Date().toISOString(), restarts: 0 }], workflowRuns:[], candidates: [], variants: [], publications: [], materials: [], activity: [{ id: '1', level: 'info', title: '浏览器预览模式', detail: '请运行桌面端以启用完整功能', at: new Date().toISOString() }] });
    return {
      async getState() { fallback ||= seed(); return fallback; }, onStateChanged() {},
      async runCollection() { return { ok: false, message: '请在桌面端运行' }; }, async runWorkflow() { return { ok:false,message:'请在桌面端运行' }; }, async resumeWorkflow() { return { ok:false,message:'请在桌面端运行' }; }, async openXhsLogin() { return { ok: false, message: '请在桌面端运行' }; }, async checkXhsLogin() { return { ok:false, message:'请在桌面端运行' }; }, async openCreatorLogin() { return { ok: false, message: '请在桌面端运行' }; }, async collectPerformance() { return { ok: false, message: '请在桌面端运行' }; }, async addSource() { return { ok: false, message: '请在桌面端运行' }; }, async saveEnterpriseProfile(){return {ok:false,message:'请在桌面端运行'};}, async activateEnterpriseProfile(){return {ok:false,message:'请在桌面端运行'};}, async archiveEnterpriseProfile(){return {ok:false,message:'请在桌面端运行'};}, async restoreEnterpriseProfile(){return {ok:false,message:'请在桌面端运行'};}, async setCandidateStatus() { return { ok: false }; }, async generateVariants() { return { ok: false }; }, async setVariantStatus() { return { ok: false }; }, async updateVariant() { return { ok: false }; }, async generateVariantImages() { return { ok: false, message:'请在桌面端运行' }; }, async setExportDirectory() { return { ok: false, message:'请在桌面端运行' }; }, async exportVariant() { return { ok: false }; }, async saveMetrics() { return { ok: false }; }, async scaleVariant() { return { ok: false }; }, async restartAgent() { return { ok: false }; }, async inspectSupervisor() { return { ok: false }; }, async saveSettings(payload) { Object.assign(fallback.settings, payload); return { ok: true }; }, async saveModelProfile(){return {ok:false,message:'请在桌面端运行'};}, async testModelProfile(){return {ok:false,message:'请在桌面端运行'};}, async activateModelProfile(){return {ok:false,message:'请在桌面端运行'};}, async testFeishu() { return { ok: false, message: '请在桌面端运行' }; }, async resetDemo() { fallback = seed(); return { ok: true }; }
    };
  }

  function createHttpApi() {
    let lastSaved = '';
    async function request(route, payload) {
      const response = await fetch(route, payload === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`服务请求失败：${response.status}`);
      return response.json();
    }
    const client = {
      async getState() { const next = await request('/api/state'); lastSaved = next.lastSavedAt; return next; },
      runCollection: (platform) => request('/api/collection/run', { platform, manual: true }),
      runWorkflow: () => request('/api/workflow/run', {}),
      startMaster: () => request('/api/master/start', {}),
      stopMaster: () => request('/api/master/stop', {}),
      resumeWorkflow: () => request('/api/workflow/resume', {}),
      openXhsLogin: () => request('/api/collector/xhs/open-login', {}),
      checkXhsLogin: () => request('/api/collector/xhs/probe', {}),
      openDouyinLogin: () => request('/api/collector/douyin/open-login', {}),
      openCreatorLogin: () => request('/api/collector/xhs-creator/open-login', {}),
      collectPerformance: (variantIds = []) => request('/api/performance/collect', { variantIds, manual:true }),
      addSource: (payload) => request('/api/source/add', payload),
      deleteCandidate: (id) => request('/api/candidate/delete', { id }),
      cleanupCandidates: (scope) => request('/api/candidate/cleanup', { scope }),
      deleteVariant: (id) => request('/api/variant/delete', { id }),
      cleanupVariants: () => request('/api/variant/cleanup', {}),
      cleanupRuns: () => request('/api/workflow/cleanup', {}),
      saveEnterpriseProfile: (payload) => request('/api/enterprise-profile/save', payload),
      exportEnterpriseProfile: (payload) => request('/api/enterprise-profile/export', payload),
      uploadEnterpriseImage: (payload) => request('/api/enterprise-image/upload', payload),
      deleteEnterpriseImage: (profileId, assetId) => request('/api/enterprise-image/delete', { profileId, assetId }),
      activateEnterpriseProfile: (id) => request('/api/enterprise-profile/activate', { id }),
      archiveEnterpriseProfile: (id) => request('/api/enterprise-profile/archive', { id }),
      restoreEnterpriseProfile: (id) => request('/api/enterprise-profile/restore', { id }),
      setCandidateStatus: (id, status) => request('/api/candidate/status', { id, status }),
      analyzeCandidate: (id) => request('/api/candidate/analyze', { id }),
      generateVariants: (candidateId) => request('/api/variant/generate', { candidateId }),
      setVariantStatus: (id, status) => request('/api/variant/status', { id, status }),
      updateVariant: (payload) => request('/api/variant/update', payload),
      exportVariant: (id) => request('/api/variant/export', { id }),
      generateVariantImages: (id, pageIds = [], force = false) => request('/api/variant/image/generate', { id, pageIds, force }),
      setExportDirectory: (id, directory) => request('/api/variant/export-directory', { id, directory }),
      saveMetrics: (payload) => request('/api/metrics/save', payload),
      scaleVariant: (id) => request('/api/variant/scale', { id }),
      restartAgent: (id) => request('/api/agent/restart', { id }),
      inspectSupervisor: () => request('/api/supervisor/inspect', {}),
      saveSettings: (payload) => request('/api/settings/save', payload),
      saveModelProfile: (payload) => request('/api/model-profile/save', payload),
      testModelProfile: (kind, id, apiKey = '') => request('/api/model-profile/test', { kind, id, apiKey }),
      activateModelProfile: (kind, id) => request('/api/model-profile/activate', { kind, id }),
      testFeishu: () => request('/api/feishu/test', {}),
      resetDemo: () => request('/api/data/reset', {}),
      onStateChanged(callback, onError) {
        // `runtime` is intentionally calculated by the service and is not part
        // of the persisted state file.  Comparing only lastSavedAt caused the
        // dashboard to keep showing "running" after an in-memory task settled.
        // Keep a compact signature so every meaningful live-state transition
        // reaches the console even when no business record changed.
        let previousSignature = '';
        setInterval(async () => {
          try {
            const next = await request('/api/state');
            const currentRun = next.workflowRuns?.[0] || {};
            const runtime = next.runtime || {};
            const signature = JSON.stringify({
              saved: next.lastSavedAt,
              masterEnabled: Boolean(next.settings?.masterEnabled),
              workflowRunning: Boolean(runtime.workflowRunning),
              collectionRunning: Boolean(runtime.collectionRunning),
              imageJobsRunning: Number(runtime.imageJobsRunning || 0),
              runId: currentRun.id || '',
              runStatus: currentRun.status || '',
              currentStep: currentRun.currentStep || '',
              agents: (next.agents || []).map((agent) => [agent.id, agent.status, agent.detail])
            });
            if (previousSignature && signature !== previousSignature) callback(next);
            previousSignature = signature;
            lastSaved = next.lastSavedAt;
          } catch (error) { onError?.(error); }
        }, 3000);
      }
    };
    return client;
  }

  function renderConnectionState() {
    document.body.classList.toggle('service-offline', !serviceOnline);
    const status = $('.machine-status strong');
    if (status) status.textContent = serviceOnline ? '后台运行中' : '后台连接中断';
    const mode = $('.mode-pill b');
    if (mode && !serviceOnline) mode.textContent = `正在重连（${pollFailures}）`;
    document.body.setAttribute('aria-busy', serviceOnline ? 'false' : 'true');
  }

  init().catch((error) => { console.error(error); toast('工作台启动失败', error.message, true); });
})();
