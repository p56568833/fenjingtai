/* 装配入口：初始化各模块，订阅渲染，桥接原生菜单动作 */
import { state, loadProjectIntoState } from './state.js';
import * as storage from './storage.js';
import { initModal, toast, confirmModal } from './util.js';
import { historyCommand } from './undo.js';
import { openSearch } from './search.js';
import { initFocus, openFocusMode, focusKey } from './focus.js';
import { initSrt, pickSrt } from './srt.js';
import { renderAll, initRender, setView, cycleView } from './render.js';
import { armAnimation } from './anim.js';
import { initPopover } from './popover.js';
import { initEdit } from './edit.js';
import { initKeyboard } from './keyboard.js';
import { initSearch } from './search.js';
import { initCheck } from './check.js';
import { initSections } from './sections.js';
import { initProjects, newEmptyProject } from './projects.js';
import { initPdfExport } from './pdf-export.js';
import { initImportExport, doExport, importFromFile } from './import-export.js';
import { initWorkspace, revealSavedCursor } from './workspace.js';
import { initPreview } from './preview.js';
import { initAssetDrop } from './asset-drop.js';
import { initAssetPicker } from './asset-picker.js';
import { initShotMenu } from './shot-menu.js';
import { registerModal, initModalKeys, menuAllowed } from './modal.js';
import { closePreview, previewKey } from './preview.js';
import { closeAssetPicker } from './asset-picker.js';

/* ── 主题 ── */
function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  document.querySelector('#iconSun').style.display = dark ? 'none' : '';
  document.querySelector('#iconMoon').style.display = dark ? '' : 'none';
  localStorage.setItem('fjz:theme', dark ? 'dark' : 'light');
}
/* 切换时挂 theming 类让全 UI 统一过渡 300ms，切完撤掉，避免各元素时长不一「一部分先亮」 */
function toggleTheme() {
  document.body.classList.add('theming');
  applyTheme(!document.body.classList.contains('dark'));
  clearTimeout(toggleTheme._t);
  toggleTheme._t = setTimeout(() => document.body.classList.remove('theming'), 360);
}

/* ── 保存状态指示 ── */
function saveHook(phase) {
  const el = document.querySelector('#saveState');
  const txt = document.querySelector('#saveTxt');
  if (phase === 'saving') {
    el.classList.add('saving');
    txt.textContent = '保存中…';
  } else if (phase === 'saved') {
    el.classList.remove('saving');
    txt.textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } else {
    el.classList.remove('saving');
    txt.textContent = '保存失败！';
  }
}

/* ── 原生菜单动作 ── */
function onMenuAction({ type }) {
  // 弹窗开着时，菜单快捷键（⌘Z 撤销 / ⌘T 切视图）不该在弹窗底下搞动作；弹窗可声明放行（见 modal.js）
  if (!menuAllowed(type)) return;
  switch (type) {
    case 'new-project':
      newEmptyProject();
      break;
    case 'import':
      importFromFile();
      break;
    case 'export:pdf':
    case 'export:md':
    case 'export:list':
    case 'export:csv':
    case 'export:json':
      doExport(type.split(':')[1]);
      break;
    case 'undo':
    case 'redo':
      historyCommand(type, 'menu');
      break;
    case 'search':
      openSearch();
      break;
    case 'focus-mode':
      openFocusMode();
      break;
    case 'import-srt':
      pickSrt();
      break;
    case 'toggle-view':
      cycleView();
      break;
    case 'toggle-theme':
      toggleTheme();
      break;
  }
}

/* 启动时数据文件读不出来：主进程已把坏文件改名保留、尽量用备份顶上，这里把发生了什么讲清楚 */
function showDataRecoveryNotice(info) {
  if (!info || (info.status !== 'recovered' && info.status !== 'corrupt')) return;
  const openFolder = () => window.native.openDataFolder?.();
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
  registerModal('modalMask', { close: click('#mCancel'), enter: click('#mOk') });
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
  registerModal('previewMask', { close: closePreview, onKey: previewKey });
  registerModal('assetPickerMask', { close: closeAssetPicker });
  registerModal('diffMask', { close: click('#diffCancel'), enter: click('#diffOk') });
  registerModal('envMask', {});
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
  registerModal('srtMask', { close: click('#srtCancel'), enter: click('#srtApply') });
  // 专注标注：自己处理所有按键；原生菜单的撤销 / 重做 / 主题照常可用
  registerModal('focusMask', { onKey: focusKey, allowMenu: ['undo', 'redo', 'focus-mode'] });
}

async function boot() {
  // 被 macOS「打开方式→浏览器」误开时，直接提示而不是静默坏掉
  if (!window.native) {
    const mask = document.querySelector('#envMask');
    mask.style.display = 'grid';
    return;
  }

  initModalKeys(); // 必须最先注册：弹窗的按键优先于其他所有键盘监听
  const fresh = storage.initStorage(saveHook);
  loadProjectIntoState(storage.current());
  document.querySelector('#projTitle').textContent = state.title;

  initModal();
  initRender();
  initPopover();
  initEdit();
  initKeyboard();
  initSearch();
  initCheck();
  initSections();
  initProjects();
  initImportExport();
  initPdfExport();
  initWorkspace();
  initPreview();
  initAssetDrop();
  initAssetPicker();
  initShotMenu();
  initFocus();
  initSrt();
  registerModals();

  document.querySelector('#btnTheme').onclick = toggleTheme;
  document.querySelector('#viewToggle').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) setView(b.dataset.v);
  });
  document.querySelector('#filters').addEventListener('click', e => {
    const f = e.target.closest('.chip-filter');
    if (!f) return;
    state.filter = f.dataset.f;
    armAnimation(); // 筛选切换列表大换血，给行一个入场动画更顺滑
    renderAll();
  });
  // 点完顶栏按钮立即还焦点给内容区：否则焦点停在按钮上，随手一按 Enter/空格
  // 会把上一个按钮再触发一遍（再弹菜单 / 再切视图 / 再换主题），像「莫名刷新」
  document.addEventListener(
    'click',
    e => {
      const b = e.target.closest && e.target.closest('button');
      if (b && !b.closest('#rows, .modal, .searchbar')) b.blur();
    },
    true,
  );
  window.native.onMenuAction(onMenuAction);

  applyTheme(localStorage.getItem('fjz:theme') === 'dark');
  armAnimation();
  renderAll();
  storage.persist(true);
  revealSavedCursor();

  if (fresh) setTimeout(() => toast('第一次打开：这里是示例稿，标完可以到「项目」里新建自己的'), 600);
  showDataRecoveryNotice(storage.dataLoadInfo());

  // 自动化自测钩子（npm test 时由 selftest.js 接管）
  if (new URLSearchParams(location.search).get('selftest')) {
    const { runSelfTest } = await import('./selftest.js');
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
