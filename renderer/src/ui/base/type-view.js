/* 标注类型的界面呈现：类型标签 / 色点 / 标注菜单项。颜色全部由类型主色派生（CSS 里用 --tc）。 */
import { types } from '../../app/project-queries.js';
import { ICONS } from '../../core/types.js';
import { esc } from './dom.js';

const ARROW =
  '<svg class="arr" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg>';

export const typeIcon = t => ICONS[t?.icon] || ICONS.dot;

/* 表格「类型」格里的标签：只写短名（和筛选条一致），全名放在悬停提示里 */
export function chipHTML(r) {
  const t = types().get(r.type);
  if (!r.type) return `<div class="tchip t-none">未标注 <kbd>1-${types().list.length}</kbd>${ARROW}</div>`;
  if (!t) return `<div class="tchip typed" style="--tc:#8a93a6">未知类型${ARROW}</div>`;
  return `<div class="tchip typed" style="--tc:${esc(t.color)}" title="${esc(t.full)}">${typeIcon(t)}${esc(t.label)}${ARROW}</div>`;
}

/* 标注菜单（表格类型格）：带各类型色标徽章 + 快捷键帽 + 当前选中标识 */
export function typeMenuItems(attr, isOn) {
  return types()
    .list.map((t, i) => {
      const on = isOn(t.id);
      return `<div class="pop-item${on ? ' on' : ''}" ${attr}="${esc(t.id)}"><span class="io-ico type" style="--tc:${esc(t.color)}">${typeIcon(t)}</span><span class="type-name">${esc(t.full)}</span>${on ? '<span class="chk">✓</span>' : ''}<span class="k">${i + 1}</span></div>`;
    })
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
