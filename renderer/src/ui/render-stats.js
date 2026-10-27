import { viewState } from '../app/view-state.js';
/* 顶部统计：全片时间与素材挂载总览 + 筛选条 + 进度。 */
import { state } from '../app/state.js';
import { types } from '../app/project-queries.js';
import { shots, linkedUsages } from '../core/shots.js';
import { esc } from './base/dom.js';
import { filterList } from './base/type-view.js';
import { roll } from './base/motion.js';
import { renderOverview } from './timeline-overview.js';

let lastPid = null;
let prevCounts = new Map();
let prevProg = [];

export function renderStats() {
  const lines = state.rows.filter(r => r.kind === 'line');
  const counts = { none: 0 };
  for (const r of lines) counts[r.type || 'none'] = (counts[r.type || 'none'] || 0) + 1;
  const shotGroups = shots(state.rows);
  const shotCounts = { none: 0 };
  for (const [r] of shotGroups) shotCounts[r.type || 'none'] = (shotCounts[r.type || 'none'] || 0) + 1;
  renderOverview(lines);
  const filters = document.querySelector('#filters');
  // 「未标注」为 0 时不占位置（正在用这个筛选时除外）
  const items = filterList()
    .filter(f => f.id !== 'none' || counts.none || viewState.filter === 'none')
    .map(f => ({
      ...f,
      cls: `chip-filter ${viewState.filter === f.id ? 'active' : ''}${f.id !== 'all' && !shotCounts[f.id] ? ' empty' : ''}`,
      n: String(f.id === 'all' ? shotGroups.length : shotCounts[f.id] || 0),
    }));
  const rebuilt = patchFilters(filters, items);
  const samePid = lastPid === state.projectId;
  lastPid = state.projectId;
  const nextCounts = new Map();
  const chips = filters.querySelectorAll('.chip-filter[data-f]');
  items.forEach((f, i) => {
    const n = chips[i].querySelector('.n');
    const before = prevCounts.get(f.id);
    nextCounts.set(f.id, f.n);
    if (samePid && before != null && before !== f.n) {
      if (rebuilt) n.textContent = before;
      roll(n, f.n);
    } else if (!rebuilt && (n.dataset.moRoll ?? n.textContent) !== f.n) {
      delete n.dataset.moRoll;
      n.textContent = f.n;
    }
  });
  prevCounts = nextCounts;
  const ti = types();
  const visualShots = shotGroups.filter(g => g[0].type && ti.needsVisual(g[0].type));
  // 看「有没有挂上要用的素材」（主画面 / 叠加 / 未分配，不算备选）
  const done = lines.length - counts.none,
    linked = visualShots.filter(g => g.some(m => linkedUsages(m).length)).length;
  // 全部标完后「已标 N/N」不再有信息量，只留素材进度
  const prog = document.querySelector('#progressTxt');
  prog.innerHTML =
    (counts.none ? `已标 <b>${done}/${lines.length}</b> 句 · ` : `${lines.length} 句 · `) +
    `已关联素材 <b>${linked}/${visualShots.length}</b> 个镜头`;
  const nums = [...prog.querySelectorAll('b')].map(b => b.textContent);
  if (samePid && nums.length === prevProg.length)
    prog.querySelectorAll('b').forEach((b, i) => {
      if (prevProg[i] !== nums[i]) {
        b.textContent = prevProg[i];
        roll(b, nums[i]);
      }
    });
  prevProg = nums;
  prog.title = `已标注 ${done}/${lines.length} 句 · 需要画面的镜头 ${visualShots.length} 个（共用画面算一个），其中已关联素材 ${linked} 个（备选不算）`;
  document.querySelector('#markTools').hidden = !counts.none;
}

/* 筛选标签原地更新：协作同步、素材变化时统计会频繁重画，整排重建会让标签闪烁，
   按下和松开之间被换掉的按钮也收不到点击。标签种类没变时只改状态；返回是否整排重建。 */
function patchFilters(filters, items) {
  const chips = [...filters.querySelectorAll('.chip-filter[data-f]')];
  if (chips.length !== items.length || chips.some((c, i) => c.dataset.f !== items[i].id)) {
    filters.innerHTML = items
      .map(
        f =>
          `<button class="${f.cls}" data-f="${f.id}" aria-pressed="${f.cls.includes(' active')}"><span class="dot" style="background:${f.color}"></span><span class="lb">${esc(f.label)}</span><span class="n">${f.n}</span></button>`,
      )
      .join('');
    return true;
  }
  items.forEach((f, i) => {
    const chip = chips[i];
    if (chip.className !== f.cls) chip.className = f.cls;
    const pressed = String(f.cls.includes(' active'));
    if (chip.getAttribute('aria-pressed') !== pressed) chip.setAttribute('aria-pressed', pressed);
    const dot = chip.querySelector('.dot');
    if (dot.style.background !== f.color) dot.style.background = f.color;
    const lb = chip.querySelector('.lb');
    if (lb.textContent !== f.label) lb.textContent = f.label;
  });
  return false; // 数字由 renderStats 处理（变了就滚动过去）
}
