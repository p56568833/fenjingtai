/* 撤销 / 重做：每次改动前存快照，⌘Z 回退一步、⇧⌘Z 再前进一步。快照绑定项目，切项目即清栈。
   快照里带上当时选中的句子，撤销 / 重做后光标回到改动发生的地方，不会跳回第一句。 */
import { state, update } from './state.js';
import { persist } from './storage.js';
import { toast } from './util.js';

const stack = [];
const redoStack = [];
const MAX = 80;

const capture = label => ({
  label,
  projectId: state.projectId,
  sel: state.sel,
  // 素材库、字幕时间一起进快照：片段范围、重新定位、字幕对齐才能整体撤销回退
  data: JSON.stringify({
    title: state.title,
    rows: state.rows,
    assets: state.assets || {},
    timing: state.timing || null,
  }),
});

export function snapshot(label) {
  stack.push(capture(label));
  if (stack.length > MAX) stack.shift();
  redoStack.length = 0; // 有了新改动，之前撤销掉的就不能再重做了
}
export const clearUndo = () => {
  stack.length = 0;
  redoStack.length = 0;
};
export const canUndo = () => stack.length > 0;
export const canRedo = () => redoStack.length > 0;

function restore(u) {
  const p = JSON.parse(u.data);
  state.title = p.title;
  state.rows = p.rows;
  state.assets = p.assets || {};
  state.timing = p.timing || null;
  document.querySelector('#projTitle').textContent = state.title;
  state.multi = null;
  if (u.sel != null && state.rows.some(r => r.id === u.sel && r.kind === 'line')) state.sel = u.sel;
  else if (state.sel != null && !state.rows.some(r => r.id === state.sel)) {
    state.sel = state.rows.find(r => r.kind === 'line')?.id ?? null;
  }
  persist();
  update('rows'); // 撤销改的是内存数据，必须广播重渲染，否则界面纹丝不动、看起来像没生效
  const el = document.querySelector(`.row[data-id="${state.sel}"],.as[data-id="${state.sel}"]`);
  el?.scrollIntoView({ block: 'nearest' });
}

export function undo() {
  const u = stack.pop();
  if (!u) {
    toast('没有可撤销的操作');
    return;
  }
  if (u.projectId !== state.projectId) {
    toast('那条操作不在当前项目里');
    return;
  }
  redoStack.push({ ...capture(u.label), sel: state.sel });
  restore(u);
  toast(`已撤销：${u.label}`);
}

export function redo() {
  const r = redoStack.pop();
  if (!r) {
    toast('没有可重做的操作');
    return;
  }
  if (r.projectId !== state.projectId) {
    toast('那条操作不在当前项目里');
    return;
  }
  stack.push(capture(r.label));
  restore(r);
  toast(`已重做：${r.label}`);
}

/* 键盘和原生菜单都会发来撤销 / 重做：
   - 同一次按键两边各来一遍时只执行一次
   - 焦点在输入框 / 可编辑文字里时，撤销的是文字输入本身（交给浏览器），不是整个项目 */
let last = { kind: null, source: null, at: 0 };
export function historyCommand(kind, source = 'key') {
  const now = performance.now();
  if (last.kind === kind && last.source !== source && now - last.at < 120) return;
  last = { kind, source, at: now };
  const ae = document.activeElement;
  const editing = ae && (ae.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(ae.tagName) && !ae.matches('.row-select')));
  if (editing) {
    document.execCommand(kind);
    return;
  }
  if (kind === 'redo') redo();
  else undo();
}
