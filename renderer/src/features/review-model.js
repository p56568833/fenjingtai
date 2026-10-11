/* 视频审核页的页面状态和派生数据：正在看哪一批 / 哪个画面 / 哪个候选，以及按批次、按画面、按句子整理好的候选。
   只读 state，不碰 DOM；页面渲染和交互在 video-review.js。 */
import { state, rowById } from '../app/state.js';
import { candidateBatches } from '../core/candidate-queries.js';
import { shotMembers } from '../core/shots.js';
import { usageList } from '../core/asset-model.js';
import { reworkShots } from '../core/rework.js';
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
export const pendingCount = () => state.candidates.filter(c => !c.decision).length;
export const isPending = c => !c.decision;
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

/* 只覆盖一部分：清单写了 coverageStatus: "partial"；旧清单没有这个字段时，看标题里有没有「只覆盖 / 部分覆盖」 */
export const isPartial = c => c.coverage === 'partial' || (!c.coverage && /只覆盖|部分覆盖/.test(c.title || ''));

/* 一个画面按句子排：每个候选挂在它「配」的第一句下面；画面不止一句、又没写配哪句的，归到「整段」 */
export function layoutShot(g) {
  const members = g?.lead ? shotMembers(state.rows, g.lead) : [];
  const whole = [];
  const byNo = new Map();
  for (const c of g?.cands || []) {
    const t = targetLines(c);
    const no = members.length > 1 && t.whole ? null : t.target[0]?.no;
    if (no == null || !members.some(m => m.no === no)) whole.push(c);
    else {
      if (!byNo.has(no)) byNo.set(no, []);
      byNo.get(no).push(c);
    }
  }
  return { members, whole, byNo, order: [...whole, ...members.flatMap(m => byNo.get(m.no) || [])] };
}
/* 展开着的候选（待审的 + 这次刚审过的），按界面上从上到下的顺序——↑↓ 换候选也按这个顺序走 */
export const openOf = g => layoutShot(g).order.filter(c => isPending(c) || touched.has(c.id));

/* 这句有没有画面：看这个画面所有批次的候选；都没有时再看表格里这句挂没挂别的素材 */
export function coverageOf(row, shotCands) {
  const hits = shotCands.filter(c => targetLines(c).target.some(r => r.id === row.id));
  const ok = hits.filter(c => c.decision === 'ok');
  if (ok.some(c => !isPartial(c))) return { cls: 'ok', text: '✓ 有画面' };
  if (ok.length) return { cls: 'part', text: '只覆盖一部分', tip: ok.map(c => c.limits || c.title).join('\n') };
  if (hits.some(isPending)) return { cls: 'wait', text: '待审' };
  if (usageList(row).some(u => !u.off)) return { cls: 'has', text: '表格里有其他素材' };
  if (hits.some(c => c.decision === 're')) return { cls: 'miss', text: '等新候选' };
  return { cls: 'miss', text: '还缺画面' };
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
