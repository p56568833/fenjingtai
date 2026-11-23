import { viewState } from '../app/view-state.js';
/* 类型菜单；通用的弹出 / 定位 / 关闭在 base/popover.js。 */
import { state } from '../app/state.js';
import { types } from '../app/project-queries.js';
import { typeMenuItems } from './base/type-view.js';
import { openMenu, initPopover as initPopoverBase } from './base/popover.js';

const CLEAR_ICO =
  '<span class="io-ico type" style="--tc:#dc362e"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></span>';

export function openTypePopover(anchor) {
  const cur = state.rows.find(r => r.id === viewState.sel)?.type ?? null;
  const count = types().list.length;
  const items =
    `<div class="io-head"><span class="io-title">标注类型</span><span class="io-tip">按键 1–${count}</span></div>` +
    typeMenuItems('data-t', id => cur === id) +
    `<div class="io-sep"></div><div class="pop-item danger${cur === null ? ' on' : ''}" data-t="">${CLEAR_ICO}<span class="type-name">清除标注</span>${cur === null ? '<span class="chk">✓</span>' : ''}<span class="k">0</span></div>`;
  openMenu(anchor, items, { className: 'type-menu' });
}

export function initPopover() {
  initPopoverBase();
}
