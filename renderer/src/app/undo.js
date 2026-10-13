/* 撤销 / 重做：每次改动前存快照，⌘Z 回退一步、⇧⌘Z 再前进一步。快照绑定项目，切项目即清栈。
   快照里带上当时选中的句子，撤销 / 重做后光标回到改动发生的地方。
   这里只管数据；界面（标题、滚动到改动处）订阅 'history' 事件自己刷。 */
import { state, update, emit } from './state.js';
import { notify } from './events.js';
import { persist } from './storage.js';
import { projectData, applyProjectData } from '../core/project-data.js';

const stack = [];
const redoStack = [];
const MAX = 80;

/* 局域网协作：快照记下当时合到第几条对方改动（mark）；撤销时先把之后合进来的对方改动补进旧快照，
   只撤自己的这一步，不会把对方后来的改动一起撤掉 */
let collabHooks = {};
export const setSnapshotHooks = hooks => {
  const previous = collabHooks;
  collabHooks = hooks || {};
  return () => {
    collabHooks = previous;
  };
};

export const captureSnapshot = label => ({
  label,
  projectId: state.projectId,
  sel: state.sel,
  mark: collabHooks.mark?.(state.projectId),
  // 素材库、字幕时间、类型表、口播音频一起进快照：这些改动都能整体撤销
  data: JSON.stringify(projectData(state, 'history')),
});

/* 快照是整份项目的 JSON：长稿加几百个视频候选时一份可能有好几 MB。
   除了最多 80 步，再按总量封顶（约 120 MB 字符），超了就丢最旧的几步，至少留 10 步 */
const MAX_CHARS = 120 * 1024 * 1024;
const charsOf = list => list.reduce((n, x) => n + x.data.length, 0);
export function recordSnapshot(entry) {
  stack.push(entry);
  if (stack.length > MAX) stack.shift();
  while (stack.length > 10 && charsOf(stack) > MAX_CHARS) stack.shift();
  redoStack.length = 0; // 有了新改动，之前撤销掉的就不能再重做了
}
export function snapshot(label) {
  recordSnapshot(captureSnapshot(label));
}
/* 上一步快照之后数据其实没变（插入空句又没写就走了）：把那一步扔掉，⌘Z 不会「撤销」一个看不见的改动 */
export function discardIfUnchanged() {
  const top = stack[stack.length - 1];
  if (top && top.projectId === state.projectId && captureSnapshot(top.label).data === top.data) stack.pop();
}
export const clearUndo = () => {
  stack.length = 0;
  redoStack.length = 0;
  purged.clear();
};

/* 协作日志要裁剪时，先把将被裁掉的修改补进仍保留的撤销 / 重做快照。
   先全部计算再替换，避免某份快照出错时只更新一半历史。 */
export function rebaseHistory(projectId, rebase, mark) {
  const entries = [...stack, ...redoStack].filter(entry => entry.projectId === projectId && entry.mark != null);
  const next = entries.map(entry => {
    const data = JSON.parse(entry.data);
    rebase(data, entry);
    return { entry, data: JSON.stringify(data), mark: Math.max(entry.mark, mark) };
  });
  for (const item of next) Object.assign(item.entry, { data: item.data, mark: item.mark });
}

/* 会话开始 / 结束时重新绑定历史标记，旧会话的序号不能用于新的协作会话。 */
export function bindHistory(projectId, mark) {
  for (const entry of [...stack, ...redoStack]) if (entry.projectId === projectId) entry.mark = mark;
}

/* 不进撤销的后台结果，撤销 / 重做时不能被旧快照带回去：
   读到的素材 / 口播时长保留当前值；已清理掉的「不要」候选，快照里仍是「不要」的就别再冒出来
   （快照里是待审 / 通过，说明撤销的正是那次否决，照常恢复） */
const purged = new Set();
export const forgetPurged = ids => ids.forEach(id => purged.add(id));
function keepBackgroundResults(prevAssets, prevVoice) {
  for (const [id, a] of Object.entries(state.assets)) {
    const cur = prevAssets[id];
    if (cur?.durationSec && cur.path === a.path) a.durationSec = cur.durationSec;
  }
  if (state.voice && prevVoice?.duration && prevVoice.path === state.voice.path)
    state.voice.duration = prevVoice.duration;
  state.candidates = state.candidates.filter(c => !(purged.has(c.id) && c.decision === 'no'));
}
export const canUndo = () => stack.length > 0;
export const canRedo = () => redoStack.length > 0;

function prepareSnapshot(u) {
  const p = JSON.parse(u.data);
  collabHooks.rebase?.(p, u);
  return p;
}

export function restoreSnapshotData(u, p = prepareSnapshot(u)) {
  const prevAssets = state.assets || {},
    prevVoice = state.voice;
  const typesChanged = JSON.stringify(state.types) !== JSON.stringify(p.types || state.types);
  const voiceChanged = (state.voice?.path || '') !== (p.voice?.path || '');
  applyProjectData(state, p, 'history');
  keepBackgroundResults(prevAssets, prevVoice);
  state.multi = null;
  if (u.sel != null && state.rows.some(r => r.id === u.sel && r.kind === 'line')) state.sel = u.sel;
  else if (state.sel != null && !state.rows.some(r => r.id === state.sel)) {
    state.sel = state.rows.find(r => r.kind === 'line')?.id ?? null;
  }
  return { typesChanged, voiceChanged };
}

function restore(u, data) {
  const { typesChanged, voiceChanged } = restoreSnapshotData(u, data);
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
  let data;
  try {
    data = prepareSnapshot(u);
  } catch (error) {
    return notify(error.message || '这条撤销记录暂时无法恢复', null, 'warn');
  }
  stack.pop();
  redoStack.push({ ...captureSnapshot(u.label), sel: state.sel });
  restore(u, data);
  notify(`已撤销：${u.label}`, null, 'info');
}

export function redo() {
  const r = redoStack[redoStack.length - 1];
  if (!r) return notify('没有可重做的操作', null, 'info');
  if (r.projectId !== state.projectId) return notify('那条操作不在当前项目里', null, 'info');
  let data;
  try {
    data = prepareSnapshot(r);
  } catch (error) {
    return notify(error.message || '这条重做记录暂时无法恢复', null, 'warn');
  }
  redoStack.pop();
  stack.push(captureSnapshot(r.label));
  restore(r, data);
  notify(`已重做：${r.label}`, null, 'info');
}
