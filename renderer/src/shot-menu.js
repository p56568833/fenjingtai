/* 共用画面范围调整入口（原文 / 表格两个视图同一套菜单、同一套名称）：
   共用区域「···」= 将下一句加入这个画面 / 将最后一句移出这个画面 / 解除共用
   组内句子「···」= 从这句开始使用另一个画面（低频操作收在这里，不在每句旁常驻一排按钮）
   有差异先展示差异和处理方式，不悄悄覆盖信息。 */
import { state, rowById } from './state.js';
import { esc, toast, confirmModal, fmtTime } from './util.js';
import { TYPES } from './types.js';
import { openMenu, closePop, markPopAnchor } from './popover.js';
import { shotMembers, groupExtendNextPlan, groupSplitAtPlan } from './production.js';
import { extendGroupNextAction, dropGroupLastAction, splitGroupAtAction, ungroupAction } from './actions.js';
import { usageList, assetUsageRefs, checkClip, addRefsToShot, relocateAsset, invalidateProbe } from './assets.js';
import { openAssetPicker } from './asset-picker.js';
import { probeDuration } from './preview.js';
import { clearPreviewCache, refreshThumb } from './visuals.js';
import { pickAssets, pickOneAsset } from './native-bridge.js';

const $ = s => document.querySelector(s);
const actItem = (act, ids, label, desc, { disabled = false, danger = false } = {}) =>
  `<div class="pop-item${danger ? ' danger' : ''}${disabled ? ' disabled' : ''}" data-shot-act="${act}" ${ids}>
    <span class="main"><span>${label}</span>${desc ? `<span class="desc">${esc(desc)}</span>` : ''}</span></div>`;

/* 行「···」：常用操作（删除 ✕）留在行上，低频的收进来 */
export function openRowMenu(anchor, rowId) {
  const r = rowById(rowId);
  if (!r || r.kind !== 'line') return;
  const ids = `data-row-id="${r.id}"`;
  let html = `<div class="p-title">第 ${r.no} 句</div>`;
  html += actItem('detail', ids, '画面与素材…', '描述、素材、制作状态');
  html += actItem('add-file', ids, '添加素材（文件）', '从访达选，一个或多个');
  html += actItem('add-lib', ids, '从本项目素材添加', '用过一次的文件再关联');
  if (r.groupId) {
    const plan = groupSplitAtPlan(state.rows, r.groupId, r.id);
    html += '<div class="pop-sep"></div>';
    html += actItem(
      'split-at',
      `data-row-id="${r.id}" data-gid="${r.groupId}"`,
      '从这句开始使用另一个画面',
      plan.ok ? '把共用画面拆成前后两个' : plan.reason,
      { disabled: !plan.ok },
    );
  }
  openMenu(anchor, html);
  markPopAnchor(anchor);
}

/* 共用区域「···」：范围调整三件套 */
export function openGroupMenu(anchor, groupId) {
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
    `data-gid="${groupId}"`,
    '将下一句加入这个画面',
    plan.ok ? `下一句是第 ${plan.next.no} 句` : plan.reason,
    { disabled: !plan.ok },
  );
  html += actItem(
    'drop-last',
    `data-gid="${groupId}"`,
    '将最后一句移出这个画面',
    `第 ${last.no} 句恢复独立画面，保留描述、素材和片段`,
  );
  html += '<div class="pop-sep"></div>';
  html += actItem('ungroup', `data-gid="${groupId}"`, '解除共用', '各句恢复独立画面，保留现有信息', { danger: true });
  openMenu(anchor, html);
  markPopAnchor(anchor);
}

/* 差异确认：把「组内 / 该句 / 处理方式」摊开，确认后才动手 */
function showDiffModal(title, diffs, onOk) {
  const val = (d, side) => (d.field === '类型' ? TYPES[d[side]]?.full || '未标注' : d[side] || '（空）');
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
export async function relocateFlow(row, index) {
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
      const newPath = await pickOneAsset();
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
          toast(`已重新定位，${n} 处引用修好${res && res.adjusted ? ` · ${res.adjusted} 处片段待调整` : ''}`);
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
    toast(item.querySelector('.desc')?.textContent || '这个操作现在不可用');
    return;
  }
  closePop();
  const row = rowById(rowId);

  if (act === 'detail') {
    import('./workspace.js').then(m => m.openInspectorFor(rowId));
    return;
  }
  if (act === 'add-file') {
    pickAssets().then(paths => {
      if (!paths || !paths.length) return;
      const res = addRefsToShot(row, paths);
      toast(res.added.length ? `已添加 ${res.added.length} 个素材 · ⌘Z 可撤销` : '这些素材都已关联过');
    });
    return;
  }
  if (act === 'add-lib') {
    openAssetPicker(row);
    return;
  }

  if (act === 'extend-next') {
    const plan = groupExtendNextPlan(state.rows, groupId);
    if (!plan.ok) {
      toast(plan.reason);
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

export function initShotMenu() {
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
      const more = e.target.closest('[data-row-more]');
      if (more) {
        e.stopPropagation();
        openRowMenu(more, +more.dataset.rowMore);
        return;
      }
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
