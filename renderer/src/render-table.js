import { sharedScenes } from './visuals.js';
/* 表格视图：逐句一行的标注主界面 */
import { state, rowById, currentSelection, match, qMatch } from './state.js';
import { TYPES } from './types.js';
import { esc, hiText, durCellHTML } from './util.js';
import { takeAnimation } from './anim.js';

function chipHTML(r) {
  const t = r.type ? TYPES[r.type] : null;
  if (!t)
    return `<div class="tchip t-none">未标注 <kbd>1-5</kbd><svg class="arr" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg></div>`;
  return `<div class="tchip ${t.cls}">${t.icon}${t.full}<svg class="arr" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg></div>`;
}

export function renderTable() {
  document.querySelector('#thead').style.display = '';
  const dh = document.querySelector('#durHeading');
  if (dh) dh.textContent = state.timing ? '时间码' : '≈时长';
  const wrap = document.querySelector('#rows');
  const anim = takeAnimation();
  wrap.className = 'rows' + (anim ? ' anim' : ''); // anim 只在切视图/切筛选那次渲染挂上，入场动画播一次就完
  const selected = new Set(currentSelection());

  const visible = [];
  for (let ri = 0; ri < state.rows.length; ri++) {
    const r = state.rows[ri];
    if (r.kind === 'section') {
      let cnt = 0,
        todo = 0,
        vis = 0; // cnt=章节总句数，todo=真的没标注的，vis=当前筛选下可见的
      for (let j = ri + 1; j < state.rows.length && state.rows[j].kind !== 'section'; j++) {
        const q = state.rows[j];
        if (q.kind !== 'line') continue;
        cnt++;
        if (!q.type) todo++;
        if (match(q)) vis++;
      }
      visible.push({ row: r, show: vis > 0, cnt, todo, si: ri });
      continue;
    }
    visible.push({ row: r, show: match(r) });
  }

  let html = '';
  let i = 0;
  for (const v of visible) {
    const r = v.row;
    if (r.kind === 'section') {
      if (v.show) {
        html += `<div class="section-row" data-si="${v.si}" data-sid="${r.id}"><span class="dm">◆</span><span class="name">${esc(r.text)}</span><span class="cnt">${v.cnt} 句</span>${v.todo ? `<span class="todo-cnt">未标 ${v.todo}</span>` : ''}<span class="line"></span><span class="sec-pen" title="改名 / 删节"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></span></div>`;
      }
      continue;
    }
    if (!v.show) continue;
    i++;
    const col = r.type ? TYPES[r.type].color : 'transparent';
    const qdim = state.query && !qMatch(r) ? ' qdim' : '';
    const sentHtml = state.query && qMatch(r) ? hiText(r.text, state.query) : esc(r.text);
    const st = anim ? ` style="animation-delay:${Math.min(i * 13, 240)}ms"` : '';
    html += `
      <div class="row ${r.type ? '' : 'unannotated'}${qdim}${selected.has(r.id) ? ' selected' : ''}" data-id="${r.id}"${st}>
        <div class="spine" style="background:${col};color:${col}"></div>
        <div class="idx"><input class="row-select" type="checkbox" data-select="${r.id}" aria-label="选择第 ${r.no} 句" ${selected.has(r.id) ? 'checked' : ''}><span>${r.no || ''}</span></div>
        <div class="sent" data-id="${r.id}">${sentHtml}</div>
        <div class="dur">${durCellHTML(r)}</div>
        <div class="typebox">${chipHTML(r)}</div>
        <div class="visual-cell"><div class="note" data-id="${r.id}" contenteditable="true" spellcheck="false" data-ph="点击填写画面描述…">${esc(r.note || '')}</div><div class="row-assets"></div></div>
        <button class="row-act row-more" data-row-more="${r.id}" title="更多操作（素材 / 共用范围）"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>
        <button class="row-act row-del" data-del="${r.id}" title="删除这句"><svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>`;
  }
  wrap.innerHTML = html || `<div class="empty-hint">这个筛选下没有句子<br>点上方筛选条切回「全部」</div>`;
  const groups = sharedScenes(state.rows);
  // Keep sentence rows independent; move the shared cells into one group-wide grid row.
  for (const el of [...wrap.querySelectorAll('.row')]) {
    if (el.closest('.shared-scene')) continue;
    const r = rowById(+el.dataset.id),
      group = groups.get(r.groupId);
    if (!group) continue;
    const members = [el];
    let next = el.nextElementSibling;
    while (next?.classList.contains('row') && rowById(+next.dataset.id)?.groupId === r.groupId) {
      members.push(next);
      next = next.nextElementSibling;
    }
    const scene = document.createElement('section');
    scene.className = 'shared-scene';
    scene.dataset.owner = String(r.id);
    scene.setAttribute('aria-label', group.label);
    scene.innerHTML = `<div class="shared-scene-header"><button class="shared-scene-title" data-detail="${r.id}"><strong>共用画面</strong><span>${esc(group.label)}</span><small>查看画面与素材 ↗</small></button><button class="shared-more" data-group-more="${esc(r.groupId)}" title="调整共用范围">···</button></div><div class="shared-scene-body"><div class="shared-scene-lines"></div></div>`;
    el.before(scene);
    const body = scene.querySelector('.shared-scene-body'),
      lines = scene.querySelector('.shared-scene-lines');
    body.append(el.querySelector('.typebox'), el.querySelector('.visual-cell'));
    members.forEach((row, index) => {
      row.classList.add('shared-scene-row');
      row.querySelector('.typebox')?.remove();
      row.querySelector('.visual-cell')?.remove();
      lines.append(row);
      if (index === members.length - 1) row.classList.add('shared-scene-end');
    });
  }
}

/* 标注变化时只更新这一行的色块和脊线，不重建整页（避免「刷新一下」的感觉） */
export function updateRowVisual(id) {
  const r = rowById(id);
  if (!r) return;
  const el = document.querySelector(`.row[data-id="${id}"]`);
  if (!el) return;
  const qdim = qMatch(r) ? '' : ' qdim';
  el.classList.toggle('unannotated', !r.type);
  el.classList.toggle('qdim', !!qdim);
  el.classList.toggle('selected', currentSelection().includes(r.id));
  const col = r.type ? TYPES[r.type].color : 'transparent';
  const spine = el.querySelector('.spine');
  if (spine) {
    spine.style.background = col;
    spine.style.color = col;
  }
  const box = (el.closest('.shared-scene') || el).querySelector('.typebox');
  if (box) box.innerHTML = chipHTML(r);
}

/* 标注后就地刷新章节条的句数 / 未标数（data-si 对应 state.rows 下标），不重建列表 */
export function updateSectionBadges() {
  const stats = [];
  state.rows.forEach((r, ri) => {
    if (r.kind === 'section') stats.push({ ri, cnt: 0, todo: 0 });
    else if (stats.length) {
      const s = stats[stats.length - 1];
      s.cnt++;
      if (!r.type) s.todo++;
    }
  });
  document.querySelectorAll('.section-row[data-si]').forEach(el => {
    const s = stats.find(x => x.ri === +el.dataset.si);
    if (!s) return;
    const cnt = el.querySelector('.cnt');
    if (cnt) cnt.textContent = `${s.cnt} 句`;
    const todo = el.querySelector('.todo-cnt');
    if (todo) todo.textContent = `未标 ${s.todo}`;
  });
}
