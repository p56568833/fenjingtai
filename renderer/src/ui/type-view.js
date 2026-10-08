/* 标注类型的界面呈现：类型标签 / 色点 / 标注菜单项。颜色全部由类型主色派生（CSS 里用 --tc）。 */
import { types } from '../app/state.js';
import { ICONS } from '../core/types.js';
import { esc } from './dom.js';

const ARROW =
  '<svg class="arr" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg>';

export const typeIcon = t => ICONS[t?.icon] || ICONS.dot;
export const tcStyle = id => {
  const c = types().color(id);
  return c ? `--tc:${c}` : '';
};

/* 表格「类型」格里的标签：只写短名（和筛选条一致），全名放在悬停提示里 */
export function chipHTML(r) {
  const t = types().get(r.type);
  if (!r.type) return `<div class="tchip t-none">未标注 <kbd>1-${types().list.length}</kbd>${ARROW}</div>`;
  if (!t) return `<div class="tchip typed" style="--tc:#8a93a6">未知类型${ARROW}</div>`;
  return `<div class="tchip typed" style="--tc:${t.color}" title="${esc(t.full)}">${typeIcon(t)}${esc(t.label)}${ARROW}</div>`;
}

/* 标注菜单（表格类型格 / 原文选区卡 共用） */
export function typeMenuItems(attr, isOn) {
  return types()
    .list.map(
      (t, i) =>
        `<div class="pop-item" ${attr}="${t.id}"><span class="k">${i + 1}</span><span class="pdot" style="background:${t.color}"></span><span>${esc(t.full)}</span>${isOn(t.id) ? '<span class="chk">✓</span>' : ''}</div>`,
    )
    .join('');
}

/* 筛选条：全部 + 每个类型 + 未标注 */
export function filterList() {
  return [
    { id: 'all', label: '全部', color: '#8a93a6' },
    ...types().list.map(t => ({ id: t.id, label: t.label, color: t.color })),
    { id: 'none', label: '未标注', color: '#8a93a6' },
  ];
}
