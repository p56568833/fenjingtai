/* 候选记录共用的格式、时间与标识规则，不处理导入或素材挂载。 */
import { fmtTime, parseTime } from './text.js';
import { assetName } from './asset-model.js';
export const CANDIDATE_TYPE = 'fenjingtai-candidates';
export const DECISION = { ok: '通过', no: '不要', re: '换一个' };
export const CANDIDATE_VERSION = 4; // v4：每段视频写明给画面里的哪几句（for）；旧格式一律不再导入
export const FILL_EPS = 0.5; // 估算口播允许不足半秒的误差。
export const MARGIN_MAX = 5; // 精选片段每边最多保留五秒下载余量。
export function parseClock(v) {
  if (typeof v === 'number' && isFinite(v)) return Math.max(0, v);
  const s = String(v ?? '').trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return parseTime(s) ?? NaN;
}
export function parseLines(v) {
  if (Array.isArray(v)) return { from: +v[0], to: +(v[1] ?? v[0]) };
  const m = String(v ?? '').match(/(\d+)\s*(?:[-–—~至到]\s*(\d+))?/);
  return m ? { from: +m[1], to: +(m[2] || m[1]) } : null;
}
export function cleanBest(b, tin, tout) {
  if (!b || typeof b !== 'object') return null;
  const bi = Number(b.in),
    bo = Number(b.out);
  if (!Number.isFinite(bi) || !Number.isFinite(bo) || bo <= bi) return null;
  if (Number.isFinite(tin) && Number.isFinite(tout) && (bi < tin - 0.01 || bo > tout + 0.01)) return null;
  const lo = Number.isFinite(tin) ? Math.max(tin, bi) : bi,
    hi = Number.isFinite(tout) ? Math.min(tout, bo) : bo;
  return hi > lo ? { in: lo, out: hi } : null;
}
export const noteLine = c =>
  `视频：${c.title || assetName(c.url)}｜${fmtTime(c.in)}–${fmtTime(c.out)}｜${c.license || '版权未注明'}｜${c.page || c.url}`;
export const remotePath = c => `${c.url.split('#')[0]}#t=${c.in},${c.out}`;
export function usableSeconds(c) {
  const b = cleanBest(c.best, c.in, c.out);
  return b ? b.out - b.in : Math.max(0, c.out - c.in);
}
export const candidateChanged = (old, next) =>
  old.url !== next.url || old.in !== next.in || old.out !== next.out || old.forText !== next.forText;

/* 这个候选给画面里的哪几句：members 下标 {from, to, whole}。forIds 是导入时记下的句子 id；
   句子被删、拆分合并后对不上的跳过，一句都对不上就算整段 */
export function forRange(c, members) {
  const ids = new Set(Array.isArray(c?.forIds) ? c.forIds : []);
  const idx = members.map((m, i) => (ids.has(m.id) ? i : -1)).filter(i => i >= 0);
  const last = members.length - 1;
  if (!idx.length) return { from: 0, to: last, whole: true };
  const from = idx[0],
    to = idx[idx.length - 1];
  return { from, to, whole: from === 0 && to === last };
}

/* 画面里第 from–to 句在口播里占的时间（绝对秒数）：从第 from 句开口，到第 to 句后面那句开口（含句间停顿）；
   to 是画面最后一句时到画面结尾（下一个画面开口）。shotEnd：这个画面的结尾。不知道时间返回 null */
export function forWindow(members, times, from, to, shotEnd) {
  const a = times.get(members[from]?.id);
  if (!a) return null;
  const next = to < members.length - 1 ? times.get(members[to + 1]?.id) : null;
  const end = next ? next.start : Number.isFinite(shotEnd) ? shotEnd : times.get(members[to]?.id)?.end;
  return Number.isFinite(end) && end > a.start ? { start: a.start, end } : null;
}

/* 人读的位置：第 5 句（单句画面）/ 第 1–4 句整段 / 第 2 句 / 第 2–3 句 */
export function rangeLabel(members, from, to) {
  const a = members[from]?.no,
    b = members[to]?.no;
  if (a == null) return '';
  if (members.length > 1 && from === 0 && to === members.length - 1) return `第 ${a}–${b} 句整段`;
  return a === b ? `第 ${a} 句` : `第 ${a}–${b} 句`;
}
