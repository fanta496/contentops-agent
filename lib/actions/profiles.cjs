'use strict';
// 模型连接档案
// 这些处理函数从 server.cjs 的 handleAction 原样搬来；ctx 约定见 docs/ARCHITECTURE.md。

const { finiteNumber, now, safeText } = require('../util.cjs');

module.exports = function register(ctx) {
    const { IMAGE_REFERENCE_TEST_PNG, reserveCall, VISION_TEST_IMAGE_URL, activeProfileKey, addActivity, applyProfile, callJson, callVisionJson, generateImage, json, profileCredentialStore, profileKind, profileList, profileShape, saveState } = ctx;

  return {
  '/api/model-profile/save': async (body) => {
    const state = ctx.state;
const kind = profileKind(body.kind); const list = profileList(kind); const prior = list.find((item) => item.id === safeText(body.id, 120)); const profile = profileShape(kind, body, prior); if (!profile.baseUrl || !profile.model) return { ok: false, message: '连接档案必须填写接口地址和模型名称' }; const keyChanged = Boolean(body.apiKey); const changed = keyChanged || !prior || ['baseUrl', 'model', 'protocol', 'imageInputMode'].some((key) => prior[key] !== profile[key]); if (changed) { profile.lastTestOk = false; profile.lastTestAt = ''; profile.lastTestError = ''; } if (prior) Object.assign(prior, profile); else list.push(profile); const store = profileCredentialStore(kind, profile.id); if (body.apiKey) store.save(body.apiKey); if (state.settings[activeProfileKey(kind)] === profile.id && changed) { if (kind === 'vision') state.settings.lastVisionCheckOk = false; else if (kind === 'text') state.settings.lastAiCheckOk = false; } addActivity('info', prior ? '模型连接档案已更新' : '模型连接档案已创建', `${profile.name} · ${profile.model}`); saveState(); return { ok: true, profile: { ...profile, credentialConfigured: store.has() } };
  },
  '/api/model-profile/test': async (body) => {
    const state = ctx.state;
    // 连接测试会真实调用供应商（生图测试还会真出一张 1024x1024），必须过预算闸门。
    // 测试成功/失败都不主动结算：票据到期按保守口径计入当日消费，避免"测一次不计费"。
    const testKind = profileKind(body.kind);
    // 先按原语义校验档案是否存在，再过预算闸门（顺序反了会把"未找到档案"变成预算错误）。
    if (!profileList(testKind).find((item) => item.id === safeText(body.id, 120))) return { ok: false, message: '未找到连接档案' };
    const testHold = reserveCall(testKind, 2000, 400, '模型连接测试', testKind === 'image' ? Number(state.settings.imageCostPerImage || 0) : 0);
    if (!testHold.ok) return testHold;
const kind = profileKind(body.kind); const profile = profileList(kind).find((item) => item.id === safeText(body.id, 120)); if (!profile) return { ok: false, message: '未找到连接档案' }; const store = profileCredentialStore(kind, profile.id); if (body.apiKey) { store.save(body.apiKey); profile.lastTestOk = false; } if (!store.has()) return { ok: false, message: '该连接档案尚未保存 Key' }; const isActive = profile.id === state.settings[activeProfileKey(kind)]; try { const timeoutMs = finiteNumber(profile.requestTimeoutSeconds, kind === 'image' ? 180 : 120, 10, 1800) * 1000; const result = kind === 'vision' ? await callVisionJson({ baseUrl: profile.baseUrl, apiKey: store.read(), model: profile.model, prompt: '观察测试图片，只返回严格的 json object：{"ok":true,"message":"连接成功"}', imageUrls: [VISION_TEST_IMAGE_URL], allowTrustedTestImage: true, maxOutputTokens: Math.min(profile.maxOutputTokens, 200), timeoutMs }) : kind === 'image' ? await generateImage({ baseUrl: profile.baseUrl, apiKey: store.read(), model: profile.model, inputMode:profile.imageInputMode, referenceImages:profile.imageInputMode !== 'text_only' ? [{ bytes:IMAGE_REFERENCE_TEST_PNG, mime:'image/png', name:'reference-capability-test.png' }] : [], prompt:profile.imageInputMode !== 'text_only' ? '基于上传的测试参考图生成纯白背景图片，无文字，无水印' : '一张纯白背景上的黑色圆点，无文字，无水印', size: '1024x1024', timeoutMs }) : await callJson({ baseUrl: profile.baseUrl, apiKey: store.read(), model: profile.model, system: '只返回 json object。', prompt: '返回严格的 json object：{"ok":true,"message":"连接成功"}', maxOutputTokens: Math.min(profile.maxOutputTokens, 200), timeoutMs }); if (kind === 'image' && result.url && !result.b64) { const remote = new URL(result.url); if (remote.protocol !== 'https:') throw new Error('生图供应商返回的图片 URL 必须使用 HTTPS');
            const blockedHost = remote.hostname.toLowerCase().replace(/^\[|\]$/g, '');
            if (blockedHost === 'localhost' || blockedHost === '::1' || /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(blockedHost) || blockedHost.endsWith('.local')) throw new Error('拒绝从本机或内网地址下载图片'); const imageResponse = await fetch(remote, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }); if (!imageResponse.ok) throw new Error(`生图供应商返回的图片 URL 无法下载：HTTP ${imageResponse.status}`); const bytes = await imageResponse.arrayBuffer(); if (!bytes.byteLength || bytes.byteLength > 25 * 1024 * 1024) throw new Error('生图供应商返回的图片为空或超过 25MB 安全上限'); } profile.lastTestAt = now(); profile.lastTestOk = kind === 'image' ? Boolean(result.b64 || result.url) : Boolean(result.data?.ok); profile.lastTestError = profile.lastTestOk ? '' : kind === 'image' ? '该供应商没有返回 b64_json 或 HTTPS 图片 URL，不能用于本地保存与导出。' : '模型返回不符合预期'; profile.updatedAt = now(); if (isActive) { if (kind === 'vision') state.settings.lastVisionCheckOk = profile.lastTestOk; else if (kind === 'text') state.settings.lastAiCheckOk = profile.lastTestOk; } saveState(); return { ok: profile.lastTestOk, message: profile.lastTestOk ? '连接测试成功，可启用此档案' : profile.lastTestError, usage: result.usage }; } catch (error) { profile.lastTestAt = now(); profile.lastTestOk = false; profile.lastTestError = error.message; if (isActive) { if (kind === 'vision') state.settings.lastVisionCheckOk = false; else if (kind === 'text') state.settings.lastAiCheckOk = false; } saveState(); return { ok: false, message: error.message }; }
  },
  '/api/model-profile/activate': async (body) => {
    const state = ctx.state;
const kind = profileKind(body.kind); const profile = profileList(kind).find((item) => item.id === safeText(body.id, 120)); if (!profile) return { ok: false, message: '未找到连接档案' }; if (!profile.lastTestOk) return { ok: false, message: '连接档案必须先测试成功才能启用' }; const store = profileCredentialStore(kind, profile.id); if (!store.has()) return { ok: false, message: '连接档案缺少 Key' }; applyProfile(kind, profile); state.settings[activeProfileKey(kind)] = profile.id; addActivity('success', '模型连接档案已启用', `${profile.name} · ${profile.model}`); saveState(); return { ok: true, profile };
  },
  };
};
