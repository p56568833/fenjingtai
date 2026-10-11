/* 项目修改的提交入口：撤销、数据规范化、保存和业务事件在一次同步操作内完成。
   异步工作先取得结果，再带原项目 id 调用这里；后台结果不会进入当前项目的撤销栈。 */
import { state, update } from './state.js';
import { emit, notify } from './events.js';
import { persist, projectById, markProjectDirty } from './storage.js';
import { captureSnapshot, recordSnapshot, restoreSnapshotData } from './undo.js';
import { normalizeGroups } from '../core/shots.js';
import { syncMirror } from '../core/asset-model.js';

export function commitProjectChange({
  projectId = state.projectId,
  normalize = false,
  mirror = false,
  events = [],
  now = false,
} = {}) {
  const current = projectId === state.projectId;
  const project = current ? state : projectById(projectId);
  if (!project) return false;
  if (normalize) normalizeGroups(project.rows);
  if (mirror) syncMirror(project.rows, project.assets || {});
  if (current) persist(now);
  else markProjectDirty(projectId);
  if (current)
    for (const [event, payload] of events) {
      if (event === 'rows') update('rows');
      else emit(event, payload);
    }
  return true;
}

export function changeProject(label, mutate, options = {}) {
  if (mutate.constructor.name === 'AsyncFunction') throw new Error('项目修改必须同步完成');
  const projectId = options.projectId ?? state.projectId;
  const current = projectId === state.projectId;
  const project = current ? state : projectById(projectId);
  if (!project) return false;
  const before = label && current ? captureSnapshot(label) : null;
  const rollback = () => {
    if (!before || captureSnapshot(label).data === before.data) return;
    const { typesChanged, voiceChanged } = restoreSnapshotData(before);
    // 项目库可能共享改动前的数组引用；恢复时也重新关联项目库，防止稍后的保存仍写入失败修改。
    persist();
    if (typesChanged) emit('types');
    if (voiceChanged) emit('voice');
    update('rows');
  };
  const events = [...(options.events || [])];
  let normalize = !!options.normalize;
  const messages = [];
  const change = {
    emit: (event, payload) => events.push([event, payload]),
    normalize: () => {
      normalize = true;
    },
    notify: (...args) => messages.push(args),
  };
  let result;
  try {
    result = mutate(change, project);
    if (result?.then) throw new Error('项目修改不能等待异步任务');
    if (result === false || result?.error) {
      rollback();
      return result;
    }
  } catch (error) {
    rollback();
    throw error;
  }
  // 只有完成的修改才清空重做栈；校验失败不会留下空撤销步。
  if (before) recordSnapshot(before);
  commitProjectChange({ ...options, projectId, normalize, events });
  for (const args of messages) notify(...args);
  return result;
}
