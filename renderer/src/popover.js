/* 弹出菜单：定位 / 关闭 / 类型菜单 / 时长统计。菜单项点击由各功能模块自己监听 data-*。 */
import { state, currentSelection } from './state.js';
import { TYPES, TYPE_ORDER } from './types.js';
import { durNum } from './util.js';

export let popEl = null;
export const closePop = () => { popEl && popEl.remove(); popEl = null; };

/* 弹层跟手：记住光标位置，弹在光标右下角，贴边自动翻到左边/上边。
   拿不到鼠标坐标时（键盘触发、自动化测试的合成事件）回退到贴锚点下方。 */
const mouse = { x: 0, y: 0, seen: false };

export function openMenu(anchor, html, opts = {}){
  closePop();
  popEl = document.createElement('div'); popEl.className = 'popover';
  popEl.innerHTML = html;
  popEl.style.visibility = 'hidden';              // 先量尺寸再定位，别闪现在旧位置
  document.body.appendChild(popEl);
  const pw = popEl.offsetWidth, ph = popEl.offsetHeight;
  let x, y;
  if(opts.pos){
    // 勾选视图的选区卡：锚在句子给定位置，贴边翻转，滚动时 syncPopToAnchor 按这个点重新定位
    popEl._pos = opts.pos;
    x = Math.max(8, Math.min(opts.pos.x, innerWidth - pw - 8));
    y = opts.pos.y + ph > innerHeight - 52 ? Math.max(8, opts.pos.y - ph - 12) : opts.pos.y;
  } else if(mouse.seen){
    popEl._pos = null;
    x = mouse.x + 10; y = mouse.y + 14;
    if(x + pw > innerWidth - 8) x = mouse.x - pw - 10;
    if(y + ph > innerHeight - 52) y = Math.max(8, mouse.y - ph - 14);
    x = Math.max(8, Math.min(x, innerWidth - pw - 8));
    y = Math.max(8, y);
  } else {
    popEl._pos = null;
    const r = anchor ? anchor.getBoundingClientRect() : {left:8, top:8, bottom:8};
    x = Math.min(r.left, innerWidth - pw - 12);
    y = r.bottom + 9;
    if(y + ph > innerHeight - 48) y = Math.max(8, r.top - ph - 9);
    x = Math.max(8, x);
  }
  popEl.style.left = x+'px'; popEl.style.top = y+'px';
  popEl.style.visibility = '';
}
/* 滚动时把选区卡挪回锚点句子旁边（卡片属于选中句，不跟着滚就悬空了） */
export function syncPopToAnchor(){
  if(!popEl || !popEl._anchor) return closePop();
  if(!popEl._anchor.isConnected) return closePop();
  const r = popEl._anchor.getBoundingClientRect();
  const pw = popEl.offsetWidth, ph = popEl.offsetHeight;
  const x = Math.max(8, Math.min(r.left, innerWidth - pw - 8));
  const y0 = r.bottom + 8;
  const y = y0 + ph > innerHeight - 52 ? Math.max(8, y0 - ph - 12) : y0;
  popEl.style.left = x+'px'; popEl.style.top = y+'px';
}
export const popOpenFor = anchor => !!(popEl && popEl._anchor === anchor);
export const markPopAnchor = anchor => { if(popEl) popEl._anchor = anchor; };

export function openTypePopover(anchor){
  const cur = (state.rows.find(r=>r.id===state.sel)||{}).type ?? '?';
  let items = `<div class="p-title">标注为</div>`;
  TYPE_ORDER.forEach((k,idx)=>{
    const t = TYPES[k];
    items += `<div class="pop-item" data-t="${k}"><span class="k">${idx+1}</span><span class="pdot" style="background:${t.color}"></span><span>${t.full}</span>${cur===k?'<span class="chk">✓</span>':''}</div>`;
  });
  items += `<div class="pop-sep"></div><div class="pop-item danger" data-t=""><span class="k">0</span><span>清除标注</span>${cur===null?'<span class="chk">✓</span>':''}</div>`;
  openMenu(anchor, items);
}

export function openDurPopover(anchor){
  const lines = state.rows.filter(r=>r.kind==='line');
  const tot = {none:0}; TYPE_ORDER.forEach(k=>tot[k]=0);
  let total = 0;
  lines.forEach(r=>{
    const d = durNum(r.text||'');
    total += d;
    if(r.type) tot[r.type]+=d; else tot.none+=d;
  });
  const fmt = m => m>=1 ? m.toFixed(1)+' 分钟' : Math.round(m*60)+' 秒';
  const rowHtml = k => `<div class="pop-item" style="cursor:default"><span class="pdot" style="background:${k==='none'?'var(--seg-none)':TYPES[k].color}"></span><span>${k==='none'?'未标注':TYPES[k].full}</span><span style="margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--text-2)">${fmt(tot[k]/60)}</span></div>`;
  openMenu(anchor, `
    <div class="p-title">时长估算 · 按 4.5 字/秒</div>
    <div class="pop-item" style="cursor:default;font-weight:700"><span>全片约</span><span style="margin-left:auto;font-family:var(--mono);font-size:13px">${fmt(total/60)}</span></div>
    <div class="pop-sep"></div>
    ${TYPE_ORDER.map(rowHtml).join('')}
    ${rowHtml('none')}
  `);
}

export function initPopover(){
  window.addEventListener('mousemove', e=>{ mouse.x = e.clientX; mouse.y = e.clientY; mouse.seen = true; }, {passive:true});
  document.addEventListener('click', e=>{
    if(popEl && !popEl.contains(e.target)
      && !e.target.closest('.tchip') && !e.target.closest('.as')
      && !e.target.closest('#btnImport') && !e.target.closest('#btnExport')
      && !e.target.closest('#btnDur') && !e.target.closest('#btnProjects')) closePop();
  });
  // 窗口尺寸一变，按旧位置定位的弹层就悬空了，直接收起
  window.addEventListener('resize', closePop);
}
