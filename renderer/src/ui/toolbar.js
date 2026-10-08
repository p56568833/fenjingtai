/* 选区操作条：勾选 / Shift / ⌘ 选了句子时从表格底部浮出来（已选 N 句 · 共用一个画面 · 解除共用 · 取消）。
   多选句子不需要单独的模式按钮：悬停行首就有勾选框，Shift 点选连续、⌘ 点选跳选。
   state.multiMode（逐句点选模式）仍保留给原文视图的键盘勾选和自测用，界面上不再露出开关。 */
import { state, update, rowById, currentSelection, checkedIds } from '../app/state.js';
import { groupSelectionAction, ungroupAction } from '../app/actions.js';
import { validGroup, sameGroupSelection } from '../core/shots.js';
import { confirmModal, toast } from './dom.js';
import { closePop } from './popover.js';

const $ = s => document.querySelector(s);

export function setMultiMode(on) {
  state.multiMode = on;
  state.sel = null;
  state.multi = null;
  closePop();
  update('selection');
}

export function clearSelection() {
  if (state.multiMode) return setMultiMode(false);
  if (!state.multi) return;
  state.multi = null;
  closePop();
  update('selection');
}

export function renderToolbar() {
  const ids = currentSelection().filter(id => rowById(id)?.kind === 'line');
  const ticked = checkedIds().length;
  const groups = new Set(ids.map(id => rowById(id).groupId).filter(Boolean));
  const show = ids.length > 1 || ticked > 0 || state.multiMode;
  const count = $('#selCount');
  count.hidden = !show;
  count.textContent = `已选 ${ids.length} 句`;
  const groupBtn = $('#btnGroup');
  const already = ids.length > 1 && sameGroupSelection(state.rows, ids);
  const ok = validGroup(state.rows, ids) && !already;
  groupBtn.disabled = !ok;
  groupBtn.title = already
    ? '这些句子已经在同一个共用画面里'
    : ok
      ? '选择同一章节内连续的两句或更多，再共用一个画面'
      : ids.length < 2
        ? 'Shift 点选或拖选连续两句以上才能共用'
        : '只能共用同一章节里连续的句子';
  groupBtn.hidden = !show || already;
  $('#btnUngroup').hidden = !groups.size;
  $('#selectTools').hidden = !show;
  document.body.classList.toggle('has-select-tools', show);
}

export function initToolbar() {
  $('#btnClearSel').addEventListener('click', clearSelection);
  $('#btnGroup').addEventListener('click', () => {
    const ids = [...currentSelection()];
    if (!validGroup(state.rows, ids)) return;
    if (sameGroupSelection(state.rows, ids)) return toast('这些句子已经在同一个共用画面里');
    confirmModal(
      '让这几句话共用一个画面？',
      '原文仍逐句保留，画面描述和素材共用；类型采用选区中第一个已标类型。有差异的描述会合并保留，以后修改会同步到这些句子，可随时解除或调整范围。',
      '共用一个画面',
      () => groupSelectionAction(ids),
      { danger: false },
    );
  });
  $('#btnUngroup').addEventListener('click', () => ungroupAction(currentSelection()));
}
