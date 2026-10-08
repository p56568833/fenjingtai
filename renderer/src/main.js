/* 装配入口：初始化各模块、订阅渲染、把原生菜单动作翻译成命令。
   分层：core/ 纯数据规则 → app/ 状态与数据操作 → ui/ 视图与交互 → features/ 独立功能；platform/ 原生能力。
   上层可以用下层，下层不知道上层（ESLint 里有规则把关）。 */
import { state, on, loadProjectIntoState } from './app/state.js';
import * as storage from './app/storage.js';
import * as native from './platform/native.js';
import { initModal, toast, confirmModal } from './ui/dom.js';
import { historyCommand } from './ui/history.js';
import { renderAll, initRender, setView, cycleView, syncViewToggle } from './ui/render.js';
import { armAnimation } from './ui/anim.js';
import { initPopover } from './ui/popover.js';
import { initEdit } from './ui/edit.js';
import { initKeyboard } from './ui/keyboard.js';
import { initSearch, openSearch } from './ui/search.js';
import { initCheck } from './ui/check-view.js';
import { initSections } from './ui/sections.js';
import { initProjects } from './ui/projects.js';
import { initImportExport } from './ui/import-export.js';
import { initWorkspace, revealSavedCursor } from './ui/workspace.js';
import { initAssetDrop } from './ui/asset-drop.js';
import { initAssetPicker } from './ui/asset-picker.js';
import { initShotMenu } from './ui/shot-menu.js';
import { initHelp } from './ui/help.js';
import { initTheme } from './ui/theme.js';
import { registerModal, initModalKeys, menuAllowed } from './ui/modal.js';
import { runCommand } from './ui/commands.js';
import { initFocus, focusKey } from './features/focus.js';
import { initSrt } from './features/srt.js';
import { initPreview, closePreview, previewKey } from './features/preview.js';
import { closeAssetPicker } from './ui/asset-picker.js';
import { initVoice } from './features/voice.js';
import { initPlaythrough, closePlaythrough, playthroughKey } from './features/playthrough.js';
import { initTypeEditor } from './features/type-editor.js';
import { initPdfExport } from './features/pdf-export.js';
import { initVideoReview, closeVideoReview, videoReviewKey } from './features/video-review.js';
import { initUpdate, updateKey } from './features/update.js';
import { initMotion } from './ui/motion.js';

/* ── 保存状态指示 ── */
let savedFlash = 0;
function showSaveState(phase) {
  const el = document.querySelector('#saveState');
  const txt = document.querySelector('#saveTxt');
  // 存好了：小圆点变成一个打勾的绿圈，一秒多后缩回圆点
  if (phase === 'saved' && el.classList.contains('saving')) {
    el.classList.remove('just-saved');
    void el.offsetWidth;
    el.classList.add('just-saved');
    clearTimeout(savedFlash);
    savedFlash = setTimeout(() => el.classList.remove('just-saved'), 1500);
  }
  el.classList.toggle('saving', phase === 'saving');
  el.classList.toggle('error', phase === 'error');
  if (phase === 'saving') txt.textContent = '保存中…';
  else if (phase === 'saved')
    txt.textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  else txt.textContent = '保存失败，5 秒后重试';
}

/* ── 原生菜单动作 → 命令 ── */
const MENU = {
  'new-project': 'project:new',
  import: 'import:file',
  'import-srt': 'srt:pick',
  'import-voice': 'voice:pick',
  search: () => openSearch(),
  'focus-mode': 'focus:open',
  'toggle-view': () => cycleView(),
  'toggle-theme': 'theme:toggle',
  'theme-system': 'theme:system',
  'edit-types': 'types:edit',
  help: 'help:open',
  playthrough: 'playthrough:from',
  'toggle-density': () => {
    const on = runCommand('view:density') && document.body.classList.contains('compact');
    toast(on ? '已切换到紧凑行距' : '已切换回舒适行距', null, 'info');
  },
  review: 'review:open',
  'check-update': 'update:check',
  undo: () => historyCommand('undo', 'menu'),
  redo: () => historyCommand('redo', 'menu'),
};
function onMenuAction({ type }) {
  // 弹窗开着时，菜单快捷键（⌘Z 撤销 / ⌘T 切视图）不该在弹窗底下搞动作；弹窗可声明放行（见 modal.js）
  if (!menuAllowed(type)) return;
  if (type.startsWith('export:')) return runCommand('export', type.split(':')[1]);
  const m = MENU[type];
  if (typeof m === 'function') m();
  else if (m) runCommand(m);
}

/* 启动时数据文件读不出来：主进程已把坏文件改名保留、尽量用备份顶上，这里把发生了什么讲清楚 */
function showDataRecoveryNotice(info) {
  if (!info) return;
  const openFolder = () => native.openDataFolder();
  if (info.backupError)
    setTimeout(() => toast(`自动备份没有成功（${info.backupError}），项目本身已正常保存`, null, 'warn'), 1200);
  if (info.status === 'partial') {
    confirmModal(
      '有项目读不出来，已先放到一边',
      `「${(info.broken || []).join('」「')}」的数据结构损坏，没法打开；其他项目照常可用。\n坏掉的项目原样保留在数据文件里，没有删除，可以从「项目 → 从自动备份恢复…」只取回其中一个项目。`,
      '打开数据文件夹',
      openFolder,
      { cancelText: '知道了', danger: false },
    );
    return;
  }
  if (info.status !== 'recovered' && info.status !== 'corrupt') return;
  const when = info.fromTime ? new Date(info.fromTime).toLocaleString('zh-CN', { hour12: false }) : '';
  if (info.status === 'recovered') {
    confirmModal(
      '数据文件读取失败，已自动恢复',
      `项目数据文件损坏，已用 ${when} 的自动备份恢复。这份备份之后的改动可能缺失。\n损坏的文件没有删除，已改名为「${info.kept}」留在数据文件夹里。`,
      '打开数据文件夹',
      openFolder,
      { cancelText: '知道了', danger: false },
    );
  } else {
    confirmModal(
      '数据文件读取失败',
      `项目数据文件损坏，也没有找到可用的自动备份，先打开了一份示例稿。\n原文件没有删除，已改名为「${info.kept}」留在数据文件夹里，可以尝试手动修复或从别处恢复。`,
      '打开数据文件夹',
      openFolder,
      { cancelText: '知道了', danger: false },
    );
  }
}

/* 所有遮罩弹窗登记进弹窗栈：Esc 关最上层、Enter 确认，按键不漏到底下 */
function registerModals() {
  const click = sel => () => document.querySelector(sel)?.click();
  // 危险操作（删除等）的确认框：回车不直接执行，焦点默认在「取消」上
  registerModal('modalMask', {
    close: click('#mCancel'),
    enter: () => !document.querySelector('#mOk').classList.contains('danger') && click('#mOk')(),
  });
  registerModal('pasteMask', {
    close: click('#pasteCancel'),
    onKey: e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        click('#pasteOk')();
        return true;
      }
    },
  });
  registerModal('importPreviewMask', { close: click('#cancelImport'), enter: click('#acceptImport') });
  registerModal('reviewMask', { close: click('#closeReview') });
  registerModal('previewMask', { close: closePreview, onKey: previewKey, autoFocus: false });
  registerModal('assetPickerMask', { close: closeAssetPicker });
  registerModal('diffMask', { close: click('#diffCancel'), enter: click('#diffOk') });
  registerModal('envMask', {});
  registerModal('srtMask', { close: click('#srtCancel'), enter: click('#srtApply') });
  registerModal('pdfMask', {
    close: click('#pdfCancel'),
    onKey: e => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && e.target.id !== 'pdfCancel') {
        e.preventDefault();
        click('#pdfOk')();
        return true;
      }
    },
  });
  // 视频审核现在是一个「页面」（顶栏下面整块），顶栏照常能点；⌘T 切回表格、导入候选清单、检查更新都放行
  registerModal('vrMask', {
    close: closeVideoReview,
    onKey: videoReviewKey,
    allowMenu: ['undo', 'redo', 'toggle-view', 'import', 'check-update', 'help', 'new-project'],
    autoFocus: false,
  });
  registerModal('typeEditorMask', { close: click('#teCancel') });
  registerModal('helpMask', { close: click('#helpClose'), enter: click('#helpClose') });
  registerModal('updateMask', { onKey: updateKey });
  registerModal('ptMask', {
    close: closePlaythrough,
    onKey: playthroughKey,
    allowMenu: ['undo', 'redo'],
    autoFocus: false,
  });
  // 专注标注：自己处理所有按键；原生菜单的撤销 / 重做 / 主题照常可用
  registerModal('focusMask', { onKey: focusKey, allowMenu: ['undo', 'redo', 'focus-mode'], autoFocus: false });
}

async function boot() {
  // 被 macOS「打开方式→浏览器」误开时，直接提示而不是静默坏掉
  if (!native.isNative()) {
    document.querySelector('#envMask').style.display = 'grid';
    return;
  }

  // 自动化自测时关掉脚本动效：测试要立刻量到元素的最终位置
  if (new URLSearchParams(location.search).get('selftest')) document.documentElement.dataset.motion = 'off';
  initModalKeys(); // 必须最先注册：弹窗的按键优先于其他所有键盘监听
  on('save-state', showSaveState);
  on('notify', ({ msg, action, kind }) => toast(msg, action, kind));
  const fresh = storage.initStorage();
  loadProjectIntoState(storage.current());

  initModal();
  initTheme();
  initRender();
  initPopover();
  initEdit();
  initKeyboard();
  initSearch();
  initCheck();
  initSections();
  initProjects();
  initImportExport();
  initWorkspace();
  initPreview();
  initAssetDrop();
  initAssetPicker();
  initShotMenu();
  initFocus();
  initSrt();
  initVoice();
  initPlaythrough();
  initTypeEditor();
  initPdfExport();
  initVideoReview();
  initHelp();
  initUpdate();
  registerModals();
  initMotion(); // 弹窗从按钮长出来：要在所有弹窗都建好之后

  document.querySelector('#viewToggle').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.v === 'review') return runCommand('video:open');
    if (document.querySelector('#vrMask.show')) closeVideoReview();
    setView(b.dataset.v);
  });
  addEventListener('resize', () => syncViewToggle());
  document.querySelector('#filters').addEventListener('click', e => {
    const f = e.target.closest('.chip-filter');
    if (!f) return;
    state.filter = f.dataset.f;
    renderAll(); // 留下来的句子滑到新位置，筛掉的淡出，新出现的淡入（render.js）
  });
  document.querySelector('#btnTypes').addEventListener('click', () => runCommand('types:edit'));
  // 点完顶栏按钮立即还焦点给内容区：否则焦点停在按钮上，随手一按 Enter / 空格会把上一个按钮再触发一遍
  document.addEventListener(
    'click',
    e => {
      const b = e.target.closest && e.target.closest('button');
      if (b && !b.closest('#rows, .modal, .searchbar')) b.blur();
    },
    true,
  );
  native.onMenuAction(onMenuAction);

  armAnimation();
  renderAll();
  storage.persist(true); // 载入时做过的数据迁移（老格式素材、类型表）落盘
  revealSavedCursor();

  if (fresh)
    setTimeout(() => toast('第一次打开：这里是示例稿。把自己的稿子拖进窗口，或点「导入」就能开始', null, 'info'), 600);
  showDataRecoveryNotice(storage.dataLoadInfo());

  // 自动化自测钩子（npm test 时由 test/selftest.js 接管）
  if (new URLSearchParams(location.search).get('selftest')) {
    const { runSelfTest } = await import('./test/selftest.js');
    try {
      window.__SELFTEST_RESULT__ = await runSelfTest();
    } catch (error) {
      window.__SELFTEST_RESULT__ = {
        total: 1,
        failed: 1,
        cases: [{ name: '自测异常', ok: false, detail: error.stack }],
      };
    }
    console.log('SELFTEST_DONE', JSON.stringify(window.__SELFTEST_RESULT__));
  }
}

boot();
