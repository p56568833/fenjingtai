/* 视频审核页的页面状态和派生数据：正在看哪一批 / 哪个画面 / 哪个候选，以及按批次、按画面、按句子整理好的候选。
   只读 state，不碰 DOM；页面渲染和交互在 video-review.js。 */
import { state, rowById, lineSeconds, timeline } from '../app/state.js';
import { candidateBatches } from '../core/candidate-queries.js';
import { shotMembers } from '../core/shots.js';
import { usageList } from '../core/asset-model.js';
import { reworkShots } from '../core/rework.js';
import { shotPlans, planOf, currentPlan } from '../core/candidates.js';
import { shotSeconds } from '../app/line-coverage.js';
import { targetLines } from './clip-player.js';

export const page = {
  mode: 'review', // 'review' 待审（按批次） | 'rework' 待返工（所有批次没过关的画面）
  curRework: null, // 待返工页里选中的画面（第一句的 id）
  reworkDocAt: 0, // 这次打开软件后最近一次生成返工单的时间
  curBatch: null, // 正在看的批次
  curShot: null, // 右边显示的画面（画面第一句的 id）
  curCand: null, // 键盘焦点所在的候选
  plans: new Map(), // 画面 key → 正在看的方案（Tab）
};
/* 刚审过的候选先展开留在原处（来得及写意见、撤回），换画面后收成一行 */
export const touched = new Set();

/* 未采用：画面已经有方案用通过的视频填满了，别的还没审的视频不再算待审（想用还能自己点通过）。
   候选多的时候 isPending 会被调很多次：候选、审核结果、句子都没变就用上次算的 */
let idleMemo = null;
let idleKey = null;
export function idleIds() {
  const key = [
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
    if (shotPlans(cands, shotSeconds(members)).some(p => p.filled))
      for (const c of cands) if (!c.decision) out.add(c.id);
  }
  idleMemo = out;
  return out;
}
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
export const batches = () => candidateBatches(state.candidates);

export const batchLabel = b => `${b.id === 'legacy' ? '' : `第 ${b.number} 批 · `}${b.name}`;

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

/* 批次在左栏的显示名：机器名的下划线换成「·」、去掉末尾 8 位日期（日期另外显示）；完整名字在悬停提示里 */
export const prettyBatch = name =>
  String(name || '')
    .replace(/[_\s-]*\d{8}$/, '')
    .replace(/_+/g, ' · ')
    .trim() || String(name || '');
export const fmtDate = t => {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};
export const batchNo = b => (b.id === 'legacy' ? '之前导入的' : `第 ${b.number} 批`);

/* 画面内容只对上口播的一部分：清单写了 limitations（缺了什么） */
export const isPartial = c => !!c.limits;

/* 一个画面的候选按方案、再按方案里的先后排（方案里的视频都配整个画面） */
export function layoutShot(g) {
  const members = g?.lead ? shotMembers(state.rows, g.lead) : [];
  const order = [...(g?.cands || [])].sort((a, b) => planOf(a) - planOf(b) || (a.seq ?? 0) - (b.seq ?? 0));
  return { members, whole: order, byNo: new Map(), order };
}
/* 一个画面的方案（审核页的 Tab）：shotPlans 的结果，need 按这个画面现在的口播时长 */
export const plansOfGroup = g => {
  const members = g?.lead ? shotMembers(state.rows, g.lead) : [];
  return shotPlans(g?.cands || [], members.length ? shotSeconds(members) : null);
};
/* 正在看的方案：点过的 Tab 优先；否则表格里正在用的方案；否则第一个还有待审的；否则方案一 */
export function activePlan(g, plans = plansOfGroup(g)) {
  if (!plans.length) return null;
  const chosen = page.plans.get(g.key);
  if (plans.some(p => p.plan === chosen)) return chosen;
  const using = usingPlan(g);
  if (plans.some(p => p.plan === using)) return using;
  return (plans.find(p => p.cands.some(isPending)) || plans[0]).plan;
}
/* 表格里这个画面正在用的方案（没有通过的视频挂着时为 null） */
export const usingPlan = g =>
  g?.lead ? currentPlan(shotMembers(state.rows, g.lead), state.assets || {}, state.candidates) : null;
/* 方案在 Tab 上的状态：已填满 / 待审 N / 不够长 / 还差几秒 / 未采用 / 等新候选 */
export function planStatus(p) {
  const pending = p.cands.filter(isPending).length;
  if (p.filled) return { cls: 'ok', text: '已填满' };
  if (pending) return { cls: 'wait', text: `待审 ${pending}` };
  if (!p.fits) return { cls: 'part', text: '不够长' };
  if (p.cands.some(isIdle)) return { cls: 'has', text: '未采用' };
  if (p.ok.length && p.need) return { cls: 'miss', text: `还差 ${secText(p.need - p.okLen)} 秒` };
  return { cls: 'miss', text: '等新候选' };
}
/* 展开着的候选（正在看的方案里待审的 + 这次刚审过的），按方案里的先后——↑↓ 换候选也按这个顺序走 */
export const openOf = g => {
  const plan = activePlan(g);
  return layoutShot(g).order.filter(c => planOf(c) === plan && (isPending(c) || touched.has(c.id)));
};

/* 秒数显示：保留一位小数，整数不带 .0 */
export const secText = x => String(Math.round(Math.max(0, x) * 10) / 10);
/* 这句有没有画面：先看表格里实际的画面排布（和预览、表格的「每句的画面」同一套算法），再看候选审到哪一步。
   cov：这个画面每句的盖住情况（shotLineCoverage 的结果，渲染时整组算一次传进来）。
   sec：标签里的秒数（有画面时「盖住 / 需要」，没画面时「需 N 秒」）；note：只覆盖一部分时缺了什么 */
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
    if (ok.length && !ok.some(c => !isPartial(c))) {
      const note = [...new Set(ok.map(c => c.limits).filter(Boolean))].join('；');
      return { cls: 'part', text: '只覆盖一部分', sec, note: note || '通过的画面只拍到口播内容的一部分' };
    }
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
  return b ? batchLabel(b) : '';
};
/* 待返工页里展开的候选：否掉的都展开（要能看画面、改判）；通过的收成一行 */
/* 待返工页只列有问题的候选：否掉的、待审的，和你标了「不满意」的那个已通过视频；别的已通过视频不相干，不列 */
export const reworkShown = item => {
  const out = new Set((item?.replaces || []).map(x => x.assetId));
  return item ? item.cands.filter(c => c.decision !== 'ok' || out.has(c.assetId)) : [];
};
export const reworkOpen = item => reworkShown(item).filter(c => c.decision !== 'ok' || touched.has(c.id));
