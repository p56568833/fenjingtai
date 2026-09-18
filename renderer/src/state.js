/* 应用状态 + 事件总线。
   规则：UI 不得直接改 state 的字段后自己刷界面，一律走 update()，由订阅方决定重渲染粒度。 */
const listeners = new Set();

export const state = {
  // 当前项目
  projectId: null,
  title: '',
  rows: [],            // {id, kind:'line'|'section', text, note?, type?}
  // 纯 UI 状态（不进撤销栈）
  filter: 'all',
  sel: null,
  multi: null,
  query: '',
  view: 'table',
};

export function on(evt, fn){ listeners.add({evt, fn}); }
export function emit(evt, payload){ for(const l of listeners) if(l.evt===evt) l.fn(payload); }

/* 修改数据后广播。events:
   'rows'      结构或标注变化 → 全量重渲染（表格/总览/统计/选中）
   'selection' 只变选中态 → 原地高亮，不重建 DOM
   'view'      切换视图 */
export function update(evt = 'rows'){
  emit(evt);
}

export const rowById = id => state.rows.find(r=>r.id===id);
export function renumber(){ let n=0; state.rows.forEach(r=>{ if(r.kind==='line') r.no = ++n; }); }
export function currentSelection(){
  if(state.multi && state.multi.length) return state.multi;
  return state.sel!=null ? [state.sel] : [];
}
export function visibleLineIds(){
  // 勾选视图是整篇原文流，筛选不适用：导航/搜索都按全部句子走
  if(state.view==='check'){
    return state.rows.filter(r=>r.kind==='line').map(r=>r.id);
  }
  const ids = [];
  for(const r of state.rows){
    if(r.kind!=='line') continue;
    if(state.filter==='all' || (state.filter==='none' ? !r.type : r.type===state.filter)) ids.push(r.id);
  }
  return ids;
}
export const match = r => state.filter==='all' || (state.filter==='none' ? !r.type : r.type===state.filter);
/* 搜索命中：句子正文或备注包含查询词（表格/总览/搜索条共用） */
export const qMatch = r => !state.query
  || (r.text||'').toLowerCase().includes(state.query.toLowerCase())
  || (r.note||'').toLowerCase().includes(state.query.toLowerCase());

/* 载入一个项目到 state（切换项目 / 初次打开 / 导入） */
export function loadProjectIntoState(p){
  state.projectId = p.id;
  state.title = p.title;
  state.rows = p.rows;
  // 清掉 v1.1 短暂存在过的「B roll·未细分」试验类型（四类 B roll 现在直接一步标）
  for(const r of state.rows) if(r.kind==='line' && r.type==='b') r.type = null;
  state.filter = 'all'; state.sel = null; state.multi = null;
  state.query = '';
  const first = state.rows.find(r=>r.kind==='line');
  if(first) state.sel = first.id;
}
