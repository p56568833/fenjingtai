/* 应用状态 + 事件总线。
   规则：UI 不得直接改 state 的字段后自己刷界面，一律走 update()，由订阅方决定重渲染粒度。
   （与 assets.js 互相引用：只在函数运行时调用，模块求值期不互相调用，安全） */
import { hydrateProjectAssets } from './assets.js';
const listeners = new Set();

export const state = {
  // 当前项目
  projectId: null,
  title: '',
  rows: [], // {id, kind:'line'|'section', text, note?, type?, assetUsages?}
  assets: {}, // 项目级素材库 { [assetId]: {id, kind, path, name, durationSec?} }
  timing: null, // 对齐过的剪映字幕 {name, at, duration, cues}；句子上的 r.time 是对齐结果
  // 纯 UI 状态（不进撤销栈）
  filter: 'all',
  sel: null,
  multi: null,
  multiMode: false,
  query: '',
  view: 'table',
  speechRate: 4.5,
  autoAdvance: false,
  focusMode: false, // 专注标注打开时为 true（期间不走「标完自动跳转」）
};

export function on(evt, fn) {
  listeners.add({ evt, fn });
}
export function emit(evt, payload) {
  for (const l of listeners) if (l.evt === evt) l.fn(payload);
}

/* 修改数据后广播。events:
   'rows'      结构或标注变化 → 全量重渲染（表格/总览/统计/选中）
   'selection' 只变选中态 → 原地高亮，不重建 DOM
   'view'      切换视图 */
export function update(evt = 'rows') {
  emit(evt);
}

export const rowById = id => state.rows.find(r => r.id === id);
export function renumber() {
  let n = 0;
  state.rows.forEach(r => {
    if (r.kind === 'line') r.no = ++n;
  });
}
export function currentSelection() {
  if (state.multi && state.multi.length) return state.multi;
  return state.sel != null ? [state.sel] : [];
}
export function visibleLineIds() {
  const ids = [];
  for (const r of state.rows) {
    if (r.kind !== 'line') continue;
    if (state.filter === 'all' || (state.filter === 'none' ? !r.type : r.type === state.filter)) ids.push(r.id);
  }
  return ids;
}
export const match = r => state.filter === 'all' || (state.filter === 'none' ? !r.type : r.type === state.filter);
/* 搜索命中：句子正文或备注包含查询词（表格/总览/搜索条共用） */
export const qMatch = r =>
  !state.query ||
  (r.text || '').toLowerCase().includes(state.query.toLowerCase()) ||
  (r.note || '').toLowerCase().includes(state.query.toLowerCase());

/* 载入一个项目到 state（切换项目 / 初次打开 / 导入）。
   老项目只有 r.assets 文本，hydrateProjectAssets 载入时迁移成素材库 + 使用记录（含片段范围） */
export function loadProjectIntoState(p) {
  state.projectId = p.id;
  state.title = p.title;
  state.rows = p.rows;
  state.assets = hydrateProjectAssets(p);
  state.timing = p.timing && Array.isArray(p.timing.cues) ? p.timing : null;
  // 清掉 v1.1 短暂存在过的「B roll·未细分」试验类型（四类 B roll 现在直接一步标）
  for (const r of state.rows) if (r.kind === 'line' && r.type === 'b') r.type = null;
  state.filter = 'all';
  state.sel = null;
  state.multi = null;
  state.multiMode = false;
  state.query = '';
  const first = state.rows.find(r => r.kind === 'line');
  state.sel = state.rows.some(r => r.kind === 'line' && r.id === p.cursorId) ? p.cursorId : (first?.id ?? null);
  state.speechRate = Number(p.speechRate) >= 1 && Number(p.speechRate) <= 10 ? Number(p.speechRate) : 4.5;
  emit('project-loaded');
}

export function toggleLineSelection(id, checked) {
  if (rowById(id)?.kind !== 'line') return;
  const selected = new Set(currentSelection());
  const add = checked ?? !selected.has(id);
  if (add) selected.add(id);
  else selected.delete(id);
  state.multi = [...selected];
  state.sel = selected.has(id) ? id : (state.multi[state.multi.length - 1] ?? null);
  if (!state.multi.length) state.multi = null;
}
