/* 标注类型表的修改（本项目）：改名 / 改色 / 排序 / 增删，一次保存 = 一步撤销。
   删除正在使用的类型时，用到它的句子按 remap 改成别的类型（或清除标注），不会留下「未知类型」。 */
import { state, update, emit } from './state.js';
import { notify } from './events.js';
import { persist, setDefaultTypes } from './storage.js';
import { snapshot } from './undo.js';
import { normalizeTypes } from '../core/types.js';

/* next：新的类型表；remap：{ 被删的 id: 改成的 id | null } */
export function setProjectTypes(next, { remap = {}, asDefault = false } = {}) {
  const list = normalizeTypes(next);
  const ids = new Set(list.map(t => t.id));
  snapshot('修改标注类型');
  let moved = 0;
  for (const r of state.rows) {
    if (r.kind !== 'line' || !r.type || ids.has(r.type)) continue;
    const to = Object.hasOwn(remap, r.type) ? remap[r.type] : null;
    r.type = to && ids.has(to) ? to : null;
    moved++;
  }
  state.types = list;
  if (state.filter !== 'all' && state.filter !== 'none' && !ids.has(state.filter)) state.filter = 'all';
  if (asDefault) setDefaultTypes(list);
  persist();
  emit('types');
  update('rows');
  notify(moved ? `标注类型已更新，${moved} 句改了类型 · ⌘Z 可撤销` : '标注类型已更新 · ⌘Z 可撤销');
  return { moved };
}
