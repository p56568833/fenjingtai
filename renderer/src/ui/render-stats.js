/* 顶部统计：节奏色条（一句一段，宽度 = 时长）+ 筛选条 + 进度。
   句子结构没变（只是改了类型 / 文字）时原地改颜色和宽度，不重建几百上千个按钮 */
import { state, types, lineSeconds } from '../app/state.js';
import { shots } from '../core/shots.js';
import { esc } from './dom.js';
import { filterList } from './type-view.js';

const segColor = r => types().color(r.type) || 'var(--seg-none)';
const segTitle = r => `第 ${r.no} 句 · ${types().label(r.type)} · ${r.text.slice(0, 35)}`;
const segGrow = r => String(Math.max(0.2, lineSeconds(r)));

function renderSegbar(lines) {
  const bar = document.querySelector('#segbar');
  const key = lines.map(r => r.id).join(',');
  if (bar._key !== key) {
    bar._key = key;
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
  renderSegbar(lines);
  document.querySelector('#filters').innerHTML = filterList()
    // 「未标注」为 0 时不占位置（正在用这个筛选时除外）
    .filter(f => f.id !== 'none' || counts.none || state.filter === 'none')
    .map(
      f =>
        `<button class="chip-filter ${state.filter === f.id ? 'active' : ''}" data-f="${f.id}" aria-pressed="${state.filter === f.id}"><span class="dot" style="background:${f.color}"></span>${esc(f.label)}<span class="n">${f.id === 'all' ? lines.length : counts[f.id] || 0}</span></button>`,
    )
    .join('');
  const ti = types();
  const visualShots = shots(state.rows)
    .map(g => g[0])
    .filter(r => r.type && ti.needsVisual(r.type));
  // 看「有没有挂上要用的素材」（主画面 / 叠加 / 未分配，不算备选）
  const done = lines.length - counts.none,
    linked = visualShots.filter(r => (r.assetUsages || []).some(u => u.role !== 'alt')).length;
  // 全部标完后「已标 N/N」不再有信息量，只留素材进度；标注工具也一起收起（⌘E 专注标注照常可用）
  const prog = document.querySelector('#progressTxt');
  prog.innerHTML =
    (counts.none ? `已标 <b>${done}/${lines.length}</b> · ` : '') + `已挂素材 <b>${linked}/${visualShots.length}</b>`;
  prog.title = `已标注 ${done}/${lines.length} 句 · 需要画面的 ${visualShots.length} 个画面里已挂素材 ${linked} 个`;
  document.querySelector('#markTools').hidden = !counts.none;
}
