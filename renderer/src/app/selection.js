/* 选区和类型筛选操作，不修改项目数据。 */
import { state } from './state.js';
import { viewState } from './view-state.js';
import { rowById } from './project-queries.js';
export function currentSelection() {
  if (viewState.multi && viewState.multi.length) return viewState.multi;
  return viewState.sel != null ? [viewState.sel] : [];
}
export const match = r =>
  viewState.filter === 'all' || (viewState.filter === 'none' ? !r.type : r.type === viewState.filter);
export function visibleLineIds() {
  const ids = [];
  for (const r of state.rows) if (r.kind === 'line' && match(r)) ids.push(r.id);
  return ids;
}
/* 勾选框 / 多选模式：只在「勾选集合」里增删。光标停在哪句（单选）不算勾选——
   否则先点了一句再去勾别的，会把光标那句也带进来；勾光标那句时反而把它取消掉。 */
export const checkedIds = () => (viewState.multi && viewState.multi.length ? viewState.multi : []);
export function toggleLineSelection(id, checked) {
  if (rowById(id)?.kind !== 'line') return;
  const selected = new Set(checkedIds());
  const add = checked ?? !selected.has(id);
  if (add) selected.add(id);
  else selected.delete(id);
  viewState.multi = [...selected];
  if (selected.has(id)) viewState.sel = id;
  else if (viewState.multi.length) viewState.sel = viewState.multi[viewState.multi.length - 1];
  if (!viewState.multi.length) viewState.multi = null;
}
