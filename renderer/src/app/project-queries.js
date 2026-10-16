/* 当前项目的派生查询；不管理选区、搜索或项目加载。 */
import { state } from './state.js';
import { typeIndex } from '../core/types.js';
import { buildTimeline } from '../core/timeline.js';
import { speechUnits } from '../core/text.js';
/* 查询版本由项目变化推进；时间轴只在文字、句子结构或计时信息改变时失效。 */
let rev = 0;
let timingRev = 0;

/* 失败恢复会原地还原对象，引用可能保持不变；所有派生缓存都必须失效。 */
export function invalidateProjectQueries({ timing = true } = {}) {
  indexRows = null;
  typesRef = null;
  if (timing) {
    tl = null;
    timingRev++;
  }
  rev++;
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
  const key = `${timingRev}|${state.rows.length}|${state.voice?.duration || 0}|${state.speechRate}|${state.projectId}`;
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

export const projectRevision = () => rev;
