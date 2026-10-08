/* 应用状态：当前项目的数据 + 纯 UI 状态，以及围绕它的只读查询（句子索引、类型表、时间轴）。
   规则：改了数据就走 update() 广播，由订阅方决定重渲染粒度；这里不碰 DOM。 */
import { emit } from './events.js';
import { hydrateProjectAssets } from '../core/asset-model.js';
import { normalizeTypes, typeIndex } from '../core/types.js';
import { buildTimeline } from '../core/timeline.js';
import { speechUnits } from '../core/text.js';

export { on, emit } from './events.js';

export const state = {
  // 当前项目
  projectId: null,
  title: '',
  rows: [], // {id, kind:'line'|'section', text, note?, type?, assetUsages?, groupId?, time?}
  assets: {}, // 项目级素材库 { [assetId]: {id, kind, path, name, durationSec?} }
  types: normalizeTypes(null), // 本项目的标注类型表（顺序 = 快捷键 1–9）
  timing: null, // 对齐过的剪映字幕 {name, at, duration, cues}；句子上的 r.time 是对齐结果
  voice: null, // 口播音频 {path, name, duration}
  candidates: [], // 视频候选：[{id, key, rowId, lines, label, title, url, page, in, out, license, why, decision, note, assetId, savedPath, srcFile}]
  mediaDir: '', // 视频片段保存位置（按项目记住）
  speechRate: 4.5,
  // 纯 UI 状态（不进撤销栈）
  filter: 'all',
  sel: null,
  multi: null,
  multiMode: false,
  query: '',
  view: 'table',
  autoAdvance: false,
  focusMode: false,
};

/* 数据版本号：每次落盘（persist）都 +1，派生数据（时间轴等）据此失效重算 */
let rev = 0;
export const bumpRev = () => ++rev;
export const dataRev = () => rev;

/* 修改数据后广播。'rows' 全量重渲染；'selection' 只刷选中态；'view' 切视图 */
export function update(evt = 'rows') {
  if (evt === 'rows') rev++;
  emit(evt);
}

/* ── 句子索引：id → 行，O(1)。rows 数组原地增删或整体替换后自动重建 ── */
let indexRows = null;
let index = new Map(); // id → {row, i}
function rebuildIndex() {
  indexRows = state.rows;
  index = new Map();
  state.rows.forEach((row, i) => index.set(row.id, { row, i }));
}
export function rowById(id) {
  if (indexRows !== state.rows) rebuildIndex();
  let hit = index.get(id);
  if (!hit || state.rows[hit.i] !== hit.row) {
    rebuildIndex();
    hit = index.get(id);
  }
  return hit ? hit.row : undefined;
}
export function rowIndex(id) {
  return rowById(id) ? index.get(id).i : -1;
}

export function renumber() {
  let n = 0;
  for (const r of state.rows) if (r.kind === 'line') r.no = ++n;
}
export const lines = () => state.rows.filter(r => r.kind === 'line');
export function currentSelection() {
  if (state.multi && state.multi.length) return state.multi;
  return state.sel != null ? [state.sel] : [];
}
export const match = r => state.filter === 'all' || (state.filter === 'none' ? !r.type : r.type === state.filter);
export function visibleLineIds() {
  const ids = [];
  for (const r of state.rows) if (r.kind === 'line' && match(r)) ids.push(r.id);
  return ids;
}
/* 搜索命中：句子正文或备注包含查询词 */
export function qMatch(r) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return (r.text || '').toLowerCase().includes(q) || (r.note || '').toLowerCase().includes(q);
}

/* ── 类型表（按引用缓存：类型编辑一律整体替换数组） ── */
let typesRef = null;
let typesIdx = null;
export function types() {
  if (typesRef !== state.types) {
    typesRef = state.types;
    typesIdx = typeIndex(state.types);
  }
  return typesIdx;
}

/* ── 时间轴：每句在口播里的起止（字幕 > 口播音频比例推算 > 语速估算），数据一变就重算 ── */
let tlKey = '';
let tl = null;
export function timeline() {
  const key = `${rev}|${state.rows.length}|${state.voice?.duration || 0}|${state.speechRate}|${state.projectId}`;
  if (key !== tlKey || !tl) {
    tlKey = key;
    tl = buildTimeline(lines(), { voiceDuration: state.voice?.duration || null, speechRate: state.speechRate });
  }
  return tl;
}
export const timeOf = id => timeline().times.get(id) || null;
/* 一句的时长（秒） */
export function lineSeconds(r) {
  const t = r ? timeOf(r.id) : null;
  return t ? t.end - t.start : speechUnits(r?.text || '') / state.speechRate;
}

/* 载入一个项目到 state（切换项目 / 初次打开 / 导入）。
   老项目只有 r.assets 文本，hydrateProjectAssets 载入时迁移成素材库 + 使用记录（含片段范围） */
export function loadProjectIntoState(p) {
  state.projectId = p.id;
  state.title = p.title;
  state.rows = p.rows;
  state.assets = hydrateProjectAssets(p);
  p.types = normalizeTypes(p.types);
  state.types = p.types;
  state.timing = p.timing && Array.isArray(p.timing.cues) ? p.timing : null;
  state.voice = p.voice && typeof p.voice.path === 'string' ? p.voice : null;
  state.candidates = Array.isArray(p.candidates) ? p.candidates : [];
  state.mediaDir = typeof p.mediaDir === 'string' ? p.mediaDir : '';
  // 清掉 v1.1 短暂存在过的「B roll·未细分」试验类型
  for (const r of state.rows) if (r.kind === 'line' && r.type === 'b' && !types().has('b')) r.type = null;
  state.filter = 'all';
  state.multi = null;
  state.multiMode = false;
  state.query = '';
  const first = state.rows.find(r => r.kind === 'line');
  state.sel = state.rows.some(r => r.kind === 'line' && r.id === p.cursorId) ? p.cursorId : (first?.id ?? null);
  state.speechRate = Number(p.speechRate) >= 1 && Number(p.speechRate) <= 10 ? Number(p.speechRate) : 4.5;
  rev++;
  emit('project-loaded');
}

/* 勾选框 / 多选模式：只在「勾选集合」里增删。光标停在哪句（单选）不算勾选——
   否则先点了一句再去勾别的，会把光标那句也带进来；勾光标那句时反而把它取消掉。 */
export const checkedIds = () => (state.multi && state.multi.length ? state.multi : []);
export function toggleLineSelection(id, checked) {
  if (rowById(id)?.kind !== 'line') return;
  const selected = new Set(checkedIds());
  const add = checked ?? !selected.has(id);
  if (add) selected.add(id);
  else selected.delete(id);
  state.multi = [...selected];
  if (selected.has(id)) state.sel = id;
  else if (state.multi.length) state.sel = state.multi[state.multi.length - 1];
  if (!state.multi.length) state.multi = null;
}
