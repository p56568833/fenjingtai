/* 顶部统计条：比例条 / 筛选 chips / 进度。
   勾选视图下换成三支笔（A / B / 擦除）+ A·B·未标 的粗分口径。 */
import { state } from './state.js';
import { TYPES, TYPE_ORDER, FILTERS } from './types.js';

let lastKey = null;   // 计数没变就不重建 DOM：搜索打字、改文字时顶栏不闪

export function renderStats(){
  const lines = state.rows.filter(r=>r.kind==='line');
  const total = lines.length;
  const counts = {none:0};
  TYPE_ORDER.forEach(k=>counts[k]=0);
  lines.forEach(r=>{ counts[r.type||'none']++; });

  const key = JSON.stringify([counts, state.filter, state.view]);
  if(key === lastKey) return;
  lastKey = key;

  if(state.view==='check'){
    // 勾选视图：比例条按 A + B 家族四色分段（颜色和下方筛选条一致，一眼对上），悬停看明细
    const nA = counts.a;
    const nB = counts.real + counts.stock + counts.ai + counts.fx;
    let bar = nA ? `<div class="seg" style="flex-grow:${nA};background:${TYPES.a.color}" title="A roll · ${nA} 句"></div>` : '';
    TYPE_ORDER.slice(1).forEach(k=>{
      if(counts[k]) bar += `<div class="seg" style="flex-grow:${counts[k]};background:${TYPES[k].color}" title="${TYPES[k].full} · ${counts[k]} 句"></div>`;
    });
    if(counts.none) bar += `<div class="seg none" style="flex-grow:${counts.none}" title="未标注 · ${counts.none} 句"></div>`;
    document.querySelector('#segbar').innerHTML = bar || `<div class="seg none" style="flex-grow:1"></div>`;

    document.querySelector('#filters').innerHTML =
      TYPE_ORDER.map((k,idx)=>{
        const t = TYPES[k];
        return `<div class="ck-chip" data-t="${k}" title="把选中的句子标成「${t.full}」（快捷键 ${idx+1}）"><span class="dot" style="background:${t.color}"></span>${t.label}<span class="n">${counts[k]}</span><kbd>${idx+1}</kbd></div>`;
      }).join('') +
      `<div class="ck-chip" data-t="" title="清除选中句子的标注（快捷键 0）"><span class="dot" style="background:#8a93a6"></span>擦除<kbd>0</kbd></div>`;

    document.querySelector('#progressTxt').innerHTML = counts.none
      ? `A <b>${nA}</b> · B <b>${nB}</b> · 未标 <b class="todo">${counts.none}</b> 句`
      : `标完了：A <b>${nA}</b> · B <b>${nB}</b> · <b style="color:#12a06b">100%</b> 🎉`;
    return;
  }

  let bar = '';
  TYPE_ORDER.forEach(k=>{ if(counts[k]) bar += `<div class="seg" style="flex-grow:${counts[k]};background:${TYPES[k].color}"></div>`; });
  if(counts.none) bar += `<div class="seg none" style="flex-grow:${counts.none}"></div>`;
  document.querySelector('#segbar').innerHTML = bar || `<div class="seg none" style="flex-grow:1"></div>`;

  document.querySelector('#filters').innerHTML = FILTERS.map(f=>{
    const n = f.id==='all' ? total : counts[f.id];
    const act = state.filter===f.id ? 'active':'';
    return `<div class="chip-filter ${act}" data-f="${f.id}"><span class="dot" style="background:${f.color}"></span>${f.label}<span class="n">${n}</span></div>`;
  }).join('');

  const done = total - counts.none;
  const pct = total ? Math.round(done/total*100) : 0;
  document.querySelector('#progressTxt').innerHTML = counts.none
    ? `已标 <b>${done}</b>/${total} · <b style="color:var(--todo)">${pct}%</b> · 还剩 <b class="todo">${counts.none}</b> 句`
    : `全部标完 <b>${total}</b> 句 · <b style="color:#12a06b">100%</b> 🎉`;
}
