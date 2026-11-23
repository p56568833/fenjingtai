import { viewState } from '../../app/view-state.js';
/* 搜索高亮视图：命中句的关键词加 <mark>、其余句子淡化，原地改在已有元素上。
   不写进句子块的 HTML：开关搜索、换关键词都不用换掉句子块，浏览器记住的行高和滚动位置都不动，页面不闪。 */
import { state } from '../../app/state.js';
import { rowById } from '../../app/project-queries.js';
import { match } from '../../app/selection.js';
import { queryLineIds, qMatch } from '../../app/search-queries.js';
import { searchLineIds } from '../../core/search.js';

const PURE_NUM_RANGE = /^\d{1,6}\s*(?:-|–|—|~|～|到|至)\s*\d{1,6}$/;

/* 纯数字范围（如 2020-2024，不含 #/第/句 修饰）在编号直达为空时回退正文搜索 */
export function resolvedQueryLineIds() {
  const ids = queryLineIds();
  const q = (viewState.query || '').trim();
  if (!ids.length && PURE_NUM_RANGE.test(q)) {
    const fallbackIds = searchLineIds(
      state.rows.filter(r => r.kind === 'line' && match(r)),
      q,
    );
    if (fallbackIds.length) return { ids: fallbackIds, fallback: true };
  }
  return { ids, fallback: false };
}

function unmark(box) {
  const marks = box.querySelectorAll('mark');
  if (!marks.length) return;
  for (const m of marks) m.replaceWith(...m.childNodes);
  box.normalize();
}

/* 关键词可能跨过「没有画面」的红字边界，也可能在一句里出现多次：按文字节点逐段包上所有命中位置 */
function mark(box, query) {
  const q = query.toLowerCase();
  if (!q) return;
  const nodes = [];
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ n, at: text.length, len: n.data.length });
    text += n.data;
  }
  const lower = text.toLowerCase();
  const ranges = [];
  for (let pos = 0; ;) {
    const from = lower.indexOf(q, pos);
    if (from < 0) break;
    ranges.push([from, from + q.length]);
    pos = from + q.length;
  }
  if (!ranges.length) return;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const { n, at, len } = nodes[i];
    const nodeEnd = at + len;
    for (let j = ranges.length - 1; j >= 0; j--) {
      const [from, to] = ranges[j];
      if (from >= nodeEnd) continue;
      if (to <= at) break;
      const a = Math.max(from, at) - at;
      const b = Math.min(to, nodeEnd) - at;
      if (b <= a) continue;
      if (b < n.data.length) n.splitText(b); // n 留下前半段
      const part = a > 0 ? n.splitText(a) : n;
      const m = document.createElement('mark');
      part.replaceWith(m);
      m.append(part);
    }
  }
}

/* scope：要刷的表格范围（整页或刚换掉的那几块）。 */
export function isQueryHit(r) {
  const query = viewState.query;
  if (!query) return true;
  const { ids, fallback } = resolvedQueryLineIds();
  return fallback ? ids.includes(r.id) : qMatch(r);
}

export function paintSearch(scope = document.querySelector('#rows')) {
  if (!scope) return;
  const els = scope.matches?.('.row[data-id]') ? [scope] : scope.querySelectorAll('.row[data-id]');
  const query = viewState.query;
  const { ids, fallback } = query ? resolvedQueryLineIds() : { ids: [], fallback: false };
  const fallbackSet = fallback ? new Set(ids) : null;
  for (const el of els) {
    const r = rowById(+el.dataset.id);
    if (!r) continue;
    const hit = !query || (fallbackSet ? fallbackSet.has(r.id) : qMatch(r));
    el.classList.toggle('qdim', !hit);
    const box = el.classList.contains('row') ? el.querySelector('.sent') : el;
    if (box && !box.isContentEditable) {
      unmark(box);
      if (query && hit) mark(box, query);
    }
    const subBox = el.classList.contains('row') ? el.querySelector('.sent-sub') : null;
    if (subBox && subBox !== document.activeElement) {
      unmark(subBox);
      if (query && hit) mark(subBox, query);
    }
  }
}
