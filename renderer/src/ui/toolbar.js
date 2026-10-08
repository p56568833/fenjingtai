/* 选区操作条：勾选 / Shift / ⌘ 选了句子时从表格底部浮出来（已选 N 句 · 共用一个画面 · 解除共用 · 取消）。
   多选句子不需要单独的模式按钮：悬停行首就有勾选框，Shift 点选连续、⌘ 点选跳选。
   state.multiMode（逐句点选模式）仍保留给原文视图的键盘勾选和自测用，界面上不再露出开关。 */
import { state, update, rowById, currentSelection, checkedIds, types } from '../app/state.js';
import { groupSelectionAction, ungroupAction, annotateSelection } from '../app/actions.js';
import { validGroup, sameGroupSelection } from '../core/shots.js';
import { confirmModal, toast, esc } from './dom.js';
import { closePop } from './popover.js';
import { roll } from './motion.js';

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
  const wasShown = !count.hidden;
  count.hidden = !show;
  // 「已选 N 句」：数字跟着增减滚动
  let n = count.querySelector('.sel-n');
  if (!n) {
    count.innerHTML = '已选 <span class="sel-n"></span> 句';
    n = count.querySelector('.sel-n');
  }
  if (wasShown && show) roll(n, String(ids.length));
  else {
    n.textContent = String(ids.length);
    n.dataset.moRoll = String(ids.length);
  }
  const groupBtn = $('#btnGroup');
  const already = ids.length > 1 && sameGroupSelection(state.rows, ids);
  const ok = validGroup(state.rows, ids) && !already;
  const why = already ? '这些句子已经在同一个共用画面里' : ok ? '' : groupBlockReason(ids);
  groupBtn.disabled = !ok;
  groupBtn.title = ok ? '让这几句共用一个画面（原文逐句保留）' : why;
  groupBtn.hidden = !show || already || ids.length < 2 || !ok; // 不能共用时不摆一个灰按钮，直接写原因
  // 不能共用时直接在操作条上说原因，不用悬停才知道
  const hint = $('#selHint');
  hint.hidden = !show || already || ok || ids.length < 2;
  hint.textContent = why;
  renderSelTypes(show && ids.length > 0);
  $('#btnUngroup').hidden = !groups.size;
  $('#selectTools').hidden = !show;
  document.body.classList.toggle('has-select-tools', show);
}

/* 为什么不能共用：跨章节 / 不连续 */
function groupBlockReason(ids) {
  if (ids.length < 2) return 'Shift 点选或拖选连续两句以上才能共用';
  const idx = ids.map(id => state.rows.findIndex(r => r.id === id)).sort((a, b) => a - b);
  const span = state.rows.slice(idx[0], idx[idx.length - 1] + 1);
  if (span.some(r => r.kind === 'section')) return '跨了章节，不能共用一个画面';
  return '选的句子不连续，不能共用一个画面';
}

/* 操作条上的类型按钮：鼠标也能批量标注（数字键照常可用） */
let typesKey = '';
function renderSelTypes(show) {
  const box = $('#selTypes');
  box.hidden = !show;
  if (!show) return;
  const list = types().list;
  const key = list.map(t => t.id + t.color + t.label).join('|');
  if (key === typesKey) return;
  typesKey = key;
  box.innerHTML =
    list
      .map(
        (t, i) =>
          `<button class="sel-type" data-sel-type="${esc(t.id)}" title="标成「${esc(t.full)}」（${i + 1}）"><span class="dot" style="background:${t.color}"></span>${esc(t.label)}</button>`,
      )
      .join('') + `<button class="sel-type clear" data-sel-type="" title="清除这些句子的标注（⌫）">清除</button>`;
}

export function initToolbar() {
  $('#selTypes').addEventListener('click', e => {
    const b = e.target.closest('[data-sel-type]');
    if (!b) return;
    annotateSelection(b.dataset.selType || null);
  });
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
