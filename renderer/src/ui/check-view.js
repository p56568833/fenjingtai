/* 勾选视图交互：选中句子即弹标注卡（选 A / B roll 四类、写批注），卡跟选区走；
   拖选几句后按 1-5 / 点顶部色块＝批量标；批注以红字显示在句子下方，点红字可改。
   数据改动统一走 actions（快照 + 落盘 + 原地刷新）。 */
import { state, rowById, visibleLineIds, currentSelection, toggleLineSelection, types } from '../app/state.js';
import { markSentences, setNote, splitGroupAtAction } from '../app/actions.js';
import { groupSplitAtPlan } from '../core/shots.js';
import { renderSelectionOnly } from './render.js';
import { toast, composing, esc, readEditable } from './dom.js';
import { openMenu, closePop, markPopAnchor, popEl } from './popover.js';
import { typeMenuItems } from './type-view.js';
import { runCommand } from './commands.js';

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function rangeIds(a, b) {
  const ids = visibleLineIds();
  const i = ids.indexOf(a),
    j = ids.indexOf(b);
  if (i < 0 || j < 0) return [b];
  const [s, t] = i < j ? [i, j] : [j, i];
  return ids.slice(s, t + 1);
}

/* 把选中句带到视口 */
function revealCursor() {
  renderSelectionOnly();
  const el = document.querySelector(`.as[data-id="${state.sel}"]`);
  el && el.scrollIntoView({ block: 'nearest' });
}
function setCursor(id, { atMouse = false } = {}) {
  state.multi = null;
  state.sel = id;
  revealCursor();
  popCardForSelection({ atMouse });
}
const selectedLines = () =>
  currentSelection().filter(id => {
    const r = rowById(id);
    return r && r.kind === 'line';
  });

/* ── 拖选 ── */
let sweep = null; // {startId, lastId, moved}
let dragClick = false; // 拖选松手后浏览器补发的合成 click：吃掉，免得把刚弹的卡当「点外面」关掉

/* ── 标注卡：选中即弹，跟选区走（悬停延时那套已删）。多选时卡作用于整组 ── */
function selectionCardHTML() {
  const ids = selectedLines();
  const rs = ids.map(rowById).filter(Boolean);
  const head = rs.length > 1 ? `选中 ${rs.length} 句` : `第 ${rs[0]?.no || ''} 句`;
  const all = t => rs.length > 0 && rs.every(r => r.type === t);
  let items = `<div class="p-title">${head}</div>`;
  items += typeMenuItems('data-ck-t', all);
  items += `<div class="pop-sep"></div><div class="pop-item" data-ck-t=""><span class="k">0</span><span>擦除标注</span>${rs.every(r => !r.type) ? '<span class="chk">✓</span>' : ''}</div>`;
  if (rs.length === 1) {
    const r0 = rs[0];
    items += `<div class="pop-item" data-ck-note="${ids[0]}"><span class="k"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></span><span class="main"><span>${r0.note ? '修改批注' : '写批注'}</span>${r0.note ? `<span class="desc">${esc(trunc(r0.note, 30))}</span>` : ''}</span></div>`;
    items += `<div class="pop-item" data-ck-detail="${ids[0]}"><span class="k">▣</span><span class="main"><span>画面与素材…</span><span class="desc">描述、素材与片段（右侧面板）</span></span></div>`;
    if (r0.groupId) {
      const plan = groupSplitAtPlan(state.rows, r0.groupId, r0.id);
      items += `<div class="pop-item${plan.ok ? '' : ' disabled'}" data-ck-split="${ids[0]}" data-gid="${esc(r0.groupId)}"><span class="k">⑂</span><span class="main"><span>从这句开始使用另一个画面</span>${plan.ok ? '<span class="desc">把共用画面拆成前后两个</span>' : `<span class="desc">${esc(plan.reason)}</span>`}</span></div>`;
    }
  }
  return items;
}

/* 卡跟选区走：鼠标选的就弹在光标旁（跟手），键盘换句时锚在句子下方 */
function popCardForSelection({ atMouse = false } = {}) {
  if (state.view !== 'check' || state.sel == null) return;
  const el = document.querySelector(`.as[data-id="${state.sel}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  openMenu(el, selectionCardHTML(), atMouse ? { atMouse: true } : { pos: { x: r.left, y: r.bottom + 8 } });
  markPopAnchor(el);
  popEl._ids = selectedLines();
  popEl.classList.add('hovercard');
}

/* ── 批注编辑器：句子下方就地一行，Enter / 失焦保存，Esc 取消 ──
   编辑时把原红字行藏起来（不然同一句话下面挂两行红字），收场时再放出来 */
function restoreNoteLine(id) {
  const orig = document.querySelector(`.as-note[data-note="${id}"]`);
  if (orig) orig.style.display = '';
}
function openNoteEditor(id) {
  document.querySelectorAll('.as-note-edit').forEach(commitNote);
  const span = document.querySelector(`.as[data-id="${id}"]`);
  if (!span) return;
  const passage = span.closest('.shared-passage');
  if (passage) id = +passage.dataset.noteOwner;
  const r = rowById(id);
  const orig = document.querySelector(`.as-note[data-note="${id}"]`);
  if (orig) orig.style.display = 'none';
  const ed = document.createElement('span');
  ed.className = 'as-note as-note-edit';
  ed.contentEditable = 'plaintext-only';
  ed.spellcheck = false;
  ed.dataset.edit = String(id);
  ed.dataset.ph = '输入画面批注，回车保存…';
  ed.textContent = r?.note || '';
  if (passage) passage.append(ed);
  else span.after(ed);
  ed.focus();
  const range = document.createRange();
  range.selectNodeContents(ed);
  range.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(range);
}
function commitNote(ed) {
  if (ed._done || !ed.isConnected) return; // remove() 会同步触发 focusout 再进来一次，得挡住
  ed._done = true;
  const id = +ed.dataset.edit;
  const txt = readEditable(ed).trim();
  try {
    ed.remove();
  } catch (err) {
    /* 节点正在摘离时 remove 可能报错，此时它已经不在文档里 */
  }
  restoreNoteLine(id);
  setNote(id, txt);
}

/* ── 拖选 ── */
export function initCheck() {
  const rows = document.querySelector('#rows');

  rows.addEventListener('mousedown', e => {
    if (state.view !== 'check') return;
    if (e.target.closest('[data-detail]')) return;
    dragClick = false;
    const el = e.target.closest('.as');
    if (!el) {
      // 点空白：取消选中（虚线一起消失），卡由全局点击关闭器收
      if (state.sel != null || state.multi) {
        state.sel = null;
        state.multi = null;
        renderSelectionOnly();
      }
      closePop();
      return;
    }
    e.preventDefault(); // 拖选不能带出原生文字选区
    const id = +el.dataset.id;
    if (state.multiMode) {
      toggleLineSelection(id);
      closePop();
      renderSelectionOnly();
      return;
    }
    if (e.shiftKey && state.sel != null && state.sel !== id) {
      state.multi = rangeIds(state.sel, id);
      state.sel = id;
      revealCursor();
      popCardForSelection({ atMouse: true });
      return;
    }
    sweep = { startId: id, lastId: id, moved: false };
    setCursor(id, { atMouse: true });
  });

  rows.addEventListener('mouseover', e => {
    if (state.view !== 'check' || !sweep) return;
    const el = e.target.closest('.as');
    if (!el) return;
    const id = +el.dataset.id;
    if (id !== sweep.lastId) {
      closePop(); // 一动就是拖选：卡收起，拖完再弹
      sweep.lastId = id;
      sweep.moved = true;
      state.multi = rangeIds(sweep.startId, id);
      state.sel = sweep.startId;
      renderSelectionOnly();
    }
  });

  document.addEventListener('mouseup', () => {
    if (sweep) {
      dragClick = sweep.moved;
      if (sweep.moved) popCardForSelection({ atMouse: true }); // 拖完整组，卡弹在松手处
      sweep = null;
    }
  });
  // 抢在 popover 的「点外面关闭」之前吃掉拖选的合成 click
  document.addEventListener(
    'click',
    e => {
      if (dragClick) {
        dragClick = false;
        e.stopPropagation();
      }
    },
    true,
  );
  window.addEventListener('blur', () => {
    sweep = null;
    closePop();
  });

  // 空项目：粘贴整篇文章；点红字批注 → 就地改
  rows.addEventListener('click', e => {
    const noteEl = e.target.closest('.as-note');
    if (noteEl && !noteEl.classList.contains('as-note-edit')) {
      openNoteEditor(+noteEl.dataset.note);
      return;
    }
    if (e.target.closest('[data-ck-paste]')) runCommand('import:paste');
  });

  // 标注卡上的菜单项（capture 抢在 popover 外点关闭之前处理）；卡记录的 _ids 就是弹卡时的选区
  document.addEventListener(
    'click',
    e => {
      if (!popEl || !popEl.classList.contains('hovercard')) return;
      const tItem = e.target.closest && e.target.closest('[data-ck-t]');
      if (tItem) {
        const ids = popEl._ids || [];
        closePop();
        if (ids.length) markSentences(ids, tItem.dataset.ckT || null);
        return;
      }
      const nItem = e.target.closest && e.target.closest('[data-ck-note]');
      if (nItem) {
        closePop();
        openNoteEditor(+nItem.dataset.ckNote);
        return;
      }
      const dItem = e.target.closest && e.target.closest('[data-ck-detail]');
      if (dItem) {
        closePop();
        runCommand('inspector:open', +dItem.dataset.ckDetail);
        return;
      }
      const sItem = e.target.closest && e.target.closest('[data-ck-split]');
      if (sItem) {
        closePop();
        if (sItem.classList.contains('disabled')) {
          toast(sItem.querySelector('.desc')?.textContent || '现在不能拆分');
          return;
        }
        splitGroupAtAction(sItem.dataset.gid, +sItem.dataset.ckSplit);
      }
    },
    true,
  );

  // 批注编辑器键盘：Enter 保存 / Esc 取消（capture 先于全局键盘）
  rows.addEventListener(
    'keydown',
    e => {
      const ed = e.target.closest && e.target.closest('.as-note-edit');
      if (!ed) return;
      e.stopPropagation();
      if (composing(e)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        commitNote(ed);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        ed._done = true; // 先标记：remove 会同步触发 focusout，不能让它把没保存的输入写进去
        ed.remove();
        restoreNoteLine(+ed.dataset.edit);
      }
    },
    true,
  );
  rows.addEventListener('focusout', e => {
    const ed = e.target.closest && e.target.closest('.as-note-edit');
    if (ed) commitNote(ed);
  });
}

/* 勾选视图的键盘：方向键挪光标，1-5 / 0 作用于当前选中（拖选后批量），⌫ 擦除。
   返回 true 表示按键已消费。 */
export function handleCheckKey(e) {
  if (state.multiMode && (e.key === ' ' || e.key === 'Enter')) {
    const target = e.target.closest?.('.as');
    if (target) {
      e.preventDefault();
      toggleLineSelection(+target.dataset.id);
      renderSelectionOnly();
      return true;
    }
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const ids = visibleLineIds();
    if (!ids.length) return true;
    let i = ids.indexOf(state.sel);
    i =
      i === -1
        ? e.key === 'ArrowDown'
          ? 0
          : ids.length - 1
        : Math.min(ids.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
    setCursor(ids[i]);
    return true;
  }
  if (types().isTypeKey(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const ids = selectedLines();
    if (!ids.length) return true;
    closePop(); // 卡上的 ✓ 已经过时，收起；选中没变所以不再重弹
    markSentences(ids, types().keyToType(e.key));
    return true;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    if (e.metaKey || e.ctrlKey) return false; // ⌘⌫ 删除句子，交给全局键盘（两个视图一致）
    e.preventDefault();
    const ids = selectedLines();
    if (ids.length) {
      closePop();
      markSentences(ids, null);
    }
    return true;
  }
  if (e.key === 'Enter') {
    e.preventDefault(); // 阅读视图没有备注框可跳：Enter 就是「下一句」
    const all = visibleLineIds();
    const next = all[all.indexOf(state.sel) + 1];
    if (next != null) setCursor(next);
    return true;
  }
  if (/^[1-9]$/.test(e.key)) {
    e.preventDefault();
    return true;
  } // 没有对应类型的数字键，别穿透到表格逻辑
  return false;
}
