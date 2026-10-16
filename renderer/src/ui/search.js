/* ⌘F 搜索：输入后定位首个结果，↓/↑ 继续向后 / 向前跳转，Enter 选定当前这句并收起搜索。
   也能输入句子编号（248、248-256）或口播时间（26:37、26:37-27:21）直达。 */
import { state, queryLineIds, queryJumpLabel, rowById, match } from '../app/state.js';
import { setView } from './render.js';
import { runCommand } from './base/commands.js';
import { closePop, syncPopToAnchor, popEl } from './base/popover.js';
import { leave, cancelLeave, flash, reduced, SPRING } from './base/motion.js';
import { paintSearch } from './base/search-paint.js';

let timer = null; // 打字防抖；关闭时一并取消，免得关掉后旧关键词又生效

function qMatches() {
  return queryLineIds();
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
  clearTimeout(timer);
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
  // 只原地去掉高亮和淡化，不重画正文：页面不闪，也不会漂回搜索前的位置
  if (state.query) {
    state.query = '';
    paintSearch();
  }
  const inp = document.querySelector('#searchInput');
  inp.value = ''; // 输入框残留旧关键词但不生效，纯属误导
  document.querySelector('#searchCnt').textContent = '';
  document.querySelector('#searchJump').textContent = '';
}

function selectResult(id) {
  // 编号 / 时间直达的句子可能被类型筛选藏起来，这时切回「全部」再跳
  runCommand('nav:jump', id, { preserveFilter: match(rowById(id)) });
  flash(document.querySelector(`.row[data-id="${id}"],.as[data-id="${id}"]`));
}
function qNav(d) {
  const m = qMatches();
  if (!m.length) return;
  const current = m.indexOf(state.sel);
  const i = current < 0 ? (d > 0 ? 0 : m.length - 1) : (current + d + m.length) % m.length;
  selectResult(m[i]);
  updateQCount();
}
function updateQCount() {
  const m = qMatches();
  document.querySelector('#searchCnt').textContent = state.query
    ? `${m.length ? m.indexOf(state.sel) + 1 : 0}/${m.length}`
    : '';
  document.querySelector('#searchJump').textContent = queryJumpLabel();
}

export function initSearch() {
  document.querySelector('#btnSearch').onclick = openSearch;
  document.querySelector('#qClose').onclick = closeSearch;
  // 打字防抖 + 输入法保护：拼音还没上屏时不搜（否则每敲一个字母整页重渲染一次，还拿半截拼音去匹配）
  const inp = document.querySelector('#searchInput');
  let composing = false;
  const apply = () => {
    clearTimeout(timer);
    if (composing) return false;
    const q = inp.value.trim();
    if (q === state.query) return false;
    state.query = q;
    paintSearch(); // 原地刷新高亮和淡化，不换句子块
    const first = qMatches()[0];
    if (first != null) selectResult(first);
    updateQCount();
    return true;
  };
  const navigate = d => {
    if (!apply()) qNav(d);
  };
  // 回车＝选定当前这一句：收起搜索停在这里（防抖还没生效时先定位第一个结果）；没有结果时留着搜索框继续改
  const confirm = () => {
    apply();
    if (qMatches().includes(state.sel)) closeSearch();
  };
  document.querySelector('#qNext').onclick = () => navigate(1);
  document.querySelector('#qPrev').onclick = () => navigate(-1);
  inp.addEventListener('compositionstart', () => {
    composing = true;
    clearTimeout(timer);
  });
  inp.addEventListener('input', e => {
    clearTimeout(timer);
    if (e.isComposing || composing) return;
    timer = setTimeout(apply, 150);
  });
  inp.addEventListener('compositionend', () => {
    composing = false;
    clearTimeout(timer);
    timer = setTimeout(apply, 150);
  });
  document.querySelector('#searchInput').addEventListener('keydown', e => {
    e.stopPropagation();
    if (composing || e.isComposing || e.keyCode === 229) return; // 输入法选字的回车不是「选定」
    if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
    }
    // 上下键在结果之间切换（单行输入框里上下键本来也没有用处）
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      navigate(e.key === 'ArrowDown' ? 1 : -1);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  });
  // 找到了就直接点正文：选中点的那句，搜索收起，页面停在原处
  document.addEventListener(
    'click',
    e => {
      const bar = document.querySelector('#searchbar');
      if (!bar.classList.contains('show') || bar.contains(e.target)) return;
      if (e.target.closest?.('#btnSearch')) return;
      setTimeout(closeSearch); // 等点击本身的处理（选中句子等）先做完
    },
    true,
  );
  // 滚动时：勾选视图的选区卡跟着句子挪，其他弹层（锚着鼠标位置）直接收起
  document.querySelector('#tableWrap').addEventListener(
    'scroll',
    () => {
      // 协作菜单锚在固定顶栏；正文滚动（含跳句后的校准）不改变它的位置。
      if (popEl?._anchor?.id === 'btnCollab') return;
      if (popEl && popEl.classList.contains('hovercard')) syncPopToAnchor();
      else closePop();
    },
    { passive: true },
  );
}
