/* 候选记录共用的格式、时间与标识规则，不处理导入或素材挂载。 */
import { fmtTime, parseTime } from './text.js';
import { assetName } from './asset-model.js';
export const CANDIDATE_TYPE = 'fenjingtai-candidates';
export const DECISION = { ok: '通过', no: '不要', re: '换一个' };
export const CANDIDATE_VERSION = 3;
export const LEGACY_VERSION = 2; // 旧版清单按单个方案导入。
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
export const planOf = c => (Number.isSafeInteger(c?.plan) && c.plan > 0 ? c.plan : 1);
export const PLAN_NAMES = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
export const planName = n => `方案${PLAN_NAMES[n - 1] || n}`;
export function usableSeconds(c) {
  const b = cleanBest(c.best, c.in, c.out);
  return b ? b.out - b.in : Math.max(0, c.out - c.in);
}
export const candidateChanged = (old, next) => old.url !== next.url || old.in !== next.in || old.out !== next.out;
