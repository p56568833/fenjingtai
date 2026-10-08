/* 工作区：导航（跳句 / 下一个未标注 / 恢复光标）+ 侧栏、工具条、徽标的统一刷新 + 列宽拖动 */
import { state, on, emit, update, rowById } from '../app/state.js';
import { rememberCursor } from '../app/storage.js';
import { repairPunctuationAction } from '../app/actions.js';
import { repairCandidates } from '../core/shots.js';
import { toast, confirmModal } from './dom.js';
import { closePop } from './popover.js';
import { renderOutline, initOutline } from './outline.js';
import { renderToolbar, initToolbar } from './toolbar.js';
import { renderInspector, initInspector, isInspectorOpen, openInspectorFor } from './inspector.js';
import { initReview } from './review.js';
import { rowBadges, refreshMissing, resetMissing } from './badges.js';
import { registerCommand } from './commands.js';
import { flash } from './motion.js';

const $ = s => document.querySelector(s);
let lastProject = null;

export { openInspectorFor };
export { openReview } from './review.js';

export function jumpTo(id) {
  if (!rowById(id)) return;
  closePop();
  const filtered = state.filter !== 'all';
  state.filter = 'all';
  state.multi = null;
  const r = rowById(id);
  state.sel =
    r.kind === 'section' ? (state.rows.slice(state.rows.indexOf(r) + 1).find(x => x.kind === 'line')?.id ?? null) : id;
  if (filtered) emit('rows');
  else update('selection');
  // 章节标题会吸顶，当前坐标不是章节起点；定位首句也能让浏览器展开屏幕外的正文。
  const el = document.querySelector(`.row[data-id="${state.sel}"],.as[data-id="${state.sel}"]`);
  // 目标本来就在眼前（比如标完自动跳下一句）就不闪了，只有真的「跳过去」才闪
  const box = $('#tableWrap')?.getBoundingClientRect();
  const at = el?.getBoundingClientRect();
  const far = !!(box && at && (at.top < box.top || at.bottom > box.bottom));
  el?.scrollIntoView({ block: 'center' });
  const selectedId = state.sel;
  requestAnimationFrame(() => {
    // content-visibility 展开后行高可能变化，下一帧校准；新导航或项目切换后不再滚旧目标。
    if (state.sel === selectedId && el?.isConnected) el.scrollIntoView({ block: 'center' });
    const now = document.querySelector(`.row[data-id="${selectedId}"],.as[data-id="${selectedId}"]`);
    if (far && state.sel === selectedId) flash(now); // 跳过去的那句荡开一圈光：告诉你「是这句」
  });
  rememberCursor();
}

export function nextUnmarked() {
  const lines = state.rows.filter(r => r.kind === 'line');
  const i = lines.findIndex(r => r.id === state.sel);
  const ordered = [...lines.slice(i + 1), ...lines.slice(0, i + 1)];
  const next = ordered.find(r => !r.type);
  if (next) jumpTo(next.id);
  else toast('所有句子都已标注');
}
export function revealSavedCursor() {
  requestAnimationFrame(() => {
    const el = document.querySelector(`.row[data-id="${state.sel}"],.as[data-id="${state.sel}"]`);
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
  if (isInspectorOpen() && !$('#inspector').contains(document.activeElement)) renderInspector(true);
}

function refresh() {
  renderOutline();
  renderToolbar();
  rowBadges();
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
  on('workspace', refresh);
  on('cursor', () => {
    rememberCursor();
    renderToolbar();
    renderOutline();
  });
  on('annotated', ({ type }) => {
    if (state.autoAdvance && type && !state.focusMode) nextUnmarked();
  });
  $('#btnNext').onclick = nextUnmarked;
  try {
    state.autoAdvance = localStorage.getItem('fjz:autoAdvance') === 'true';
  } catch {}
  $('#autoAdvance').checked = state.autoAdvance;
  $('#autoAdvance').onchange = e => {
    state.autoAdvance = e.target.checked;
    try {
      localStorage.setItem('fjz:autoAdvance', String(state.autoAdvance));
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
  // 任意 data-jump（节奏色条 / 章节目录 / 交稿检查）：跳到那句
  document.addEventListener('click', e => {
    const jump = e.target.closest('[data-jump]');
    if (jump) jumpTo(+jump.dataset.jump);
    // 点句子里的素材卡 / 徽标 / 「共用画面」标题：打开右侧面板
    const detail = e.target.closest('[data-detail]');
    if (detail && !detail.closest('#inspector')) openInspectorFor(+detail.dataset.detail);
  });
  initColumnResizer();
}
