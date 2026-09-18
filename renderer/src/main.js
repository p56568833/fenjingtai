/* 装配入口：初始化各模块，订阅渲染，桥接原生菜单动作 */
import { state, update, loadProjectIntoState } from './state.js';
import * as storage from './storage.js';
import { initModal, toast } from './util.js';
import { undo, clearUndo } from './undo.js';
import { renderAll, initRender, setView, cycleView } from './render.js';
import { armAnimation } from './anim.js';
import { initPopover, closePop } from './popover.js';
import { initEdit } from './edit.js';
import { initKeyboard } from './keyboard.js';
import { initSearch } from './search.js';
import { initCheck } from './check.js';
import { initSections } from './sections.js';
import { initProjects, newEmptyProject } from './projects.js';
import { initImportExport, doExport, importFromFile } from './import-export.js';
import { demoProject } from './demo.js';

/* ── 主题 ── */
function applyTheme(dark){
  document.body.classList.toggle('dark', dark);
  document.querySelector('#iconSun').style.display = dark ? 'none' : '';
  document.querySelector('#iconMoon').style.display = dark ? '' : 'none';
  localStorage.setItem('fjz:theme', dark ? 'dark' : 'light');
}
/* 切换时挂 theming 类让全 UI 统一过渡 300ms，切完撤掉，避免各元素时长不一「一部分先亮」 */
function toggleTheme(){
  document.body.classList.add('theming');
  applyTheme(!document.body.classList.contains('dark'));
  clearTimeout(toggleTheme._t);
  toggleTheme._t = setTimeout(()=>document.body.classList.remove('theming'), 360);
}

/* ── 保存状态指示 ── */
function saveHook(phase){
  const el = document.querySelector('#saveState');
  const txt = document.querySelector('#saveTxt');
  if(phase==='saving'){ el.classList.add('saving'); txt.textContent = '保存中…'; }
  else if(phase==='saved'){ el.classList.remove('saving'); txt.textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}); }
  else { el.classList.remove('saving'); txt.textContent = '保存失败！'; }
}

/* ── 原生菜单动作 ── */
function onMenuAction({ type }){
  // 确认弹窗开着时，菜单快捷键（⌘Z 撤销 / ⌘T 切视图）不该在弹窗底下搞动作
  if(document.querySelector('#modalMask').classList.contains('show') && type!=='toggle-theme') return;
  switch(type){
    case 'new-project': newEmptyProject(); break;
    case 'import': importFromFile(); break;
    case 'export:md': case 'export:list': case 'export:csv': case 'export:json':
      doExport(type.split(':')[1]); break;
    case 'undo': undo(); break;
    case 'toggle-view': cycleView(); break;
    case 'toggle-theme': toggleTheme(); break;
  }
}

async function boot(){
  // 被 macOS「打开方式→浏览器」误开时，直接提示而不是静默坏掉
  if(!window.native){
    const mask = document.querySelector('#envMask');
    mask.style.display = 'grid';
    return;
  }

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

  document.querySelector('#btnTheme').onclick = toggleTheme;
  document.querySelector('#viewToggle').addEventListener('click', e=>{
    const b = e.target.closest('button'); if(b) setView(b.dataset.v);
  });
  document.querySelector('#filters').addEventListener('click', e=>{
    const f = e.target.closest('.chip-filter'); if(!f) return;
    state.filter = f.dataset.f;
    armAnimation();          // 筛选切换列表大换血，给行一个入场动画更顺滑
    renderAll();
  });
  // 点完顶栏按钮立即还焦点给内容区：否则焦点停在按钮上，随手一按 Enter/空格
  // 会把上一个按钮再触发一遍（再弹菜单 / 再切视图 / 再换主题），像「莫名刷新」
  document.addEventListener('click', e=>{
    const b = e.target.closest && e.target.closest('button');
    if(b && !b.closest('#rows, .modal, .searchbar')) b.blur();
  }, true);
  window.native.onMenuAction(onMenuAction);

  applyTheme(localStorage.getItem('fjz:theme') === 'dark');
  armAnimation();
  renderAll();
  storage.persist(true);

  if(fresh) setTimeout(()=> toast('第一次打开：这里是示例稿，标完可以到「项目」里新建自己的'), 600);

  // 自动化自测钩子（npm test 时由 selftest.js 接管）
  if(new URLSearchParams(location.search).get('selftest')){
    const { runSelfTest } = await import('./selftest.js');
    window.__SELFTEST_RESULT__ = await runSelfTest();
    console.log('SELFTEST_DONE', JSON.stringify(window.__SELFTEST_RESULT__));
  }
}

boot();
