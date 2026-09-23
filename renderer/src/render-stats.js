import { shots } from './production.js';
import { state } from './state.js';
import { TYPES, FILTERS } from './types.js';
import { esc, lineSeconds } from './util.js';
/* 顶部节奏色条：一句一段。句子结构没变（只是改了类型 / 文字）时原地改颜色和宽度，
   不重建几百上千个按钮——长稿里每标一句都整条重建是主要卡顿来源 */
const segColor = r => (r.type ? TYPES[r.type].color : 'var(--seg-none)');
const segTitle = r => `第 ${r.no} 句 · ${r.type ? TYPES[r.type].label : '未标注'} · ${r.text.slice(0, 35)}`;
const segGrow = r => String(Math.max(0.2, lineSeconds(r)));
function renderSegbar(lines) {
  const bar = document.querySelector('#segbar');
  const key = lines.map(r => r.id).join(',');
  if (bar._key !== key) {
    bar._key = key;
    bar.innerHTML = lines
      .map(
        r =>
          `<button class="seg" data-jump="${r.id}" style="flex-grow:${segGrow(r)};background:${segColor(r)}" title="${esc(segTitle(r))}" aria-label="跳到第 ${r.no} 句"></button>`,
      )
      .join('');
    return;
  }
  const segs = bar.children;
  lines.forEach((r, i) => {
    const el = segs[i],
      bg = segColor(r),
      grow = segGrow(r),
      title = segTitle(r);
    if (el._bg !== bg) {
      el.style.background = bg;
      el._bg = bg;
    }
    if (el.style.flexGrow !== grow) el.style.flexGrow = grow;
    if (el.title !== title) el.title = title;
  });
}

export function renderStats() {
  const lines = state.rows.filter(r => r.kind === 'line');
  const counts = { none: 0 };
  Object.keys(TYPES).forEach(k => (counts[k] = 0));
  lines.forEach(r => counts[r.type || 'none']++);
  renderSegbar(lines);
  document.querySelector('#filters').innerHTML = FILTERS.map(
    f =>
      `<button class="chip-filter ${state.filter === f.id ? 'active' : ''}" data-f="${f.id}" aria-pressed="${state.filter === f.id}"><span class="dot" style="background:${f.color}"></span>${f.label}<span class="n">${f.id === 'all' ? lines.length : counts[f.id]}</span></button>`,
  ).join('');
  const b = shots(state.rows)
    .map(g => g[0])
    .filter(r => r.type && r.type !== 'a');
  const done = lines.length - counts.none,
    ready = b.filter(r => r.status === 'ready').length;
  document.querySelector('#progressTxt').innerHTML =
    `已标 <b>${done}/${lines.length}</b> · 素材就绪 <b>${ready}/${b.length}</b>`;
}
