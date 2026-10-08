/* 右侧「画面与素材」面板：画面描述 / 素材（角色、出现位置、片段）/ 这个画面对应的口播时间 / 视频候选入口。
   输入即保存；素材路径文本框在离开输入框时才提交（打字过程中不建素材条目）。
   角色和位置的改动只刷面板和素材卡，不重建整张表（长稿视口不跳）。 */
import { state, on, emit, update, rowById, types, timeline } from '../app/state.js';
import { setShotNote, markReviewed } from '../app/actions.js';
import {
  setShotRefsFromText,
  removeUsage,
  addRefsToShot,
  setUsageRole,
  autoAssignRoles,
} from '../app/asset-actions.js';
import { ROLES, shotMembers } from '../core/shots.js';
import { spanOf } from '../core/timeline.js';
import { fmtTc, fmtLen } from '../core/text.js';
import { layoutShot, circled } from '../core/shot-layout.js';
import * as native from '../platform/native.js';
import { esc, toast, revealRow } from './dom.js';
import { sharedScenes, assetRefs, hydrateAssetCards, inspectorAssets, refreshThumb, missingPaths } from './badges.js';
import { registerCommand, runCommand } from './commands.js';
import { preserveReadingPosition } from './reading-position.js';

const $ = s => document.querySelector(s);
let detailOpen = false;
let wsTimer = null;
let session = null; // 本次聚焦编辑描述的撤销会话：同一次编辑只拍一张快照

export const isInspectorOpen = () => detailOpen;

/* 面板里的操作说明收进「ⓘ」悬停提示，不再一直占着位置 */
const ASSET_TIPS =
  '也可以把文件直接拖进这里或句子上。移除只解除关联，保留本地文件；⌘Z 可撤销。' +
  '输入自动保存；共用画面的描述、素材和视频片段整组共用一份。链接与路径随项目保存，本地素材需随交稿另行打包。';

/* 这个画面在口播里的时间段，拆成三块分别放：
   - meta：口播时间 + 片段够不够长的提醒，放在「素材与片段」标题下面（说的是素材和口播对不对得上）
   - sync：「对着口播看画面」，放在「素材与片段」标题右边（预览的是这些素材怎么配口播）
   - listen：「听这段口播」，放在原文旁边（听的是这几句话） */
function voiceParts(members) {
  const span = spanOf(
    timeline(),
    members.map(r => r.id),
  );
  if (!span) return { meta: '', sync: '', listen: '' };
  const src = timeline().source;
  const how = src === 'srt' ? '字幕实测' : src === 'fit' ? '按口播音频推算' : '按语速估算';
  const len = span.end - span.start;
  // 每个视频主画面：片段够不够盖住它出现的那几秒
  const layout = layoutShot(state.assets || {}, members, timeline());
  const short = [];
  let videos = 0;
  for (const it of layout?.items || []) {
    if (it.kind !== 'video') continue;
    const clipLen = it.usage.clip ? it.usage.clip.out - it.usage.clip.in : it.asset.durationSec;
    if (clipLen == null || !isFinite(clipLen)) continue;
    videos++;
    const need = Math.min(it.end, len) - it.start;
    if (clipLen < need - 0.3)
      short.push(`${circled(it.n)} 片段 ${fmtLen(clipLen)}，比出现时间短 ${fmtLen(need - clipLen)}`);
  }
  const compare = short.length
    ? short.map(x => `<p class="voice-warn">${esc(x)}</p>`).join('')
    : videos
      ? '<p class="voice-ok">视频片段都够盖住各自出现的时间</p>'
      : '';
  return {
    meta: `<div class="voice-block"><div class="voice-line"><b>口播</b><span class="mono">${fmtTc(span.start)}–${fmtTc(span.end)}</span><span>${fmtLen(len)} · ${how}</span></div>${compare}</div>`,
    sync: `<button class="btn sync-btn" data-sync-preview="${members[0].id}" title="${state.voice ? '口播和画面一起播；下面的镜头轨可以调每个主画面出现的秒数' : '还没导入口播音频：按估算时间静音走一遍。下面的镜头轨可以调每个主画面出现的秒数'}">▶ 对着口播看画面</button>`,
    listen: state.voice
      ? `<button class="text-button listen-btn" data-voice-range="${members[0].id}">▶ 听这段口播</button>`
      : '',
  };
}

export function renderInspector(force = false) {
  const panel = $('#inspector');
  const changeLayout = () => {
    panel.hidden = !detailOpen;
    document.querySelector('.workspace').classList.toggle('has-inspector', detailOpen);
  };
  if (panel.hidden !== !detailOpen) preserveReadingPosition(changeLayout);
  else changeLayout();
  $('#btnDetail').setAttribute('aria-expanded', String(detailOpen));
  $('#btnDetail').classList.toggle('active', detailOpen);
  if (!detailOpen) return;
  if (!force && panel.contains(document.activeElement)) return;
  const r = rowById(state.sel);
  if (!r || r.kind !== 'line') {
    panel.innerHTML = '<div class="side-title">画面与素材</div><p class="side-empty">先选择一句口播。</p>';
    return;
  }
  const members = shotMembers(state.rows, r);
  session = null;
  panel.dataset.row = String(r.id);
  panel.dataset.project = state.projectId;
  const ti = types();
  const visual = !r.type || ti.needsVisual(r.type);
  const voice = voiceParts(members);
  panel.innerHTML = `<div class="side-title">${members.length > 1 ? sharedScenes(state.rows).get(r.groupId)?.label : '第 ' + r.no + ' 句'}<button class="text-button side-locate" id="locateDetail" title="把这句滚到正文中间">定位到正文</button><button class="text-button" id="closeDetail" aria-label="关闭素材面板">✕</button></div>
    <section class="detail-assets">
      <div class="asset-list-title">素材与片段<span class="info-tip" tabindex="0" title="${esc(ASSET_TIPS)}" aria-label="${esc(ASSET_TIPS)}">ⓘ</span><span class="spacer"></span>${voice.sync}</div>
      ${voice.meta}
      <div class="asset-list">${inspectorAssets(r, { missing: missingPaths() })}</div>
      <div class="detail-buttons"><button class="btn" id="attachAsset">添加素材</button><button class="btn" id="attachFromLib">从本项目素材</button>${missingPaths().size ? '<button class="btn" id="relinkFolder" title="选一个文件夹，按文件名自动找回所有失联素材">按文件夹找回失联素材</button>' : ''}</div>
      <details class="asset-paths"><summary>编辑链接或文件路径</summary><textarea id="detailAssets" rows="3" placeholder="一行一个链接或文件路径，离开输入框时保存">${esc(assetRefs(r).join('\n'))}</textarea></details>
    </section>
    <label class="detail-note-block"><span class="detail-label">${visual ? '画面描述' : '备注'}</span><textarea id="detailNote" rows="4" placeholder="${visual ? '画面里有什么？如何呈现？' : '给剪辑的备注'}">${esc(r.note || '')}</textarea></label>
    <div class="detail-label detail-excerpt-title">原文${members.length > 1 ? `<small>${members.length} 句</small>` : ''}<span class="spacer"></span>${voice.listen}</div>
    <p class="detail-excerpt">${esc(members.map(x => x.text).join(''))}</p>
    ${r.needsReview ? '<button class="btn" id="confirmReviewed">已核对这段改稿</button>' : ''}`;
  hydrateAssetCards();
}

/* 原文视图的选区卡 / 行菜单：打开右侧面板看这个画面的素材 */
export function openInspectorFor(id) {
  const r = rowById(id);
  if (!r || r.kind !== 'line') return;
  state.sel = id;
  state.multi = null;
  detailOpen = true;
  update('selection');
  renderInspector(true);
}

function panelRow() {
  const panel = $('#inspector');
  const r = rowById(+panel.dataset.row);
  return r && panel.dataset.project === state.projectId ? r : null;
}

export function initInspector() {
  registerCommand('inspector:open', openInspectorFor);
  $('#btnDetail').onclick = () => {
    detailOpen = !detailOpen;
    renderInspector(true);
  };
  on('cursor', () => renderInspector());
  on('voice', () => renderInspector(true));
  on('types', () => renderInspector(true));

  const panel = $('#inspector');
  panel.addEventListener('click', async e => {
    if (e.target.closest('#closeDetail')) {
      detailOpen = false;
      return renderInspector();
    }
    if (e.target.closest('#locateDetail')) {
      const r = panelRow();
      if (r) revealRow(r.id, 'center');
      return;
    }
    const r = panelRow();
    if (!r) return;
    if (e.target.closest('#attachAsset')) {
      const pid = state.projectId;
      const paths = await native.pickAssets();
      if (pid !== state.projectId || !paths?.length) return;
      const res = addRefsToShot(r, paths);
      renderInspector(true);
      return toast(res.added.length ? `已添加 ${res.added.length} 个素材 · ⌘Z 可撤销` : '这些素材都已关联过');
    }
    if (e.target.closest('#attachFromLib')) return runCommand('assets:pick-from-project', r);
    if (e.target.closest('#relinkFolder')) return runCommand('assets:relink-folder');
    const roleBtn = e.target.closest('[data-role-usage]');
    if (roleBtn) {
      const role = roleBtn.dataset.role;
      const demoted = setUsageRole(r, +roleBtn.dataset.roleUsage, role);
      renderInspector(true);
      if (demoted)
        toast(
          demoted.length
            ? `已设为${ROLES[role]}，「${demoted.join('」「')}」改为备选（同一句只能有一个主画面）`
            : `已设为${ROLES[role]} · ⌘Z 可撤销`,
        );
      return;
    }
    if (e.target.closest('#autoRoles')) {
      const n = autoAssignRoles(r);
      renderInspector(true);
      if (n) toast(`已整理 ${n} 个素材的角色 · ⌘Z 可撤销`);
      return;
    }
    const vrBtn = e.target.closest('[data-vr-open]');
    if (vrBtn) return runCommand('video:open', +vrBtn.dataset.vrOpen);
    const remove = e.target.closest('[data-remove-usage]');
    if (remove) {
      removeUsage(r, +remove.dataset.removeUsage);
      return renderInspector(true);
    }
    const relocate = e.target.closest('[data-relocate-usage]');
    if (relocate) {
      runCommand('assets:relocate', r, +relocate.dataset.relocateUsage, () => renderInspector(true));
      return;
    }
    const clipBtn = e.target.closest('[data-clip-usage]');
    if (clipBtn) return runCommand('preview:usage', r, +clipBtn.dataset.clipUsage);
    const pvBtn = e.target.closest('[data-preview-usage]');
    if (pvBtn) return runCommand('preview:usage', r, +pvBtn.dataset.previewUsage);
    const sys = e.target.closest('[data-sys-open]');
    if (sys) {
      const error = await native.openAsset(sys.dataset.sysOpen);
      if (error) toast(error);
      return;
    }
    const retry = e.target.closest('[data-thumb-retry]');
    if (retry) return refreshThumb(retry.dataset.thumbRetry);
    const vr = e.target.closest('[data-voice-range]');
    if (vr) return runCommand('voice:play-shot', +vr.dataset.voiceRange);
    const sp = e.target.closest('[data-sync-preview]');
    if (sp) return runCommand('playthrough:shot', +sp.dataset.syncPreview);
    if (e.target.closest('#confirmReviewed')) {
      markReviewed(r);
      renderInspector(true);
    }
  });

  panel.addEventListener('focusin', e => {
    if (e.target.id === 'detailNote') session = { snapped: false };
  });
  panel.addEventListener('input', e => {
    const r = panelRow();
    if (!r) return;
    if (e.target.id === 'detailNote' && setShotNote(r, e.target.value, { session })) {
      clearTimeout(wsTimer);
      wsTimer = setTimeout(() => emit('workspace'), 250); // 停手后再刷侧栏 / 徽标
    }
  });
  panel.addEventListener('change', e => {
    const r = panelRow();
    if (!r) return;
    if (e.target.id === 'detailAssets' && setShotRefsFromText(r, e.target.value)) {
      panel.querySelector('.asset-list').innerHTML = inspectorAssets(r, { missing: missingPaths() });
      hydrateAssetCards();
    }
  });
}
