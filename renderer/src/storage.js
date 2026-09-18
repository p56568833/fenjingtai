/* 数据层：所有项目数据落在本机磁盘文件（主进程原子写 + 自动备份），不再依赖浏览器 localStorage。
   library 结构：{ v:2, currentId, projects: { [id]: {id, title, rows, updatedAt} } } */

import { state, loadProjectIntoState } from './state.js';
import { demoProject } from './demo.js';

let library = null;
let saveTimer = null;
let saveHook = null;   // 供 UI 显示「保存中/已保存」
let dirty = false;     // 有改动还没落盘

export function initStorage(hook){
  saveHook = hook || (()=>{});
  library = window.native ? window.native.loadData() : null;
  // 关窗/退出时把防抖中的保存同步冲刷掉：普通保存是异步 IPC，进程一退就丢了
  window.addEventListener('beforeunload', ()=>{
    if(!dirty || !library) return;
    try{
      clearTimeout(saveTimer);
      window.native.saveDataSync(JSON.parse(JSON.stringify(library)));
      dirty = false;
    }catch(e){}
  });
  if(!library || !library.projects || !Object.keys(library.projects).length){
    // 首次启动：先装载示例再落盘（persist 会用 state 反写当前项目，必须等 state 就绪）
    const demo = demoLibrary();
    library = demo.lib;
    loadProjectIntoState(library.projects[library.currentId]);
    persist(true);
    return demo.fresh;
  }
  if(!library.projects[library.currentId]){
    library.currentId = Object.keys(library.projects)[0];
  }
  return false;
}

function demoLibrary(){
  // 首次启动给一份示例项目，让空白软件打开就有东西可看
  const d = demoProject();
  const id = 'p_' + Date.now().toString(36);
  return { fresh:true, lib: { v:2, currentId:id, projects: { [id]: {id, title:d.title, rows:d.rows, updatedAt:Date.now()} } } };
}

export const current = () => library.projects[library.currentId];
export const allProjects = () => Object.values(library.projects).sort((a,b)=>b.updatedAt-a.updatedAt);

export function syncFromState(){
  // 把 state 里的当前项目内容写回 library；state 还没装载任何项目时不动盘上的数据
  const p = current();
  if(!p || state.projectId !== library.currentId) return;
  p.title = state.title;
  p.rows = state.rows;
  p.updatedAt = Date.now();
}

export function persist(now=false){
  syncFromState();
  dirty = true;
  saveHook('saving');
  clearTimeout(saveTimer);
  const doSave = async () => {
    try{ await window.native.saveData(JSON.parse(JSON.stringify(library))); dirty = false; saveHook('saved'); }
    catch(e){ saveHook('error'); }
  };
  if(now) doSave(); else saveTimer = setTimeout(doSave, 400);
}

/* 新建项目（rows 可空 = 空项目） */
export function createProject(title, rows=[]){
  const id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
  library.projects[id] = { id, title, rows, updatedAt: Date.now() };
  library.currentId = id;
  loadProjectIntoState(library.projects[id]);
  persist(true);
  return id;
}

export function switchProject(id){
  if(!library.projects[id] || id === library.currentId) return false;
  persist(true);                                     // 切走前先把当前项目落盘
  library.currentId = id;
  loadProjectIntoState(library.projects[id]);
  persist(true);
  return true;
}

export function deleteProject(id){
  delete library.projects[id];
  const ids = Object.keys(library.projects);
  if(!ids.length) return false;
  if(library.currentId === id){
    // 删的是当前项目：state 必须同步指向新项目，不能悬空在已删除的引用上
    library.currentId = ids[0];
    loadProjectIntoState(library.projects[ids[0]]);
  }
  persist(true);
  return true;
}

/* 备份恢复：整库替换 */
export function restoreLibrary(data){
  if(!data || !data.projects) return false;
  library = data;
  if(!library.projects[library.currentId]) library.currentId = Object.keys(library.projects)[0];
  loadProjectIntoState(library.projects[library.currentId]);
  persist(true);
  return true;
}
