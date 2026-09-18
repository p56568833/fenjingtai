/* 导入导出：文件 / 粘贴 / 示例；MD（含批注回读）/ 素材清单 / CSV / 项目 JSON。
   桌面版导出走系统保存对话框。 */
import { state, update } from './state.js';
import { TYPES, TYPE_ORDER } from './types.js';
import { toast, confirmModal, esc, dur, durNum } from './util.js';
import { parseAny, migrateSections } from './parse.js';
import { applyImport } from './actions.js';
import * as storage from './storage.js';
import { clearUndo } from './undo.js';
import { openMenu, closePop, popOpenFor, markPopAnchor, openDurPopover } from './popover.js';
import { armAnimation } from './anim.js';
import { demoProject } from './demo.js';

const tName = t => t ? TYPES[t].label : '未标注';

function hasWork(){
  return state.rows.some(r=>r.kind==='line' && (r.type||r.note));
}
function guardedImport(label, action){
  if(!hasWork()){ action(); return; }
  confirmModal('导入会替换当前内容', `当前项目「${state.title}」里已有标注和备注，导入新稿子会覆盖它们。想分开存的话，先到「项目」里新建一个项目再导入。`, label, action);
}

function doApplyImport(rows, title, sourceName){
  applyImport(rows, title, sourceName);
}

/* 项目 JSON 一律导入为新项目（不覆盖现有工作，更安全） */
function importAsNewProject(name, txt){
  let proj;
  try{ proj = JSON.parse(txt); }
  catch(err){ toast('JSON 解析失败'); return; }
  const rows = migrateSections(proj.rows||[]);
  if(!rows.length){ toast('这个 JSON 里没有句子'); return; }
  storage.createProject(proj.title || name.replace(/\.json$/i,''), rows);
  clearUndo(); armAnimation(); update('rows');
  document.querySelector('#projTitle').textContent = state.title;
  toast(`已作为新项目导入「${state.title}」· ${rows.filter(r=>r.kind==='line').length} 句`);
}

async function importText(txt, name, isJson){
  if(isJson){ importAsNewProject(name, txt); return; }
  const rows = parseAny(txt);
  if(!rows.length){ toast('没识别出句子，检查一下文件内容'); return; }
  guardedImport('覆盖并导入', ()=> doApplyImport(rows, name.replace(/\.(md|markdown|txt)$/i,''), name));
}

/* 弹系统文件对话框选稿子导入（导入菜单和原生菜单 ⌘O 共用） */
export async function importFromFile(){
  const r = await window.native.importFile();
  if(r) importText(r.content, r.name, r.name.endsWith('.json'));
}

/* ── 导出 ── */
async function download(name, content){
  const ok = await window.native.exportFile(name, content);
  toast(ok ? `已导出：${name}` : '已取消导出');
  return ok;
}

export async function doExport(kind){
  const title = state.title || '未命名项目';
  const lines = state.rows.filter(r=>r.kind==='line');

  if(kind==='md'){
    let out = `# ${title}\n\n`;
    for(const r of state.rows){
      if(r.kind==='section'){ out += `\n## ${r.text}\n\n`; continue; }
      const tag = r.type ? TYPES[r.type].full : '未标注';
      let note = '';
      if(r.note) note = r.type && r.type!=='a' ? `（画面：${r.note}）` : `（备注：${r.note}）`;
      out += `- [${tag}] ${r.text}${note}\n`;
    }
    await download(`${title}·带批注.md`, out);
  }
  if(kind==='list'){
    const dMin = r => durNum(r.text||'')/60;
    let out = `# 素材清单 · ${title}\n`;
    TYPE_ORDER.filter(k=>k!=='a').forEach(k=>{
      const items = lines.filter(r=>r.type===k);
      if(!items.length) return;
      const sub = items.reduce((s,r)=>s+dMin(r),0);
      out += `\n## ${TYPES[k].full}（${items.length} 条 · 约 ${sub>=1?sub.toFixed(1)+' 分钟':Math.round(sub*60)+' 秒'}）\n\n`;
      items.forEach((r,i)=>{ out += `${i+1}. 「${r.text}」${r.note?` —— ${r.note}`:'【缺画面描述】'} 【第 ${r.no} 句 · ${dur(r.text)}】\n`; });
    });
    const nA = lines.filter(r=>r.type==='a').length;
    const total = lines.reduce((s,r)=>s+dMin(r),0);
    out += `\n---\nA roll 共 ${nA} 句（真人出镜，无需配画面）\n全片约 ${total>=1?total.toFixed(1)+' 分钟':Math.round(total*60)+' 秒'}（按 4.5 字/秒估算）\n`;
    await download(`素材清单·${title}.md`, out);
  }
  if(kind==='csv'){
    let sec = '';
    const rows = [['序号','章节','口播内容','估算时长','类型','画面/备注']];
    for(const r of state.rows){
      if(r.kind==='section'){ sec = r.text; continue; }
      rows.push([r.no, sec, r.text, dur(r.text), tName(r.type), r.note||'']);
    }
    const csv = '\uFEFF' + rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    await download(`${title}.csv`, csv);
  }
  if(kind==='json'){
    storage.persist(true);
    await download(`${title}·项目.json`, JSON.stringify({v:1, title, rows:state.rows, savedAt:new Date().toISOString()}, null, 2));
  }
}

/* ── 菜单与装配 ── */
/* 粘贴导入弹窗（导入菜单 / 勾选视图空态按钮共用） */
export function openPaste(){
  document.querySelector('#pasteMask').classList.add('show');
  setTimeout(()=> document.querySelector('#pasteArea').focus(), 60);
}

export function initImportExport(){
  document.querySelector('#btnImport').onclick = e=>{
    e.stopPropagation();
    if(popOpenFor(e.currentTarget)){ closePop(); return; }
    openMenu(e.currentTarget, `
      <div class="p-title">导入稿子</div>
      <div class="pop-item" data-imp="file"><svg class="mi" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg><span class="main">选择文件<span class="desc">MD / TXT / 项目 JSON，整篇自动分句</span></span></div>
      <div class="pop-item" data-imp="paste"><svg class="mi" viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg><span class="main">粘贴稿子文本<span class="desc">整篇复制进来，也认得出带批注的 MD</span></span></div>
      <div class="pop-sep"></div>
      <div class="pop-item" data-imp="jsonnew"><svg class="mi" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v5M9.5 13.5h5"/></svg><span class="main">项目 JSON 导入为新项目<span class="desc">从网页版或别的机器整体搬过来</span></span></div>`);
    markPopAnchor(e.currentTarget);
  };

  document.querySelector('#btnExport').onclick = e=>{
    e.stopPropagation();
    if(popOpenFor(e.currentTarget)){ closePop(); return; }
    openMenu(e.currentTarget, `
      <div class="p-title">导出「${esc(state.title)}」</div>
      <div class="pop-item" data-x="md"><span class="pdot" style="background:var(--c-a)"></span><span class="main">带批注的 MD<span class="desc">回写成批注稿，接回原来的工作流</span></span></div>
      <div class="pop-item" data-x="list"><span class="pdot" style="background:var(--c-real)"></span><span class="main">素材清单 MD<span class="desc">按类型分组，照单找素材</span></span></div>
      <div class="pop-item" data-x="csv"><span class="pdot" style="background:var(--c-stock)"></span><span class="main">CSV 表格<span class="desc">进 Excel / 飞书表格</span></span></div>
      <div class="pop-item" data-x="json"><span class="pdot" style="background:var(--c-ai)"></span><span class="main">项目文件 JSON<span class="desc">备份存档，可导回这个软件</span></span></div>`);
    markPopAnchor(e.currentTarget);
  };

  document.querySelector('#btnDur').onclick = e=>{
    e.stopPropagation();
    if(popOpenFor(e.currentTarget)){ closePop(); return; }
    openDurPopover(e.currentTarget);
    markPopAnchor(e.currentTarget);
  };

  document.addEventListener('click', async e=>{
    const pop = document.querySelector('.popover');
    const imp = e.target.closest && e.target.closest('.pop-item[data-imp]');
    if(imp && pop){
      closePop();
      const w = imp.dataset.imp;
      if(w==='file') importFromFile();
      if(w==='paste') openPaste();
      if(w==='jsonnew'){
        const r = await window.native.importFile();
        if(r) importAsNewProject(r.name, r.content);
      }
      return;
    }
    const x = e.target.closest && e.target.closest('.pop-item[data-x]');
    if(x && pop){ closePop(); doExport(x.dataset.x); }
  }, true);

  // 粘贴导入
  document.querySelector('#pasteCancel').onclick = ()=> document.querySelector('#pasteMask').classList.remove('show');
  document.querySelector('#pasteMask').addEventListener('click', e=>{ if(e.target.id==='pasteMask') e.target.classList.remove('show'); });
  document.querySelector('#pasteOk').onclick = ()=>{
    const txt = document.querySelector('#pasteArea').value;
    const rows = parseAny(txt);
    if(!rows.length){ toast('先粘点内容进来'); return; }
    document.querySelector('#pasteMask').classList.remove('show');
    document.querySelector('#pasteArea').value = '';
    guardedImport('覆盖并导入', ()=> doApplyImport(rows, '粘贴的口播稿', '粘贴的文本'));
  };
}
