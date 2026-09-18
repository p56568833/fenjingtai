/* 全局键盘：1-6 标注 / 删除 / 方向导航 / ⌘F / ⌘Z / Esc；勾选视图的键位由 check.js 接管 */
import { state, currentSelection, visibleLineIds } from './state.js';
import { KEY2TYPE } from './types.js';
import { composing } from './util.js';
import { undo } from './undo.js';
import { deleteSelection, annotateSelection } from './actions.js';
import { renderSelectionOnly, cycleView } from './render.js';
import { closePop } from './popover.js';
import { openSearch, closeSearch } from './search.js';
import { handleCheckKey } from './check.js';

function moveTo(dir){
  const ids = visibleLineIds(); if(!ids.length) return;
  let i = ids.indexOf(state.sel);
  i = i===-1 ? (dir>0?0:ids.length-1) : Math.min(ids.length-1, Math.max(0, i+dir));
  state.sel = ids[i]; state.multi = null; closePop();
  renderSelectionOnly();
  const el = document.querySelector(`[data-id="${state.sel}"]`);
  el && el.scrollIntoView({block:'nearest'});
}

export function initKeyboard(){
  document.addEventListener('keydown', e=>{
    const mod = e.metaKey || e.ctrlKey;

    // 确认弹窗开着时：Enter 确认 / Esc 取消，其余快捷键一律不穿透（⌘F/⌘T 不该作用在弹窗底下）
    if(document.querySelector('#modalMask').classList.contains('show')){
      if(e.key==='Enter'){ e.preventDefault(); document.querySelector('#mOk').click(); }
      else if(e.key==='Escape'){ e.preventDefault(); document.querySelector('#mCancel').click(); }
      return;
    }
    if(document.querySelector('#pasteMask').classList.contains('show')){
      if(e.key==='Escape'){ e.preventDefault(); document.querySelector('#pasteCancel').click(); }
      return;
    }

    if(mod && (e.key==='f' || e.key==='F')){ e.preventDefault(); openSearch(); return; }
    if(mod && (e.key==='t' || e.key==='T')){ e.preventDefault(); cycleView(); return; }

    const ae = document.activeElement;
    const editing = ae && ae.isContentEditable;
    if(mod && (e.key==='z' || e.key==='Z')){
      if(!editing){ e.preventDefault(); undo(); }
      return;
    }
    if(editing) return;                       // 编辑中的其余按键由 edit.js 处理
    if(composing(e)) return;

    if(e.key==='Escape'){
      if(state.multi){ state.multi = null; renderSelectionOnly(); }
      closePop(); closeSearch(); return;
    }
    // 勾选视图：方向键 / 1·2·0 / ⌫ 都按「阅读勾选」的语义走（⌫ 只擦勾选不删句子）
    if(state.view==='check' && handleCheckKey(e)) return;
    if(e.key==='Delete' || e.key==='Backspace'){
      if(!currentSelection().length) return;
      e.preventDefault();
      deleteSelection();
      return;
    }
    if(!visibleLineIds().length) return;

    if(e.key==='ArrowDown' || e.key==='ArrowUp'){
      e.preventDefault();
      state.multi = null;
      moveTo(e.key==='ArrowDown' ? 1 : -1);
      return;
    }
    if(e.key==='Enter'){
      e.preventDefault();
      const note = document.querySelector(`.row[data-id="${state.sel}"] .note`);
      if(note) note.focus();
      return;
    }
    if(KEY2TYPE.hasOwnProperty(e.key)){
      if(!currentSelection().length) return;
      e.preventDefault();
      closePop();
      annotateSelection(KEY2TYPE[e.key]);
    }
  });
}
