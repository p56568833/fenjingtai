/* 章节管理：点章节行弹菜单（改名 / 插入新章节 / 只删标题 / 删整节），双击章节名直接改名；
   表格 / 勾选两个视图共用，数据操作全在 actions.js。 */
import { state, rowById } from './state.js';
import { insertSectionWithSentence, deleteSectionHeader, deleteSectionAll, sectionSentenceCount } from './actions.js';
import { persist } from './storage.js';
import { snapshot } from './undo.js';
import { esc, toast, confirmModal, composing } from './util.js';
import { openMenu, closePop, popOpenFor, markPopAnchor } from './popover.js';
import { startEdit } from './edit.js';

/* ── 行内改名：进入即全选，Enter / 失焦保存，Esc 还原。打字过程不写数据，提交时才快照 ── */
let ren = null; // {id, el, baseline}

function startRename(nameEl, id) {
  const r = rowById(id);
  if (!r || r.kind !== 'section' || (ren && ren.el === nameEl)) return;
  commitRename();
  ren = { id, el: nameEl, baseline: r.text };
  nameEl.contentEditable = 'true';
  nameEl.spellcheck = false;
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(range);
}

function commitRename() {
  const { id, el } = ren || {};
  ren = null;
  if (!el) return;
  el.contentEditable = 'false';
  const r = rowById(id);
  if (!r) return;
  const txt = el.textContent.trim();
  if (txt && txt !== r.text && el.isConnected) {
    snapshot('重命名章节');
    r.text = txt;
    persist();
    toast('章节已改名');
  }
  el.textContent = r.text; // 改名成功就地换上（顺带把空名 / 没变的情况还原）
}

/* ── 章节菜单 ── */
function sectionMenu(id, anchor) {
  const r = rowById(id);
  if (!r || r.kind !== 'section') return;
  const n = sectionSentenceCount(id);
  const si = state.rows.indexOf(r);
  const isFirst = !state.rows.slice(0, si).some(x => x.kind === 'section');
  const headDesc = isFirst ? `${n} 句保留为开头正文` : n ? `${n} 句并回上一节` : '这节还没有句子';
  openMenu(
    anchor,
    `
    <div class="p-title">章节「${esc(r.text)}」</div>
    <div class="pop-item" data-sec-act="rename" data-sec-id="${id}"><svg class="mi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span class="main">改名</span></div>
    ${state.view === 'table' ? `<div class="pop-item" data-sec-act="insert" data-sec-id="${id}"><svg class="mi" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg><span class="main">在这节后面插入新章节<span class="desc">立个标题和空句，接着往下写</span></span></div>` : ''}
    <div class="pop-sep"></div>
    <div class="pop-item" data-sec-act="delhead" data-sec-id="${id}"><svg class="mi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 7l4-4M4 7l4 4"/></svg><span class="main">只删标题<span class="desc">${headDesc}</span></span></div>
    <div class="pop-item danger" data-sec-act="delall" data-sec-id="${id}"><svg class="mi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2m-1 0v14a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V6"/></svg><span class="main">删除整节<span class="desc">标题和 ${n} 句一起删</span></span></div>
  `,
  );
  markPopAnchor(anchor);
}

/* 菜单项动作（capture 抢在弹层「点外面关闭」之前，和类型菜单同一套规矩） */
function onMenuAction(item) {
  const id = +item.dataset.secId;
  const act = item.dataset.secAct;
  closePop();
  if (act === 'rename') {
    const holder = document.querySelector(`.section-row[data-sid="${id}"], .ck-sec[data-sid="${id}"]`);
    const nameEl = holder && holder.querySelector('.name');
    nameEl && startRename(nameEl, id);
  }
  if (act === 'insert') {
    const sentId = insertSectionWithSentence(id);
    if (sentId != null)
      setTimeout(() => {
        // 等 update('rows') 重建 DOM 后进编辑态
        const el = document.querySelector(`.row[data-id="${sentId}"] .sent`);
        el && startEdit(el, { inserting: true });
      }, 0);
  }
  if (act === 'delhead') deleteSectionHeader(id);
  if (act === 'delall') {
    const n = sectionSentenceCount(id);
    if (!n) {
      deleteSectionHeader(id);
      return;
    } // 空节没有可删的句子，退化为只删标题
    confirmModal('删除整节', `「${rowById(id)?.text || ''}」标题下的 ${n} 句会一起删除。`, '删除整节', () =>
      deleteSectionAll(id),
    );
  }
}

export function initSections() {
  const rows = document.querySelector('#rows');

  rows.addEventListener('click', e => {
    // 点章节行：弹管理菜单（改名中的章节名除外，那会儿在打字）
    const secRow = e.target.closest('.section-row, .ck-sec');
    if (secRow && !e.target.closest('.name[contenteditable="true"]')) {
      e.stopPropagation();
      if (popOpenFor(secRow)) {
        closePop();
        return;
      }
      sectionMenu(+secRow.dataset.sid, secRow);
    }
  });

  rows.addEventListener('dblclick', e => {
    const nameEl = e.target.closest('.section-row .name, .ck-sec .name');
    if (nameEl && !nameEl.isContentEditable) {
      const holder = nameEl.closest('[data-sid]');
      holder && startRename(nameEl, +holder.dataset.sid);
    }
  });

  document.addEventListener(
    'click',
    e => {
      const item = e.target.closest && e.target.closest('[data-sec-act]');
      if (item && document.querySelector('.popover')) onMenuAction(item);
    },
    true,
  );

  rows.addEventListener(
    'keydown',
    e => {
      if (!ren || e.target !== ren.el) return;
      e.stopPropagation();
      if (composing(e)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        commitRename();
      } // 直接提交，不赌焦点事件
      else if (e.key === 'Escape') {
        e.preventDefault();
        ren.el.textContent = ren.baseline;
        ren = null;
        e.target.contentEditable = 'false';
        e.target.blur();
      }
    },
    true,
  );
  rows.addEventListener('focusout', e => {
    if (ren && e.target === ren.el) commitRename();
  });
}
