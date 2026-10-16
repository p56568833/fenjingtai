import { projectRefresh } from '../core/project-refresh.js';
import { viewState } from '../app/view-state.js';
/* 渲染总入口：订阅数据事件，决定重渲染粒度（全量 / 原地刷新） */
import { state } from '../app/state.js';
import { on, emit } from '../app/events.js';
import { renumber, rowById } from '../app/project-queries.js';
import { visibleLineIds } from '../app/selection.js';
import { renderStats } from './render-stats.js';
import { renderTable, updateRowVisual, updateSectionBadges } from './render-table.js';
import { renderCheck, updateCheckSpans, updateCheckNote } from './render-check.js';
import { armAnimation, animationArmed } from './base/anim.js';
import { flipCapture, flipPlay } from './base/motion.js';
import { closePop } from './base/popover.js';
import { flushPendingEdits, deferRenderWhileEditing, clearDeferredRender, isEditingIn } from './base/edit-session.js';
import { renderSelectionOnly } from './base/selection.js';
import { revealRow } from './base/dom.js';
import { registerCommand, runCommand } from './base/commands.js';
import { staleBlock } from './base/keyed-patch.js';
import { paintSearch } from './base/search-paint.js';

function syncTitle() {
  const t = document.querySelector('#projTitle');
  if (t && t.textContent !== state.title) t.textContent = state.title;
  if (t) t.title = state.title;
}

/* 连续输入描述时只合并侧栏刷新；数据和其他描述格仍立即更新。 */
let workspaceTimer = null;
let pendingWorkspace = null;
function refreshWorkspace(options, delayed = false) {
  clearTimeout(workspaceTimer);
  const ids = options.rowIds;
  if (pendingWorkspace && pendingWorkspace.projectId === state.projectId)
    options = {
      ...options,
      rowIds:
        !pendingWorkspace.options.rowIds || !ids ? null : [...new Set([...pendingWorkspace.options.rowIds, ...ids])],
    };
  pendingWorkspace = { projectId: state.projectId, options };
  const flush = () => {
    const pending = pendingWorkspace;
    pendingWorkspace = null;
    if (pending?.projectId === state.projectId) emit('workspace', pending.options);
  };
  if (delayed) workspaceTimer = setTimeout(flush, 250);
  else flush();
}
function clearWorkspaceRefresh() {
  clearTimeout(workspaceTimer);
  pendingWorkspace = null;
}

let lastRendered = null;
let rendering = false;
export function renderAll() {
  if (rendering) return;
  if (
    lastRendered === `${state.projectId}|${viewState.view}` &&
    deferRenderWhileEditing('main-view', '#rows, #inspector, #focusMask, #vrList', renderAll)
  )
    return;
  clearDeferredRender('main-view');
  clearDeferredRender('main-partial');
  rendering = true;
  try {
    flushPendingEdits();
    paintAll();
  } finally {
    rendering = false;
  }
}

/* 表格和原文视图都按块原地更新（base/keyed-patch.js）：没变的句子留着原来的元素，浏览器自己的滚动锚点
   就能让正在看的位置不动，不用重画后再把视口拽回去。切项目 / 切视图 / 导入时整块重来，走入场动画。 */
function paintAll() {
  // 同一个项目、同一个视图里更新（筛选、删句、撤销、组成共用画面…）：记下屏幕上每句的位置，
  // 更新后从老位置滑到新位置。切项目 / 切视图 / 导入时走整页入场动画，不做这个。
  const flip =
    viewState.view === 'table' && lastRendered === `${state.projectId}|${viewState.view}` && !animationArmed()
      ? flipCapture(document.querySelector('#rows'))
      : null;
  document.body.classList.toggle('reading', viewState.view === 'check');
  const reviewing = viewState.view === 'review';
  document.querySelector('#tablePage').hidden = reviewing;
  const reviewPage = document.querySelector('#reviewPage');
  if (reviewPage) reviewPage.hidden = !reviewing;
  if (viewState.filter !== 'all') {
    const visible = new Set(visibleLineIds());
    if (!visible.has(viewState.sel)) viewState.sel = visibleLineIds()[0] ?? null;
    if (viewState.multi) {
      viewState.multi = viewState.multi.filter(id => visible.has(id));
      if (!viewState.multi.length) viewState.multi = null;
    }
  }
  renumber();
  syncTitle();
  syncViewToggle();
  renderStats();
  if (viewState.view === 'check') renderCheck();
  else if (!reviewing) renderTable();
  if (!reviewing) paintSearch();
  clearWorkspaceRefresh();
  emit('workspace');
  emit('view-painted');
  renderSelectionOnly();
  flipPlay(document.querySelector('#rows'), flip);
  lastRendered = `${state.projectId}|${viewState.view}`;
  // 这里不滚动：滚动交给明确的交互（键盘导航 / 搜索跳转 / 切视图），否则打字、筛选、撤销都会拽视口
}

export function setView(v) {
  if (viewState.view === v) return;
  flushPendingEdits(); // 先把正在编辑的内容提交掉，重建界面不丢输入
  const from = viewState.view;
  document.activeElement?.blur(); // 离开页面时不把焦点留在已经收起的内容里
  viewState.view = v;
  closePop();
  armAnimation();
  renderAll();
  emit('view', { from, view: v });
  // 切完视图把正在处理的句子带到视口中间：位置可预期，不会「莫名跳走」
  if (v !== 'review') document.querySelector(`[data-id="${viewState.sel}"]`)?.scrollIntoView({ block: 'center' });
}

/* 顶栏视图切换：视频审核 ↔ 表格。视频审核开着时它是选中项；白色滑块滑到选中按钮底下（CSS 弹簧过渡） */
export function syncViewToggle() {
  const box = document.querySelector('#viewToggle');
  if (!box) return;
  const active = viewState.view;
  let on = null;
  box.querySelectorAll('button').forEach(b => {
    const hit = b.dataset.v === active;
    b.classList.toggle('active', hit);
    b.setAttribute('aria-selected', String(hit));
    if (hit) on = b;
  });
  const pill = box.querySelector('.vt-pill');
  if (!pill || !on) return;
  pill.style.width = `${on.offsetWidth}px`;
  pill.style.transform = `translateX(${on.offsetLeft}px)`;
}
/* ⌘T / 原生菜单：表格 ↔ 视频审核 */
export function cycleView() {
  if (viewState.view === 'review') setView('table');
  else runCommand('video:open');
}

/* 标注变了：筛选「全部」下原地刷新颜色和标签，其他筛选下句子可见性会变，整页重建 */
function onMarks({ ids }) {
  if (viewState.view === 'check') updateCheckSpans(ids);
  else {
    ids.forEach(updateRowVisual);
    updateSectionBadges();
  }
}

/* 画面描述变了：原文视图原地增删红字；表格里正在编辑的那格不动，别的格同步文字 */
function onNotes({ ids }) {
  if (viewState.view === 'check') return ids.forEach(updateCheckNote);
  let deferred = false;
  for (const id of ids) {
    const el = document.querySelector(`.note[data-id="${id}"]`);
    const r = rowById(id);
    if (el && r && el.textContent !== (r.note || '')) {
      if (el === document.activeElement) {
        deferred = true;
        continue;
      }
      el.textContent = r.note || '';
      staleBlock(el);
    }
  }
  return deferred;
}

/* 本机、撤销和协作走同一份变化清单；局部更新不触碰正在输入的格子。 */
function onProjectChange(change) {
  if (change.projectId !== state.projectId) return;
  const plan = projectRefresh(change);
  syncTitle();
  if (plan.table || (plan.marks && viewState.filter !== 'all')) return renderAll();
  const ids = change.rowIds || [];
  if (plan.marks) onMarks({ ids });
  if (plan.notes && onNotes({ ids })) deferRenderWhileEditing('main-partial', '#rows', renderAll);
  if (plan.stats) renderStats();
  if (plan.workspace)
    refreshWorkspace(
      {
        preservePosition: true,
        rowIds: change.assets ? (change.assetRowIds ?? null) : change.rowIds,
      },
      plan.notes && !plan.marks && !change.assets && isEditingIn('#rows, #inspector'),
    );
  if (plan.marks || plan.notes) emit('view-painted');
  if (change.source === 'history') renderSelectionOnly();
}

export function initRender() {
  registerCommand('view:set', setView);
  registerCommand('view:sync-toggle', syncViewToggle);
  // 待审数字滚动结束、字体加载或顶栏布局变化时，按钮尺寸还可能再次改变。
  const toggle = document.querySelector('#viewToggle');
  if (toggle) {
    const observer = new ResizeObserver(syncViewToggle);
    observer.observe(toggle);
    toggle.querySelectorAll('button').forEach(button => observer.observe(button));
  }
  on('view-refresh', renderAll);
  on('project-committed', onProjectChange);
  on('selection', renderSelectionOnly);
  on('project-loaded', () => {
    clearWorkspaceRefresh();
    armAnimation();
    syncTitle();
  });
  on('reveal', ({ id }) => requestAnimationFrame(() => revealRow(id)));
  on('history', ({ sel }) => {
    syncTitle();
    revealRow(sel);
  });
}
