/* 视频审核页的页面状态和派生数据：正在看哪一批 / 哪个画面 / 哪个候选，以及按批次、按画面、按句子整理好的候选。
   只读 state，不碰 DOM；页面渲染和交互在 video-review.js。 */
import { state, rowById, lineSeconds, timeline, on } from '../app/state.js';
import { candidateBatches } from '../core/candidate-queries.js';
import { shotMembers } from '../core/shots.js';
import { usageList } from '../core/asset-model.js';
import { reworkShots } from '../core/rework.js';
import { planOf } from '../core/candidates.js';
import { layoutShot as layoutPictures } from '../core/shot-layout.js';
import { mainFilled, mainGaps } from '../core/shot-tracks.js';
import { targetLines } from './clip-player.js';

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
let idleMemo = null;
let idleKey = null;
let usageRev = 0; // 拖动两条轨只改使用记录、不换数组：靠事件计数让「未采用」跟着重算
for (const ev of ['rows', 'assets-changed', 'history', 'project-loaded']) on(ev, () => usageRev++);
export function idleIds() {
  const key = [
    usageRev,
    state.candidates,
    state.rows,
    timeline(),
    state.candidates.map(c => `${c.id}${c.decision || ''}`).join(),
  ];
  if (idleMemo && idleKey && key.every((k, i) => k === idleKey[i])) return idleMemo;
  idleKey = key;
  const byLead = new Map();
  for (const c of state.candidates) {
    if (c.decision) continue;
    const lead = leadOf(c);
    if (lead && !byLead.has(lead)) byLead.set(lead, null);
  }
  const out = new Set();
  for (const lead of byLead.keys()) {
    const members = shotMembers(state.rows, lead);
    const ids = new Set(members.map(m => m.id));
    const cands = state.candidates.filter(c => ids.has(c.rowId));
    if (mainFilled(state.assets || {}, members, timeline(), fromReview))
      for (const c of cands) if (!c.decision) out.add(c.id);
  }
  idleMemo = out;
  return out;
}
/* 正片轨上审核来的视频（占位照片之类不算） */
const fromReview = id => !!state.assets?.[id]?.source?.candidate;
export const isIdle = c => !c.decision && idleIds().has(c.id);
export const isPending = c => !c.decision && !idleIds().has(c.id);
export const pendingCount = () => state.candidates.filter(isPending).length;
export const candidatesForRow = row =>
  row ? state.candidates.filter(c => shotMembers(state.rows, row).some(m => m.id === c.rowId)) : [];

/* 句子所在章节名 */
export function sectionOf(rowId) {
  let name = '';
  for (const r of state.rows) {
    if (r.kind === 'section') name = r.text;
    if (r.id === rowId) return name;
  }
  return '';
}
export const leadOf = c => {
  const row = rowById(c.rowId);
  return row ? shotMembers(state.rows, row)[0] : null;
};

/* 批次：按导入时间新的在前；1.8 以前导入的没有批次，归成「之前导入的」 */
export const batches = () => candidateBatches(state.candidates, state.rows);

export const batchLabel = b => b.label;

/* 一批里的画面：按稿子顺序，带章节名和待审数 */
export function shotsOf(batch) {
  const order = new Map(state.rows.map((r, i) => [r.id, i]));
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

export const fmtDay = t => {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
export const rangeText = lead => {
  if (!lead) return '找不到对应句子';
  const members = shotMembers(state.rows, lead);
  return members.length > 1 ? `第 ${members[0].no}–${members[members.length - 1].no} 句` : `第 ${members[0].no} 句`;
};

export const batchDetail = b =>
  [b.detail, b.scope.missing && b.scope.count ? '部分句子已移除' : ''].filter(Boolean).join(' · ');

/* 一个画面的候选按清单里的先后排（清单里同一方案的视频挨在一起） */
export function layoutShot(g) {
  const members = g?.lead ? shotMembers(state.rows, g.lead) : [];
  const order = [...(g?.cands || [])].sort((a, b) => planOf(a) - planOf(b) || (a.seq ?? 0) - (b.seq ?? 0));
  return { members, whole: order, byNo: new Map(), order };
}
/* 正片轨排了多少：{ got（盖住的秒数）, dur（口播秒数）, full }；不知道时间返回 null */
export function trackFill(g) {
  const members = g?.lead ? shotMembers(state.rows, g.lead) : [];
  const layout = members.length ? layoutPictures(state.assets || {}, members, timeline()) : null;
  if (!layout || !(layout.dur > 0)) return null;
  const empty = layout.items.length ? mainGaps(layout).reduce((t, x) => t + x.end - x.start, 0) : layout.dur;
  return { got: Math.max(0, layout.dur - empty), dur: layout.dur, full: layout.items.length > 0 && empty === 0 };
}
/* 展开着的候选（待审的 + 这次刚审过的），按清单里的先后——↑↓ 换候选也按这个顺序走 */
export const openOf = g => layoutShot(g).order.filter(c => isPending(c) || touched.has(c.id));

/* 秒数显示：保留一位小数，整数不带 .0 */
export const secText = x => String(Math.round(Math.max(0, x) * 10) / 10);
/* 这句有没有画面：先看表格里实际的画面排布（和预览、表格的「每句的画面」同一套算法），再看候选审到哪一步。
   cov：这个画面每句的盖住情况（shotLineCoverage 的结果，渲染时整组算一次传进来）。
   sec：标签里的秒数（有画面时「盖住 / 需要」，没画面时「需 N 秒」）。
   清单里写的「缺了什么」只在审核卡片上提示；审过并通过就算接受了，句子标签不再因为它报问题 */
export function coverageOf(row, shotCands, cov) {
  const hits = shotCands.filter(c => targetLines(c).target.some(r => r.id === row.id));
  const ok = hits.filter(c => c.decision === 'ok');
  const x = cov?.find(y => y.row.id === row.id);
  const need = x ? x.need : lineSeconds(row);
  if (x && x.state !== 'ok' && x.state !== 'empty') {
    const sec = `${secText(x.got)} / ${secText(need)} 秒`;
    return {
      cls: 'part',
      text: '画面不够长',
      sec,
      tip: `画面只盖住这句 ${secText(x.got)} 秒，口播 ${secText(need)} 秒，后面 ${secText(need - x.got)} 秒是空的`,
    };
  }
  if (x?.state === 'ok') {
    const sec = `${secText(need)} / ${secText(need)} 秒`;
    if (ok.length) return { cls: 'ok', text: '✓ 有画面', sec };
    if (hits.some(isPending)) return { cls: 'wait', text: '待审', sec: `需 ${secText(need)} 秒` };
    return { cls: 'has', text: '表格里有其他素材', sec };
  }
  // 这句没画面（或者还不知道时间）
  const sec = `需 ${secText(need)} 秒`;
  if (hits.some(isPending)) return { cls: 'wait', text: '待审', sec };
  if (!x && usageList(row).some(u => !u.off)) return { cls: 'has', text: '表格里有其他素材' };
  if (hits.some(c => c.decision === 're')) return { cls: 'miss', text: '等新候选', sec };
  if (ok.length)
    return {
      cls: 'miss',
      text: '还缺画面',
      sec,
      tip: '通过的画面在表格里没排到这句（可能只配了前面几句），这句播出来是空的',
    };
  return { cls: 'miss', text: '还缺画面', sec };
}

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
