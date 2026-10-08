/* 左侧章节目录：各章句数 / 未标数，点击跳转；高亮跟随正文浏览位置 */
import { state } from '../app/state.js';
import { esc } from './dom.js';

let outlineOpen = true;
let lastKey = '';
let items = [];
let frame = 0;

function syncActiveOutline() {
  frame = 0;
  if (!outlineOpen || !items.length) return;
  const wrap = document.querySelector('#tableWrap');
  const outline = document.querySelector('#outline');
  const box = wrap.getBoundingClientRect();
  const probe = box.top + box.height * 0.5;
  let active = null;
  for (const item of items) {
    const anchor = item.sectionId
      ? document.querySelector(`${state.view === 'check' ? '.ck-sec' : '.section-row'}[data-sid="${item.sectionId}"]`)
      : document.querySelector(`.row[data-id="${item.jump}"],.as[data-id="${item.jump}"]`);
    if (!anchor) continue; // 筛选后这一章可能没有可见句子
    if (active === null || anchor.getBoundingClientRect().top <= probe) active = item.jump;
    else break;
  }
  for (const button of outline.querySelectorAll('.outline-item')) {
    button.classList.toggle('active', +button.dataset.jump === active);
  }
  const selected = outline.querySelector('.outline-item.active');
  if (!selected) return;
  const view = outline.getBoundingClientRect();
  const row = selected.getBoundingClientRect();
  if (row.top < view.top) outline.scrollTop += row.top - view.top;
  else if (row.bottom > view.bottom) outline.scrollTop += row.bottom - view.bottom;
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
  btn.onclick = () => {
    outlineOpen = !outlineOpen;
    document.querySelector('#outline').hidden = !outlineOpen;
    btn.setAttribute('aria-expanded', String(outlineOpen));
    btn.classList.toggle('active', outlineOpen);
    lastKey = '';
    renderOutline();
  };
  btn.classList.toggle('active', outlineOpen);
}
