/* 全局撤销：每次改动前存快照，⌘Z 回退一步。快照绑定项目，切项目即清栈。 */
import { state, update } from './state.js';
import { persist } from './storage.js';
import { toast } from './util.js';

const stack = [];
const MAX = 80;

export function snapshot(label){
  stack.push({ label, projectId: state.projectId, data: JSON.stringify({ title: state.title, rows: state.rows }) });
  if(stack.length > MAX) stack.shift();
}
export const clearUndo = () => { stack.length = 0; };

export function undo(){
  const u = stack.pop();
  if(!u){ toast('没有可撤销的操作'); return; }
  if(u.projectId !== state.projectId){ toast('那条操作不在当前项目里'); return; }
  const p = JSON.parse(u.data);
  state.title = p.title; state.rows = p.rows;
  document.querySelector('#projTitle').textContent = state.title;
  state.multi = null;
  if(state.sel!=null && !state.rows.some(r=>r.id===state.sel)){
    state.sel = state.rows.find(r=>r.kind==='line')?.id ?? null;
  }
  persist();
  update('rows');   // 撤销改的是内存数据，必须广播重渲染，否则界面纹丝不动、看起来像没生效
  toast(`已撤销：${u.label}`);
}
