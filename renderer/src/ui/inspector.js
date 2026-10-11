/* 右侧「画面与素材」面板：画面描述 / 素材（角色、出现位置、片段）/ 这个画面对应的口播时间 / 视频候选入口。
   画面描述输入即保存；添加和移除素材集中在列表下方。
   角色和位置的改动只刷面板和素材卡，不重建整张表（长稿视口不跳）。 */
import { state, on, emit, update, rowById, types, timeline } from '../app/state.js';
import { setShotNote } from '../app/actions.js';
import {
  removeUsage,
  addRefsToShot,
  autoAssignRoles,
  swapPictures,
  setUsageLines,
  toggleAlt,
} from '../app/asset-actions.js';
import { usageList } from '../core/asset-model.js';
import { ROLES, shotMembers, usageSpan } from '../core/shots.js';
import { spanOf } from '../core/timeline.js';
import { fmtTc, fmtLen } from '../core/text.js';
import { layoutShot, circled } from '../core/shot-layout.js';
import { shotCoverage } from '../core/coverage.js';
import * as native from '../platform/native.js';
import { esc, toast } from './base/dom.js';
import { sharedScenes, assetName, orderedUsages, inspectorAssets } from './asset-html.js';
import { hydrateAssetCards, refreshThumb } from './asset-thumbs.js';
import { missingPaths } from './asset-files.js';
import { registerCommand, runCommand } from './base/commands.js';
import { openMenu, closePop, markPopAnchor, popOpenFor } from './base/popover.js';
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
  // 和素材卡片上的「需要 / 可用」同一套算法（core/coverage.js）
  const short = [];
  let videos = 0;
  for (const cov of shotCoverage(layout).values()) {
    if (cov.verdict === 'still' || cov.verdict === 'unknown') continue;
    videos++;
    if (cov.verdict === 'short')
      short.push(`${circled(cov.n)} 可用 ${fmtLen(cov.usable)}，需要 ${fmtLen(cov.need)}，差 ${fmtLen(cov.lack)}`);
  }
  const compare = short.length
    ? short.map(x => `<p class="voice-warn">${esc(x)}</p>`).join('')
    : videos
      ? '<p class="voice-ok">视频可用片段都够盖住各自要占的时间</p>'
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
  panel.innerHTML = `<div class="side-title">${members.length > 1 ? sharedScenes(state.rows).get(r.groupId)?.label : '第 ' + r.no + ' 句'}</div>
    <section class="detail-assets">
      <div class="asset-list-title">素材与片段<span class="info-tip" tabindex="0" title="${esc(ASSET_TIPS)}" aria-label="${esc(ASSET_TIPS)}">ⓘ</span><span class="spacer"></span>${voice.sync}</div>
      ${voice.meta}
      <div class="asset-list">${inspectorAssets(r, { missing: missingPaths() })}</div>
      <div class="detail-buttons"><button class="btn" id="attachAsset">添加素材</button><button class="btn" id="removeAsset" title="只解除关联，保留本地文件；⌘Z 可撤销"${usageList(r).length ? '' : ' disabled'}>移除素材</button><button class="btn" id="reworkShot" title="这个画面还缺镜头：写下要什么，生成返工单交给 AI 去找">再找一个…</button></div>
      ${(() => {
        const rw = members.find(m => m.rework && !m.rework.assetId)?.rework;
        return rw
          ? `<button class="detail-rework" id="reworkShotEdit" title="点开修改，或者不用找了"><b>待补</b><span>${esc(rw.note)}</span></button>`
          : '';
      })()}
    </section>
    <label class="detail-note-block"><span class="detail-label">${visual ? '画面描述' : '备注'}</span><textarea id="detailNote" rows="4" placeholder="${visual ? '画面里有什么？如何呈现？' : '给剪辑的备注'}">${esc(r.note || '')}</textarea></label>
`;
  hydrateAssetCards();
  markNoteClamp();
}
/* 画面描述和表格里一样：平时只露前 4 行（超出的末尾淡出），点进去编辑时展开全文 */
function markNoteClamp() {
  const note = $('#detailNote');
  if (!note) return;
  // 收起与淡出提示在同一帧完成，避免先露出完整底部、下一帧再盖上渐变。
  if (document.activeElement !== note) note.classList.toggle('clamped', note.scrollHeight > note.clientHeight + 2);
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

function openRemoveMenu(anchor, r) {
  if (popOpenFor(anchor)) return closePop();
  const usages = usageList(r);
  if (usages.length === 1) {
    removeUsage(r, 0);
    return renderInspector(true);
  }
  if (!usages.length) return;
  openMenu(
    anchor,
    '<div class="p-title">选择要移除的素材</div>' +
      orderedUsages(r)
        .map(({ u, index }) => {
          const asset = state.assets[u.assetId] || u;
          return `<div class="pop-item" data-remove-usage="${index}" data-remove-asset="${esc(u.assetId)}" data-remove-row="${r.id}" data-remove-project="${esc(state.projectId)}"><span class="main">${esc(asset.name || assetName(asset.path || '') || '未命名素材')}<span class="desc">${esc(ROLES[u.role] || '未分配')}</span></span></div>`;
        })
        .join(''),
  );
  markPopAnchor(anchor);
}

export function initInspector() {
  registerCommand('inspector:open', openInspectorFor);
  registerCommand('inspector:refresh', () => renderInspector(true));
  $('#btnDetail').onclick = () => {
    detailOpen = !detailOpen;
    renderInspector(true);
  };
  on('cursor', () => renderInspector());
  on('voice', () => renderInspector(true));
  on('types', () => renderInspector(true));
  on('durations', () => renderInspector()); // 读到了文件时长：卡片上的「文件 / 可用」补上数（正在输入时不打断）

  const panel = $('#inspector');
  document.addEventListener('click', e => {
    const remove = e.target.closest('[data-remove-asset]');
    if (!remove) return;
    const r = panelRow();
    closePop();
    if (panel.hidden || !r || r.id !== +remove.dataset.removeRow || state.projectId !== remove.dataset.removeProject)
      return;
    const index = usageList(r).findIndex(u => u.assetId === remove.dataset.removeAsset);
    if (index < 0) return;
    removeUsage(r, index);
    renderInspector(true);
  });
  panel.addEventListener('click', async e => {
    const r = panelRow();
    if (!r) return;
    if (e.target.closest('#reworkShot, #reworkShotEdit')) return runCommand('rework:edit', r);
    const rwBtn = e.target.closest('[data-rework-usage]');
    if (rwBtn) {
      const u = usageList(r)[+rwBtn.dataset.reworkUsage];
      if (u) runCommand('rework:edit', r, u.assetId);
      return;
    }
    if (e.target.closest('#attachAsset')) {
      const pid = state.projectId;
      const paths = await native.pickAssets();
      if (pid !== state.projectId || !paths?.length) return;
      const res = addRefsToShot(r, paths);
      renderInspector(true);
      return toast(
        res.added.length ? `已添加 ${res.added.length} 个素材 · ⌘Z 可撤销` : '这些素材都已关联过',
        null,
        res.added.length ? 'ok' : 'info',
      );
    }
    const removeButton = e.target.closest('#removeAsset');
    if (removeButton) {
      e.stopPropagation();
      return openRemoveMenu(removeButton, r);
    }
    const cell = e.target.closest('[data-line-usage]');
    if (cell) {
      const index = +cell.dataset.lineUsage,
        k = +cell.dataset.line;
      const u = usageList(r)[index];
      if (!u) return;
      const members = shotMembers(state.rows, r);
      const sp = usageSpan(members, u.assetId);
      const hadManual = members.some(m => usageList(m).some(x => x.at));
      let from = sp.from,
        to = sp.to;
      if (u.role === 'alt' || sp.empty) {
        // 备选的：点哪格都先放回上屏，还配原来那几句（原来没配句子就配这一句）
        if (sp.empty) from = to = k;
      } else if (k >= from && k <= to) {
        if (from === to) {
          if (!hadManual) return toast('至少要配一句；不想用它就点「备选」', null, 'warn');
        } else if (k === from) from++;
        else if (k === to) to--;
        else from = to = k;
      } else if (k < from) from = k;
      else to = k;
      setUsageLines(r, index, from, to);
      renderInspector(true);
      if (hadManual) toast('已改回按句子排（手动拖过的秒数清掉了） · ⌘Z 可撤销', null, 'ok');
      return;
    }
    const altBtn = e.target.closest('[data-alt-usage]');
    if (altBtn) {
      const role = toggleAlt(r, +altBtn.dataset.altUsage);
      renderInspector(true);
      if (role) toast(role === 'alt' ? '已放进备选，不上屏 · ⌘Z 可撤销' : '已放回上屏 · ⌘Z 可撤销', null, 'ok');
      return;
    }
    const swapBtn = e.target.closest('[data-swap-a]');
    if (swapBtn) {
      if (swapPictures(r, swapBtn.dataset.swapA, swapBtn.dataset.swapB)) {
        renderInspector(true);
        toast('已调换两个画面的位置 · ⌘Z 可撤销', null, 'ok');
      }
      return;
    }
    if (e.target.closest('#autoRoles')) {
      const n = autoAssignRoles(r);
      renderInspector(true);
      if (n) toast(`已整理 ${n} 个素材的角色 · ⌘Z 可撤销`, null, 'ok');
      return;
    }
    const vrBtn = e.target.closest('[data-vr-open]');
    if (vrBtn) return runCommand('video:open', +vrBtn.dataset.vrOpen);
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
      if (error) toast(error, null, 'error');
      return;
    }
    const retry = e.target.closest('[data-thumb-retry]');
    if (retry) return refreshThumb(retry.dataset.thumbRetry);
    const vr = e.target.closest('[data-voice-range]');
    if (vr) return runCommand('voice:play-shot', +vr.dataset.voiceRange);
    const sp = e.target.closest('[data-sync-preview]');
    if (sp) return runCommand('playthrough:shot', +sp.dataset.syncPreview);
  });

  panel.addEventListener('focusin', e => {
    if (e.target.id === 'detailNote') session = { snapped: false };
  });
  panel.addEventListener('focusout', e => {
    if (e.target.id === 'detailNote') markNoteClamp(); // 编辑完收回 4 行
  });
  panel.addEventListener('input', e => {
    const r = panelRow();
    if (!r) return;
    if (e.target.id === 'detailNote' && setShotNote(r, e.target.value, { session })) {
      clearTimeout(wsTimer);
      wsTimer = setTimeout(() => emit('workspace'), 250); // 停手后再刷侧栏 / 徽标
    }
  });
}
