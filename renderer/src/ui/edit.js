import { viewState } from '../app/view-state.js';
/* 编辑交互：双击改字 / Enter 拆分 / 句首 ⌫ 合并 / 插入 / 备注跳行与撤销。
   全部走 #rows 事件委托；中文输入法组合中的按键一律放行给输入法。 */
import { state } from '../app/state.js';
import { rowById } from '../app/project-queries.js';
import { currentSelection, visibleLineIds, toggleLineSelection } from '../app/selection.js';
import {
  mergeToPrev,
  splitAt,
  insertAfter,
  dropIfEmpty,
  annotateSelection,
  setSentenceText,
  typeNote,
  typeSub,
} from '../app/actions.js';
import { esc, composing, toast, readEditable } from './base/dom.js';
import { rowBadges } from './badges.js';
import { registerEditFlush } from './base/edit-session.js';
import { staleBlock } from './base/keyed-patch.js';
import { renderSelectionOnly, selectedMemberOrOwner } from './base/selection.js';
import { markPopAnchor, closePop } from './base/popover.js';
import { paintSearch } from './base/search-paint.js';
import { openTypePopover } from './popover.js';

const EDITABLE_SENT = '.sent[contenteditable="true"], .sent[contenteditable="plaintext-only"]';
const EDITABLE_NAME = '.name[contenteditable="true"], .name[contenteditable="plaintext-only"]';

function insertPlainText(text) {
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return;
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/* ── 光标工具 ── */
function caretState(el) {
  const selection = getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return { offset: pre.toString().length, collapsed: range.collapsed };
}
function placeCaret(el, caret) {
  const sel = getSelection();
  const range = document.createRange();
  let remain = caret,
    placed = false,
    n;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while ((n = walk.nextNode())) {
    if (remain <= n.textContent.length) {
      range.setStart(n, remain);
      placed = true;
      break;
    }
    remain -= n.textContent.length;
  }
  if (!placed) range.selectNodeContents(el);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/* ── 进入 / 提交句子编辑 ── */
export function startEdit(el, { inserting = false } = {}) {
  // 连续编辑修复：上一句还在编辑时，先原地提交（不触发整页重建），再进新句
  for (const s of document.querySelectorAll(EDITABLE_SENT)) {
    if (s !== el) commitSentEdit(s);
  }
  el._inserting = inserting;
  el._projectId = state.projectId;
  // 始终用纯文本进入编辑：清掉 .gap-txt 标红与搜索高亮 <mark>，提交后重新恢复
  const row = rowById(+el.dataset.id);
  el.textContent = row ? row.text : el.textContent;
  // 保持 contenteditable="true" 以兼容既有 UI 自测选择器；富文本与换行在 paste/beforeinput 中严格拦截
  el.contentEditable = 'true';
  el.spellcheck = false;
  el.focus();
  if (inserting) placeCaret(el, 0);
  else {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
}

function commitSentEdit(el) {
  el.contentEditable = 'false';
  staleBlock(el); // 改过字（或去掉过没画面的标记）：下次更新按数据重画这句
  if (el._projectId && el._projectId !== state.projectId) return;
  const r = rowById(+el.dataset.id);
  const txt = el.textContent.trim();
  if (!r) return;
  if (txt && setSentenceText(r.id, txt)) {
    toast('已修改这句话', null, 'ok');
  } else if (!txt) {
    if (el._inserting)
      dropIfEmpty(r.id); // 插入的新句没写内容 → 撤掉
    else el.innerHTML = esc(r.text); // 老句不允许被清空
  }
  el._inserting = false;
  if (el.isConnected) {
    rowBadges([r.id]); // 没画面的字重新标红（编辑时去掉了）
    if (viewState.query) paintSearch(el.closest('.row'));
  }
}

/* 切换视图 / 重建界面前把进行中的编辑提交掉（改字、批注、中文字幕、章节改名），不丢输入 */
function flushPendingEdits() {
  for (const s of [...document.querySelectorAll(EDITABLE_SENT)]) commitSentEdit(s);
  for (const n of [...document.querySelectorAll(EDITABLE_NAME)])
    n.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  const active = document.activeElement;
  if (active?.classList?.contains('sent-sub')) {
    active._composing = false;
    const r = rowById(+active.dataset.id);
    if (subEdit && r && readEditable(active) !== (r.sub || '')) onSubInput(active);
    subEdit = null;
  }
}

/* Enter：句尾空出新句子接着写；句中从光标处拆开；句首只提交 */
function splitSent(el) {
  const r = rowById(+el.dataset.id);
  if (!r) return;
  const full = el.textContent;
  const offset = caretState(el)?.offset ?? full.length;
  if (offset === 0) {
    commitSentEdit(el);
    return;
  } // 句首：只提交
  if (offset >= full.trimEnd().length && full.trim()) {
    // 句尾：空出新句子
    el.contentEditable = 'false';
    commitSentEdit(el);
    const nid = insertAfter(r.id);
    if (nid != null)
      setTimeout(() => {
        const nel = document.querySelector(`#rows .row[data-id="${nid}"] .sent`);
        if (nel) startEdit(nel, { inserting: true });
      }, 0);
    return;
  }
  el.contentEditable = 'false'; // 先退出编辑态：重渲染后旧元素不能再把全文写回
  const nid = splitAt(r.id, offset, full);
  if (!nid) {
    commitSentEdit(el);
    return;
  } // 空白边界拆不动：只提交
}

/* ── 备注：撤销快照（进入编辑后的第一次输入前存）+ Enter 跳下一行 ── */
let noteEdit = null; // {id, baseline}

function onNoteFocus(el) {
  const r = rowById(+el.dataset.id);
  noteEdit = r ? { projectId: state.projectId, id: r.id, baseline: r.note || '', snapped: false } : null;
}
function onNoteInput(el) {
  if ((noteEdit && noteEdit.projectId !== state.projectId) || el._composing) return;
  const r = rowById(+el.dataset.id);
  if (!r) return;
  staleBlock(el);
  typeNote(r, readEditable(el), noteEdit);
}
function focusNextNote(el) {
  const notes = [...document.querySelectorAll('#rows .note')];
  const next = notes[notes.indexOf(el) + 1];
  if (next) {
    next.focus();
    placeCaret(next, next.textContent.length);
  } else el.blur();
}

/* ── 中文字幕：原地内联编辑 + Enter 跳下一句 ── */
let subEdit = null; // { projectId, id, baseline, snapped }

function onSubFocus(el) {
  const r = rowById(+el.dataset.id);
  if (el.querySelector('mark')) el.textContent = r ? r.sub || '' : readEditable(el);
  subEdit = r ? { projectId: state.projectId, id: r.id, baseline: r.sub || '', snapped: false } : null;
}
function onSubInput(el) {
  if ((subEdit && subEdit.projectId !== state.projectId) || el._composing) return;
  const r = rowById(+el.dataset.id);
  if (!r) return;
  staleBlock(el);
  typeSub(r, readEditable(el), subEdit);
}
function focusNextSub(el) {
  const subs = [...document.querySelectorAll('#rows .sent-sub')];
  const next = subs[subs.indexOf(el) + 1];
  if (next) {
    next.focus();
    placeCaret(next, next.textContent.length);
  } else el.blur();
}

/* ── 选择（表格行 / 总览段） ── */
function selectOnClick(id, e) {
  if (e.shiftKey && viewState.sel != null && viewState.sel !== id) {
    const ids = visibleLineIds();
    const a = ids.indexOf(viewState.sel),
      b = ids.indexOf(id);
    if (a > -1 && b > -1) {
      const [s, t] = a < b ? [a, b] : [b, a];
      viewState.multi = ids.slice(s, t + 1);
      return;
    }
  }
  if (e.metaKey || e.ctrlKey) {
    if (!viewState.multi) viewState.multi = viewState.sel != null ? [viewState.sel] : [];
    const i = viewState.multi.indexOf(id);
    if (i > -1) viewState.multi.splice(i, 1);
    else viewState.multi.push(id);
    viewState.sel = id;
    if (!viewState.multi.length) viewState.multi = null;
    return;
  }
  viewState.multi = null;
  viewState.sel = id;
}

/* ── 装配 ── */
export function initEdit() {
  registerEditFlush(flushPendingEdits);
  const rows = document.querySelector('#rows');

  // 画面描述被截成 4 行时，悬停提示「点开看全文」（只在悬停时量一次，不用跟着内容同步）
  rows.addEventListener('mouseover', e => {
    const n = e.target.closest('.note');
    if (!n || n === document.activeElement) return;
    const clamped = n.scrollHeight > n.clientHeight + 2;
    n.classList.toggle('clamped', clamped);
    if (clamped) n.title = '点击展开全文';
    else n.removeAttribute('title');
  });

  rows.addEventListener('click', e => {
    if (e.target.closest('[data-detail]')) return;
    const selection = e.target.closest('.row-select');
    if (selection) {
      e.stopPropagation();
      if (e.shiftKey && viewState.sel != null) selectOnClick(+selection.dataset.select, e);
      else toggleLineSelection(+selection.dataset.select, selection.checked);
      closePop();
      renderSelectionOnly();
      return;
    }

    const shared = e.target.closest('.shared-scene');
    if (shared && !e.target.closest('.row')) {
      viewState.sel = selectedMemberOrOwner(+shared.dataset.owner);
      viewState.multi = null;
      renderSelectionOnly();
      const chip = e.target.closest('.tchip');
      if (chip) {
        openTypePopover(chip);
        markPopAnchor(chip);
      }
      return;
    }
    const row = e.target.closest('.row');
    if (!row) return;
    selectOnClick(+row.dataset.id, e);
    const chip = e.target.closest('.tchip');
    renderSelectionOnly();
    if (chip && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      openTypePopover(chip);
      markPopAnchor(chip);
    }
  });

  // Shift 点选一段句子时不要顺带拉出浏览器原生的文字选区（满屏蓝色高亮）；正在编辑的格子里照常可以 Shift 扩选文字
  rows.addEventListener('mousedown', e => {
    if (viewState.view !== 'table' || !e.shiftKey) return;
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae.isContentEditable && ae.contains(e.target)) return;
    if (e.target.closest('input, textarea, select')) return;
    e.preventDefault();
  });

  rows.addEventListener('dblclick', e => {
    const sent = e.target.closest('.sent');
    if (sent && !sent.isContentEditable) startEdit(sent);
  });

  rows.addEventListener('focusin', e => {
    if (e.target.classList.contains('note')) onNoteFocus(e.target);
    else if (e.target.classList.contains('sent-sub')) onSubFocus(e.target);
  });
  rows.addEventListener('focusout', e => {
    const el = e.target;
    if (el.classList.contains('sent') && el.isContentEditable) commitSentEdit(el);
    if (el.classList.contains('note')) {
      el._composing = false;
      const r = rowById(+el.dataset.id);
      if (noteEdit && r && readEditable(el) !== (r.note || '')) onNoteInput(el);
      if (!el.textContent.trim()) el.innerHTML = '';
      noteEdit = null;
    }
    if (el.classList.contains('sent-sub')) {
      el._composing = false;
      const r = rowById(+el.dataset.id);
      if (subEdit && r && readEditable(el) !== (r.sub || '')) onSubInput(el);
      if (!el.textContent.trim()) el.innerHTML = '';
      subEdit = null;
      if (el.isConnected && viewState.query) {
        const row = el.closest('.row');
        setTimeout(() => {
          if (row?.isConnected && el !== document.activeElement) paintSearch(row);
        }, 0);
      }
    }
  });
  rows.addEventListener('paste', e => {
    const sent = e.target.closest?.('.sent');
    if (!sent || !sent.isContentEditable) return;
    e.preventDefault();
    const clean = (e.clipboardData?.getData('text/plain') ?? '').replace(/\r?\n+/g, ' ');
    insertPlainText(clean);
  });
  rows.addEventListener('beforeinput', e => {
    const sent = e.target.closest?.('.sent');
    if (!sent || !sent.isContentEditable) return;
    if (/^format|^insert(?:Paragraph|LineBreak)$/.test(e.inputType)) {
      e.preventDefault();
    } else if (e.inputType === 'insertFromDrop') {
      e.preventDefault();
      const raw = e.dataTransfer?.getData('text/plain') ?? '';
      if (raw) insertPlainText(raw.replace(/\r?\n+/g, ' '));
    }
  });
  rows.addEventListener('input', e => {
    if (e.target.classList.contains('note') && !e.isComposing) onNoteInput(e.target);
    else if (e.target.classList.contains('sent-sub') && !e.isComposing) onSubInput(e.target);
  });
  rows.addEventListener('compositionstart', e => {
    e.target._composing = true;
  });
  rows.addEventListener('compositionend', e => {
    e.target._composing = false;
    if (e.target.classList.contains('note')) onNoteInput(e.target);
    else if (e.target.classList.contains('sent-sub')) onSubInput(e.target);
  });

  rows.addEventListener(
    'keydown',
    e => {
      const el = e.target;
      const isSent = el.classList && el.classList.contains('sent') && el.isContentEditable;
      const isNote = el.classList && el.classList.contains('note');
      const isSub = el.classList && el.classList.contains('sent-sub');
      if (!isSent && !isNote && !isSub) return;
      if (e.metaKey || e.ctrlKey) return; // 全局快捷键（⌘F / ⇧⌘E / ⌘/ / ⌘Z 等）放行冒泡
      if (composing(e)) return; // 输入法组合中：交给输入法
      let consumed = false;
      if (isSent) {
        if (e.key === 'Enter') {
          e.preventDefault();
          splitSent(el);
          consumed = true;
        } else if (e.key === 'Escape') {
          e.preventDefault();
          const r = rowById(+el.dataset.id);
          if (el._inserting && r) {
            dropIfEmpty(r.id);
          } else if (r) {
            el.textContent = r.text;
            el.blur();
          }
          consumed = true;
        } else if (e.key === 'Backspace') {
          const cs = caretState(el);
          if (cs && cs.collapsed && cs.offset === 0) {
            const currentText = el.textContent;
            el.contentEditable = 'false'; // 同 splitSent：防止重渲染后的回调写回旧文本
            const res = mergeToPrev(+el.dataset.id, currentText);
            if (res) {
              e.preventDefault();
              setTimeout(() => {
                // 等 update('rows') 重建 DOM 后再定位
                const next = document.querySelector(`#rows .row[data-id="${res.id}"] .sent`);
                if (next) {
                  startEdit(next);
                  placeCaret(next, res.seam);
                }
              }, 0);
            } else {
              el.contentEditable = 'true'; // 章节首句之类合并不了：回到编辑态
            }
            consumed = true;
          }
        }
      } else if (isNote) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          focusNextNote(el);
          consumed = true;
        } else if (e.key === 'Escape') {
          el.blur();
          consumed = true;
        }
      } else if (isSub) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          focusNextSub(el);
          consumed = true;
        } else if (e.key === 'Escape') {
          el.blur();
          consumed = true;
        }
      }
      if (consumed) e.stopPropagation();
    },
    true,
  );

  // 类型菜单项
  document.addEventListener(
    'click',
    e => {
      const item = e.target.closest && e.target.closest('.pop-item[data-t]');
      if (item && document.querySelector('.popover:not(.pop-leaving)')) {
        const t = item.dataset.t || null;
        if (currentSelection().length) {
          closePop();
          annotateSelection(t);
        }
      }
    },
    true,
  );
}
