/* 导出到剪映：接线层。
   弹窗结构与渲染在 jianying-export-view.js；预检序号、视图代次、配置 / 执行 / 完成状态、
   当前任务、取消请求和最近结果都在 jianying-export-controller.js；
   这里只保留初始化、命令与弹窗注册、DOM 事件绑定和问题定位（定位要用项目数据，不能放进 view）。
   原有交互不变：首屏配置 → 执行进度 → 结果页，关闭窗口任务继续，完成后用提示带回结果。 */
import { state } from '../app/state.js';
import { rowById } from '../app/project-queries.js';
import { usageList } from '../core/asset-model.js';
import { toast } from '../ui/base/dom.js';
import { registerModal } from '../ui/base/modal.js';
import { closePop } from '../ui/base/popover.js';
import { registerCommand, runCommand } from '../ui/base/commands.js';
import { createJianyingExportController } from './jianying-export-controller.js';
import * as view from './jianying-export-view.js';

const $ = s => document.querySelector(s);

/* 接线实例：生产用 app/edit-export.js，自测可以单独 import 它检查状态。 */
export const jianyingExportController = createJianyingExportController();

/* 表单值只在这里从 DOM 读一次，随后全部以纯数据快照交给 controller。 */
function readForm() {
  const [width, height] = String($('#jyCanvas').value || '1920x1080')
    .split('x')
    .map(Number);
  return {
    name: $('#jyName').value.trim() || state.title || '未命名项目',
    mode: document.querySelector('input[name="jyMode"]:checked')?.value === 'folder' ? 'folder' : 'library',
    options: {
      width: width || 1920,
      height: height || 1080,
      fps: Number($('#jyFps').value) || 30,
      subtitles: !!$('#jySubs').checked,
      altAssets: !!$('#jyAlt').checked,
    },
    confirm: !!$('#jyConfirm').checked,
  };
}

/* 问题定位：把问题映射回当前项目里的句子（数据在 app/，所以留在接线层）。 */
function firstRowForAsset(assetId) {
  return state.rows.find(row => row.kind === 'line' && usageList(row).some(usage => usage.assetId === assetId));
}

function issueRow(issue) {
  if (!issue) return null;
  if (issue.rowId != null) {
    const row = rowById(issue.rowId);
    if (row) return row;
  }
  if (issue.lineNo != null) {
    const row = state.rows.find(item => item.kind === 'line' && item.no === issue.lineNo);
    if (row) return row;
  }
  if (issue.assetId) return firstRowForAsset(issue.assetId) || null;
  return null;
}

function onIssueClick(event) {
  const button = event.target.closest('[data-jy-issue]');
  if (!button) return;
  const issue = jianyingExportController.issueAt(button.dataset.jyScope, Number(button.dataset.jyIssue));
  if (!issue) return;
  const row = issueRow(issue);
  if (!row) return toast('这一项对应的内容已经不在当前项目里', null, 'info');
  closeJianyingExport();
  runCommand('nav:jump', row.id);
  if (issue.assetId) runCommand('inspector:open', row.id);
}

/* ── 打开 / 关闭 ── */
export function openJianyingExport() {
  if (view.isJianyingExportViewShown()) return;
  closePop();
  view.showJianyingExportView();
  void jianyingExportController.open({ title: state.title });
}

function closeJianyingExport() {
  const { background } = jianyingExportController.close();
  view.hideJianyingExportView();
  if (background) view.notifyJianyingExportBackground();
}

function onEnter() {
  const current = jianyingExportController.getState();
  if (current.pane === 'run') return;
  if (current.pane === 'done') return closeJianyingExport();
  if (current.blockReason) return;
  void startFromForm();
}

/* ── 用户操作交给 controller ── */
async function startFromForm() {
  const outcome = await jianyingExportController.start(readForm());
  if (outcome.notice) toast(outcome.notice.text, null, outcome.notice.kind);
}

async function pickDest() {
  await jianyingExportController.pickDest();
}

async function requestCancel() {
  const outcome = await jianyingExportController.requestCancel();
  if (outcome.notice) toast(outcome.notice.text, null, outcome.notice.kind);
}

async function backToConfig() {
  await jianyingExportController.backToConfig({ title: state.title });
}

async function revealDraft() {
  const draftDir = jianyingExportController.getState().lastDone?.result?.draftDir;
  const shown = await jianyingExportController.reveal();
  if (!shown) view.notifyJianyingExportRevealFailed(draftDir);
}

async function openApp() {
  const opened = await jianyingExportController.openApp();
  if (!opened) view.notifyJianyingExportOpenAppFailed();
}

async function registerDraft() {
  const outcome = await jianyingExportController.register();
  if (outcome.notice) toast(outcome.notice.text, null, outcome.notice.kind);
}

function showLastResult() {
  if (!jianyingExportController.showLastResult()) return;
  view.showJianyingExportView();
}

export function initJianyingExport() {
  view.mountJianyingExportView();
  jianyingExportController.subscribe((current, event) => {
    view.renderJianyingExportView(current, { locateIssue: issueRow });
    /* 结果在弹窗藏着时返回：只提示，用户点「查看结果」再回到结果页 */
    if (event?.type === 'finished' && !view.isJianyingExportViewShown())
      view.notifyJianyingExportFinished(current, { onOpenResult: showLastResult });
    /* controller 主动给的失败提示（如自动取消失败）：只在这里 toast 一次，避免双提示 */
    if (event?.type === 'notice' && event.notice) toast(event.notice.text, null, event.notice.kind);
  });
  $('#jianyingMask').addEventListener('click', event => {
    if (event.target.id === 'jianyingMask') closeJianyingExport();
  });
  $('#jyClose').addEventListener('click', closeJianyingExport);
  $('#jyGo').addEventListener('click', () => void startFromForm());
  $('#jyAdjust').addEventListener('click', () => void backToConfig());
  $('#jyReveal').addEventListener('click', () => void revealDraft());
  $('#jyOpenApp').addEventListener('click', () => void openApp());
  $('#jyRegister').addEventListener('click', () => void registerDraft());
  $('#jyBackground').addEventListener('click', closeJianyingExport);
  $('#jyCancelRun').addEventListener('click', () => void requestCancel());
  $('#jyPickDest').addEventListener('click', () => void pickDest());
  document
    .querySelectorAll('input[name="jyMode"]')
    .forEach(input =>
      input.addEventListener('change', () => jianyingExportController.updateForm(readForm(), { persist: true })),
    );
  for (const id of ['jyCanvas', 'jyFps', 'jySubs', 'jyAlt'])
    $(`#${id}`).addEventListener('change', () =>
      jianyingExportController.updateForm(readForm(), { persist: true, reprepare: true }),
    );
  $('#jyName').addEventListener('input', () => jianyingExportController.updateForm(readForm()));
  $('#jyConfirm').addEventListener('change', () => jianyingExportController.updateForm(readForm()));
  $('#jyIssues').addEventListener('click', onIssueClick);
  $('#jyDoneIssues').addEventListener('click', onIssueClick);
  registerModal('jianyingMask', { close: closeJianyingExport, enter: onEnter });
  registerCommand('jianying:export', openJianyingExport);
}
