/* 搜索高亮视图：命中句的关键词加 <mark>、其余句子淡化，原地改在已有元素上。
   不写进句子块的 HTML：开关搜索、换关键词都不用换掉句子块，浏览器记住的行高和滚动位置都不动，页面不闪。 */
import { state, rowById, qMatch } from '../../app/state.js';

function unmark(box) {
  const marks = box.querySelectorAll('mark');
  if (!marks.length) return;
  for (const m of marks) m.replaceWith(...m.childNodes);
  box.normalize();
}

/* 关键词可能跨过「没有画面」的红字边界：按文字节点逐段包上 */
function mark(box, query) {
  const nodes = [];
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ n, at: text.length });
    text += n.data;
  }
  const from = text.toLowerCase().indexOf(query.toLowerCase());
  if (from < 0) return;
  const to = from + query.length;
  for (const { n, at } of nodes) {
    const a = Math.max(from, at) - at,
      b = Math.min(to, at + n.data.length) - at;
    if (b <= a) continue;
    if (b < n.data.length) n.splitText(b); // n 留下前半段
    const part = a > 0 ? n.splitText(a) : n;
    const m = document.createElement('mark');
    part.replaceWith(m);
    m.append(part);
  }
}

/* scope：要刷的范围（整页或刚换掉的那几块）；表格的 .row 和原文视图的 .as 都在 #rows 里 */
export function paintSearch(scope = document.querySelector('#rows')) {
  if (!scope) return;
  const els = scope.matches?.('.row[data-id],.as[data-id]')
    ? [scope]
    : scope.querySelectorAll('.row[data-id],.as[data-id]');
  const query = state.query;
  for (const el of els) {
    const r = rowById(+el.dataset.id);
    if (!r) continue;
    const hit = !query || qMatch(r);
    el.classList.toggle('qdim', !hit);
    const box = el.classList.contains('row') ? el.querySelector('.sent') : el;
    if (!box || box.isContentEditable) continue; // 正在改这句：不动文字，免得光标乱跳
    unmark(box);
    if (query && hit) mark(box, query);
  }
}
