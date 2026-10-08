/* 撤销 / 重做：每次改动前存快照，⌘Z 回退一步、⇧⌘Z 再前进一步。快照绑定项目，切项目即清栈。
   快照里带上当时选中的句子，撤销 / 重做后光标回到改动发生的地方。
   这里只管数据；界面（标题、滚动到改动处）订阅 'history' 事件自己刷。 */
import { state, update, emit } from './state.js';
import { notify } from './events.js';
import { persist } from './storage.js';

const stack = [];
const redoStack = [];
const MAX = 80;

const capture = label => ({
  label,
  projectId: state.projectId,
  sel: state.sel,
  // 素材库、字幕时间、类型表、口播音频一起进快照：这些改动都能整体撤销
  data: JSON.stringify({
    title: state.title,
    rows: state.rows,
    assets: state.assets || {},
    timing: state.timing || null,
    types: state.types,
    voice: state.voice || null,
    candidates: state.candidates || [],
  }),
});

/* 快照是整份项目的 JSON：长稿加几百个视频候选时一份可能有好几 MB。
   除了最多 80 步，再按总量封顶（约 120 MB 字符），超了就丢最旧的几步，至少留 10 步 */
const MAX_CHARS = 120 * 1024 * 1024;
const charsOf = list => list.reduce((n, x) => n + x.data.length, 0);
export function snapshot(label) {
  stack.push(capture(label));
  if (stack.length > MAX) stack.shift();
  while (stack.length > 10 && charsOf(stack) > MAX_CHARS) stack.shift();
  redoStack.length = 0; // 有了新改动，之前撤销掉的就不能再重做了
}
/* 上一步快照之后数据其实没变（插入空句又没写就走了）：把那一步扔掉，⌘Z 不会「撤销」一个看不见的改动 */
export function discardIfUnchanged() {
  const top = stack[stack.length - 1];
  if (top && top.projectId === state.projectId && capture(top.label).data === top.data) stack.pop();
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
  const typesChanged = JSON.stringify(state.types) !== JSON.stringify(p.types || state.types);
  if (p.types) state.types = p.types;
  const voiceChanged = (state.voice?.path || '') !== (p.voice?.path || '');
  state.voice = p.voice || null;
  state.candidates = p.candidates || [];
  state.multi = null;
  if (u.sel != null && state.rows.some(r => r.id === u.sel && r.kind === 'line')) state.sel = u.sel;
  else if (state.sel != null && !state.rows.some(r => r.id === state.sel)) {
    state.sel = state.rows.find(r => r.kind === 'line')?.id ?? null;
  }
  persist();
  if (typesChanged) emit('types');
  if (voiceChanged) emit('voice');
  update('rows'); // 撤销改的是内存数据，必须广播重渲染
  emit('history', { sel: state.sel });
}

export function undo() {
  const u = stack[stack.length - 1];
  if (!u) return notify('没有可撤销的操作', null, 'info');
  if (u.projectId !== state.projectId) return notify('那条操作不在当前项目里', null, 'info');
  stack.pop();
  redoStack.push({ ...capture(u.label), sel: state.sel });
  restore(u);
  notify(`已撤销：${u.label}`, null, 'info');
}

export function redo() {
  const r = redoStack[redoStack.length - 1];
  if (!r) return notify('没有可重做的操作', null, 'info');
  if (r.projectId !== state.projectId) return notify('那条操作不在当前项目里', null, 'info');
  redoStack.pop();
  stack.push(capture(r.label));
  restore(r);
  notify(`已重做：${r.label}`, null, 'info');
}
