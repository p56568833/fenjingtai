/* 渲染总入口：订阅 state 事件，决定重渲染粒度 */
import { state, on, renumber, currentSelection } from './state.js';
import { renderStats } from './render-stats.js';
import { renderTable } from './render-table.js';
import { armAnimation } from './anim.js';
import { renderCheck } from './render-check.js';
import { closePop } from './popover.js';

export function renderAll(){
  renumber();
  renderStats();
  if(state.view==='check') renderCheck();
  else renderTable();
  // 注意：这里不滚动。滚动交给明确的交互（键盘导航/搜索跳转/切视图），
  // 否则搜索打字、切筛选、撤销、删除都会把视口拽到选中句，像「莫名刷新」。
}

/* 只刷选中高亮，不重建 DOM（键盘导航 / 点选时不打断进行中的编辑） */
export function renderSelectionOnly(){
  if(state.view==='check'){
    const sel = new Set(currentSelection());
    document.querySelectorAll('.as').forEach(el=>el.classList.toggle('cur', sel.has(+el.dataset.id)));
    return;
  }
  const sel = new Set(currentSelection());
  document.querySelectorAll('.row').forEach(el=>el.classList.toggle('selected', sel.has(+el.dataset.id)));
}

export function setView(v){
  if(state.view===v) return;
  state.view = v; closePop();
  // 按钮高亮跟着视图走（之前只切内容不切换高亮，看起来像没切过去）
  document.querySelectorAll('#viewToggle button').forEach(b=>b.classList.toggle('active', b.dataset.v===v));
  armAnimation();
  renderAll();
  // 切完视图把正在处理的句子带到视口中间：位置可预期，不会「莫名跳走」
  const selEl = document.querySelector(`[data-id="${state.sel}"]`);
  selEl && selEl.scrollIntoView({block:'center'});
}

/* ⌘T / 原生菜单：表格 ↔ 勾选 */
const VIEW_CYCLE = ['table','check'];
export function cycleView(){
  setView(VIEW_CYCLE[(VIEW_CYCLE.indexOf(state.view)+1) % VIEW_CYCLE.length]);
}

export function initRender(){
  on('rows', renderAll);
  on('selection', renderSelectionOnly);
}
