/* 原文视图：整篇原文排版（保留段落），先选句子、再标类型。
   只有渲染；点击 / 拖选 / 键盘交互在 check-view.js。 */
import { state, rowById, currentSelection, qMatch, match, types } from '../app/state.js';
import { sharedScenes } from './badges.js';
import { esc, hiText } from './dom.js';
import { takeAnimation } from './anim.js';

/* 句子 span 的基础类名与配色（选中高亮 cur 由 renderSelectionOnly 统一管理，不在这里）。
   渲染与标注后的原地刷新共用同一份，状态永远和数据对得上 */
export function spanClass(r) {
  const st = r.type ? ` typed st-${r.type}` : '';
  const qdim = state.query && !qMatch(r) ? ' qdim' : '';
  return `as${st}${qdim}`;
}
const spanStyle = r => (r.type ? ` style="--tc:${types().color(r.type)}"` : '');

/* 段落规则：para 标记 = 原稿换行；同时再长的段落也封顶续分（5 句 / 120 字），
   老项目没有 para 标记也能保证不会糊成一整块 */
const MAX_SENTS = 5;
const MAX_CHARS = 120;

export function renderCheck() {
  document.querySelector('#thead').style.display = 'none';
  const wrap = document.querySelector('#rows');
  const anim = takeAnimation();
  wrap.className = 'rows ck' + (anim ? ' anim' : ''); // anim 只在切视图/切筛选那次渲染挂上

  if (!state.rows.some(r => r.kind === 'line')) {
    wrap.innerHTML = `<div class="ck-empty">
      <div class="big">把整篇稿子粘进来，读一遍顺手标画面</div>
      <div class="sub">自动按标点分句、保留段落排版。<br>点句子就弹出标注卡：选标注类型，写画面批注（红字显示在句子下方）。</div>
      <button class="btn primary" data-ck-paste>粘贴整篇文章</button>
    </div>`;
    return;
  }

  let html = `<div class="ck-hint">拖选或 Shift 点选多句 · 选中同一章节连续几句可「共用一个画面」 · 顶部标签筛选正文</div>`;
  html += `<div class="ck-article">`;
  let buf = [],
    bufChars = 0,
    i = 0,
    activeGroup = null,
    activeOwner = null;
  const groups = sharedScenes(state.rows);
  const closeGroup = () => {
    if (activeGroup) {
      flushP();
      const owner = rowById(activeOwner);
      if (owner?.note) html += `<span class="as-note shared-note" data-note="${activeOwner}">${esc(owner.note)}</span>`;
      html += `</div>`;
      activeGroup = null;
      activeOwner = null;
    }
  };
  const span = r => {
    const hit = state.query && qMatch(r);
    const txt = hit ? hiText(r.text, state.query) : esc(r.text);
    const note = r.note && !r.groupId ? `<span class="as-note" data-note="${r.id}">${esc(r.note)}</span>` : '';
    return `<span class="${spanClass(r)}"${spanStyle(r)} data-id="${r.id}">${txt}</span>` + note;
  };
  const flushP = () => {
    if (!buf.length) return;
    i++;
    html +=
      `<p class="ck-p"${anim ? ` style="animation-delay:${Math.min(i * 24, 240)}ms"` : ''}>` +
      buf.map(span).join('') +
      `</p>`;
    buf = [];
    bufChars = 0;
  };
  for (const r of state.rows) {
    if (r.kind === 'section') {
      flushP();
      closeGroup();
      html += `<div class="ck-sec" data-sid="${r.id}"><span class="dm">◆</span><span class="name">${esc(r.text)}</span><span class="line"></span><span class="sec-pen" title="改名 / 删节"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></span></div>`;
      continue;
    }
    if (!match(r)) continue;
    if (activeGroup !== (r.groupId || null)) {
      flushP();
      closeGroup();
      const group = groups.get(r.groupId);
      if (group) {
        activeGroup = r.groupId;
        activeOwner = r.id;
        html += `<div class="shared-passage" data-note-owner="${r.id}"><div class="shared-passage-heading"><button class="shared-passage-title" data-detail="${r.id}"><strong>共用画面</strong><span>${esc(group.label)}</span><small>查看素材 ↗</small></button><button class="shared-more" data-group-more="${esc(r.groupId)}" title="调整共用范围">···</button></div>`;
      }
    }
    if (buf.length && (r.para || buf.length >= MAX_SENTS || bufChars >= MAX_CHARS)) flushP();
    buf.push(r);
    bufChars += (r.text || '').length;
  }
  flushP();
  closeGroup();
  html += `</div>`;
  wrap.innerHTML = html;
}

/* 数据变了以后原地刷新指定句子 span 的类名，不重建整篇（标注时文字不闪）。
   选中高亮是 renderSelectionOnly 的职责，这里刷完基础类名要把它补回去 */
export function updateCheckSpans(ids) {
  const sel = new Set(currentSelection());
  for (const id of ids) {
    const r = rowById(id);
    if (!r) continue;
    const el = document.querySelector(`.as[data-id="${id}"]`);
    if (!el) continue;
    el.className = spanClass(r) + (sel.has(id) ? ' cur' : '');
    if (r.type) el.style.setProperty('--tc', types().color(r.type));
    else el.style.removeProperty('--tc');
  }
}

/* 批注保存后原地更新句下红字行：有则改字、无则建、清空则删，不重建整篇 */
export function updateCheckNote(id) {
  const r = rowById(id);
  if (!r) return;
  const span = document.querySelector(`.as[data-id="${id}"]`);
  if (!span) return;
  const passage = span.closest('.shared-passage');
  const owner = passage ? +passage.dataset.noteOwner : id;
  let noteEl = document.querySelector(`.as-note[data-note="${owner}"]`);
  if (r.note) {
    if (!noteEl) {
      noteEl = document.createElement('span');
      noteEl.className = 'as-note' + (passage ? ' shared-note' : '');
      noteEl.dataset.note = String(owner);
      if (passage) passage.append(noteEl);
      else span.after(noteEl);
    }
    noteEl.textContent = r.note;
  } else if (noteEl) noteEl.remove();
}
