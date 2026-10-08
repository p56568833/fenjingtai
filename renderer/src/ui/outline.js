/* 左侧章节目录：各章句数 / 未标数，点击跳到章节第一句 */
import { state } from '../app/state.js';
import { esc } from './dom.js';

let outlineOpen = true;
let lastKey = '';

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
  const items = sections.map(s => ({
    jump: s.id ?? s.lines[0].id,
    text: s.text,
    n: s.lines.length,
    todo: s.lines.filter(r => !r.type).length,
    active: s.lines.some(r => r.id === state.sel),
  }));
  // 内容没变（只是光标在同一章里挪动）就不重画
  const key = JSON.stringify(items);
  if (key === lastKey) return;
  lastKey = key;
  document.querySelector('#outline').innerHTML =
    `<div class="side-title">章节 <span>${sections.length}</span></div>` +
      items
        .map(
          s =>
            `<button class="outline-item ${s.active ? 'active' : ''}" data-jump="${s.jump}"><span>${esc(s.text)}</span><small>${s.n} 句 · ${s.todo ? '未标 ' + s.todo : '已标完'}</small></button>`,
        )
        .join('') || '<div class="side-empty">导入口播稿后开始</div>';
}

export function initOutline() {
  const btn = document.querySelector('#btnOutline');
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
