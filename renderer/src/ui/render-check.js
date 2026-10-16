/* 原文视图：整篇原文排版（保留段落），先选句子、再标类型。
   只有渲染；点击 / 拖选 / 键盘交互在 check-view.js。 */
import { state, rowById, currentSelection, qMatch, match, types } from '../app/state.js';
import { sharedScenes } from './asset-html.js';
import { esc } from './base/dom.js';
import { takeAnimation } from './base/anim.js';
import { patchChildren, staleBlock } from './base/keyed-patch.js';

/* 句子 span 的基础类名与配色（选中高亮 cur 由 renderSelectionOnly 统一管理，不在这里）。
   渲染与标注后的原地刷新共用同一份，状态永远和数据对得上 */
export function spanClass(r) {
  const st = r.type ? ` typed st-${r.type}` : '';
  return `as${st}`; // 搜索淡化由 paintSearch 原地刷
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
    patchChildren(wrap, [
      {
        key: 'empty',
        html: `<div class="ck-empty">
      <div class="big">把整篇稿子粘进来，读一遍顺手标画面</div>
      <div class="sub">自动按标点分句、保留段落排版。<br>点句子就弹出标注卡：选标注类型，写画面批注（红字显示在句子下方）。</div>
      <button class="btn primary" data-ck-paste>粘贴整篇文章</button>
    </div>`,
      },
    ]);
    return;
  }

  // 按块排（和表格一样只换变了的块）：章节标题、一段一块，共用画面的几段连同批注合成一块
  const blocks = [];
  let buf = [],
    bufChars = 0,
    group = null; // 正在攒的共用画面：{ owner, html }
  const span = r => {
    const txt = esc(r.text);
    const note = r.note && !r.groupId ? `<span class="as-note" data-note="${r.id}">${esc(r.note)}</span>` : '';
    return `<span class="${spanClass(r)}"${spanStyle(r)} data-id="${r.id}">${txt}</span>` + note;
  };
  const flushP = () => {
    if (!buf.length) return;
    const html = `<p class="ck-p">${buf.map(span).join('')}</p>`;
    if (group) group.html += html;
    else blocks.push({ key: `p${buf[0].id}`, html });
    buf = [];
    bufChars = 0;
  };
  const closeGroup = () => {
    if (!group) return;
    flushP();
    const owner = rowById(group.owner);
    if (owner?.note)
      group.html += `<span class="as-note shared-note" data-note="${group.owner}">${esc(owner.note)}</span>`;
    blocks.push({ key: `g${group.owner}`, html: group.html + '</div>' });
    group = null;
  };
  const groups = sharedScenes(state.rows);
  for (const r of state.rows) {
    if (r.kind === 'section') {
      flushP();
      closeGroup();
      blocks.push({
        key: `s${r.id}`,
        html: `<div class="ck-sec" data-sid="${r.id}"><span class="dm">◆</span><span class="name">${esc(r.text)}</span><span class="line"></span></div>`,
      });
      continue;
    }
    if (!match(r)) continue;
    if ((group?.id ?? null) !== (r.groupId || null)) {
      flushP();
      closeGroup();
      const g = groups.get(r.groupId);
      if (g)
        group = {
          id: r.groupId,
          owner: r.id,
          html: `<div class="shared-passage" data-note-owner="${r.id}"><div class="shared-passage-heading"><button class="shared-passage-title" data-detail="${r.id}"><strong>共用画面</strong><span>${esc(g.label)}</span><small>查看素材 ↗</small></button><button class="shared-more" data-group-more="${esc(r.groupId)}" title="调整共用范围">···</button></div>`,
        };
    }
    if (buf.length && (r.para || buf.length >= MAX_SENTS || bufChars >= MAX_CHARS)) flushP();
    buf.push(r);
    bufChars += (r.text || '').length;
  }
  flushP();
  closeGroup();
  patchChildren(
    wrap,
    [
      {
        key: 'hint',
        html: `<div class="ck-hint">拖选或 Shift 点选多句 · 选中同一章节连续几句可「共用一个画面」 · 顶部标签筛选正文</div>`,
      },
      { key: 'article', html: `<div class="ck-article"></div>`, kids: blocks },
    ],
    { fresh: anim },
  );
  if (anim)
    wrap.querySelectorAll('.ck-p').forEach((el, i) => (el.style.animationDelay = `${Math.min((i + 1) * 24, 240)}ms`));
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
    staleBlock(el);
    el.className = spanClass(r) + (sel.has(id) ? ' cur' : '') + (state.query && !qMatch(r) ? ' qdim' : '');
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
  staleBlock(span);
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
