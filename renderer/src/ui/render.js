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

function syncTitle() {
  const t = document.querySelector('#projTitle');
  if (t && t.textContent !== state.title) t.textContent = state.title;
  if (t) t.title = state.title;
}

/* 整表重建会换掉所有行：屏幕外的新行只按 contain-intrinsic-size 占位（72px），和原来的真实行高对不上，
   scrollTop 不变的话视口会「闪现」到很远的地方。重建前记下一句锚点（优先当前选中句）离视口顶部的距离，
   重建后把它放回原处，行高稳定前持续校准。切项目 / 切视图不保持（各自有定位逻辑）。 */
const ROW_SEL = '.row[data-id],.as[data-id]';
let lastRendered = null;

/* 句子的排版位置：去掉重画过渡动画（FLIP）临时加在它和外层上的位移，量到动画中途的位置会校准错 */
function layoutTop(el) {
  let top = el.getBoundingClientRect().top;
  for (let e = el; e && e.id !== 'tableWrap'; e = e.parentElement) {
    const t = getComputedStyle(e).transform;
    if (t && t !== 'none') top -= new DOMMatrixReadOnly(t).m42;
  }
  return top;
}

function captureAnchor() {
  if (state.view === 'review') return null;
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
  return { wrap, id: el.dataset.id, top: layoutTop(el) };
}

/* 重建当下浏览器会把新行都按真实高度排一遍，下一帧屏幕外的行才缩回占位高度：只校准一两次赶不上，视口会漂走。
   接下来几帧里，每次排版后（绘制前）都把锚点句放回原处；你一滚动 / 点击 / 按键就停，不和你抢视口。 */
let releaseAnchor = null;
function restoreAnchor(a) {
  releaseAnchor?.();
  if (!a) return;
  const { wrap } = a;
  const rows = document.querySelector('#rows');
  wrap.classList.add('holding-anchor');
  let scrollTop = null,
    frame = null,
    frames = 8;
  const release = () => {
    if (releaseAnchor !== release) return;
    releaseAnchor = null;
    observer.disconnect();
    cancelAnimationFrame(frame);
    wrap.classList.remove('holding-anchor');
    for (const event of ['wheel', 'pointerdown', 'keydown']) document.removeEventListener(event, release, true);
  };
  const fix = () => {
    if (releaseAnchor !== release) return;
    // 别处滚动过（跳转到某句、搜索定位…）：以那边为准
    if (scrollTop != null && Math.abs(wrap.scrollTop - scrollTop) > 1) return release();
    const el = document.querySelector(`.row[data-id="${a.id}"],.as[data-id="${a.id}"]`);
    if (!el) return release();
    const d = layoutTop(el) - a.top;
    if (Math.abs(d) >= 1) wrap.scrollTop += d;
    scrollTop = wrap.scrollTop;
  };
  const observer = new ResizeObserver(fix);
  releaseAnchor = release;
  for (const event of ['wheel', 'pointerdown', 'keydown']) document.addEventListener(event, release, true);
  fix();
  if (rows) observer.observe(rows);
  const tick = () => {
    fix();
    if (releaseAnchor === release && --frames > 0) frame = requestAnimationFrame(tick);
    else release();
  };
  frame = requestAnimationFrame(tick);
}

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

function paintAll() {
  const anchor = captureAnchor();
  // 同一个项目、同一个视图里重画（筛选、删句、撤销、组成共用画面…）：记下屏幕上每句的位置，
  // 重画后从老位置滑到新位置。切项目 / 切视图 / 导入时走整页入场动画，不做这个。
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
  emit('workspace');
  renderSelectionOnly();
  restoreAnchor(anchor);
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
    if (el && r && el !== document.activeElement && el.textContent !== (r.note || '')) el.textContent = r.note || '';
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
