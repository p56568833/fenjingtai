/* 全局键盘：1-9 标注 / 删除 / 方向导航 / ⌘F / ⌘Z / 空格播口播 / Esc；原文视图的键位由 check-view.js 接管 */
import { state, currentSelection, visibleLineIds, types } from '../app/state.js';
import { deleteSelection, annotateSelection } from '../app/actions.js';
import { composing, isEditing } from './dom.js';
import { historyCommand } from './history.js';
import { renderSelectionOnly, cycleView } from './render.js';
import { closePop } from './popover.js';
import { openSearch, closeSearch } from './search.js';
import { handleCheckKey } from './check-view.js';
import { runCommand } from './commands.js';

function moveTo(dir) {
  const ids = visibleLineIds();
  if (!ids.length) return;
  let i = ids.indexOf(state.sel);
  i = i === -1 ? (dir > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, i + dir));
  state.sel = ids[i];
  state.multi = null;
  closePop();
  renderSelectionOnly();
  const el = document.querySelector(`[data-id="${state.sel}"]`);
  el && el.scrollIntoView({ block: 'nearest' });
}

export function initKeyboard() {
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;

    // 弹窗开着时的按键由 modal.js 统一处理（Esc 关最上层 / Enter 确认），不会走到这里

    if (mod && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openSearch();
      return;
    }
    if (mod && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      cycleView();
      return;
    }

    // 以事件来源判断是否在编辑：隐藏窗口里焦点不总是落得稳，只看 activeElement 会把表单里的退格误当删除句子
    const editing = isEditing(e.target);
    if (mod && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
      // 编辑文字时交给浏览器撤销输入；否则撤销 / 重做项目改动（⇧⌘Z 或 ⌘Y 重做）
      if (!editing) {
        e.preventDefault();
        historyCommand(e.shiftKey || e.key === 'y' ? 'redo' : 'undo', 'key');
      }
      return;
    }
    if (mod && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      runCommand(e.shiftKey ? 'pdf:open' : 'focus:open'); // ⇧⌘E 导出 PDF，⌘E 专注标注
      return;
    }
    if (mod && e.key === '/') {
      e.preventDefault();
      runCommand('help:open');
      return;
    }
    if (composing(e)) return;

    // 审核和表格是同级视图：共用全局快捷键，其余按键交给当前页，不能改动隐藏的表格。
    if (state.view === 'review') {
      runCommand('video:key', e);
      return;
    }
    if (editing) return; // 编辑中的其余按键由 edit.js 处理

    if (e.key === 'Escape') {
      if (state.multi || state.multiMode) {
        state.multi = null;
        state.multiMode = false;
        renderSelectionOnly();
      }
      closePop();
      closeSearch();
      return;
    }
    // 空格：播放 / 暂停口播（有口播音频时；没有就不占用这个键）
    if (e.key === ' ' && !mod && state.voice && !state.multiMode) {
      e.preventDefault();
      runCommand('voice:toggle');
      return;
    }
    // 原文视图：方向键 / 1·2·0 / ⌫ 都按「阅读勾选」的语义走（⌫ 只擦勾选不删句子）
    if (state.view === 'check' && handleCheckKey(e)) return;
    // 两个视图同一套：⌫ 只清标注（误按也不丢字），⌘⌫ 才删除句子（可撤销）
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!currentSelection().length) return;
      e.preventDefault();
      if (mod) deleteSelection();
      else annotateSelection(null);
      return;
    }
    if (!visibleLineIds().length) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      state.multi = null;
      moveTo(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = document.querySelector(`.row[data-id="${state.sel}"]`);
      const note = (row?.closest('.shared-scene') || row)?.querySelector('.note');
      if (note) note.focus();
      return;
    }
    if (!mod && !e.altKey && types().isTypeKey(e.key)) {
      if (!currentSelection().length) return;
      e.preventDefault();
      closePop();
      annotateSelection(types().keyToType(e.key));
    }
  });
}
