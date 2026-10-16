import { viewState } from '../app/view-state.js';
/* 工作区：导航（跳句 / 下一个未标注 / 恢复光标）+ 侧栏、工具条、徽标的统一刷新 + 列宽拖动 */
import { state } from '../app/state.js';
import { on, emit } from '../app/events.js';
import { update } from '../app/project-events.js';
import { rowById } from '../app/project-queries.js';
import { rememberCursor } from '../app/storage.js';
import { repairPunctuationAction } from '../app/actions.js';
import { setFitDone } from '../app/asset-actions.js';
import { repairCandidates } from '../core/shots.js';
import { toast, confirmModal } from './base/dom.js';
import { closePop } from './base/popover.js';
import { renderOutline, initOutline, beginOutlineJump } from './outline.js';
import { renderToolbar, initToolbar } from './toolbar.js';
import { renderInspector, initInspector, isInspectorOpen, openInspectorFor } from './inspector.js';
import { initReview } from './review.js';
import { rowBadges } from './badges.js';
import { refreshMissing, resetMissing } from './asset-files.js';
import { renderStats } from './render-stats.js';
import { initOverview, renderOverview, renderOverviewSelection } from './timeline-overview.js';
import { preserveReadingPosition } from './reading-position.js';
import { registerCommand } from './base/commands.js';
import { scrollGuard } from './base/scroll-guard.js';
import { selectedMemberOrOwner } from './base/selection.js';

const $ = s => document.querySelector(s);
let lastProject = null;
let cancelJump = null;

export { openInspectorFor };
export { openReview } from './review.js';

export function jumpTo(id, { preserveFilter = false } = {}) {
  if (!rowById(id)) return;
  cancelJump?.();
  closePop();
  const filtered = !preserveFilter && viewState.filter !== 'all';
  if (!preserveFilter) viewState.filter = 'all';
  viewState.multi = null;
  const r = rowById(id);
  viewState.sel =
    r.kind === 'section' ? (state.rows.slice(state.rows.indexOf(r) + 1).find(x => x.kind === 'line')?.id ?? null) : id;
  if (filtered) emit('view-refresh');
  else update('selection');
  // 章节标题会吸顶，当前坐标不是章节起点；定位首句也能让浏览器展开屏幕外的正文。
  const el = document.querySelector(`.row[data-id="${viewState.sel}"],.as[data-id="${viewState.sel}"]`);
  const releaseOutline = beginOutlineJump(viewState.sel);
  // 跳过去后不再给那句闪一圈光（切章节时整组画面框会「散开」一下，看着晃）；选中底色已经标出是哪句
  el?.scrollIntoView({ block: 'center' });
  const selectedId = viewState.sel,
    project = state.projectId,
    view = viewState.view;
  let frame = 0,
    remaining = 3;
  const guard = scrollGuard(() => {
    cancelAnimationFrame(frame);
    if (cancelJump === guard.cancel) cancelJump = null;
    releaseOutline();
  });
  cancelJump = guard.cancel;
  const settle = () => {
    if (!guard.active()) return;
    // 长稿占位块展开后继续校准几帧；新导航、切项目 / 视图或用户开始操作立即结束。
    if (viewState.sel !== selectedId || state.projectId !== project || viewState.view !== view || !el?.isConnected)
      return guard.cancel();
    el.scrollIntoView({ block: 'center' });
    if (--remaining) frame = requestAnimationFrame(settle);
    else guard.cancel();
  };
  frame = requestAnimationFrame(settle);
  rememberCursor();
}

export function nextUnmarked() {
  const lines = state.rows.filter(r => r.kind === 'line');
  const i = lines.findIndex(r => r.id === viewState.sel);
  const ordered = [...lines.slice(i + 1), ...lines.slice(0, i + 1)];
  const next = ordered.find(r => !r.type);
  if (next) jumpTo(next.id);
  else toast('所有句子都已标注', null, 'ok');
}
export function revealSavedCursor() {
  cancelJump?.();
  const { projectId } = state;
  const { sel, view } = viewState;
  let frame;
  const guard = scrollGuard(() => {
    cancelAnimationFrame(frame);
    if (cancelJump === guard.cancel) cancelJump = null;
  });
  cancelJump = guard.cancel;
  frame = requestAnimationFrame(() => {
    if (!guard.active()) return;
    guard.cancel();
    if (viewState.sel !== sel || state.projectId !== projectId || viewState.view !== view) return;
    const el = document.querySelector(`.row[data-id="${sel}"],.as[data-id="${sel}"]`);
    el?.scrollIntoView({ block: 'center' });
  });
}

/* 孤立标点：有可修复的才在工具条上露出提示，平时不占位置 */
function renderRepairHint() {
  const n = repairCandidates(state.rows).length;
  const hint = $('#repairHint');
  hint.hidden = !n;
  if (n) hint.textContent = `发现 ${n} 处孤立标点 · 修复`;
}

function onMissingChanged() {
  rowBadges();
  renderOverview();
  if (isInspectorOpen() && !$('#inspector').contains(document.activeElement)) renderInspector(true);
}

function refresh(options = {}) {
  const { preservePosition = false, rowIds = null, stats = false } = options || {};
  renderOutline();
  renderToolbar();
  const refreshBadges = () => rowBadges(rowIds);
  if (preservePosition) preserveReadingPosition(refreshBadges);
  else refreshBadges();
  if (stats) renderStats();
  renderInspector();
  renderRepairHint();
  if (lastProject !== state.projectId) {
    lastProject = state.projectId;
    resetMissing();
    revealSavedCursor();
    renderInspector(true);
  }
  refreshMissing(onMissingChanged);
}

function initColumnResizer() {
  const handle = document.createElement('span');
  handle.className = 'column-resizer';
  handle.title = '拖动调整备注列宽';
  $('#thead').lastElementChild.append(handle);
  handle.onpointerdown = e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const start = e.clientX,
      w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--note-width')) || 250;
    handle.onpointermove = ev =>
      document.documentElement.style.setProperty(
        '--note-width',
        Math.max(160, Math.min(520, w + start - ev.clientX)) + 'px',
      );
    handle.onpointerup = () => {
      handle.onpointermove = null;
      try {
        localStorage.setItem(
          'fjz:noteWidth',
          getComputedStyle(document.documentElement).getPropertyValue('--note-width'),
        );
      } catch {}
    };
  };
  let width = null;
  try {
    width = localStorage.getItem('fjz:noteWidth');
  } catch {}
  if (/^\d+px$/.test(width || '')) document.documentElement.style.setProperty('--note-width', width);
}

export function initWorkspace() {
  initOutline();
  initToolbar();
  initInspector();
  initReview();
  registerCommand('nav:jump', jumpTo);
  registerCommand('nav:next-unmarked', nextUnmarked);
  initOverview();
  on('workspace', refresh);
  on('durations', () => renderOverview());
  on('cursor', () => {
    renderOverviewSelection();
    rememberCursor();
    renderToolbar();
    renderOutline();
  });
  on('annotated', ({ type }) => {
    if (viewState.autoAdvance && type && !viewState.focusMode) nextUnmarked();
  });
  $('#btnNext').onclick = nextUnmarked;
  try {
    viewState.autoAdvance = localStorage.getItem('fjz:autoAdvance') === 'true';
  } catch {}
  $('#autoAdvance').checked = viewState.autoAdvance;
  $('#autoAdvance').onchange = e => {
    viewState.autoAdvance = e.target.checked;
    try {
      localStorage.setItem('fjz:autoAdvance', String(viewState.autoAdvance));
    } catch {}
  };
  $('#repairHint').onclick = () => {
    const n = repairCandidates(state.rows).length;
    if (!n) return;
    confirmModal(
      '合并孤立标点？',
      `发现 ${n} 行仅有标点，将并回上一句。已有类型、备注或素材的行会保留。可以用 ⌘Z 撤销。`,
      '修复',
      repairPunctuationAction,
      { danger: false },
    );
  };
  // 素材卡上的「剪辑已补足」勾：卡片本身是按钮（打开面板 / 预览），捕获阶段先拦下，只切换勾
  const toggleFit = e => {
    const fit = e.target.closest?.('[data-fit-asset]');
    if (!fit) return;
    if (e.type === 'keydown' && e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    const r = rowById(+fit.dataset.fitRow);
    if (!r || !setFitDone(r, fit.dataset.fitAsset, fit.getAttribute('aria-checked') !== 'true')) return;
    if (isInspectorOpen()) renderInspector(true);
  };
  document.addEventListener('click', toggleFit, true);
  document.addEventListener('keydown', toggleFit, true);
  // 任意 data-jump（节奏色条 / 章节目录 / 交稿检查）：跳到那句
  document.addEventListener('click', e => {
    const jump = e.target.closest('[data-jump]');
    if (jump) jumpTo(+jump.dataset.jump);
    // 点句子里的素材卡 / 徽标 / 「共用画面」标题：打开右侧面板
    const detail = e.target.closest('[data-detail]');
    if (detail && !detail.closest('#inspector')) {
      const shared = detail.closest('.shared-scene, .shared-passage');
      const ownerId = +detail.dataset.detail;
      const id = shared && !detail.closest('.row, .as') ? selectedMemberOrOwner(ownerId) : ownerId;
      openInspectorFor(id);
    }
  });
  initColumnResizer();
}
