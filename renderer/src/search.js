/* ⌘F 搜索：浮条 + <mark> 高亮 + 其余淡化 + Enter/Shift+Enter 跳转 */
import { state, rowById, visibleLineIds, update, qMatch } from './state.js';
import { renderSelectionOnly } from './render.js';
import { closePop, syncPopToAnchor, popEl } from './popover.js';

function qMatches(){
  return visibleLineIds().filter(id => qMatch(rowById(id)));
}

export function openSearch(){
  document.querySelector('#searchbar').classList.add('show');
  const inp = document.querySelector('#searchInput');
  inp.focus(); inp.select();
}
export function closeSearch(){
  document.querySelector('#searchbar').classList.remove('show');
  if(state.query){ state.query = ''; update('rows'); }
  const inp = document.querySelector('#searchInput');
  inp.value = '';                      // 输入框残留旧关键词但不生效，纯属误导
  document.querySelector('#searchCnt').textContent = '';
}

function qNav(d){
  const m = qMatches();
  if(!m.length) return;
  let i = m.indexOf(state.sel);
  i = (i + d + m.length) % m.length;
  state.sel = m[i]; state.multi = null;
  renderSelectionOnly();
  const el = document.querySelector(`[data-id="${state.sel}"]`);
  el && el.scrollIntoView({block:'center'});
  updateQCount();
}
function updateQCount(){
  const m = qMatches();
  document.querySelector('#searchCnt').textContent = state.query ? `${m.length ? m.indexOf(state.sel)+1 : 0}/${m.length}` : '';
}

export function initSearch(){
  document.querySelector('#btnSearch').onclick = openSearch;
  document.querySelector('#qClose').onclick = closeSearch;
  document.querySelector('#qNext').onclick = ()=>qNav(1);
  document.querySelector('#qPrev').onclick = ()=>qNav(-1);
  document.querySelector('#searchInput').addEventListener('input', e=>{
    state.query = e.target.value.trim();
    update('rows');                            // 重渲染以刷新高亮和淡化
    updateQCount();
  });
  document.querySelector('#searchInput').addEventListener('keydown', e=>{
    e.stopPropagation();
    if(e.key==='Enter'){ e.preventDefault(); qNav(e.shiftKey?-1:1); }
    if(e.key==='Escape'){ e.preventDefault(); closeSearch(); }
  });
  // 滚动时：勾选视图的选区卡跟着句子挪，其他弹层（锚着鼠标位置）直接收起
  document.querySelector('#tableWrap').addEventListener('scroll', ()=>{
    if(popEl && popEl.classList.contains('hovercard')) syncPopToAnchor();
    else closePop();
  }, {passive:true});
}
