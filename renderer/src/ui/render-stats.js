/* 顶部统计：节奏色条（一句一段，宽度 = 时长）+ 筛选条 + 进度。
   句子结构没变（只是改了类型 / 文字）时原地改颜色和宽度，不重建几百上千个按钮 */
import { state, types, lineSeconds } from '../app/state.js';
import { shots, linkedUsages } from '../core/shots.js';
import { esc } from './dom.js';
import { filterList } from './type-view.js';
import { roll, reduced } from './motion.js';

const segColor = r => types().color(r.type) || 'var(--seg-none)';
const segTitle = r => `第 ${r.no} 句 · ${types().label(r.type)} · ${r.text.slice(0, 35)}`;
const segGrow = r => String(Math.max(0.2, lineSeconds(r)));

/* 数字滚动要知道上一次是多少：换项目时清零（换项目不滚，直接显示） */
let lastPid = null;
let prevCounts = new Map();
let prevProg = [];

function renderSegbar(lines) {
  const bar = document.querySelector('#segbar');
  const key = lines.map(r => r.id).join(',');
  if (bar._key !== key) {
    bar._key = key;
    // 打开 / 切换项目时，色条从左往右「画」出来；改稿子（增删句）时不重播
    if (bar._pid !== state.projectId) {
      bar._pid = state.projectId;
      if (!reduced() && lines.length)
        bar.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], {
          duration: 900,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        });
    }
    bar.innerHTML =
      lines
        .map(
          r =>
            `<button class="seg" data-jump="${r.id}" style="flex-grow:${segGrow(r)};background:${segColor(r)}" title="${esc(segTitle(r))}" aria-label="跳到第 ${r.no} 句"></button>`,
        )
        .join('') + '<span class="seg-playhead" id="segPlayhead" hidden></span>';
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
      // 标了一句：色条上对应那一段亮一下
      if (el._bg && !reduced())
        el.animate([{ filter: 'brightness(1.5) saturate(1.3)' }, { filter: 'none' }], {
          duration: 700,
          easing: 'ease-out',
        });
      el._bg = bg;
    }
    if (el.style.flexGrow !== grow) el.style.flexGrow = grow;
    if (el.title !== title) el.title = title;
  });
}

export function renderStats() {
  const lines = state.rows.filter(r => r.kind === 'line');
  const counts = { none: 0 };
  for (const r of lines) counts[r.type || 'none'] = (counts[r.type || 'none'] || 0) + 1;
  const shotGroups = shots(state.rows);
  const shotCounts = { none: 0 };
  for (const [r] of shotGroups) shotCounts[r.type || 'none'] = (shotCounts[r.type || 'none'] || 0) + 1;
  renderSegbar(lines);
  document.querySelector('#filters').innerHTML = filterList()
    // 「未标注」为 0 时不占位置（正在用这个筛选时除外）
    .filter(f => f.id !== 'none' || counts.none || state.filter === 'none')
    .map(
      f =>
        `<button class="chip-filter ${state.filter === f.id ? 'active' : ''}${f.id !== 'all' && !shotCounts[f.id] ? ' empty' : ''}" data-f="${f.id}" aria-pressed="${state.filter === f.id}"><span class="dot" style="background:${f.color}"></span>${esc(f.label)}<span class="n">${f.id === 'all' ? shotGroups.length : shotCounts[f.id] || 0}</span></button>`,
    )
    .join('');
  const filters = document.querySelector('#filters');
  const samePid = lastPid === state.projectId;
  lastPid = state.projectId;
  const nextCounts = new Map();
  for (const chip of filters.querySelectorAll('.chip-filter[data-f]')) {
    const n = chip.querySelector('.n');
    const now = n.textContent;
    const before = prevCounts.get(chip.dataset.f);
    nextCounts.set(chip.dataset.f, now);
    if (samePid && before != null && before !== now) {
      n.textContent = before;
      roll(n, now);
    }
  }
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
