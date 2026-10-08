/* 渲染总入口：订阅数据事件，决定重渲染粒度（全量 / 原地刷新） */
import { state, on, emit, renumber, currentSelection, checkedIds, visibleLineIds, rowById } from '../app/state.js';
import { renderStats } from './render-stats.js';
import { renderTable, updateRowVisual, updateSectionBadges } from './render-table.js';
import { renderCheck, updateCheckSpans, updateCheckNote } from './render-check.js';
import { armAnimation } from './anim.js';
import { closePop } from './popover.js';
import { flushPendingEdits } from './edit.js';
import { revealRow } from './dom.js';

function syncTitle() {
  const t = document.querySelector('#projTitle');
  if (t && document.activeElement !== t && t.textContent !== state.title) t.textContent = state.title;
}

/* 整表重建会换掉所有行：屏幕外的新行只按 contain-intrinsic-size 占位（72px），和原来的真实行高对不上，
   scrollTop 不变的话视口会「闪现」到很远的地方。重建前记下一句锚点（优先当前选中句）离视口顶部的距离，
   重建后把它放回原处；下一帧行高展开后再校准一次。切项目 / 切视图不保持（各自有定位逻辑）。 */
const ROW_SEL = '.row[data-id],.as[data-id]';
let lastRendered = null;

function captureAnchor() {
  const wrap = document.querySelector('#tableWrap');
  const key = `${state.projectId}|${state.view}`;
  if (!wrap || lastRendered !== key) return null;
  const box = wrap.getBoundingClientRect();
  const inView = el => {
    const r = el.getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom;
  };
  let el =
    state.sel != null ? document.querySelector(`.row[data-id="${state.sel}"],.as[data-id="${state.sel}"]`) : null;
  if (!el || !inView(el)) el = [...document.querySelectorAll(ROW_SEL)].find(inView) || null;
  if (!el) return null;
  return { wrap, id: el.dataset.id, top: el.getBoundingClientRect().top };
}

function restoreAnchor(a) {
  if (!a) return;
  const fix = () => {
    const el = document.querySelector(`.row[data-id="${a.id}"],.as[data-id="${a.id}"]`);
    if (!el) return;
    const d = el.getBoundingClientRect().top - a.top;
    if (Math.abs(d) >= 1) a.wrap.scrollTop += d;
  };
  fix();
  requestAnimationFrame(fix);
}

export function renderAll() {
  const anchor = captureAnchor();
  document.body.classList.toggle('reading', state.view === 'check');
  if (state.filter !== 'all') {
    const visible = new Set(visibleLineIds());
    if (!visible.has(state.sel)) state.sel = visibleLineIds()[0] ?? null;
    if (state.multi) {
      state.multi = state.multi.filter(id => visible.has(id));
      if (!state.multi.length) state.multi = null;
    }
  }
  renumber();
  syncTitle();
  document
    .querySelectorAll('#viewToggle button')
    .forEach(b => b.classList.toggle('active', b.dataset.v === state.view));
  renderStats();
  if (state.view === 'check') renderCheck();
  else renderTable();
  emit('workspace');
  renderSelectionOnly();
  restoreAnchor(anchor);
  lastRendered = `${state.projectId}|${state.view}`;
  // 这里不滚动：滚动交给明确的交互（键盘导航 / 搜索跳转 / 切视图），否则打字、筛选、撤销都会拽视口
}

/* 只刷选中高亮，不重建 DOM（键盘导航 / 点选时不打断进行中的编辑） */
export function renderSelectionOnly() {
  document.body.classList.toggle('multi-mode', state.multiMode);
  document.body.classList.toggle('multi-active', checkedIds().length > 0); // 勾了一句也一直显示勾，不用等第二句
  document.querySelector('#selectionHeading').textContent = state.multiMode ? '选择 / #' : '#';
  emit('cursor');
  const sel = new Set(currentSelection());
  if (state.view === 'check') {
    document.querySelectorAll('.as').forEach(el => {
      const checked = sel.has(+el.dataset.id);
      el.classList.toggle('cur', checked);
      if (state.multiMode) {
        el.setAttribute('role', 'checkbox');
        el.setAttribute('aria-checked', String(checked));
        el.tabIndex = 0;
      } else {
        el.removeAttribute('role');
        el.removeAttribute('aria-checked');
        el.removeAttribute('tabindex');
      }
    });
    return;
  }
  const ticked = new Set(checkedIds());
  document.querySelectorAll('.row').forEach(el => {
    el.classList.toggle('selected', sel.has(+el.dataset.id));
    const box = el.querySelector('.row-select');
    if (box) box.checked = ticked.has(+el.dataset.id);
  });
}

export function setView(v) {
  if (state.view === v) return;
  flushPendingEdits(); // 先把正在编辑的内容提交掉，重建界面不丢输入
  state.view = v;
  closePop();
  armAnimation();
  renderAll();
  // 切完视图把正在处理的句子带到视口中间：位置可预期，不会「莫名跳走」
  document.querySelector(`[data-id="${state.sel}"]`)?.scrollIntoView({ block: 'center' });
}

/* ⌘T / 原生菜单：原文 ↔ 表格 */
const VIEW_CYCLE = ['table', 'check'];
export function cycleView() {
  setView(VIEW_CYCLE[(VIEW_CYCLE.indexOf(state.view) + 1) % VIEW_CYCLE.length]);
}

/* 标注变了：筛选「全部」下原地刷新颜色和标签，其他筛选下句子可见性会变，整页重建 */
function onMarks({ ids }) {
  if (state.filter !== 'all') return emit('rows');
  if (state.view === 'check') updateCheckSpans(ids);
  else {
    ids.forEach(updateRowVisual);
    updateSectionBadges();
  }
  renderStats();
}

/* 画面描述变了：原文视图原地增删红字；表格里正在编辑的那格不动，别的格同步文字 */
function onNotes({ ids }) {
  if (state.view === 'check') return ids.forEach(updateCheckNote);
  for (const id of ids) {
    const el = document.querySelector(`.note[data-id="${id}"]`);
    const r = rowById(id);
    if (el && r && el !== document.activeElement && el.textContent !== (r.note || '')) el.textContent = r.note || '';
  }
}

export function initRender() {
  on('rows', renderAll);
  on('selection', renderSelectionOnly);
  on('marks', onMarks);
  on('notes', onNotes);
  on('title', syncTitle);
  on('project-loaded', () => {
    armAnimation();
    syncTitle();
  });
  on('reveal', ({ id }) => requestAnimationFrame(() => revealRow(id)));
  on('history', ({ sel }) => {
    syncTitle();
    revealRow(sel);
  });
}
