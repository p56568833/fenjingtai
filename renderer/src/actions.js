/* 数据操作中心：界面只调用这里的函数，改完数据统一广播重渲染。
   每个会改数据的操作先 snapshot（可撤销），再 persist（落盘）。 */
import { state, update, currentSelection, rowById, match } from './state.js';
import { TYPES } from './types.js';
import { persist } from './storage.js';
import { snapshot, undo } from './undo.js';
import { toast } from './util.js';
import { renderStats } from './render-stats.js';
import { updateRowVisual, updateSectionBadges } from './render-table.js';
import { updateCheckSpans, updateCheckNote } from './render-check.js';

const nextId = () => Math.max(0, ...state.rows.map(r=>r.id)) + 1;
const commit = () => { persist(); update('rows'); };
const tName = t => TYPES[t] ? TYPES[t].label : '未标注';

/* 从位置 i 开始找最近的句子（跳过章节行），先向后找不到再向前——删除后选中句留在原地 */
function nearestLine(i){
  for(let j=Math.max(0,i); j<state.rows.length; j++) if(state.rows[j].kind==='line') return state.rows[j];
  for(let j=Math.min(i,state.rows.length)-1; j>=0; j--) if(state.rows[j].kind==='line') return state.rows[j];
  return null;
}

/* ── 标注：表格视图原地更新单格（不重渲染） ── */
export function setType(ids, t){
  ids = ids.filter(id => { const r = rowById(id); return r && r.kind==='line'; });
  if(!ids.length) return;
  snapshot(ids.length>1 ? `批量标注 ${ids.length} 句` : '标注');
  ids.forEach(id => { rowById(id).type = t; });
  persist();
  if(state.filter!=='all'){
    update('rows');   // 筛选下行的可见性会变，整页刷一次
  } else {
    ids.forEach(updateRowVisual);
    updateSectionBadges();   // 章节条的「未标 N」跟着变，不重建列表
    renderStats();
  }
  if(t===null) toast(ids.length>1 ? '已清除这些句子的标注' : '已清除这句的标注');
}

/* ── 勾选视图：把句子勾成 A / B（null = 擦除）。类型没变的句子跳过，不产生空撤销步 ── */
export function markSentences(ids, t){
  const targets = ids
    .map(id=>rowById(id))
    .filter(r=>r && r.kind==='line' && r.type!==t);
  if(!targets.length) return;
  const what = t ? `标成 ${tName(t)}` : '擦除标注';
  snapshot(targets.length>1 ? `${what}（${targets.length} 句）` : what);
  targets.forEach(r=>{ r.type = t; });
  persist();
  if(state.view==='check'){
    updateCheckSpans(targets.map(r=>r.id));   // 原地刷句子底色，整篇不重建
    renderStats();
  } else {
    update('rows');
  }
}

/* ── 勾选视图批注：保存 / 修改一句话的画面批注（红字显示在句子下方）── */
export function setNote(id, txt){
  const r = rowById(id);
  if(!r || r.kind!=='line' || (r.note||'') === txt) return;
  snapshot(r.note ? '修改批注' : '写批注');
  r.note = txt;
  persist();
  if(state.view==='check'){
    updateCheckNote(id);   // 原地增删红字行，不重建整篇
  } else {
    update('rows');
  }
}

/* ── 删除 ── */
export function deleteRows(ids){
  if(!ids.length) return;
  snapshot(ids.length>1 ? `删除 ${ids.length} 句` : '删除句子');
  const idxs = ids.map(id=>state.rows.findIndex(r=>r.id===id)).filter(i=>i>-1);
  const firstDel = idxs.length ? Math.min(...idxs) : state.rows.length;
  ids.forEach(id => {
    const i = state.rows.findIndex(r=>r.id===id);
    if(i>-1) state.rows.splice(i,1);
  });
  state.multi = null;
  state.sel = nearestLine(firstDel)?.id ?? null;   // 选中句停在删除位置，不跳回第一句
  commit();
  toast(`已删除 ${ids.length} 句`, {label:'撤销', cb:undo});
}

/* ── 合并：并回上一句（文本拼接 / 备注合并 / 类型沿用），返回目标句 id ── */
export function mergeToPrev(id){
  const i = state.rows.findIndex(r=>r.id===id);
  if(i<=0) return null;
  const cur = state.rows[i], prev = state.rows[i-1];
  if(!prev || prev.kind!=='line') return null;
  snapshot('合并句子');
  const seam = prev.text.length;
  prev.text = prev.text + cur.text;
  prev.note = [prev.note, cur.note].filter(Boolean).join(' ');
  if(!prev.type) prev.type = cur.type;
  state.rows.splice(i,1);
  state.multi = null;
  state.sel = prev.id;
  commit();
  // 筛选下合并结果可能不可见，明说去向，避免「句子丢了」的错觉
  if(!match(prev)) toast(`已并回上一句（第 ${prev.no} 句，当前筛选下不显示，切「全部」可见）`);
  else toast('已并回上一句');
  return { id: prev.id, seam };
}

/* ── 拆分：从光标 offset 处拆成两句 ── */
export function splitAt(id, offset){
  const r = rowById(id); if(!r) return null;
  const a = r.text.slice(0, offset).trim(), b = r.text.slice(offset).trim();
  if(!a || !b) return null;
  snapshot('拆分句子');
  const i = state.rows.findIndex(x=>x.id===id);
  const nid = nextId();
  r.text = a;
  state.rows.splice(i+1, 0, {id:nid, kind:'line', text:b, note:'', type:null});
  state.multi = null; state.sel = nid;
  commit();
  toast('已从光标处拆分');
  return nid;
}

/* ── 插入：在 id 后插一句空句（返回新句 id，由调用方进入编辑态）── */
export function insertAfter(id){
  const i = state.rows.findIndex(r=>r.id===id);
  const at = i<0 ? state.rows.length : i+1;
  snapshot('插入句子');
  const nid = nextId();
  state.rows.splice(at, 0, {id:nid, kind:'line', text:'', note:'', type:null});
  state.multi = null; state.sel = nid;
  commit();
  return nid;
}

/* 插入后没打字就走人：把空句清掉。
   如果这句是「插入新章节」送的开篇空句，句子没写成，刚立的标题也连带撤掉，不留空节 */
let freshSection = null;   // {secId, sentId}
export function dropIfEmpty(id){
  const r = rowById(id);
  if(r && r.kind==='line' && !r.text.trim()){
    const i = state.rows.indexOf(r);
    state.rows.splice(i,1);
    if(freshSection && freshSection.sentId===id){
      const s = rowById(freshSection.secId);
      const j = s ? state.rows.indexOf(s) : -1;
      if(j>-1 && (j+1>=state.rows.length || state.rows[j+1].kind==='section')) state.rows.splice(j,1);
      freshSection = null;
    }
    state.sel = nearestLine(i)?.id ?? null;
    commit();
  }
}

/* ── 章节：从句子处拆节 / 节尾接着写新节 / 删标题 / 删整节 ── */

/* 从这句分为新章节：在这句前面插标题，这句成为新章节的第一句。
   上一行已经是章节标题时拒绝，不然会做出删不掉内容、只能干瞪着的空节 */
export function addSectionBefore(id){
  const i = state.rows.findIndex(r=>r.id===id);
  if(i<0 || state.rows[i].kind!=='line') return null;
  if(i>0 && state.rows[i-1].kind==='section'){ toast('这句已经是章节开头了'); return null; }
  snapshot('分出新章节');
  const sid = nextId();
  state.rows.splice(i, 0, {id:sid, kind:'section', text:'新章节'});
  state.multi = null;
  commit();
  toast('已分出新章节，给它起个名');
  return sid;
}

/* 在某节最后一句后面立一个新章节（标题 + 开篇空句），返回空句 id 供调用方进入编辑态。
   适合在文档末尾接着写新的一节；空句没写就走人 → dropIfEmpty 连标题一起清 */
export function insertSectionWithSentence(secId){
  const si = state.rows.findIndex(r=>r.id===secId);
  if(si<0 || state.rows[si].kind!=='section') return null;
  let at = si + 1;
  while(at < state.rows.length && state.rows[at].kind==='line') at++;
  snapshot('插入新章节');
  const sid = nextId();
  state.rows.splice(at, 0, {id:sid, kind:'section', text:'新章节'});
  const nid = nextId();
  state.rows.splice(at+1, 0, {id:nid, kind:'line', text:'', note:'', type:null});
  state.multi = null; state.sel = nid;
  freshSection = { secId: sid, sentId: nid };
  commit();
  return nid;
}

/* 只删章节标题：句子保留，自然并回上一节（第一节则变成开头的无章节正文） */
export function deleteSectionHeader(id){
  const i = state.rows.findIndex(r=>r.id===id);
  if(i<0 || state.rows[i].kind!=='section') return;
  snapshot('删除章节标题');
  if(freshSection && freshSection.secId===id) freshSection = null;
  state.rows.splice(i,1);
  state.multi = null;
  commit();
  toast('已删章节标题，句子保留');
}

/* 某节标题下有多少句（菜单文案 / 确认弹窗用） */
export function sectionSentenceCount(id){
  const i = state.rows.findIndex(r=>r.id===id);
  if(i<0) return 0;
  let n = 0;
  for(let j=i+1; j<state.rows.length && state.rows[j].kind!=='section'; j++) n++;
  return n;
}

/* 删整节：标题 + 到下一节之前的全部句子 */
export function deleteSectionAll(id){
  const i = state.rows.findIndex(r=>r.id===id);
  if(i<0 || state.rows[i].kind!=='section') return;
  const name = state.rows[i].text;
  snapshot(`删除章节「${name}」`);
  if(freshSection && freshSection.secId===id) freshSection = null;
  let j = i+1;
  while(j < state.rows.length && state.rows[j].kind!=='section') j++;
  const n = j - i - 1;
  state.rows.splice(i, j-i);
  state.multi = null;
  state.sel = nearestLine(i)?.id ?? null;
  commit();
  toast(`已删除「${name}」和其中 ${n} 句`, {label:'撤销', cb:undo});
}

/* ── 应用导入（覆盖当前项目内容；空项目直接进，有内容先确认）── */
export function applyImport(rows, title){
  snapshot('导入新稿子');
  state.rows = rows;
  state.title = title;
  document.querySelector('#projTitle').textContent = title;
  state.filter = 'all'; state.multi = null;
  state.sel = rows.find(r=>r.kind==='line')?.id ?? null;
  commit();
  toast(`已导入「${title}」· ${rows.filter(r=>r.kind==='line').length} 句`);
}

export const annotateSelection = t => setType(currentSelection(), t);
export const deleteSelection = () => deleteRows(currentSelection());
