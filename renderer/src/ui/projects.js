/* 多项目管理：顶栏「项目」菜单（列表 / 新建 / 切换 / 删除 / 最近删除 / 从备份恢复）+ 菜单内重命名 */
import { state } from '../app/state.js';
import { update } from '../app/project-events.js';
import * as storage from '../app/storage.js';
import { clearUndo } from '../app/undo.js';
import { renameProject } from '../app/actions.js';
import * as native from '../platform/native.js';
import { toast, confirmModal, esc } from './base/dom.js';
import { openMenu, closePop, popOpenFor, markPopAnchor, popEl } from './base/popover.js';
import { armAnimation, slideIn } from './base/anim.js';
import { registerCommand, runCommand } from './base/commands.js';
import { registerModal, anyModalOpen } from './base/modal.js';
import { flushPendingEdits } from './base/edit-session.js';

const timeAgo = t => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
};
const lineCount = p => (p.rows || []).filter(r => r.kind === 'line').length;
/* 二级菜单（最近删除 / 自动备份）就地替换项目菜单，顶上「‹ 返回」回到上一层 */
const svg = p => `<svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
const ico = (cls, p) => `<span class="io-ico sm ${cls}">${svg(p)}</span>`;
const ICO_BOARD = '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 10h18M9 10v10"/>';
const ICO_FOLDER = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>';
const ICO_PLUS = '<path d="M12 5v14M5 12h14"/>';
const ICO_EDIT = '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>';
const ICO_CLOCK = '<path d="M12 8v4l2.5 2.5"/><circle cx="12" cy="12" r="9"/>';
const ICO_RESTORE = '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>';
const ICO_BACK = '<path d="m15 18-6-6 6-6"/>';
const ICO_EXT = '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>';
const TRASH_PATH =
  'M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7M10 11v5M14 11v5';
const subHead = (to, backLabel, title, badge = '') => `<div class="io-head proj-sub-head">
  <button class="io-head-btn pop-back" data-projact="${to}">${svg(ICO_BACK)}<span>${esc(backLabel)}</span></button>
  <span class="io-title proj-sub-title">${esc(title)}</span>
  ${badge ? `<span class="io-badge slate">${esc(badge)}</span>` : ''}
</div>`;

/* 换了项目（切换 / 新建 / 删除当前 / 恢复）后的统一收尾 */
function afterProjectChange(msg) {
  clearUndo();
  armAnimation();
  update('rows');
  slideIn(document.querySelector('.workspace'), 1, 48); // 换了项目：新内容从右边滑进来
  if (msg) toast(msg, null, 'ok');
}

let backupMenuSeq = 0;

function openProjectsMenu(anchor) {
  backupMenuSeq++;
  const all = storage.allProjects();
  const list = all
    .map(p => {
      const cur = p.id === state.projectId;
      const tags = [
        p.langMode === 'en-zh' ? '<span class="io-badge sky proj-bilingual">英配中字</span>' : '',
        p.collab
          ? `<span class="io-badge green proj-collab">${p.collab.role === 'host' ? '共享中' : '协作'}</span>`
          : '',
      ]
        .filter(Boolean)
        .join('');
      return `<div class="pop-item proj-card${cur ? ' cur' : ''}" data-proj="${esc(p.id)}">
        ${ico(cur ? 'blue' : 'slate', cur ? ICO_BOARD : ICO_FOLDER)}
        <span class="io-meta">
          <span class="io-name proj-name">${esc(p.title || '未命名')}</span>
          <span class="proj-meta"><span>${lineCount(p)} 句 · ${timeAgo(p.updatedAt || Date.now())}</span>${tags}</span>
        </span>
        ${
          cur
            ? '<span class="chk proj-cur-pill">✓ 当前</span>'
            : `<button class="proj-del" data-projdel="${esc(p.id)}" title="删除这个项目（30 天内可在「最近删除」找回）" aria-label="删除这个项目"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${TRASH_PATH}"/></svg></button>`
        }
      </div>`;
    })
    .join('');
  const trashN = storage.trashList().length;
  openMenu(
    anchor,
    `<div class="io-head proj-head">
      <div class="proj-head-left"><span class="io-title">项目</span><span class="io-badge slate">${all.length} 个</span></div>
      <button class="io-head-btn" data-projact="folder" title="项目数据存在这台电脑上，点开看数据文件夹"><span>数据文件夹</span>${svg(ICO_EXT)}</button>
    </div>
    <div class="proj-list">${list}</div>
    <div class="proj-foot">
      <div class="io-grid proj-grid">
        <button class="pop-item io-tile" data-projact="new" title="新建空项目 (⌘N)，也可以直接把稿子文件拖进窗口">
          ${ico('blue', ICO_PLUS)}
          <span class="io-tile-txt"><strong>新建空项目</strong><small>⌘N · 可拖稿导入</small></span>
        </button>
        <button class="pop-item io-tile" data-projact="rename" title="修改当前项目名称">
          ${ico('violet', ICO_EDIT)}
          <span class="io-tile-txt"><strong>重命名当前</strong><small>修改项目标题</small></span>
        </button>
      </div>
      <div class="proj-util">
        ${
          trashN
            ? `<button class="pop-item proj-util-btn" data-projact="trash" title="删除的项目保留 30 天">${svg(`<path d="${TRASH_PATH}"/>`)}<span>最近删除</span><span class="io-badge amber">${trashN}</span><span class="io-arrow">›</span></button>`
            : ''
        }
        <button class="pop-item proj-util-btn" data-projact="backup" title="每 30 分钟自动备份，可单取项目或整库恢复">${svg(ICO_CLOCK)}<span>自动备份恢复</span><span class="io-arrow">›</span></button>
      </div>
    </div>`,
    { className: 'proj-menu', hoverGlide: false },
  );
  markPopAnchor(anchor);
  popEl?.querySelector('.proj-card.cur')?.scrollIntoView({ block: 'nearest' });
}

function openTrashMenu(anchor) {
  backupMenuSeq++;
  const list = storage.trashList();
  openMenu(
    anchor,
    subHead('projects', '项目', '最近删除', list.length ? `${list.length} 个` : '') +
      (!list.length
        ? '<div class="proj-empty">最近删除是空的</div>'
        : `<div class="proj-sub-hint">删除的项目保留 30 天，点击即可找回</div><div class="proj-list">${list
            .map(
              x =>
                `<div class="pop-item proj-card" data-untrash="${esc(x.project.id)}">${ico('amber', ICO_RESTORE)}<span class="io-meta"><span class="io-name proj-name">${esc(x.project.title || '未命名')}</span><span class="io-desc">${lineCount(x.project)} 句 · ${timeAgo(x.deletedAt)}删除</span></span><span class="io-pill">找回</span></div>`,
            )
            .join('')}</div>`),
    { className: 'proj-menu', sub: true, hoverGlide: false },
  );
  markPopAnchor(anchor);
}

async function openBackupMenu(anchor) {
  const seq = ++backupMenuSeq;
  const pid = state.projectId;
  const list = (await native.listBackups()) || [];
  if (seq !== backupMenuSeq || state.projectId !== pid || anyModalOpen() || popEl || !anchor?.isConnected) return;
  openMenu(
    anchor,
    subHead('projects', '项目', '自动备份', list.length ? `${list.length} 份` : '') +
      (!list.length
        ? '<div class="proj-empty">暂无自动备份<small>写盘时每 30 分钟自动留存一份：24 小时内全留，更早的每天留一份、保留 30 天</small></div>'
        : `<div class="proj-sub-hint">选一个时间点，可只取回单个项目或整库恢复</div><div class="proj-list">${list
            .map(
              b =>
                `<div class="pop-item proj-card" data-backup="${esc(b.f)}">${ico('sky', ICO_CLOCK)}<span class="io-meta"><span class="io-name">${esc(b.f.replace(/^备份-|\.json$/g, ''))}</span><span class="io-desc">${timeAgo(b.t)}</span></span><span class="io-arrow">›</span></div>`,
            )
            .join('')}</div>`),
    { className: 'proj-menu', sub: true, hoverGlide: false },
  );
  markPopAnchor(anchor);
}

/* 选了一个备份：列出里面的项目，可以只取回一个（作为新项目，不动现有项目），或整库替换 */
async function openBackupDetail(anchor, file) {
  const seq = ++backupMenuSeq;
  const pid = state.projectId;
  const r = await native.restoreBackup(file);
  if (seq !== backupMenuSeq || state.projectId !== pid || anyModalOpen() || popEl || !anchor?.isConnected) return;
  if (!r?.ok) return toast('备份读取失败', null, 'error');
  const projects = Object.values(r.data.projects || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  openMenu(
    anchor,
    subHead('backup', '全部备份', file.replace(/^备份-|\.json$/g, ''), `${projects.length} 个`) +
      '<div class="proj-sub-hint">点某个项目只取回它（作为新项目加入，不动现有项目）</div>' +
      `<div class="proj-list">${projects
        .map(
          p =>
            `<div class="pop-item proj-card" data-backup-one="${esc(p.id)}" data-backup-file="${esc(file)}">${ico('blue', ICO_FOLDER)}<span class="io-meta"><span class="io-name proj-name">${esc(p.title || '未命名')}</span><span class="io-desc">${lineCount(p)} 句 · 当时 ${timeAgo(p.updatedAt || Date.now())}改过</span></span><span class="io-pill">取回</span></div>`,
        )
        .join('')}</div>` +
      `<div class="proj-foot"><div class="pop-item proj-card danger" data-backup-all="${esc(file)}">${ico('red', ICO_RESTORE)}<span class="io-meta"><span class="io-name">整库恢复到这个时间点</span><span class="io-desc">当前所有项目会被替换（数据损坏时兜底用）</span></span></div></div>`,
    { className: 'proj-menu', sub: true, hoverGlide: false },
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
      flushPendingEdits();
      if (storage.allProjects().length <= 1) return toast('至少保留一个项目', null, 'warn');
      const wasCurrent = id === state.projectId;
      if (storage.deleteProject(id)) {
        // 只有删的是当前项目才需要换内容；删别的项目时当前的撤销记录和光标原样保留
        if (wasCurrent) afterProjectChange();
        toast('项目已删除，可在「最近删除」找回', null, 'ok');
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
function newEmptyProject() {
  flushPendingEdits();
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
      if (!document.querySelector('.popover:not(.pop-leaving)')) return;
      const del = e.target.closest('[data-projdel]');
      if (del) {
        e.stopPropagation();
        confirmDelete(del.dataset.projdel);
        return;
      }
      const proj = e.target.closest('[data-proj]');
      if (proj) {
        const id = proj.dataset.proj;
        if (id !== state.projectId) {
          flushPendingEdits();
          if (storage.switchProject(id)) afterProjectChange(`已切换到「${state.title}」`);
        }
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
        if (storage.restoreFromTrash(un.dataset.untrash)) toast('项目已找回，在「项目」列表里', null, 'ok');
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
        if (!p) return toast('备份读取失败', null, 'error');
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
            flushPendingEdits();
            const r = await native.restoreBackup(f);
            if (r?.ok && storage.restoreLibrary(r.data)) afterProjectChange('已恢复到备份');
            else toast('备份读取失败', null, 'error');
          },
        );
      }
    },
    true,
  );
}
