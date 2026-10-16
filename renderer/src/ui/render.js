/* 渲染总入口：订阅数据事件，决定重渲染粒度（全量 / 原地刷新） */
import { state, on, emit, update, renumber, visibleLineIds, rowById } from '../app/state.js';
import { renderStats } from './render-stats.js';
import { renderTable, updateRowVisual, updateSectionBadges } from './render-table.js';
import { renderCheck, updateCheckSpans, updateCheckNote } from './render-check.js';
import { armAnimation, animationArmed } from './base/anim.js';
import { flipCapture, flipPlay } from './base/motion.js';
import { closePop } from './base/popover.js';
import { flushPendingEdits, deferRenderWhileEditing, clearDeferredRender } from './base/edit-session.js';
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

let lastRendered = null;
let rendering = false;
export function renderAll() {
  if (rendering) return;
  if (
    lastRendered === `${state.projectId}|${state.view}` &&
    deferRenderWhileEditing('main-view', '#rows, #inspector, #focusMask, #vrList', renderAll)
  )
    return;
  clearDeferredRender('main-view');
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
    state.view === 'table' && lastRendered === `${state.projectId}|${state.view}` && !animationArmed()
      ? flipCapture(document.querySelector('#rows'))
      : null;
  document.body.classList.toggle('reading', state.view === 'check');
  const reviewing = state.view === 'review';
  document.querySelector('#tablePage').hidden = reviewing;
  const reviewPage = document.querySelector('#reviewPage');
  if (reviewPage) reviewPage.hidden = !reviewing;
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
  syncViewToggle();
  renderStats();
  if (state.view === 'check') renderCheck();
  else if (!reviewing) renderTable();
  if (!reviewing) paintSearch();
  emit('workspace');
  renderSelectionOnly();
  flipPlay(document.querySelector('#rows'), flip);
  lastRendered = `${state.projectId}|${state.view}`;
  // 这里不滚动：滚动交给明确的交互（键盘导航 / 搜索跳转 / 切视图），否则打字、筛选、撤销都会拽视口
}

export function setView(v) {
  if (state.view === v) return;
  flushPendingEdits(); // 先把正在编辑的内容提交掉，重建界面不丢输入
  const from = state.view;
  document.activeElement?.blur(); // 离开页面时不把焦点留在已经收起的内容里
  state.view = v;
  closePop();
  armAnimation();
  renderAll();
  emit('view', { from, view: v });
  // 切完视图把正在处理的句子带到视口中间：位置可预期，不会「莫名跳走」
  if (v !== 'review') document.querySelector(`[data-id="${state.sel}"]`)?.scrollIntoView({ block: 'center' });
}

/* 顶栏视图切换：视频审核 ↔ 表格。视频审核开着时它是选中项；白色滑块滑到选中按钮底下（CSS 弹簧过渡） */
export function syncViewToggle() {
  const box = document.querySelector('#viewToggle');
  if (!box) return;
  const active = state.view;
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
  if (state.view === 'review') setView('table');
  else runCommand('video:open');
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
    if (el && r && el !== document.activeElement && el.textContent !== (r.note || '')) {
      el.textContent = r.note || '';
      staleBlock(el);
    }
  }
}

/* 远端修改和后台任务使用同一个编辑保护：只广播刷新请求，由渲染入口等待输入结束。 */
function onRemoteRows() {
  update('rows');
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
  on('rows', renderAll);
  on('selection', renderSelectionOnly);
  on('marks', onMarks);
  on('notes', onNotes);
  on('collab-remote', onRemoteRows);
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
