/* 多项目管理：顶栏「项目」菜单（列表 / 新建 / 切换 / 删除 / 最近删除 / 从备份恢复）+ 菜单内重命名 */
import { state, update } from '../app/state.js';
import * as storage from '../app/storage.js';
import { clearUndo } from '../app/undo.js';
import { renameProject } from '../app/actions.js';
import * as native from '../platform/native.js';
import { toast, confirmModal, esc } from './dom.js';
import { openMenu, closePop, popOpenFor, markPopAnchor } from './popover.js';
import { armAnimation, slideIn } from './anim.js';
import { registerCommand, runCommand } from './commands.js';
import { registerModal } from './modal.js';

const timeAgo = t => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
};
const lineCount = p => (p.rows || []).filter(r => r.kind === 'line').length;
/* 二级菜单（最近删除 / 自动备份）就地替换项目菜单，顶上一行「‹ 返回」回到上一层 */
const back = (to, label) =>
  `<div class="pop-item pop-back" data-projact="${to}"><svg class="mi" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg><span>${label}</span></div>`;
const FOLDER =
  '<svg class="mi" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
const TRASH_PATH =
  'M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7M10 11v5M14 11v5';

/* 换了项目（切换 / 新建 / 删除当前 / 恢复）后的统一收尾 */
function afterProjectChange(msg) {
  clearUndo();
  armAnimation();
  update('rows');
  slideIn(document.querySelector('.workspace'), 1, 48); // 换了项目：新内容从右边滑进来
  if (msg) toast(msg);
}

function openProjectsMenu(anchor) {
  const list = storage
    .allProjects()
    .map(p => {
      const cur = p.id === state.projectId;
      return `<div class="pop-item" data-proj="${esc(p.id)}">${FOLDER}
      <span class="main"><span>${esc(p.title || '未命名')}</span><span class="desc">${lineCount(p)} 句 · ${timeAgo(p.updatedAt || Date.now())}</span></span>
      ${cur ? '<span class="chk">✓</span>' : `<button class="proj-del" data-projdel="${esc(p.id)}" title="删除这个项目（30 天内可在「最近删除」找回）" aria-label="删除这个项目"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${TRASH_PATH}"/></svg></button>`}
    </div>`;
    })
    .join('');
  const trashN = storage.trashList().length;
  openMenu(
    anchor,
    `
    <div class="p-title p-title-row"><span>项目 · ${storage.allProjects().length} 个</span><button class="p-title-link" data-projact="folder" title="项目数据存在这台电脑上，点开看数据文件夹">数据文件夹</button></div>
    ${list}
    <div class="pop-sep"></div>
    <div class="pop-item" data-projact="rename"><svg class="mi" viewBox="0 0 24 24"><path d="m14 5 5 5M4 20l4-1 12-12-3-3L5 16Z"/></svg><span>重命名当前项目…</span></div>
    <div class="pop-item" data-projact="new"><svg class="mi" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span class="main">新建空项目<span class="desc">⌘N · 也可以直接把稿子文件拖进窗口</span></span></div>
    <div class="pop-sep"></div>
    ${trashN ? `<div class="pop-item" data-projact="trash"><svg class="mi" viewBox="0 0 24 24"><path d="${TRASH_PATH}"/></svg><span class="main">最近删除（${trashN}）<span class="desc">删除的项目保留 30 天</span></span></div>` : ''}
    <div class="pop-item" data-projact="backup"><svg class="mi" viewBox="0 0 24 24"><path d="M12 8v4l2.5 2.5"/><circle cx="12" cy="12" r="9"/></svg><span>从自动备份恢复…</span></div>
  `,
  );
  markPopAnchor(anchor);
}

function openTrashMenu(anchor) {
  const list = storage.trashList();
  openMenu(
    anchor,
    back('projects', '项目') +
      (!list.length
        ? `<div class="p-title">最近删除是空的</div>`
        : `<div class="p-title">最近删除（30 天后自动清掉）</div>` +
          list
            .map(
              x =>
                `<div class="pop-item" data-untrash="${esc(x.project.id)}">${FOLDER}<span class="main"><span>${esc(x.project.title || '未命名')}</span><span class="desc">${lineCount(x.project)} 句 · ${timeAgo(x.deletedAt)}删除 · 点击找回</span></span></div>`,
            )
            .join('')),
    { sub: true },
  );
  markPopAnchor(anchor);
}

async function openBackupMenu(anchor) {
  const list = await native.listBackups();
  openMenu(
    anchor,
    back('projects', '项目') +
      (!list.length
        ? `<div class="p-title">暂无备份（写盘时每 30 分钟自动备份一份：24 小时内全留，更早的每天留一份、保留 30 天）</div>`
        : `<div class="p-title">选一个时间点（下一步可选：只取回某个项目，或整库恢复）</div>` +
          list
            .map(
              b =>
                `<div class="pop-item" data-backup="${esc(b.f)}"><span>${esc(b.f.replace(/^备份-|\.json$/g, ''))}</span><span class="sub">${timeAgo(b.t)}</span></div>`,
            )
            .join('')),
    { sub: true },
  );
  markPopAnchor(anchor);
}

/* 选了一个备份：列出里面的项目，可以只取回一个（作为新项目，不动现有项目），或整库替换 */
async function openBackupDetail(anchor, file) {
  const r = await native.restoreBackup(file);
  if (!r?.ok) return toast('备份读取失败');
  const projects = Object.values(r.data.projects || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  openMenu(
    anchor,
    back('backup', '全部备份') +
      `<div class="p-title">备份 ${esc(file.replace(/^备份-|\.json$/g, ''))} 里的项目 · 点一个只取回它</div>` +
      projects
        .map(
          p =>
            `<div class="pop-item" data-backup-one="${esc(p.id)}" data-backup-file="${esc(file)}">${FOLDER}<span class="main"><span>${esc(p.title || '未命名')}</span><span class="desc">${lineCount(p)} 句 · 当时 ${timeAgo(p.updatedAt || Date.now())}改过 · 作为新项目加回来</span></span></div>`,
        )
        .join('') +
      `<div class="pop-sep"></div><div class="pop-item danger" data-backup-all="${esc(file)}"><span class="main">整库恢复到这个时间点<span class="desc">当前所有项目会被替换（数据损坏时兜底用）</span></span></div>`,
    { sub: true },
  );
  markPopAnchor(anchor);
}

function confirmDelete(id) {
  const p = storage.allProjects().find(x => x.id === id);
  closePop();
  confirmModal(
    `删除项目「${p?.title || '未命名'}」？`,
    '删除后 30 天内可以在「项目 → 最近删除」里找回。',
    '删除',
    () => {
      if (storage.allProjects().length <= 1) return toast('至少保留一个项目');
      const wasCurrent = id === state.projectId;
      if (storage.deleteProject(id)) {
        // 只有删的是当前项目才需要换内容；删别的项目时当前的撤销记录和光标原样保留
        if (wasCurrent) afterProjectChange();
        toast('项目已删除，可在「最近删除」找回');
      }
    },
  );
}

/* 顶部标题只显示；改名通过项目菜单内的独立对话框提交。 */
let namingProjectId = null;
const closeProjectName = () => document.querySelector('#projectNameMask').classList.remove('show');
function openProjectName() {
  namingProjectId = state.projectId;
  const input = document.querySelector('#projectNameInput');
  input.value = state.title;
  input.setCustomValidity('');
  document.querySelector('#projectNameMask').classList.add('show');
  input.focus();
  input.select();
}
function saveProjectName() {
  const input = document.querySelector('#projectNameInput');
  if (!input.value.trim()) {
    input.setCustomValidity('请输入项目名称');
    input.reportValidity();
    return;
  }
  if (namingProjectId === state.projectId) renameProject(input.value.trim());
  closeProjectName();
}

/* 新建空项目：原生菜单和项目菜单共用，随后在对话框中起名。 */
export function newEmptyProject() {
  storage.createProject('未命名项目', []);
  afterProjectChange();
  openProjectName();
}

export function initProjects() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="projectNameMask"><div class="modal">
      <h3>重命名项目</h3>
      <label for="projectNameInput">项目名称</label>
      <input class="project-name-input" id="projectNameInput" type="text" required autocomplete="off" />
      <div class="m-btns"><button class="btn" id="projectNameCancel">取消</button><button class="btn primary" id="projectNameSave">保存</button></div>
    </div></div>`,
  );
  document.querySelector('#projectNameCancel').onclick = closeProjectName;
  document.querySelector('#projectNameSave').onclick = saveProjectName;
  document.querySelector('#projectNameInput').oninput = e => e.target.setCustomValidity('');
  document.querySelector('#projectNameMask').onclick = e => {
    if (e.target.id === 'projectNameMask') closeProjectName();
  };
  registerModal('projectNameMask', { close: closeProjectName, enter: saveProjectName });
  registerCommand('project:new', newEmptyProject);
  document.querySelector('#btnProjects').onclick = e => {
    e.stopPropagation();
    if (popOpenFor(e.currentTarget)) return closePop();
    openProjectsMenu(e.currentTarget);
  };
  const btn = () => document.querySelector('#btnProjects');

  document.addEventListener(
    'click',
    async e => {
      if (!document.querySelector('.popover')) return;
      const del = e.target.closest('[data-projdel]');
      if (del) {
        e.stopPropagation();
        confirmDelete(del.dataset.projdel);
        return;
      }
      const proj = e.target.closest('[data-proj]');
      if (proj) {
        const id = proj.dataset.proj;
        if (id !== state.projectId && storage.switchProject(id)) afterProjectChange(`已切换到「${state.title}」`);
        closePop();
        return;
      }
      const act = e.target.closest('[data-projact]');
      if (act) {
        closePop();
        const a = act.dataset.projact;
        if (a === 'new') newEmptyProject();
        if (a === 'rename') openProjectName();
        if (a === 'types') runCommand('types:edit');
        if (a === 'folder') native.openDataFolder();
        if (a === 'projects') setTimeout(() => openProjectsMenu(btn()), 0);
        if (a === 'trash') setTimeout(() => openTrashMenu(btn()), 0);
        if (a === 'backup') setTimeout(() => openBackupMenu(btn()), 0);
        return;
      }
      const un = e.target.closest('[data-untrash]');
      if (un) {
        closePop();
        if (storage.restoreFromTrash(un.dataset.untrash)) toast('项目已找回，在「项目」列表里');
        return;
      }
      const bk = e.target.closest('[data-backup]');
      if (bk) {
        const f = bk.dataset.backup;
        closePop();
        setTimeout(() => openBackupDetail(btn(), f), 0);
        return;
      }
      const one = e.target.closest('[data-backup-one]');
      if (one) {
        closePop();
        const r = await native.restoreBackup(one.dataset.backupFile);
        const p = r?.ok && r.data.projects?.[one.dataset.backupOne];
        if (!p) return toast('备份读取失败');
        if (!storage.importProjectCopy(p)) return toast('备份里的这个项目结构损坏，没法取回', null, 'error');
        toast(`已把「${p.title || '未命名'}」作为新项目取回，现有项目没动`, null, 'ok');
        return;
      }
      const all = e.target.closest('[data-backup-all]');
      if (all) {
        const f = all.dataset.backupAll;
        closePop();
        confirmModal(
          '整库恢复到这个备份？',
          '当前所有项目会被备份里的版本整个替换（用于数据损坏时兜底）。',
          '整库恢复',
          async () => {
            const r = await native.restoreBackup(f);
            if (r?.ok && storage.restoreLibrary(r.data)) afterProjectChange('已恢复到备份');
            else toast('备份读取失败');
          },
        );
      }
    },
    true,
  );
}
