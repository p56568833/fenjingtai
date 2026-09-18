/* 编辑交互：双击改字 / Enter 拆分 / 句首 ⌫ 合并 / 插入 / 备注跳行与撤销。
   全部走 #rows 事件委托；中文输入法组合中的按键一律放行给输入法。 */
import { state, rowById, currentSelection, visibleLineIds } from './state.js';
import { snapshot } from './undo.js';
import { persist } from './storage.js';
import { esc, dur, composing, toast } from './util.js';
import { renderStats } from './render-stats.js';
import { renderSelectionOnly } from './render.js';
import {
  deleteRows, mergeToPrev, splitAt, insertAfter, dropIfEmpty, annotateSelection,
} from './actions.js';
import { openTypePopover, markPopAnchor, closePop } from './popover.js';

/* ── 光标工具 ── */
function caretState(el){
  const selection = getSelection();
  if(!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return { offset: pre.toString().length, collapsed: range.collapsed };
}
function placeCaret(el, caret){
  const sel = getSelection();
  const range = document.createRange();
  let remain = caret, placed = false, n;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while((n = walk.nextNode())){
    if(remain <= n.textContent.length){ range.setStart(n, remain); placed = true; break; }
    remain -= n.textContent.length;
  }
  if(!placed) range.selectNodeContents(el);
  range.collapse(true);
  sel.removeAllRanges(); sel.addRange(range);
}

/* ── 进入 / 提交句子编辑 ── */
export function startEdit(el, { inserting=false } = {}){
  // 连续编辑修复：上一句还在编辑时，先原地提交（不触发整页重建），再进新句
  for(const s of document.querySelectorAll('.sent[contenteditable="true"]')){
    if(s!==el) commitSentEdit(s);
  }
  el._inserting = inserting;
  el.contentEditable = 'true';
  el.spellcheck = false;
  el.focus();
  if(inserting) placeCaret(el, 0);
  else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
}

function commitSentEdit(el){
  el.contentEditable = 'false';
  const r = rowById(+el.dataset.id);
  const txt = el.textContent.trim();
  if(!r) return;
  if(txt && txt !== r.text){
    snapshot('修改文字');
    r.text = txt;
    persist();
    el.innerHTML = esc(txt);                                    // 原地更新，不重建整页
    const row = el.closest('.row');
    if(row) row.querySelector('.dur').textContent = dur(txt);
    renderStats();
    toast('已修改这句话');
  }
  else if(!txt){
    if(el._inserting){ dropIfEmpty(r.id); }                     // 插入的新句没写内容 → 撤掉
    else { el.innerHTML = esc(r.text); }                        // 老句不允许被清空
  }
  el._inserting = false;
}

/* 拆分：Enter，从光标处断开 */
function splitSent(el){
  const r = rowById(+el.dataset.id); if(!r) return;
  const offset = caretState(el)?.offset ?? el.textContent.length;
  el.contentEditable = 'false';            // 先退出编辑态：重渲染后旧元素不能再把全文写回
  const nid = splitAt(r.id, offset);
  if(!nid){ commitSentEdit(el); return; }  // 光标在开头或结尾：只提交不拆
}

/* ── 备注：撤销快照（进入编辑后的第一次输入前存）+ Enter 跳下一行 ── */
let noteEdit = null;   // {id, baseline}

function onNoteFocus(el){
  const r = rowById(+el.dataset.id);
  noteEdit = r ? { id: r.id, baseline: r.note || '' } : null;
}
function onNoteInput(el){
  const r = rowById(+el.dataset.id);
  if(!r) return;
  if(noteEdit && noteEdit.id === r.id && !noteEdit.snapped && el.textContent !== noteEdit.baseline){
    // 把备注恢复到编辑前的值拍快照，再写回新值 —— 撤销就能回到编辑前
    const now = el.textContent;
    r.note = noteEdit.baseline; snapshot('编辑备注'); r.note = now;
    noteEdit.snapped = true;
  }
  r.note = el.textContent;
  persist();
}
function focusNextNote(el){
  const notes = [...document.querySelectorAll('#rows .note')];
  const next = notes[notes.indexOf(el) + 1];
  if(next){ next.focus(); placeCaret(next, next.textContent.length); }
  else el.blur();
}

/* ── 选择（表格行 / 总览段） ── */
function selectOnClick(id, e){
  if(e.shiftKey && state.sel!=null && state.sel!==id){
    const ids = visibleLineIds();
    const a = ids.indexOf(state.sel), b = ids.indexOf(id);
    if(a>-1 && b>-1){
      const [s,t] = a<b ? [a,b] : [b,a];
      state.multi = ids.slice(s, t+1);
      return;
    }
  }
  if(e.metaKey || e.ctrlKey){
    if(!state.multi) state.multi = state.sel!=null ? [state.sel] : [];
    const i = state.multi.indexOf(id);
    if(i>-1) state.multi.splice(i,1); else state.multi.push(id);
    state.sel = id;
    if(!state.multi.length) state.multi = null;
    return;
  }
  state.multi = null; state.sel = id;
}

/* ── 装配 ── */
export function initEdit(){
  const rows = document.querySelector('#rows');

  rows.addEventListener('click', e=>{
    const add = e.target.closest('.row-add');
    if(add){ e.stopPropagation(); const nid = insertAfter(+add.dataset.add); setTimeout(()=>{
      const el = document.querySelector(`.row[data-id="${nid}"] .sent`);
      el && startEdit(el, {inserting:true});
    }, 0); return; }
    const del = e.target.closest('.row-del');
    if(del){ e.stopPropagation(); deleteRows([+del.dataset.del]); return; }

    const row = e.target.closest('.row'); if(!row) return;
    selectOnClick(+row.dataset.id, e);
    const chip = e.target.closest('.tchip');
    renderSelectionOnly();
    if(chip && !e.shiftKey && !e.metaKey && !e.ctrlKey){
      openTypePopover(chip); markPopAnchor(chip);
    }
  });

  rows.addEventListener('dblclick', e=>{
    const sent = e.target.closest('.sent');
    if(sent && !sent.isContentEditable) startEdit(sent);
  });

  rows.addEventListener('focusin', e=>{
    if(e.target.classList.contains('note')) onNoteFocus(e.target);
  });
  rows.addEventListener('focusout', e=>{
    const el = e.target;
    if(el.classList.contains('sent') && el.isContentEditable) commitSentEdit(el);
    if(el.classList.contains('note')){
      if(!el.textContent.trim()) el.innerHTML = '';
      noteEdit = null;
    }
  });
  rows.addEventListener('input', e=>{
    if(e.target.classList.contains('note')) onNoteInput(e.target);
  });

  rows.addEventListener('keydown', e=>{
    const el = e.target;
    const isSent = el.classList && el.classList.contains('sent') && el.isContentEditable;
    const isNote = el.classList && el.classList.contains('note');
    if(!isSent && !isNote) return;
    if(composing(e)) return;                          // 输入法组合中：交给输入法
    if(isSent){
      if(e.key==='Enter'){ e.preventDefault(); splitSent(el); }
      else if(e.key==='Escape'){
        e.preventDefault();
        const r = rowById(+el.dataset.id);
        if(el._inserting && r){ dropIfEmpty(r.id); }
        else if(r){ el.textContent = r.text; el.blur(); }
      }
      else if(e.key==='Backspace'){
        const cs = caretState(el);
        if(cs && cs.collapsed && cs.offset===0){
          el.contentEditable = 'false';    // 同 splitSent：防止重渲染后的回调写回旧文本
          const res = mergeToPrev(+el.dataset.id);
          if(res){
            e.preventDefault();
            setTimeout(()=>{                              // 等 update('rows') 重建 DOM 后再定位
              const next = document.querySelector(`.row[data-id="${res.id}"] .sent`);
              if(next){ startEdit(next); placeCaret(next, res.seam); }
            }, 0);
          } else {
            el.contentEditable = 'true';   // 章节首句之类合并不了：回到编辑态
          }
        }
      }
    } else {
      if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); focusNextNote(el); }
      else if(e.key==='Escape'){ el.blur(); }
    }
    e.stopPropagation();
  }, true);

  // 类型菜单项
  document.addEventListener('click', e=>{
    const item = e.target.closest && e.target.closest('.pop-item[data-t]');
    if(item && document.querySelector('.popover')){
      const t = item.dataset.t || null;
      if(currentSelection().length){
        closePop();
        annotateSelection(t);
      }
    }
  }, true);
}
