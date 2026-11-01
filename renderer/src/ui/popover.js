import { viewState } from '../app/view-state.js';
/* 类型菜单；通用的弹出 / 定位 / 关闭在 base/popover.js。 */
import { state } from '../app/state.js';
import { typeMenuItems } from './base/type-view.js';
import { openMenu, initPopover as initPopoverBase } from './base/popover.js';

export function openTypePopover(anchor) {
  const cur = state.rows.find(r => r.id === viewState.sel)?.type ?? null;
  const items =
    `<div class="p-title">标注为</div>` +
    typeMenuItems('data-t', id => cur === id) +
    `<div class="pop-sep"></div><div class="pop-item danger" data-t=""><span class="k">0</span><span>清除标注</span>${cur === null ? '<span class="chk">✓</span>' : ''}</div>`;
  openMenu(anchor, items);
}

export function initPopover() {
  initPopoverBase();
}
