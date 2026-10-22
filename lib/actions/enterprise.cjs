'use strict';
// 项目资料库与参考图
// 这些处理函数从 server.cjs 的 handleAction 原样搬来；ctx 约定见 docs/ARCHITECTURE.md。

const { now, safeText, uid } = require('../util.cjs');
const { imageBytesMatchMime, imageExtension } = require('../media.cjs');

module.exports = function register(ctx) {
    const { addActivity, addActivityTo, commitStateSnapshot, enterpriseAssetPath, exportEnterpriseProfile, finalizeEnterpriseImageRemoval, fs, normalizeEnterpriseImageAsset, normalizeEnterpriseProfile, path, rollbackEnterpriseImageRemoval, saveState, stageEnterpriseImageRemoval } = ctx;

  return {
  '/api/enterprise-profile/save': async (body) => {
    const state = ctx.state;
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
    addActivityTo(next, existing ? 'info' : 'success', existing ? '项目资料库已更新' : '项目资料库已创建', `${incoming.name} · ${incoming.brandName || incoming.productName}`);
    const committed = commitStateSnapshot(next); const persisted = committed.enterpriseProfiles.find((item) => item.id === savedProfile.id);
    return { ok: true, profile: persisted, active: committed.activeEnterpriseProfileId === savedProfile.id };
  },
  '/api/enterprise-profile/export': async (body) => {
    const state = ctx.state;
const profile = state.enterpriseProfiles.find((item) => item.id === safeText(body.profileId, 120));
    if (!profile) return { ok:false, message:'未找到项目资料库' };
    return exportEnterpriseProfile(profile, body.directory);
  },
  '/api/enterprise-image/upload': async (body) => {
    const state = ctx.state;
const profile = state.enterpriseProfiles.find((item) => item.id === safeText(body.profileId, 120) && item.status === 'active');
    if (!profile) return { ok:false, message:'请先选择一个有效的项目资料库' };
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
    try { fs.writeFileSync(temporary, bytes, { flag:'wx' }); fs.renameSync(temporary, target); const next = structuredClone(state); const nextProfile = next.enterpriseProfiles.find((item) => item.id === profile.id); nextProfile.imageAssets.push(asset); nextProfile.updatedAt = now(); addActivityTo(next, 'success', '参考图片已入库', `${profile.name} · ${asset.name}`); commitStateSnapshot(next); return { ok:true, asset }; }
    catch (error) { try { fs.rmSync(temporary, { force:true }); fs.rmSync(target, { force:true }); } catch {} return { ok:false, message:`参考图片未保存：${error.message}` }; }
  },
  '/api/enterprise-image/delete': async (body) => {
    const state = ctx.state;
const profile = state.enterpriseProfiles.find((item) => item.id === safeText(body.profileId, 120));
    if (!profile) return { ok:false, message:'未找到项目资料库' };
    const index = profile.imageAssets.findIndex((asset) => asset.id === safeText(body.assetId, 120));
    if (index < 0) return { ok:false, message:'未找到参考图片' };
    const asset = profile.imageAssets[index]; let stage;
    if (asset.file !== `${profile.id}/${asset.id}${imageExtension(asset.mime)}`) return { ok:false, message:'参考图片归属校验失败，已拒绝删除以保护其他资料库' };
    try { stage = stageEnterpriseImageRemoval(asset); } catch (error) { return { ok:false, message:`参考图片未删除：${error.message}` }; }
    const previousUpdatedAt = profile.updatedAt; const previousActivity = state.activity.slice();
    profile.imageAssets.splice(index, 1); profile.updatedAt = now(); addActivity('info', '参考图片已删除', `${profile.name} · ${asset.name}`);
    try { saveState(); } catch (error) {
      profile.imageAssets.splice(index, 0, asset); profile.updatedAt = previousUpdatedAt; state.activity = previousActivity;
      try { rollbackEnterpriseImageRemoval(stage); } catch {}
      return { ok:false, message:`参考图片未删除：保存资料库失败，已回滚：${error.message}` };
    }
    try { finalizeEnterpriseImageRemoval(stage); } catch (error) { addActivity('warning', '参考图片待清理', `${profile.name} · ${asset.name}：${error.message}`); saveState(); }
    return { ok:true };
  },
  '/api/enterprise-profile/activate': async (body) => {
    const state = ctx.state;
const profile = state.enterpriseProfiles.find((item) => item.id === safeText(body.id, 120));
    if (!profile) return { ok: false, message: '未找到项目资料库' };
    if (profile.status !== 'active') return { ok: false, message: '已停用的资料库不能用于生产' };
    state.activeEnterpriseProfileId = profile.id; addActivity('success', '已切换生产资料库', profile.name); saveState(); return { ok: true };
  },
  '/api/enterprise-profile/archive': async (body) => {
    const state = ctx.state;
const profile = state.enterpriseProfiles.find((item) => item.id === safeText(body.id, 120));
    if (!profile) return { ok: false, message: '未找到项目资料库' };
    profile.status = 'archived'; profile.updatedAt = now();
    if (state.activeEnterpriseProfileId === profile.id) state.activeEnterpriseProfileId = state.enterpriseProfiles.find((item) => item.id !== profile.id && item.status === 'active')?.id || '';
    addActivity('warning', '项目资料库已停用', profile.name); saveState(); return { ok: true };
  },
  '/api/enterprise-profile/restore': async (body) => {
    const state = ctx.state;
const profile = state.enterpriseProfiles.find((item) => item.id === safeText(body.id, 120));
    if (!profile) return { ok: false, message: '未找到项目资料库' };
    profile.status = 'active'; profile.updatedAt = now();
    if (!state.activeEnterpriseProfileId) state.activeEnterpriseProfileId = profile.id;
    addActivity('info', '项目资料库已恢复', profile.name); saveState(); return { ok: true };
  },
  };
};
