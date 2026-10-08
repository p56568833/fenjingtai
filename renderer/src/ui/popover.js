/* 弹出菜单：定位 / 关闭 / 类型菜单 / 时长统计。菜单项点击由各功能模块自己监听 data-*。 */
import { state, types, timeline, lineSeconds } from '../app/state.js';
import { setSpeechRate } from '../app/actions.js';
import { clearTiming } from '../app/subtitle.js';
import { SOURCE_TEXT } from '../core/timeline.js';
import { esc } from './dom.js';
import { typeMenuItems } from './type-view.js';
import { runCommand } from './commands.js';
import { glide } from './motion.js';

export let popEl = null;
let lastInput = 'mouse'; // 最近一次是键盘还是鼠标：键盘打开的菜单直接把焦点放到第一项
export const closePop = ({ restoreFocus = false } = {}) => {
  const anchor = popEl?._anchor;
  const hadFocus = popEl?.contains(document.activeElement);
  setAnchorOpen(anchor, false);
  popEl && popEl.remove();
  popEl = null;
  if ((restoreFocus || hadFocus) && anchor?.isConnected && typeof anchor.focus === 'function')
    anchor.focus({ preventScroll: true });
};
/* 菜单里能按的项：带 data-* 动作、没被禁用的 .pop-item，以及菜单里的按钮 / 输入框 */
const menuItems = () =>
  popEl
    ? [...popEl.querySelectorAll('.pop-item, button, input')].filter(
        el =>
          !el.closest('.disabled') &&
          !el.disabled &&
          (el.tagName !== 'DIV' || Object.keys(el.dataset).length > 0) &&
          !(el.tagName === 'BUTTON' && el.closest('.pop-item')),
      )
    : [];
function wireMenuA11y() {
  popEl.setAttribute('role', 'menu');
  for (const el of menuItems())
    if (el.tagName === 'DIV') {
      el.setAttribute('role', 'menuitem');
      el.tabIndex = -1;
    }
  // 原文视图跟着选区弹出的选区卡（opts.pos）不是菜单：不抢焦点、不接管方向键，方向键照常换句
  popEl._kbd = lastInput === 'key' && !popEl._pos;
  if (popEl._kbd) {
    const el = popEl;
    setTimeout(() => el === popEl && menuItems()[0]?.focus({ preventScroll: true }), 0);
  }
}
/* 菜单打开时：↑↓ 在项之间移动、回车 / 空格执行、Esc 关闭并把焦点还给打开它的按钮 */
function menuKey(e) {
  if (!popEl) return;
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!popEl.contains(document.activeElement) && !popEl._kbd) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const n = items.length;
    if (!n) return;
    const next = e.key === 'ArrowDown' ? (i + 1 + n) % n : (i - 1 + n) % n;
    items[i < 0 ? 0 : next].focus({ preventScroll: true });
  } else if ((e.key === 'Enter' || e.key === ' ') && i >= 0 && items[i].tagName === 'DIV') {
    e.preventDefault();
    e.stopImmediatePropagation();
    items[i].click();
  } else if (e.key === 'Escape' && popEl.contains(document.activeElement)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    closePop({ restoreFocus: true });
  }
}

/* 弹层定位：有锚点（顶栏按钮、类型标签、「…」按钮）就贴着锚点弹——
   锚点在窗口左半边就左对齐、在右半边就右对齐，下面放不下翻到上面；菜单从锚点那一角「长」出来。
   只有原文视图里鼠标划选的选区卡（opts.atMouse）才跟着光标。 */
const mouse = { x: 0, y: 0, seen: false };
const GAP = 6;
function setAnchorOpen(anchor, open) {
  if (!anchor?.classList || anchor.classList.contains('as')) return;
  anchor.classList.toggle('pop-open', open);
  if (anchor.tagName === 'BUTTON') anchor.setAttribute('aria-expanded', String(open));
}

export function openMenu(anchor, html, opts = {}) {
  closePop();
  popEl = document.createElement('div');
  popEl.className = 'popover';
  popEl.innerHTML = html;
  popEl.style.visibility = 'hidden'; // 先量尺寸再定位，别闪现在旧位置
  document.body.appendChild(popEl);
  const pw = popEl.offsetWidth,
    ph = popEl.offsetHeight;
  let x, y;
  if (opts.pos) {
    // 勾选视图的选区卡：锚在句子给定位置，贴边翻转，滚动时 syncPopToAnchor 按这个点重新定位
    popEl._pos = opts.pos;
    x = Math.max(8, Math.min(opts.pos.x, innerWidth - pw - 8));
    y = opts.pos.y + ph > innerHeight - 52 ? Math.max(8, opts.pos.y - ph - 12) : opts.pos.y;
  } else if (anchor && !opts.atMouse) {
    popEl._pos = null;
    const r = anchor.getBoundingClientRect();
    const alignRight = r.left + r.width / 2 > innerWidth / 2;
    x = alignRight ? r.right - pw : r.left;
    y = r.bottom + GAP;
    let up = false;
    if (y + ph > innerHeight - 12 && r.top - GAP - ph >= 8) {
      y = r.top - GAP - ph;
      up = true;
    } else if (y + ph > innerHeight - 12) y = Math.max(8, innerHeight - 12 - ph);
    x = Math.max(8, Math.min(x, innerWidth - pw - 8));
    popEl.style.transformOrigin = `${up ? 'bottom' : 'top'} ${alignRight ? 'right' : 'left'}`;
    popEl.classList.toggle('pop-up', up);
  } else {
    popEl._pos = null;
    const m = mouse.seen ? mouse : { x: 8, y: 8 };
    x = m.x + 10;
    y = m.y + 14;
    if (x + pw > innerWidth - 8) x = m.x - pw - 10;
    if (y + ph > innerHeight - 52) y = Math.max(8, m.y - ph - 14);
    x = Math.max(8, Math.min(x, innerWidth - pw - 8));
    y = Math.max(8, y);
  }
  if (opts.sub) popEl.classList.add('pop-sub');
  popEl.style.left = x + 'px';
  popEl.style.top = y + 'px';
  popEl.style.visibility = '';
  wireMenuA11y();
  wireHoverGlide(popEl);
}
/* 菜单里的灰色高亮块跟着鼠标（或键盘焦点）在项之间滑，像 macOS 的菜单 */
function wireHoverGlide(el) {
  const hoverable = t => t?.closest?.('.pop-item:not(.disabled)');
  const to = item => item && el.contains(item) && glide(el, item, 'pop-glide');
  el.addEventListener('mouseover', e => to(hoverable(e.target)));
  el.addEventListener('focusin', e => to(hoverable(e.target)));
  el.addEventListener('mouseleave', () => {
    if (!el.contains(document.activeElement)) glide(el, null, 'pop-glide');
  });
}
/* 滚动时把选区卡挪回锚点句子旁边（卡片属于选中句，不跟着滚就悬空了） */
export function syncPopToAnchor() {
  if (!popEl || !popEl._anchor) return closePop();
  if (!popEl._anchor.isConnected) return closePop();
  const r = popEl._anchor.getBoundingClientRect();
  const pw = popEl.offsetWidth,
    ph = popEl.offsetHeight;
  const x = Math.max(8, Math.min(r.left, innerWidth - pw - 8));
  const y0 = r.bottom + 8;
  const y = y0 + ph > innerHeight - 52 ? Math.max(8, y0 - ph - 12) : y0;
  popEl.style.left = x + 'px';
  popEl.style.top = y + 'px';
}
export const popOpenFor = anchor => !!(popEl && popEl._anchor === anchor);
export const markPopAnchor = anchor => {
  if (!popEl) return;
  popEl._anchor = anchor;
  setAnchorOpen(anchor, true);
};

export function openTypePopover(anchor) {
  const cur = state.rows.find(r => r.id === state.sel)?.type ?? null;
  const items =
    `<div class="p-title">标注为</div>` +
    typeMenuItems('data-t', id => cur === id) +
    `<div class="pop-sep"></div><div class="pop-item danger" data-t=""><span class="k">0</span><span>清除标注</span>${cur === null ? '<span class="chk">✓</span>' : ''}</div>`;
  openMenu(anchor, items);
}

const fmtDur = sec => (sec >= 60 ? (sec / 60).toFixed(1) + ' 分钟' : Math.round(sec) + ' 秒');

export function openDurPopover(anchor) {
  const lines = state.rows.filter(r => r.kind === 'line');
  const ti = types();
  const tot = { none: 0 };
  ti.list.forEach(t => (tot[t.id] = 0));
  let total = 0;
  for (const r of lines) {
    const d = lineSeconds(r);
    total += d;
    tot[r.type && Object.hasOwn(tot, r.type) ? r.type : 'none'] += d;
  }
  const tl = timeline();
  const rowHtml = (id, label, color) =>
    `<div class="pop-item" style="cursor:default"><span class="pdot" style="background:${color}"></span><span>${esc(label)}</span><span style="margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--text-2)">${fmtDur(tot[id])}</span></div>`;
  const approx = lines.filter(r => !(r.time && r.time.st === 'ok')).length;
  const head =
    tl.source === 'srt'
      ? `时长 · 字幕实测${approx ? `（${approx} 句为推算 / 估算）` : ''}`
      : tl.source === 'fit'
        ? `时长 · ${SOURCE_TEXT.fit}（相当于 ${tl.rate.toFixed(1)} 字/秒）`
        : `时长估算 · 按 ${state.speechRate} 字/秒`;
  const timed = state.timing;
  const timingHtml = timed
    ? `<div class="pop-sep"></div><div class="p-title">剪映字幕 · ${esc(timed.name)}</div>
       <div class="dur-actions"><button class="btn" id="durRealign" title="改过稿子后，用同一份字幕重新对齐">重新对齐</button><button class="btn" id="durPickSrt">换一份字幕</button><button class="btn" id="durClearTiming">清除字幕时间</button></div>`
    : `<div class="pop-sep"></div><div class="dur-actions"><button class="btn" id="durPickSrt" title="录完口播后，用剪映导出的 SRT 字幕换成真实时间">对齐剪映字幕（SRT）…</button></div>`;
  const voiceHtml = state.voice
    ? `<div class="p-title">口播音频 · ${esc(state.voice.name)}</div><div class="dur-actions"><button class="btn" id="durVoice">更换…</button><button class="btn" id="durVoiceClear">移除</button></div>`
    : `<div class="dur-actions"><button class="btn" id="durVoice" title="导入录好的口播音频：逐句播放、和画面对着预览；没对字幕时按音频长度推算每句时间">导入口播音频…</button></div>`;
  openMenu(
    anchor,
    `
    <div class="p-title">${head}</div>
    <div class="pop-item" style="cursor:default;font-weight:700"><span>全片约</span><span style="margin-left:auto;font-family:var(--mono);font-size:13px">${fmtDur(total)}</span></div>
    <div class="pop-sep"></div>
    ${ti.list.map(t => rowHtml(t.id, t.full, t.color)).join('')}
    ${rowHtml('none', '未标注', 'var(--seg-none)')}
    ${tl.source === 'rate' ? `<label class="rate-control">语速 <input id="speechRate" type="number" min="1" max="10" step="0.1" value="${state.speechRate}"> 字 / 秒 <button class="btn" id="saveRate">应用</button></label>` : ''}
    ${timingHtml}
    <div class="pop-sep"></div>
    ${voiceHtml}
  `,
  );
}

export function initPopover() {
  document.addEventListener(
    'keydown',
    e => {
      lastInput = 'key';
      menuKey(e);
    },
    true,
  );
  document.addEventListener('mousedown', () => (lastInput = 'mouse'), true);
  // 时长菜单里的按钮：字幕 / 口播音频相关的动作由各功能模块登记成命令
  document.addEventListener('click', e => {
    const b = e.target.closest('#durRealign, #durPickSrt, #durClearTiming, #durVoice, #durVoiceClear');
    if (b) {
      closePop();
      if (b.id === 'durClearTiming') clearTiming();
      else
        runCommand(
          { durRealign: 'srt:realign', durPickSrt: 'srt:pick', durVoice: 'voice:pick', durVoiceClear: 'voice:clear' }[
            b.id
          ],
        );
      return;
    }
    if (!e.target.closest('#saveRate')) return;
    if (setSpeechRate(Number(document.querySelector('#speechRate')?.value))) closePop();
  });
  window.addEventListener(
    'mousemove',
    e => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.seen = true;
    },
    { passive: true },
  );
  document.addEventListener('click', e => {
    if (
      popEl &&
      !popEl.contains(e.target) &&
      !e.target.closest('.tchip') &&
      !e.target.closest('.as') &&
      !e.target.closest('#btnImport') &&
      !e.target.closest('#btnExport') &&
      !e.target.closest('#btnHelp') &&
      !e.target.closest('#btnDur') &&
      !e.target.closest('#btnProjects')
    )
      closePop();
  });
  // 窗口尺寸一变，按旧位置定位的弹层就悬空了，直接收起
  window.addEventListener('resize', closePop);
}
