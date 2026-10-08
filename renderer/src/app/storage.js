/* 数据层：项目数据落在本机磁盘文件（主进程原子写 + 自动备份）。
   library 结构：{ v:2, currentId, projects: {[id]: project}, settings: {defaultTypes?}, trash: {[id]: {project, deletedAt}} }
   写盘只发「改动过的项目」（增量补丁），主进程合并后整文件原子写：
   项目再多，打字时渲染进程也不用把整个库深拷贝、跨进程搬一遍。 */
import { state, loadProjectIntoState, bumpRev } from './state.js';
import { emit } from './events.js';
import { demoProject } from '../core/demo.js';
import { normalizeTypes } from '../core/types.js';
import * as native from '../platform/native.js';

let library = null;
let saveTimer = null;
let revision = 0;
let loadInfo = { status: 'ok' };
let retryTimer = null;
const dirtyIds = new Set(); // 待写盘的项目
let metaDirty = false; // currentId / settings / trash 变了
let fullDirty = false; // 整库替换（恢复备份）
export const dataLoadInfo = () => loadInfo;
const TRASH_DAYS = 30;

/* 保存状态：saving / saved / error，界面层订阅 'save-state' 显示 */
const saveHook = phase => emit('save-state', phase);

export function initStorage() {
  library = native.isNative() ? native.loadData() : null;
  loadInfo = native.dataStatus() || { status: library ? 'ok' : 'missing' };
  // 关窗 / 退出时把防抖中的保存同步冲刷掉：普通保存是异步 IPC，进程一退就丢了
  window.addEventListener('beforeunload', () => {
    if (!hasPending() || !library) return;
    try {
      clearTimeout(saveTimer);
      syncFromState();
      if (native.saveDataSync(takePatch())) markClean();
    } catch {}
  });
  if (!library || !library.projects || !Object.keys(library.projects).length) {
    // 首次启动：先装载示例再落盘（persist 会用 state 反写当前项目，必须等 state 就绪）
    library = { v: 2, settings: {}, trash: {}, ...(library || {}), ...demoLibrary() };
    loadProjectIntoState(library.projects[library.currentId]);
    fullDirty = true;
    persist(true);
    // 数据文件坏了（坏文件已被主进程改名保留）不算「第一次打开」，由界面另行提示
    return loadInfo.status !== 'corrupt';
  }
  library.settings ||= {};
  library.trash ||= {};
  purgeTrash();
  if (!library.projects[library.currentId]) library.currentId = Object.keys(library.projects)[0];
  return false;
}

function demoLibrary() {
  const d = demoProject();
  const id = 'p_' + Date.now().toString(36);
  return { currentId: id, projects: { [id]: { id, title: d.title, rows: d.rows, updatedAt: Date.now() } } };
}

export const current = () => library.projects[library.currentId];
/* 按 id 取库里的项目（后台任务完成时项目已经切走，要改的是原项目） */
export const projectById = id => library?.projects?.[id] || null;
export const allProjects = () => Object.values(library.projects).sort((a, b) => b.updatedAt - a.updatedAt);
export const settings = () => library.settings;

/* 新项目默认用的类型表（用户在类型编辑器里勾了「以后新建项目也用这套」才有） */
export const defaultTypesForNew = () => normalizeTypes(library?.settings?.defaultTypes);
export function setDefaultTypes(types) {
  library.settings.defaultTypes = normalizeTypes(types);
  metaDirty = true;
  schedule();
}

/* 把 state 里的当前项目内容写回 library；state 还没装载任何项目时不动盘上的数据 */
export function syncFromState() {
  const p = current();
  if (!p || state.projectId !== library.currentId) return;
  p.title = state.title;
  p.rows = state.rows;
  p.cursorId = state.sel;
  p.speechRate = state.speechRate;
  p.assets = state.assets;
  p.types = state.types;
  if (state.timing) p.timing = state.timing;
  else delete p.timing;
  if (state.voice) p.voice = state.voice;
  else delete p.voice;
  if (state.candidates && state.candidates.length) p.candidates = state.candidates;
  else delete p.candidates;
  if (state.mediaDir) p.mediaDir = state.mediaDir;
  else delete p.mediaDir;
  p.updatedAt = Date.now();
  dirtyIds.add(p.id);
}

const hasPending = () => fullDirty || metaDirty || dirtyIds.size > 0;
function markClean() {
  dirtyIds.clear();
  metaDirty = false;
  fullDirty = false;
}
/* 取出当前待写的补丁（取完即清，失败时由 doSave 放回） */
function takePatch() {
  if (fullDirty) return { full: library };
  const projects = {};
  for (const id of dirtyIds) projects[id] = library.projects[id] ?? null;
  return {
    currentId: library.currentId,
    settings: library.settings,
    trash: metaDirty ? library.trash : undefined,
    projects,
  };
}

function schedule(now = false) {
  const version = ++revision;
  saveHook('saving');
  clearTimeout(saveTimer);
  if (now) doSave(version);
  else saveTimer = setTimeout(() => doSave(version), 400);
}

export function persist(now = false) {
  syncFromState();
  bumpRev();
  schedule(now);
}

/* 写盘；失败（磁盘满 / 权限）时 5 秒后自动重试，不等下一次改动才再试 */
async function doSave(version) {
  clearTimeout(retryTimer);
  if (!hasPending()) {
    if (version === revision) saveHook('saved');
    return;
  }
  const wasFull = fullDirty,
    wasMeta = metaDirty,
    ids = [...dirtyIds];
  const patch = takePatch();
  markClean();
  try {
    await native.saveData(patch);
    if (version === revision && !hasPending()) saveHook('saved');
  } catch {
    // 放回去，下次一起写
    fullDirty ||= wasFull;
    metaDirty ||= wasMeta;
    ids.forEach(id => dirtyIds.add(id));
    saveHook('error');
    retryTimer = setTimeout(() => {
      if (hasPending()) doSave(revision);
    }, 5000);
  }
}

/* 不是当前项目的数据被改了（后台任务跑到一半切了项目）：标记那个项目待写盘 */
export function markProjectDirty(id) {
  if (!library?.projects?.[id]) return;
  dirtyIds.add(id);
  schedule();
}

export function archiveCurrentCopy(label) {
  syncFromState();
  const p = current();
  const id = 'p_' + crypto.randomUUID();
  library.projects[id] = { ...structuredClone(p), id, title: p.title + ' · ' + label, updatedAt: Date.now() };
  dirtyIds.add(id);
}

/* 光标位置单独记（不算改动、不进撤销），停 1.5 秒再写，方向键连按不会连写 */
export function rememberCursor() {
  if (!library || state.sel == null) return;
  const p = current();
  if (p && p.id === state.projectId && p.cursorId !== state.sel) {
    p.cursorId = state.sel;
    dirtyIds.add(p.id);
    const version = ++revision;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => doSave(version), 1500);
  }
}

/* 新建项目（rows 可空 = 空项目；assets = 项目级素材库，导入项目 JSON 时带上） */
export function createProject(title, rows = [], assets = {}, extra = {}) {
  const id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  library.projects[id] = { id, title, rows, assets, types: defaultTypesForNew(), ...extra, updatedAt: Date.now() };
  library.currentId = id;
  metaDirty = true;
  loadProjectIntoState(library.projects[id]);
  persist(true);
  return id;
}

export function switchProject(id) {
  if (!library.projects[id] || id === library.currentId) return false;
  syncFromState(); // 切走前先把当前项目记下
  library.currentId = id;
  metaDirty = true;
  loadProjectIntoState(library.projects[id]);
  persist(true);
  return true;
}

/* 删除项目：先进「最近删除」，30 天内可以找回 */
export function deleteProject(id) {
  const p = library.projects[id];
  if (!p) return false;
  if (Object.keys(library.projects).length <= 1) return false;
  if (id === library.currentId) syncFromState();
  library.trash[id] = { project: p, deletedAt: Date.now() };
  delete library.projects[id];
  dirtyIds.add(id); // 补丁里 null = 从项目表删掉
  metaDirty = true;
  if (library.currentId === id) {
    // 删的是当前项目：state 必须同步指向新项目，不能悬空在已删除的引用上
    library.currentId = allProjects()[0].id;
    loadProjectIntoState(library.projects[library.currentId]);
  }
  persist(true);
  return true;
}
export const trashList = () =>
  Object.values(library.trash || {})
    .filter(x => x && x.project)
    .sort((a, b) => b.deletedAt - a.deletedAt);
export function restoreFromTrash(id) {
  const item = library.trash[id];
  if (!item) return false;
  delete library.trash[id];
  library.projects[id] = { ...item.project, updatedAt: Date.now() };
  dirtyIds.add(id);
  metaDirty = true;
  schedule(true);
  return true;
}
function purgeTrash(now = Date.now()) {
  for (const [id, x] of Object.entries(library.trash || {}))
    if (!x || now - x.deletedAt > TRASH_DAYS * 86400000) {
      delete library.trash[id];
      metaDirty = true;
    }
}

/* 备份恢复：整库替换 */
export function restoreLibrary(data) {
  if (!data || !data.projects || typeof data.projects !== 'object') return false;
  // 备份里结构坏掉的项目不载入（留在原备份文件里），其余照常恢复
  const projects = Object.fromEntries(Object.entries(data.projects).filter(([, p]) => p && Array.isArray(p.rows)));
  if (!Object.keys(projects).length) return false;
  library = { settings: {}, trash: {}, ...data, projects };
  if (!library.projects[library.currentId]) library.currentId = Object.keys(library.projects)[0];
  loadProjectIntoState(library.projects[library.currentId]);
  fullDirty = true;
  persist(true);
  return true;
}

/* 从备份里只取一个项目，作为新项目加回来（不动其它项目） */
export function importProjectCopy(project, suffix = '（从备份恢复）') {
  if (!project || !Array.isArray(project.rows)) return null;
  const id = 'p_' + crypto.randomUUID();
  library.projects[id] = {
    ...structuredClone(project),
    id,
    title: (project.title || '未命名') + suffix,
    updatedAt: Date.now(),
  };
  dirtyIds.add(id);
  metaDirty = true;
  schedule(true);
  return id;
}
