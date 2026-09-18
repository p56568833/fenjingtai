/* 多项目管理：顶栏「项目」菜单（列表 / 新建 / 切换 / 删除 / 从备份恢复）+ 标题改名 */
import { state, update } from './state.js';
import * as storage from './storage.js';
import { clearUndo } from './undo.js';
import { toast, confirmModal, esc } from './util.js';
import { openMenu, closePop, popOpenFor, markPopAnchor } from './popover.js';
import { armAnimation } from './anim.js';
import { demoProject } from './demo.js';
import { migrateSections } from './parse.js';

const timeAgo = t => {
  const s = (Date.now()-t)/1000;
  if(s<60) return '刚刚';
  if(s<3600) return Math.floor(s/60)+' 分钟前';
  if(s<86400) return Math.floor(s/3600)+' 小时前';
  return Math.floor(s/86400)+' 天前';
};

function openProjectsMenu(anchor){
  const list = storage.allProjects().map(p=>{
    const n = p.rows.filter(r=>r.kind==='line').length;
    const cur = p.id===state.projectId;
    return `<div class="pop-item" data-proj="${p.id}">
      <svg class="mi" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
      <span class="main"><span>${esc(p.title||'未命名')}</span><span class="desc">${n} 句 · ${timeAgo(p.updatedAt||Date.now())}</span></span>
      ${cur?'<span class="chk">✓</span>':`<button class="proj-del" data-projdel="${p.id}" title="删除这个项目">✕</button>`}
    </div>`;
  }).join('');
  openMenu(anchor, `
    <div class="p-title">项目（存本机：菜单 文件 → 打开数据文件夹）</div>
    ${list}
    <div class="pop-sep"></div>
    <div class="pop-item" data-projact="new"><svg class="mi" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>新建空项目</span></div>
    <div class="pop-item" data-projact="demo"><svg class="mi" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6"/></svg><span>新建示例稿项目</span></div>
    <div class="pop-item" data-projact="backup"><svg class="mi" viewBox="0 0 24 24"><path d="M12 8v4l2.5 2.5"/><circle cx="12" cy="12" r="9"/></svg><span>从自动备份恢复…</span></div>
  `);
  markPopAnchor(anchor);
}

async function openBackupMenu(anchor){
  const list = await window.native.listBackups();
  openMenu(anchor, !list.length
    ? `<div class="p-title">暂无备份（软件每 30 分钟自动滚一份，最多留 10 份）</div>`
    : `<div class="p-title">选一个时间点恢复（当前所有项目会被替换）</div>` +
      list.map(b=>`<div class="pop-item" data-backup="${esc(b.f)}"><span>${esc(b.f.replace(/^备份-|\.json$/g,''))}</span><span class="sub">${timeAgo(b.t)}</span></div>`).join(''));
  markPopAnchor(anchor);
}

function confirmDelete(id){
  const p = storage.allProjects().find(x=>x.id===id);
  closePop();
  confirmModal(`删除项目「${p?.title||'未命名'}」？`, '项目和它的全部标注会一起删掉。自动备份里可能还有早前的版本。', '删除', ()=>{
    if(storage.allProjects().length <= 1){ toast('至少保留一个项目'); return; }
    if(storage.deleteProject(id)){
      clearUndo();
      const cur = storage.current();
      state.projectId = cur.id; state.title = cur.title; state.rows = cur.rows;
      document.querySelector('#projTitle').textContent = state.title;
      state.sel = state.rows.find(r=>r.kind==='line')?.id ?? null;
      armAnimation();
      update('rows');
      toast('项目已删除');
    }
  });
}

/* 新建空项目：原生菜单「新建项目」和项目菜单共用这一条路 */
export function newEmptyProject(){
  storage.createProject('未命名项目', []);
  clearUndo(); armAnimation(); update('rows');
  const t = document.querySelector('#projTitle');
  t.textContent = state.title;
  t.focus();
  const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  toast('已新建项目，先给它起个名');
}

export function initProjects(){
  document.querySelector('#btnProjects').onclick = e=>{
    e.stopPropagation();
    if(popOpenFor(e.currentTarget)){ closePop(); return; }
    openProjectsMenu(e.currentTarget);
  };

  document.addEventListener('click', async e=>{
    const pop = document.querySelector('.popover');
    if(!pop) return;

    const del = e.target.closest('[data-projdel]');
    if(del){ e.stopPropagation(); confirmDelete(del.dataset.projdel); return; }

    const proj = e.target.closest('[data-proj]');
    if(proj && !del){
      const id = proj.dataset.proj;
      if(id!==state.projectId && storage.switchProject(id)){
        clearUndo();
        armAnimation();
        update('rows');
        document.querySelector('#projTitle').textContent = state.title;
        toast(`已切换到「${state.title}」`);
      }
      closePop();
      return;
    }
    const act = e.target.closest('[data-projact]');
    if(act){
      closePop();
      const a = act.dataset.projact;
      if(a==='new'){
        newEmptyProject();
      }
      if(a==='demo'){
        const d = demoProject();
        storage.createProject(d.title, d.rows);
        clearUndo(); armAnimation(); update('rows');
        document.querySelector('#projTitle').textContent = state.title;
        toast('示例稿项目已新建');
      }
      if(a==='backup'){
        setTimeout(()=>openBackupMenu(document.querySelector('#btnProjects')), 0);
      }
      return;
    }
    const bk = e.target.closest('[data-backup]');
    if(bk){
      const f = bk.dataset.backup;
      closePop();
      confirmModal('恢复这个备份？', '当前所有项目会被备份里的版本整个替换（用于数据损坏时兜底）。', '恢复', async ()=>{
        const r = await window.native.restoreBackup(f);
        if(r.ok && storage.restoreLibrary(r.data)){
          clearUndo(); armAnimation(); update('rows');
          document.querySelector('#projTitle').textContent = state.title;
          toast('已恢复到备份');
        } else toast('备份读取失败');
      });
    }
  }, true);

  // 项目改名：标题直接编辑；Esc 恢复改名前的标题
  const title = document.querySelector('#projTitle');
  let titleBefore = '';
  title.addEventListener('focus', ()=>{ titleBefore = state.title; });
  title.addEventListener('input', ()=>{ state.title = title.textContent.trim(); storage.persist(); });
  title.addEventListener('keydown', e=>{
    if(e.key==='Enter'){ e.preventDefault(); title.blur(); }
    else if(e.key==='Escape'){
      title.textContent = titleBefore;
      state.title = titleBefore;
      storage.persist();
      title.blur();
    }
  });
}
