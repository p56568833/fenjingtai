/* 左侧章节目录：各章句数 / 未标数，点击跳转；高亮跟随正文浏览位置 */
import { state } from '../app/state.js';
import { esc } from './dom.js';
import { glide, leave, cancelLeave, reduced, EASE_OUT } from './motion.js';

let outlineOpen = true;
let lastKey = '';
let items = [];
let frame = 0;
let jumpTarget = null;

function syncActiveOutline() {
  frame = 0;
  if (!outlineOpen || !items.length) return;
  let active = jumpTarget?.project === state.projectId && jumpTarget.view === state.view ? jumpTarget.id : null;
  if (active !== null) return showActiveOutline(active);
  const wrap = document.querySelector('#tableWrap');
  const box = wrap.getBoundingClientRect();
  const probe = box.top + box.height * 0.5;
  for (const item of items) {
    const anchor = item.sectionId
      ? document.querySelector(`${state.view === 'check' ? '.ck-sec' : '.section-row'}[data-sid="${item.sectionId}"]`)
      : document.querySelector(`.row[data-id="${item.jump}"],.as[data-id="${item.jump}"]`);
    if (!anchor) continue; // 筛选后这一章可能没有可见句子
    if (active === null || anchor.getBoundingClientRect().top <= probe) active = item.jump;
    else break;
  }
  showActiveOutline(active);
}

function showActiveOutline(active) {
  const outline = document.querySelector('#outline');
  for (const button of outline.querySelectorAll('.outline-item')) {
    button.classList.toggle('active', +button.dataset.jump === active);
  }
  const selected = outline.querySelector('.outline-item.active');
  glide(outline, selected, 'outline-glide'); // 高亮块跟着正文滑到当前章节
  if (!selected) return;
  const view = outline.getBoundingClientRect();
  const row = selected.getBoundingClientRect();
  if (row.top < view.top) outline.scrollTop += row.top - view.top;
  else if (row.bottom > view.bottom) outline.scrollTop += row.bottom - view.bottom;
}

/* 明确跳转时先显示目标章节，正文展开、滚动校准期间不让旧坐标覆盖它。
   结束后恢复按浏览位置高亮；旧跳转的结束回调不能释放新跳转。 */
export function beginOutlineJump(id) {
  const index = state.rows.findIndex(r => r.id === id);
  const section = state.rows.slice(0, index + 1).findLast(r => r.kind === 'section');
  const target = {
    id: section?.id ?? state.rows.find(r => r.kind === 'line')?.id,
    project: state.projectId,
    view: state.view,
  };
  jumpTarget = target;
  if (outlineOpen) showActiveOutline(target.id);
  return () => {
    if (jumpTarget !== target) return;
    jumpTarget = null;
    scheduleActiveOutline();
  };
}

function scheduleActiveOutline() {
  if (!frame) frame = requestAnimationFrame(syncActiveOutline);
}

export function renderOutline() {
  if (!outlineOpen) return;
  const sections = [];
  let section = { text: '开场', id: null, lines: [] };
  for (const r of state.rows) {
    if (r.kind === 'section') {
      if (section.lines.length) sections.push(section);
      section = { text: r.text, id: r.id, lines: [] };
    } else section.lines.push(r);
  }
  if (section.lines.length) sections.push(section);
  items = sections.map(s => ({
    jump: s.id ?? s.lines[0].id,
    sectionId: s.id,
    text: s.text,
    n: s.lines.length,
    todo: s.lines.filter(r => !r.type).length,
  }));
  // 目录内容没变就不重画；高亮由正文滚动位置单独更新
  const key = JSON.stringify(items);
  if (key !== lastKey) {
    lastKey = key;
    document.querySelector('#outline').innerHTML =
      `<div class="side-title">章节 <span>${sections.length}</span></div>` +
        items
          .map(
            s =>
              `<button class="outline-item" data-jump="${s.jump}"><span>${esc(s.text)}</span><small>${s.n} 句 · ${s.todo ? '未标 ' + s.todo : '已标完'}</small></button>`,
          )
          .join('') || '<div class="side-empty">导入口播稿后开始</div>';
  }
  scheduleActiveOutline();
}

export function initOutline() {
  const btn = document.querySelector('#btnOutline');
  document.querySelector('#tableWrap').addEventListener('scroll', scheduleActiveOutline, { passive: true });
  const outline = document.querySelector('#outline');
  btn.onclick = () => {
    outlineOpen = !outlineOpen;
    btn.setAttribute('aria-expanded', String(outlineOpen));
    btn.classList.toggle('active', outlineOpen);
    // 目录从左边滑出来 / 收回去，表格跟着让位（带一点回弹）
    const w = outline.offsetWidth || 175;
    if (outlineOpen) {
      cancelLeave(outline);
      outline.hidden = false;
      lastKey = '';
      renderOutline();
      if (!reduced())
        outline.animate(
          [
            { marginLeft: `-${outline.offsetWidth}px`, opacity: 0 },
            { marginLeft: '0px', opacity: 1 },
          ],
          { duration: 420, easing: 'cubic-bezier(0.3, 1.25, 0.5, 1)' },
        );
    } else
      leave(
        outline,
        [
          { marginLeft: '0px', opacity: 1 },
          { marginLeft: `-${w}px`, opacity: 0 },
        ],
        { duration: 260, easing: EASE_OUT },
        () => {
          if (!outlineOpen) outline.hidden = true;
        },
      );
  };
  btn.classList.toggle('active', outlineOpen);
}
