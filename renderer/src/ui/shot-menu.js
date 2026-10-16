import { viewState } from '../app/view-state.js';
/* 共用画面范围调整入口（原文 / 表格两个视图同一套菜单、同一套名称）：
   共用区域「···」= 将下一句加入这个画面 / 将最后一句移出这个画面 / 从选中的这句开始使用另一个画面 / 解除共用
   有差异先展示差异和处理方式，不悄悄覆盖信息。 */
import { state } from '../app/state.js';
import { types } from '../app/project-queries.js';
import { extendGroupNextAction, dropGroupLastAction, splitGroupAtAction, ungroupAction } from '../app/actions.js';
import { relocateAsset, invalidateProbe, relinkByNames } from '../app/asset-actions.js';
import { shotMembers } from '../core/shots.js';
import { groupExtendNextPlan, groupSplitAtPlan } from '../core/shot-groups.js';
import { usageList, assetUsageRefs, checkClip } from '../core/asset-model.js';
import { fmtTime } from '../core/text.js';
import * as native from '../platform/native.js';
import { esc, toast, confirmModal } from './base/dom.js';
import { openMenu, closePop, markPopAnchor } from './base/popover.js';
import { clearPreviewCache } from './base/media.js';
import { refreshThumb } from './asset-thumbs.js';
import { missingPaths } from './asset-files.js';
import { registerCommand } from './base/commands.js';
import { probeDuration } from './base/media.js';

const $ = s => document.querySelector(s);
const actItem = (act, ids, label, desc, { disabled = false, danger = false } = {}) =>
  `<div class="pop-item${danger ? ' danger' : ''}${disabled ? ' disabled' : ''}" data-shot-act="${act}" ${ids}>
    <span class="main"><span>${label}</span>${desc ? `<span class="desc">${esc(desc)}</span>` : ''}</span></div>`;

/* 共用区域「···」：范围调整（加入下一句 / 移出最后一句 / 从选中的这句拆开）和解除共用 */
function openGroupMenu(anchor, groupId) {
  const members = shotMembers(
    state.rows,
    state.rows.find(r => r.groupId === groupId),
  );
  if (members.length < 2) return;
  const first = members[0],
    last = members[members.length - 1];
  const plan = groupExtendNextPlan(state.rows, groupId);
  let html = `<div class="p-title">共用画面 · 第 ${first.no}–${last.no} 句</div>`;
  html += actItem(
    'extend-next',
    `data-gid="${esc(groupId)}"`,
    '将下一句加入这个画面',
    plan.ok ? `下一句是第 ${plan.next.no} 句` : plan.reason,
    { disabled: !plan.ok },
  );
  html += actItem(
    'drop-last',
    `data-gid="${esc(groupId)}"`,
    '将最后一句移出这个画面',
    `第 ${last.no} 句恢复独立画面，保留描述、素材和片段`,
  );
  // 从这句拆开：拿当前选中的句子（组里第二句到倒数第二句才行）
  const sel = members.find(m => m.id === viewState.sel);
  const split = sel ? groupSplitAtPlan(state.rows, groupId, sel.id) : null;
  html += actItem(
    'split-at',
    `data-row-id="${sel?.id ?? ''}" data-gid="${esc(groupId)}"`,
    sel ? `从第 ${sel.no} 句开始使用另一个画面` : '从选中的句子开始使用另一个画面',
    !sel ? '先点选这个画面里的某一句' : split.ok ? '把共用画面拆成前后两个' : split.reason,
    { disabled: !split?.ok },
  );
  html += '<div class="pop-sep"></div>';
  html += actItem('ungroup', `data-gid="${esc(groupId)}"`, '解除共用', '各句恢复独立画面，保留现有信息', {
    danger: true,
  });
  openMenu(anchor, html);
  markPopAnchor(anchor);
}

/* 差异确认：把「组内 / 该句 / 处理方式」摊开，确认后才动手 */
function showDiffModal(title, diffs, onOk) {
  const val = (d, side) => (d.field === '类型' ? types().full(d[side] || null) : d[side] || '（空）');
  $('#diffTitle').textContent = title;
  $('#diffBody').innerHTML =
    `<p class="diff-intro">这句和共用画面的现有信息有差异，会这样处理（不会悄悄丢掉信息）：</p>` +
    diffs
      .map(
        d => `<div class="diff-row">
      <b>${esc(d.field)}</b>
      <span>组内：${esc(val(d, 'group'))}</span>
      <span>该句：${esc(val(d, 'other'))}</span>
      <em>→ ${esc(d.action)}</em>
    </div>`,
      )
      .join('');
  $('#diffMask').classList.add('show');
  $('#diffOk').onclick = () => {
    $('#diffMask').classList.remove('show');
    onOk();
  };
  $('#diffCancel').onclick = () => $('#diffMask').classList.remove('show');
}

/* 重新定位失联文件：先说清有几处引用，选新文件后一起修好；时长不兼容只标记不改时间 */
async function relocateFlow(row, index, done) {
  const u = usageList(row)[index];
  const asset = u && (state.assets || {})[u.assetId];
  if (!asset) return;
  const refs = assetUsageRefs(state.rows, asset.id);
  const n = refs.length;
  confirmModal(
    '重新定位素材',
    `「${asset.name}」在本项目有 ${n} 处引用。选好新文件后这 ${n} 处一起修好；原文件名、原路径和片段设置都会保留可查。`,
    '选择新文件',
    async () => {
      const newPath = await native.pickOneAsset();
      if (!newPath) return;
      const duration = await probeDuration(newPath);
      let warn = '';
      if (duration != null) {
        let bad = 0;
        for (const ref of refs)
          for (const x of usageList(ref.row))
            if (x.assetId === asset.id && x.clip && checkClip(x.clip, duration)) bad++;
        if (bad)
          warn = `\n\n有 ${bad} 处片段范围和新文件时长（${fmtTime(duration)}）不兼容，会标记「待调整」，时间不会被改动。`;
      }
      confirmModal(
        '用这个文件替换？',
        `${newPath}\n\n${n} 处引用同步修复。移除关联从不删除本地文件。${warn}`,
        '替换',
        () => {
          const res = relocateAsset(asset.id, newPath, { durationSec: duration });
          invalidateProbe();
          clearPreviewCache();
          refreshThumb(newPath);
          toast(
            `已重新定位，${n} 处引用修好${res && res.adjusted ? ` · ${res.adjusted} 处片段待调整` : ''}`,
            null,
            'ok',
          );
          done?.();
        },
      );
    },
  );
}

/* 菜单动作分发（capture，抢在弹层「点外面关闭」之前） */
function onShotAction(item) {
  const act = item.dataset.shotAct;
  const rowId = +item.dataset.rowId;
  const groupId = item.dataset.gid;
  if (item.classList.contains('disabled')) {
    closePop();
    toast(item.querySelector('.desc')?.textContent || '这个操作现在不可用', null, 'info');
    return;
  }
  closePop();

  if (act === 'extend-next') {
    const plan = groupExtendNextPlan(state.rows, groupId);
    if (!plan.ok) {
      toast(plan.reason, null, 'info');
      return;
    }
    if (plan.diffs.length) showDiffModal('将下一句加入这个画面', plan.diffs, () => extendGroupNextAction(groupId));
    else extendGroupNextAction(groupId);
    return;
  }
  if (act === 'drop-last') {
    dropGroupLastAction(groupId);
    return;
  }
  if (act === 'split-at') {
    splitGroupAtAction(groupId, rowId);
    return;
  }
  if (act === 'ungroup') {
    const members = shotMembers(
      state.rows,
      state.rows.find(r => r.groupId === groupId),
    );
    ungroupAction(members.map(r => r.id));
    return;
  }
}

/* 按文件夹批量找回失联素材：选一个文件夹，按文件名匹配（同名多个时不猜） */
async function relinkFolderFlow() {
  const missingIds = Object.values(state.assets || {})
    .filter(a => missingPaths().has(a.path))
    .map(a => a.id);
  if (!missingIds.length) return toast('没有失联的素材', null, 'info');
  const files = await native.pickFolderFiles();
  if (!files) return;
  const n = relinkByNames(missingIds, files);
  clearPreviewCache();
  toast(
    n
      ? `已按文件名找回 ${n} / ${missingIds.length} 个失联素材 · ⌘Z 可撤销`
      : '这个文件夹里没有同名文件（可以换个文件夹，或逐个「重新定位」）',
    null,
    n ? 'ok' : 'warn',
  );
}

export function initShotMenu() {
  registerCommand('assets:relocate', relocateFlow);
  registerCommand('assets:relink-folder', relinkFolderFlow);
  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <div class="modal-mask" id="diffMask">
      <div class="modal wide">
        <h3 id="diffTitle"></h3>
        <div id="diffBody"></div>
        <div class="m-btns"><button class="btn ghost" id="diffCancel">取消</button><button class="btn primary" id="diffOk">按此处理</button></div>
      </div>
    </div>`,
  );
  document.addEventListener(
    'click',
    e => {
      const gmore = e.target.closest('[data-group-more]');
      if (gmore) {
        e.stopPropagation();
        openGroupMenu(gmore, gmore.dataset.groupMore);
        return;
      }
      const item = e.target.closest && e.target.closest('[data-shot-act]');
      if (item && document.querySelector('.popover')) onShotAction(item);
    },
    true,
  );
}
