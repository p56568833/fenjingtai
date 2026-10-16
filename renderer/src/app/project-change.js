import { prepareProjectEdit } from '../core/project-edit.js';
import { viewState } from './view-state.js';
import { projectDelta } from '../core/project-delta.js';
import { publishProjectEvents } from './project-events.js';
/* 项目修改的提交入口：撤销、数据规范化、保存和业务事件在一次同步操作内完成。
   异步工作先取得结果，再带原项目 id 调用这里；后台结果不会进入当前项目的撤销栈。 */
import { state } from './state.js';
import { invalidateProjectQueries } from './project-queries.js';
import { notify } from './events.js';
import { persist, projectById, projectForId, markProjectDirty } from './storage.js';
import { captureSnapshot, recordSnapshot } from './undo.js';
import { applyProjectData } from '../core/project-data.js';
import { captureMutation, restoreMutation } from '../core/project-transaction.js';
import { normalizeGroups } from '../core/shots.js';
import { syncMirror } from '../core/asset-model.js';

function normalizeProject(project, { normalize = false, mirror = true } = {}) {
  if (normalize) normalizeGroups(project.rows);
  if (mirror) syncMirror(project.rows, project.assets || {});
}

function publishProjectChange({ projectId, events = [], now = false, changes }) {
  const current = projectId === state.projectId;
  if (current) persist(now);
  else markProjectDirty(projectId);
  if (current)
    publishProjectEvents(
      {
        projectId,
        source: 'local',
        ...(changes || {
          timing: true,
          fields: [],
          rowIds: null,
          rowFields: null,
          structural: true,
          assets: true,
          candidates: true,
        }),
      },
      events,
    );
}

export function commitProjectChange({
  projectId = state.projectId,
  normalize = false,
  mirror = true,
  events = [],
  now = false,
} = {}) {
  const project = projectForId(projectId);
  if (!project) return false;
  normalizeProject(project, { normalize, mirror });
  publishProjectChange({ projectId, events, now });
  return true;
}

export function changeProject(label, mutate, options = {}) {
  if (mutate.constructor.name === 'AsyncFunction') throw new Error('项目修改必须同步完成');
  const projectId = options.projectId ?? state.projectId;
  const current = projectId === state.projectId;
  const project = projectForId(projectId);
  if (!project) return false;
  // 每次修改都有失败恢复点；是否进撤销栈只由 label 决定。
  const checkpoint = captureMutation(project);
  const viewCheckpoint = current ? captureMutation(viewState) : null;
  const before = label && current ? captureSnapshot(label) : null;
  const rollback = () => {
    if (viewCheckpoint) restoreMutation(viewState, viewCheckpoint);
    if (!restoreMutation(project, checkpoint) || !current) return;
    // 不保存失败操作、不广播业务事件；恢复库里的引用，并让派生查询重新计算。
    const stored = projectById(projectId);
    if (stored) applyProjectData(stored, project, 'storage');
    invalidateProjectQueries();
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
  let changes;
  try {
    result = mutate(change, project);
    if (result?.then) throw new Error('项目修改不能等待异步任务');
    if (result === false || result?.error) {
      rollback();
      return result;
    }
    // 规范化同样属于修改阶段，出错时必须恢复；业务事件只在全部成功后发布。
    normalizeProject(project, { ...options, normalize });
    changes = projectDelta(JSON.parse(checkpoint.data), project);
  } catch (error) {
    rollback();
    throw error;
  }
  // 只有完成的修改才清空重做栈；校验失败不会留下空撤销步。
  if (before) recordSnapshot(before);
  publishProjectChange({ ...options, projectId, events, changes });
  for (const args of messages) notify(...args);
  return result;
}

/* 连续输入只捕获涉及的字段；完整撤销快照只在这次编辑的第一步创建。 */
export function editProjectFields(label, patch, { projectId = state.projectId } = {}) {
  const current = projectId === state.projectId;
  const project = projectForId(projectId);
  if (!project) return false;
  const edit = prepareProjectEdit(project, patch);
  if (!edit.changed) return false;
  const before = label && current ? captureSnapshot(label) : null;
  edit.apply();
  if (before) recordSnapshot(before);
  publishProjectChange({ projectId, changes: edit.changes });
  return true;
}

/* 导出前安排保存，不制造项目修改事件或使查询缓存失效。 */
export function saveCurrentProject() {
  if (!state.projectId) return false;
  persist(true);
  return true;
}
