/* 句子 / 章节 / 共用画面的数据操作：界面只调用这里的函数。
   每个会改数据的操作先 snapshot（可撤销），再 persist（落盘），然后广播事件；
   怎么刷界面由界面层订阅事件决定，这里不碰 DOM。 */
import { state, update, emit, currentSelection, rowById, rowIndex, match, types } from './state.js';
import { notify } from './events.js';
import { persist } from './storage.js';
import { snapshot, undo } from './undo.js';
import {
  validGroup,
  sameGroupSelection,
  groupRows,
  repairCandidates,
  repairPunctuation,
  expandShotIds,
  shotMembers,
  setShotField,
  normalizeGroups,
  groupExtendNext,
  groupExtendNextPlan,
  groupDropLast,
  groupSplitAt,
  groupSplitAtPlan,
  normalizeUsageSpans,
} from '../core/shots.js';
import { syncMirror, usageList, cloneUsages, hydrateProjectAssets } from '../core/asset-model.js';

const nextId = () => state.rows.reduce((m, r) => (r.id > m ? r.id : m), 0) + 1;
const commit = () => {
  normalizeGroups(state.rows);
  persist();
  update('rows');
};
const tName = t => types().label(t);

/* 从位置 i 开始找最近的句子（跳过章节行），先向后找不到再向前——删除后选中句留在原地 */
function nearestLine(i) {
  for (let j = Math.max(0, i); j < state.rows.length; j++) if (state.rows[j].kind === 'line') return state.rows[j];
  for (let j = Math.min(i, state.rows.length) - 1; j >= 0; j--) if (state.rows[j].kind === 'line') return state.rows[j];
  return null;
}

/* ── 标注（界面收到 marks 事件后能原地刷新的就原地刷新） ── */
export function setType(ids, t) {
  ids = expandShotIds(state.rows, ids);
  ids = ids.filter(id => {
    const r = rowById(id);
    return r && r.kind === 'line';
  });
  if (!ids.length) return;
  snapshot(ids.length > 1 ? `批量标注 ${ids.length} 句` : '标注');
  ids.forEach(id => {
    rowById(id).type = t;
  });
  persist();
  emit('marks', { ids });
  emit('annotated', { ids, type: t });
  emit('workspace');
  if (t === null) notify(ids.length > 1 ? '已清除这些句子的标注' : '已清除这句的标注');
}

/* ── 勾选视图：把句子勾成 A / B（null = 擦除）。类型没变的句子跳过，不产生空撤销步 ── */
export function markSentences(ids, t) {
  ids = expandShotIds(state.rows, ids);
  const targets = ids.map(id => rowById(id)).filter(r => r && r.kind === 'line' && r.type !== t);
  if (!targets.length) return;
  const what = t ? `标成 ${tName(t)}` : '擦除标注';
  snapshot(targets.length > 1 ? `${what}（${targets.length} 句）` : what);
  targets.forEach(r => {
    r.type = t;
  });
  persist();
  emit('marks', { ids: targets.map(r => r.id) });
  emit('annotated', { ids, type: t });
  emit('workspace');
}

/* ── 勾选视图批注：保存 / 修改一句话的画面批注（红字显示在句子下方）── */
export function setNote(id, txt) {
  const r = rowById(id);
  if (!r || r.kind !== 'line' || (r.note || '') === txt) return;
  snapshot(r.note ? '修改批注' : '写批注');
  const members = setShotField(state.rows, r, 'note', txt);
  persist();
  emit('notes', { ids: members.map(x => x.id) });
  emit('workspace');
}

/* ── 删除 ── */
export function deleteRows(ids) {
  if (!ids.length) return;
  snapshot(ids.length > 1 ? `删除 ${ids.length} 句` : '删除句子');
  const idxs = ids.map(rowIndex).filter(i => i > -1);
  const firstDel = idxs.length ? Math.min(...idxs) : state.rows.length;
  const gone = new Set(ids);
  state.rows = state.rows.filter(r => !gone.has(r.id));
  state.multi = null;
  state.sel = nearestLine(firstDel)?.id ?? null; // 选中句停在删除位置，不跳回第一句
  commit();
  notify(`已删除 ${ids.length} 句`, { label: '撤销', cb: undo });
}

/* ── 合并：并回上一句（文本拼接 / 备注合并 / 类型沿用），返回目标句 id ── */
export function mergeToPrev(id) {
  const i = rowIndex(id);
  if (i <= 0) return null;
  const cur = state.rows[i],
    prev = state.rows[i - 1];
  if (!prev || prev.kind !== 'line') return null;
  if ((cur.groupId || prev.groupId) && cur.groupId !== prev.groupId) {
    notify('请先解除共用，再合并句子');
    return null;
  }
  snapshot('合并句子');
  const seam = prev.text.length;
  prev.text = prev.text + cur.text;
  prev.note = [...new Set([prev.note, cur.note].filter(Boolean))].join(' ');
  const seen = new Map(usageList(prev).map(u => [u.assetId, { ...u }]));
  for (const u of usageList(cur)) {
    const had = seen.get(u.assetId);
    if (!had) seen.set(u.assetId, { ...u });
    else if (had.off && !u.off) delete had.off; // 两句里有一句用到，合并后的句子就用到
  }
  prev.assetUsages = [...seen.values()];
  prev.assets = [...new Set([prev.assets, cur.assets].filter(Boolean))].join('\n');
  if (prev.status !== cur.status) prev.status = 'todo';
  // 对齐过字幕：合并后的时间从前一句开头到后一句结尾
  if (prev.time && cur.time)
    prev.time = {
      start: Math.min(prev.time.start, cur.time.start),
      end: Math.max(prev.time.end, cur.time.end),
      conf: Math.min(prev.time.conf, cur.time.conf),
      st: [prev.time.st, cur.time.st].includes('est')
        ? 'est'
        : [prev.time.st, cur.time.st].includes('low')
          ? 'low'
          : 'ok',
    };
  else delete prev.time;
  if (!prev.type) prev.type = cur.type;
  state.rows.splice(i, 1);
  state.multi = null;
  state.sel = prev.id;
  commit();
  // 筛选下合并结果可能不可见，明说去向，避免「句子丢了」的错觉
  if (!match(prev)) notify(`已并回上一句（第 ${prev.no} 句，当前筛选下不显示，切「全部」可见）`);
  else notify('已并回上一句');
  return { id: prev.id, seam };
}

/* ── 拆分：从光标 offset 处拆成两句 ── */
export function splitAt(id, offset) {
  const r = rowById(id);
  if (!r) return null;
  const a = r.text.slice(0, offset).trim(),
    b = r.text.slice(offset).trim();
  if (!a || !b) return null;
  snapshot('拆分句子');
  const i = rowIndex(id);
  const nid = nextId();
  r.text = a;
  // 对齐过字幕：按字数比例把这句的时间切成两段（比例估的，标为低置信，重新对齐可得精确值）
  let bTime = null;
  if (r.time && r.time.end > r.time.start) {
    const cut = r.time.start + ((r.time.end - r.time.start) * a.length) / (a.length + b.length);
    const st = r.time.st === 'est' ? 'est' : 'low';
    bTime = { start: cut, end: r.time.end, conf: r.time.conf, st };
    r.time = { ...r.time, end: cut, st };
  }
  state.rows.splice(i + 1, 0, {
    id: nid,
    kind: 'line',
    text: b,
    note: r.groupId ? r.note : '',
    type: r.groupId ? r.type : null,
    ...(bTime ? { time: bTime } : {}),
    ...(r.groupId
      ? {
          groupId: r.groupId,
          assets: r.assets,
          status: r.status,
          assetUsages: cloneUsages(usageList(r)),
        }
      : {}),
  });
  state.multi = null;
  state.sel = nid;
  commit();
  notify('已从光标处拆分');
  return nid;
}

/* ── 插入：在 id 后插一句空句（返回新句 id，由调用方进入编辑态）──
   在共用画面内部插句（后面还有同组句子）时，新句直接归入这个画面：
   没写就走人（dropIfEmpty）后原共用关系原样保留，不会被一个空句拆成两半 */
export function insertAfter(id) {
  const i = rowIndex(id);
  const at = i < 0 ? state.rows.length : i + 1;
  snapshot('插入句子');
  const nid = nextId();
  const row = { id: nid, kind: 'line', text: '', note: '', type: null };
  const cur = state.rows[i],
    next = state.rows[at];
  if (cur?.groupId && next?.kind === 'line' && next.groupId === cur.groupId) {
    Object.assign(row, {
      groupId: cur.groupId,
      note: cur.note,
      type: cur.type,
      assets: cur.assets,
      status: cur.status,
      assetUsages: cloneUsages(usageList(cur)),
    });
  }
  state.rows.splice(at, 0, row);
  state.multi = null;
  state.sel = nid;
  commit();
  return nid;
}

/* 插入后没打字就走人：把空句清掉。
   如果这句是「插入新章节」送的开篇空句，句子没写成，刚立的标题也连带撤掉，不留空节 */
let freshSection = null; // {secId, sentId}
export function dropIfEmpty(id) {
  const r = rowById(id);
  if (r && r.kind === 'line' && !r.text.trim()) {
    const i = state.rows.indexOf(r);
    state.rows.splice(i, 1);
    if (freshSection && freshSection.sentId === id) {
      const s = rowById(freshSection.secId);
      const j = s ? state.rows.indexOf(s) : -1;
      if (j > -1 && (j + 1 >= state.rows.length || state.rows[j + 1].kind === 'section')) state.rows.splice(j, 1);
      freshSection = null;
    }
    state.sel = nearestLine(i)?.id ?? null;
    commit();
  }
}

/* ── 章节：从句子处拆节 / 节尾接着写新节 / 删标题 / 删整节 ── */

/* 从这句分为新章节：在这句前面插标题，这句成为新章节的第一句。
   上一行已经是章节标题时拒绝，不然会做出删不掉内容、只能干瞪着的空节 */
export function addSectionBefore(id) {
  const i = rowIndex(id);
  if (i < 0 || state.rows[i].kind !== 'line') return null;
  if (i > 0 && state.rows[i - 1].kind === 'section') {
    notify('这句已经是章节开头了');
    return null;
  }
  snapshot('分出新章节');
  const sid = nextId();
  state.rows.splice(i, 0, { id: sid, kind: 'section', text: '新章节' });
  state.multi = null;
  commit();
  notify('已分出新章节，给它起个名');
  return sid;
}

/* 在某节最后一句后面立一个新章节（标题 + 开篇空句），返回空句 id 供调用方进入编辑态。
   适合在文档末尾接着写新的一节；空句没写就走人 → dropIfEmpty 连标题一起清 */
export function insertSectionWithSentence(secId) {
  const si = rowIndex(secId);
  if (si < 0 || state.rows[si].kind !== 'section') return null;
  let at = si + 1;
  while (at < state.rows.length && state.rows[at].kind === 'line') at++;
  snapshot('插入新章节');
  const sid = nextId();
  state.rows.splice(at, 0, { id: sid, kind: 'section', text: '新章节' });
  const nid = nextId();
  state.rows.splice(at + 1, 0, { id: nid, kind: 'line', text: '', note: '', type: null });
  state.multi = null;
  state.sel = nid;
  freshSection = { secId: sid, sentId: nid };
  commit();
  return nid;
}

/* 只删章节标题：句子保留，自然并回上一节（第一节则变成开头的无章节正文） */
export function deleteSectionHeader(id) {
  const i = rowIndex(id);
  if (i < 0 || state.rows[i].kind !== 'section') return;
  snapshot('删除章节标题');
  if (freshSection && freshSection.secId === id) freshSection = null;
  state.rows.splice(i, 1);
  state.multi = null;
  commit();
  notify('已删章节标题，句子保留');
}

/* 某节标题下有多少句（菜单文案 / 确认弹窗用） */
export function sectionSentenceCount(id) {
  const i = rowIndex(id);
  if (i < 0) return 0;
  let n = 0;
  for (let j = i + 1; j < state.rows.length && state.rows[j].kind !== 'section'; j++) n++;
  return n;
}

/* 删整节：标题 + 到下一节之前的全部句子 */
export function deleteSectionAll(id) {
  const i = rowIndex(id);
  if (i < 0 || state.rows[i].kind !== 'section') return;
  const name = state.rows[i].text;
  snapshot(`删除章节「${name}」`);
  if (freshSection && freshSection.secId === id) freshSection = null;
  let j = i + 1;
  while (j < state.rows.length && state.rows[j].kind !== 'section') j++;
  const n = j - i - 1;
  state.rows.splice(i, j - i);
  state.multi = null;
  state.sel = nearestLine(i)?.id ?? null;
  commit();
  notify(`已删除「${name}」和其中 ${n} 句`, { label: '撤销', cb: undo });
}

/* ── 应用导入（覆盖当前项目内容；空项目直接进，有内容先确认）── */
export function applyImport(rows, title) {
  snapshot('导入新稿子');
  state.rows = rows;
  state.assets = hydrateProjectAssets({ rows: state.rows, assets: state.assets });
  state.title = title;
  state.filter = 'all';
  state.multi = null;
  state.sel = rows.find(r => r.kind === 'line')?.id ?? null;
  commit();
  notify(`已导入「${title}」· ${rows.filter(r => r.kind === 'line').length} 句`);
}

export const annotateSelection = t => setType(currentSelection(), t);
export const deleteSelection = () => deleteRows(currentSelection());

/* ── 共用画面范围调整：一次动作 = 一次撤销，撤销会连描述、素材、片段和状态一起恢复 ── */
const revealShot = members => emit('reveal', { id: members[0].id });

/* 加入下一句（不弹差异框的直接执行版；有差异时由 shot-menu 先展示再调这里） */
export function extendGroupNextAction(groupId) {
  const plan = groupExtendNextPlan(state.rows, groupId);
  if (!plan.ok) {
    notify(plan.reason);
    return false;
  }
  const nextNo = plan.next.no;
  snapshot('将下一句加入画面');
  const res = groupExtendNext(state.rows, groupId);
  if (!res) {
    return false;
  }
  syncMirror(state.rows, state.assets);
  persist();
  update('rows');
  revealShot(res.members);
  notify(`已把第 ${nextNo} 句加入这个画面 · ⌘Z 可撤销`);
  return true;
}

export function dropGroupLastAction(groupId) {
  const members = shotMembers(
    state.rows,
    state.rows.find(r => r.groupId === groupId),
  );
  if (members.length < 2) {
    notify('这个画面不足两句');
    return false;
  }
  const lastNo = members[members.length - 1].no;
  snapshot('将最后一句移出画面');
  groupDropLast(state.rows, groupId);
  syncMirror(state.rows, state.assets);
  persist();
  update('rows');
  revealShot(members);
  notify(`第 ${lastNo} 句已移出，恢复独立画面 · ⌘Z 可撤销`);
  return true;
}

export function splitGroupAtAction(groupId, rowId) {
  const target = rowById(rowId);
  const plan = groupSplitAtPlan(state.rows, groupId, rowId);
  if (!plan.ok) {
    notify(plan.reason);
    return false;
  }
  snapshot('从这句开始另一个画面');
  const res = groupSplitAt(state.rows, groupId, rowId);
  syncMirror(state.rows, state.assets);
  persist();
  update('rows');
  revealShot(res.back);
  notify(`已从第 ${target?.no ?? ''} 句开始另一个画面 · ⌘Z 可撤销`);
  return true;
}

export function ungroupAction(ids) {
  const groups = new Set(ids.map(id => rowById(id)?.groupId).filter(Boolean));
  if (!groups.size) return false;
  snapshot('解除共用画面');
  state.rows.forEach(r => {
    if (groups.has(r.groupId)) delete r.groupId;
  });
  normalizeUsageSpans(state.rows); // 每句只留下原本在这句出现的素材
  persist();
  update('rows');
  notify('已解除共用 · ⌘Z 可撤销');
  return true;
}

/* ── 共用画面：把选中的连续句子合成一个画面 ── */
export function groupSelectionAction(ids) {
  if (!validGroup(state.rows, ids)) return false;
  if (sameGroupSelection(state.rows, ids)) {
    notify('这些句子已经在同一个共用画面里');
    return false;
  }
  snapshot('共用画面');
  const members = groupRows(state.rows, ids);
  state.multiMode = false;
  state.multi = null;
  state.sel = members ? members[0].id : ids[0];
  persist();
  update('rows');
  emit('reveal', { id: state.sel });
  notify('已设为共用画面');
  return true;
}

/* ── 修复分句：把只有标点的孤立行并回上一句 ── */
export function repairPunctuationAction() {
  const fixes = repairCandidates(state.rows);
  if (!fixes.length) return 0;
  snapshot('修复孤立标点');
  state.rows = repairPunctuation(state.rows);
  if (!rowById(state.sel)) state.sel = state.rows.find(r => r.kind === 'line')?.id ?? null;
  state.multi = null;
  persist();
  update('rows');
  notify(`已修复 ${fixes.length} 行`);
  return fixes.length;
}

/* ── 画面信息（右侧面板）：描述 / 状态 / 待核对，整组同步 ── */
export function setShotNote(row, note, { session } = {}) {
  if (!row || (row.note || '') === note) return false;
  if (!session || !session.snapped) {
    snapshot('编辑画面与素材');
    if (session) session.snapped = true;
  }
  const members = setShotField(state.rows, row, 'note', note);
  persist();
  emit('notes', { ids: members.map(x => x.id) });
  return true;
}
export function markReviewed(row) {
  if (!row) return;
  snapshot('核对改稿');
  setShotField(state.rows, row, 'needsReview', false);
  persist();
  update('rows');
}

/* ── 语速 ── */
export function setSpeechRate(value) {
  if (!(value >= 1 && value <= 10)) return false;
  state.speechRate = value;
  persist();
  update('rows');
  return true;
}

/* ── 项目改名（打字过程直接落盘，不进撤销） ── */
export function renameProject(title) {
  state.title = title;
  persist();
  emit('title');
}

/* ── 改一句的文字（双击编辑提交时） ── */
export function setSentenceText(id, txt) {
  const r = rowById(id);
  if (!r || !txt || txt === r.text) return false;
  snapshot('修改文字');
  r.text = txt;
  persist();
  emit('text', { id });
  return true;
}

/* ── 表格里边打字边存画面描述：同一次编辑只拍一张快照（撤销回到编辑前） ── */
export function typeNote(row, text, session) {
  if (session && session.id === row.id && !session.snapped && text !== session.baseline) {
    row.note = session.baseline;
    snapshot('编辑备注');
    session.snapped = true;
  }
  const members = setShotField(state.rows, row, 'note', text);
  persist();
  return members;
}

/* ── 章节改名 ── */
export function renameSection(id, txt) {
  const r = rowById(id);
  if (!r || r.kind !== 'section' || !txt || txt === r.text) return false;
  snapshot('重命名章节');
  r.text = txt;
  persist();
  emit('workspace');
  return true;
}
