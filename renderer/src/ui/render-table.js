/* 表格视图：逐句一行的标注主界面 */
import { state, rowById, currentSelection, match, qMatch, types } from '../app/state.js';
import { sharedScenes, shotTotalText } from './asset-html.js';
import { esc } from './base/dom.js';
import { durCellHTML, durHeading } from './time-view.js';
import { chipHTML } from './base/type-view.js';
import { takeAnimation } from './base/anim.js';
import { syncSectionPins } from './section-pin.js';
import { patchChildren, staleBlock } from './base/keyed-patch.js';

/* 一句的 HTML。选中 / 勾选状态不写进来，由 renderSelectionOnly 统一刷（换选中不用重画这一行）；
   句号和时长也不写进来：前面加一句、删一句，后面每句的句号和起始时间都会变，那样整张表都得换，
   由 paintNumbers 在原地改。shared：在共用画面里（类型和素材格放在整组右边，不在这行里） */
function rowHTML(r, { shared = false, end = false } = {}) {
  // 搜索高亮和淡化不写进来，由 paintSearch 原地刷（开关搜索不换句子块，页面不闪）
  const sentHtml = esc(r.text);
  return `<div class="row ${r.type ? '' : 'unannotated'}${shared ? ' shared-scene-row' : ''}${end ? ' shared-scene-end' : ''}" data-id="${r.id}"><div class="spine"></div><div class="idx"><input class="row-select" type="checkbox" data-select="${r.id}"><span></span></div><div class="sent" data-id="${r.id}">${sentHtml}</div><div class="dur"></div>${shared ? '' : `${typeboxHTML(r)}${visualHTML(r)}`}<button class="row-act row-more" data-row-more="${r.id}" title="更多操作（素材 / 共用范围 / 删除这句）"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button></div>`;
}
const typeboxHTML = (r, total = false) =>
  `<div class="typebox">${total ? '<em class="shared-total" title="这几句口播一共占的时间：拿它和右边素材的「可用」比，看画面能不能盖满"></em>' : ''}${chipHTML(r)}</div>`;
const visualHTML = r =>
  `<div class="visual-cell"><div class="row-assets"></div><div class="note" data-id="${r.id}" contenteditable="plaintext-only" spellcheck="false" data-ph="点击填写画面描述…">${esc(r.note || '')}</div></div>`;

/* 句号、时长、共用画面的总秒数：在原地改，变了才写 */
function paintNumbers(wrap, scenes) {
  const byId = new Map(state.rows.map(r => [r.id, r]));
  for (const el of wrap.querySelectorAll('.row[data-id]')) {
    const r = byId.get(+el.dataset.id);
    if (!r) continue;
    const no = r.no || '';
    if (el._no !== no) {
      el._no = no;
      el.querySelector('.idx span').textContent = no;
      el.querySelector('.row-select').setAttribute('aria-label', `勾选第 ${no} 句`);
      el.querySelector('.row-more').setAttribute('aria-label', `第 ${no} 句的更多操作`);
    }
    const dur = durCellHTML(r);
    if (el._dur !== dur) {
      el._dur = dur;
      el.querySelector('.dur').innerHTML = dur;
    }
  }
  for (const { spec, group } of scenes) {
    const em = spec.el?.querySelector('.shared-total');
    const text = shotTotalText(group.members);
    if (em && em.textContent !== text) em.textContent = text;
  }
}

/* 共用画面：组里的句子排在左边，整组的类型、画面描述、素材格放在右边一列（跟着组里第一句） */
function sceneHTML(rows, group) {
  const r = rows[0];
  return `<section class="shared-scene" data-owner="${r.id}" aria-label="${esc(group.label)}"><div class="shared-scene-header"><button class="shared-scene-title" data-detail="${r.id}" title="${esc(group.label)} · 点开看画面与素材"><strong>共用画面</strong><span>${esc(group.label.replace('共用一个画面', ''))}</span></button><button class="shared-more" data-group-more="${esc(r.groupId)}" title="调整共用范围">···</button></div><div class="shared-scene-body"><div class="shared-scene-lines">${rows.map((x, i) => rowHTML(x, { shared: true, end: i === rows.length - 1 })).join('')}</div>${typeboxHTML(r, true)}${visualHTML(r)}</div></section>`; // 总秒数放在类型色块正上方，和右边素材的「需要 / 可用」对着看
}

/* 换掉一句 / 一组时，把旧元素上后来补画的素材卡片挪到新元素里：卡片内容没变就不重画，缩略图不闪 */
function keepAssets(before, after) {
  const ownerOf = el => el.closest('[data-owner]')?.dataset.owner || el.closest('.row')?.dataset.id;
  const old = new Map([...before.querySelectorAll('.row-assets')].map(el => [ownerOf(el), el]));
  for (const el of after.querySelectorAll('.row-assets')) {
    const prev = old.get(ownerOf(el));
    if (prev) el.replaceWith(prev);
  }
}

export function renderTable() {
  document.querySelector('#thead').style.display = '';
  const dh = document.querySelector('#durHeading');
  if (dh) dh.textContent = durHeading();
  const tk = document.querySelector('#typeKeys');
  if (tk) tk.textContent = `1-${types().list.length}`;
  const wrap = document.querySelector('#rows');
  const anim = takeAnimation();
  wrap.className = 'rows' + (anim ? ' anim' : ''); // anim 只在切视图/切筛选那次渲染挂上，入场动画播一次就完
  const groups = sharedScenes(state.rows);

  // 按块排：章节（.sec-block，顶部细条只在本章范围内吸顶）里是一句一块，共用画面的几句合成一块
  const top = [];
  let list = top;
  let pending = []; // 正在攒的共用画面：同一组里看得见的几句
  const scenes = [];
  const flushScene = () => {
    if (!pending.length) return;
    const group = groups.get(pending[0].groupId);
    const spec = { key: `g${pending[0].id}`, html: sceneHTML(pending, group) };
    list.push(spec);
    scenes.push({ spec, group });
    pending = [];
  };
  for (let ri = 0; ri < state.rows.length; ri++) {
    const r = state.rows[ri];
    if (r.kind === 'section') {
      flushScene();
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
      if (!vis) {
        list = []; // 这一章筛选下一句都没有：整章不显示，章里的句子也都看不见
        continue;
      }
      const meta = `<span class="cnt">${cnt} 句</span>${todo ? `<span class="todo-cnt">未标 ${todo}</span>` : ''}`;
      list = [
        {
          key: 'pin',
          html: `<div class="sec-pin" data-si="${ri}" data-pin="${r.id}" title="回到本章开头" aria-hidden="true"><span class="name">${esc(r.text)}</span><span class="section-meta">${meta}</span></div>`,
        },
        {
          key: 'head',
          html: `<div class="section-row" data-si="${ri}" data-sid="${r.id}"><span class="line section-line-left" aria-hidden="true"></span><span class="name">${esc(r.text)}</span><span class="line section-line-right" aria-hidden="true"></span><span class="section-meta">${meta}</span></div>`,
        },
      ];
      top.push({ key: `s${r.id}`, html: `<div class="sec-block" data-sid="${r.id}"></div>`, kids: list });
      continue;
    }
    if (!match(r)) continue; // 筛选掉的句子不占位：同一组里前后看得见的几句照样合成一块
    if (groups.has(r.groupId)) {
      if (pending.length && pending[0].groupId !== r.groupId) flushScene();
      pending.push(r);
      continue;
    }
    flushScene();
    list.push({ key: `r${r.id}`, html: rowHTML(r) });
  }
  flushScene();
  if (!top.length)
    top.push({ key: 'empty', html: `<div class="empty-hint">这个筛选下没有句子<br>点上方筛选条切回「全部」</div>` });

  patchChildren(wrap, top, { fresh: anim, onReplace: keepAssets });
  paintNumbers(wrap, scenes);
  if (anim)
    wrap.querySelectorAll('.row').forEach((el, i) => (el.style.animationDelay = `${Math.min((i + 1) * 13, 240)}ms`));
  syncSectionPins();
}

/* 标注变化时只更新这一行的色块和脊线，不重建整页（避免「刷新一下」的感觉） */
export function updateRowVisual(id) {
  const r = rowById(id);
  if (!r) return;
  const el = document.querySelector(`.row[data-id="${id}"]`);
  if (!el) return;
  staleBlock(el);
  const qdim = qMatch(r) ? '' : ' qdim';
  el.classList.toggle('unannotated', !r.type);
  el.classList.toggle('qdim', !!qdim);
  el.classList.toggle('selected', currentSelection().includes(r.id));
  const box = (el.closest('.shared-scene') || el).querySelector('.typebox');
  if (box) {
    const keep = box.querySelectorAll(':scope > .shared-total, :scope > .production-badge');
    box.innerHTML = chipHTML(r);
    box.prepend(...[...keep].filter(n => n.classList.contains('shared-total')));
    box.append(...[...keep].filter(n => n.classList.contains('production-badge')));
  }
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
  document.querySelectorAll('.section-row[data-si], .sec-pin[data-si]').forEach(el => {
    const s = stats.find(x => x.ri === +el.dataset.si);
    if (!s) return;
    const cnt = el.querySelector('.cnt');
    if (cnt) cnt.textContent = `${s.cnt} 句`;
    const todo = el.querySelector('.todo-cnt');
    if (todo) todo.textContent = `未标 ${s.todo}`;
    staleBlock(el);
  });
}
