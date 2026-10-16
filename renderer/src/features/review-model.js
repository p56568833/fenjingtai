import { buildReviewIndex } from '../core/review-index.js';
/* 视频审核页的页面状态和派生数据：正在看哪一批 / 哪个画面 / 哪个候选，以及按批次、按画面、按句子整理好的候选。
   只读 state，不碰 DOM；页面渲染和交互在 video-review.js。 */
import { state } from '../app/state.js';
import { timeline, projectRevision } from '../app/project-queries.js';
import { candidateBatches } from '../core/candidate-queries.js';
import { shotMembers } from '../core/shots.js';
import { reworkShots } from '../core/rework.js';
import { planOf } from '../core/candidate-values.js';
import { layoutShot as layoutPictures } from '../core/shot-layout.js';
import { mainFilled, mainGaps } from '../core/shot-tracks.js';
import { fmtDay } from '../core/review-format.js';

export const page = {
  mode: 'review', // 'review' 待审（按批次） | 'rework' 待返工（所有批次没过关的画面）
  curRework: null, // 待返工页里选中的画面（第一句的 id）
  reworkDocAt: 0, // 这次打开软件后最近一次生成返工单的时间
  curBatch: null, // 正在看的批次
  curShot: null, // 右边显示的画面（画面第一句的 id）
  curCand: null, // 键盘焦点所在的候选
};
/* 刚审过的候选先展开留在原处（来得及写意见、撤回），换画面后收成一行 */
export const touched = new Set();

/* 未采用：正片轨已经用通过的视频排满了，别的还没审的视频不再算待审（想用还能自己点通过）。
   候选多的时候 isPending 会被调很多次：候选、审核结果、句子都没变就用上次算的 */
let cached = null;
let cacheKey = null;
function reviewIndex() {
  const key = [
    projectRevision(),
    state.projectId,
    state.rows,
    state.candidates,
    state.rows.length,
    state.candidates.length,
  ];
  if (!cached || !key.every((value, i) => value === cacheKey[i])) {
    cacheKey = key;
    cached = { ...buildReviewIndex(state.rows, state.candidates), idle: null };
  }
  return cached;
}
function idleIds() {
  const index = reviewIndex();
  if (index.idle) return index.idle;
  const out = new Set();
  const tl = timeline();
  for (const { members, cands } of index.groups.values()) {
    if (cands.some(c => !c.decision) && mainFilled(state.assets || {}, members, tl, fromReview))
      for (const c of cands) if (!c.decision) out.add(c.id);
  }
  index.idle = out;
  return out;
}
/* 正片轨上审核来的视频（占位照片之类不算） */
const fromReview = id => !!state.assets?.[id]?.source?.candidate;
export const isIdle = c => !c.decision && idleIds().has(c.id);
export const isPending = c => !c.decision && !idleIds().has(c.id);
export const pendingCount = () => state.candidates.filter(isPending).length;

/* 句子所在章节名 */
export const sectionOf = rowId => reviewIndex().sections.get(rowId) || '';
export const leadOf = c => reviewIndex().byRow.get(c.rowId)?.lead || null;

/* 批次：按导入时间新的在前；1.8 以前导入的没有批次，归成「之前导入的」 */
export const batches = () => {
  const index = reviewIndex();
  return (index.batches ||= candidateBatches(state.candidates, state.rows));
};

export const batchLabel = b => b.label;

/* 一批里的画面：按稿子顺序，带章节名和待审数 */
export function shotsOf(batch) {
  const { order } = reviewIndex();
  const map = new Map();
  for (const c of batch?.cands || []) {
    const lead = leadOf(c);
    const key = lead ? lead.id : 'missing';
    if (!map.has(key)) map.set(key, { key, lead, cands: [] });
    map.get(key).cands.push(c);
  }
  return [...map.values()]
    .sort((a, b) => (order.get(a.lead?.id) ?? 1e9) - (order.get(b.lead?.id) ?? 1e9))
    .map(g => ({
      ...g,
      section: g.lead ? sectionOf(g.lead.id) : '',
      pending: g.cands.filter(isPending).length,
      ok: g.cands.filter(c => c.decision === 'ok').length,
      re: g.cands.filter(c => c.decision === 're').length,
    }));
}
export const curBatchObj = () => batches().find(b => b.id === page.curBatch) || null;
export const curShots = () => shotsOf(curBatchObj());
export const curGroup = () => curShots().find(g => g.key === page.curShot) || null;

export const rangeText = lead => {
  if (!lead) return '找不到对应句子';
  const members = shotMembers(state.rows, lead);
  return members.length > 1 ? `第 ${members[0].no}–${members[members.length - 1].no} 句` : `第 ${members[0].no} 句`;
};

/* 一个画面的候选按清单里的先后排（清单里同一方案的视频挨在一起） */
export const orderedCandidates = g =>
  [...(g?.cands || [])].sort((a, b) => planOf(a) - planOf(b) || (a.seq ?? 0) - (b.seq ?? 0));
/* 正片轨排了多少：{ got（盖住的秒数）, dur（口播秒数）, full }；不知道时间返回 null */
export function trackFill(g) {
  const members = g?.lead ? shotMembers(state.rows, g.lead) : [];
  const layout = members.length ? layoutPictures(state.assets || {}, members, timeline()) : null;
  if (!layout || !(layout.dur > 0)) return null;
  const empty = layout.items.length ? mainGaps(layout).reduce((t, x) => t + x.end - x.start, 0) : layout.dur;
  return { got: Math.max(0, layout.dur - empty), dur: layout.dur, full: layout.items.length > 0 && empty === 0 };
}
/* 展开着的候选（待审的 + 这次刚审过的），按清单里的先后——↑↓ 换候选也按这个顺序走 */
export const openOf = g => orderedCandidates(g).filter(c => isPending(c) || touched.has(c.id));

/* ── 待返工：所有批次里没过关（否掉了、一个都没通过）或者你写了要求的画面，按稿子顺序列在一页 ── */
export const reworkList = () => reworkShots(state.rows, state.candidates);
export const curReworkItem = () => reworkList().find(s => s.lead.id === page.curRework) || null;
export const batchOfCand = c => {
  const b = batches().find(x => x.id === (c.batchId || 'legacy'));
  return b ? `${batchLabel(b)}${b.at ? ` · ${fmtDay(b.at)}` : ''}` : '';
};
/* 待返工页里展开的候选：否掉的都展开（要能看画面、改判）；通过的收成一行 */
/* 待返工页只列有问题的候选：否掉的、待审的，和你标了「不满意」的那个已通过视频；别的已通过视频不相干，不列 */
export const reworkShown = item => {
  const out = new Set((item?.replaces || []).map(x => x.assetId));
  return item ? item.cands.filter(c => c.decision !== 'ok' || out.has(c.assetId)) : [];
};
export const reworkOpen = item => reworkShown(item).filter(c => c.decision !== 'ok' || touched.has(c.id));
