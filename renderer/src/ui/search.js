/* ⌘F 搜索：浮条 + <mark> 高亮 + 其余淡化 + Enter/Shift+Enter 跳转 */
import { state, rowById, visibleLineIds, emit, qMatch } from '../app/state.js';
import { renderSelectionOnly, setView } from './render.js';
import { closePop, syncPopToAnchor, popEl } from './popover.js';
import { leave, cancelLeave, flash, reduced, SPRING } from './motion.js';

function qMatches() {
  return visibleLineIds().filter(id => qMatch(rowById(id)));
}

export function openSearch() {
  if (state.view === 'review') setView('table'); // 搜索的是稿件句子，直接显示搜索结果所在的页面
  const bar = document.querySelector('#searchbar');
  cancelLeave(bar);
  const was = bar.classList.contains('show');
  bar.classList.add('show');
  // 搜索框从右上角的放大镜那里横着展开
  if (!was && !reduced())
    bar.animate(
      [
        { clipPath: 'inset(0 0 0 calc(100% - 44px) round 12px)', opacity: 0.4, transform: 'translateY(-6px)' },
        { clipPath: 'inset(0 0 0 0 round 12px)', opacity: 1, transform: 'none' },
      ],
      { duration: 420, easing: SPRING },
    );
  const inp = document.querySelector('#searchInput');
  inp.focus();
  inp.select();
}
export function closeSearch() {
  const bar = document.querySelector('#searchbar');
  leave(
    bar,
    [
      { clipPath: 'inset(0 0 0 0 round 12px)', opacity: 1 },
      { clipPath: 'inset(0 0 0 calc(100% - 44px) round 12px)', opacity: 0 },
    ],
    { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
    () => bar.classList.remove('show'),
  );
  if (state.query) {
    state.query = '';
    emit('rows');
  }
  const inp = document.querySelector('#searchInput');
  inp.value = ''; // 输入框残留旧关键词但不生效，纯属误导
  document.querySelector('#searchCnt').textContent = '';
}

function qNav(d) {
  const m = qMatches();
  if (!m.length) return;
  let i = m.indexOf(state.sel);
  i = (i + d + m.length) % m.length;
  state.sel = m[i];
  state.multi = null;
  renderSelectionOnly();
  const el = document.querySelector(`[data-id="${state.sel}"]`);
  el && el.scrollIntoView({ block: 'center' });
  flash(el); // 跳到的那句荡开一圈光
  updateQCount();
}
function updateQCount() {
  const m = qMatches();
  document.querySelector('#searchCnt').textContent = state.query
    ? `${m.length ? m.indexOf(state.sel) + 1 : 0}/${m.length}`
    : '';
}

export function initSearch() {
  document.querySelector('#btnSearch').onclick = openSearch;
  document.querySelector('#qClose').onclick = closeSearch;
  document.querySelector('#qNext').onclick = () => qNav(1);
  document.querySelector('#qPrev').onclick = () => qNav(-1);
  // 打字防抖 + 输入法保护：拼音还没上屏时不搜（否则每敲一个字母整页重渲染一次，还拿半截拼音去匹配）
  const inp = document.querySelector('#searchInput');
  let timer = null;
  const apply = () => {
    clearTimeout(timer);
    const q = inp.value.trim();
    if (q === state.query) return;
    state.query = q;
    emit('rows'); // 重渲染以刷新高亮和淡化
    updateQCount();
  };
  inp.addEventListener('input', e => {
    if (e.isComposing) return;
    clearTimeout(timer);
    timer = setTimeout(apply, 150);
  });
  inp.addEventListener('compositionend', () => {
    clearTimeout(timer);
    timer = setTimeout(apply, 150);
  });
  document.querySelector('#searchInput').addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return; // 输入法选字的回车不是「下一个」
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
      qNav(e.shiftKey ? -1 : 1);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  });
  // 滚动时：勾选视图的选区卡跟着句子挪，其他弹层（锚着鼠标位置）直接收起
  document.querySelector('#tableWrap').addEventListener(
    'scroll',
    () => {
      if (popEl && popEl.classList.contains('hovercard')) syncPopToAnchor();
      else closePop();
    },
    { passive: true },
  );
}
