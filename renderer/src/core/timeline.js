/* 每句话在口播里的时间（纯函数）。三档来源，自动取最准的：
   1. 'srt'  对齐过剪映字幕：用句子上的 r.time（st=ok 精确 / low 低置信 / est 字幕里没找到、按前后推算）
   2. 'fit'  导入了口播音频但没对字幕：按每句朗读量把音频总时长按比例铺满（不再猜语速）
   3. 'rate' 什么都没有：按语速（字/秒）累加估算
   对齐之后新加的句子没有 r.time，按前后已知时间把空档按字数分摊（'gap'）。 */
import { speechUnits } from './text.js';

const weight = r => Math.max(0.5, speechUnits(r.text));
const validTime = t => t && Number.isFinite(t.start) && Number.isFinite(t.end) && t.end > t.start;

/* lines：按稿子顺序的句子；返回 { times: Map(id → {start,end,src,st?}), total, source, rate } */
export function buildTimeline(lines, { voiceDuration = null, speechRate = 4.5 } = {}) {
  const times = new Map();
  const rate = speechRate > 0 ? speechRate : 4.5;
  const timed = lines.some(r => validTime(r.time));

  if (timed) {
    for (let i = 0; i < lines.length; i++) {
      const r = lines[i];
      if (validTime(r.time)) {
        times.set(r.id, { start: r.time.start, end: r.time.end, src: 'srt', st: r.time.st || 'ok' });
        continue;
      }
      // 一段连续没时间的句子：夹在前后两个已知时间之间按字数分摊；空档不够就按语速往后排
      let j = i;
      while (j < lines.length && !validTime(lines[j].time)) j++;
      const prev = i > 0 ? times.get(lines[i - 1].id) : null;
      const from = prev ? prev.end : 0;
      const run = lines.slice(i, j);
      const units = run.map(weight);
      const sum = units.reduce((a, b) => a + b, 0);
      const next = j < lines.length ? lines[j].time.start : null;
      const room = next != null ? next - from : null;
      const span = room != null && room > sum / rate / 3 ? room : sum / rate;
      let cur = from;
      run.forEach((x, k) => {
        const len = (span * units[k]) / sum;
        times.set(x.id, { start: cur, end: cur + len, src: 'gap' });
        cur += len;
      });
      i = j - 1;
    }
    const last = lines.length ? times.get(lines[lines.length - 1].id) : null;
    const total = Math.max(voiceDuration || 0, last ? last.end : 0);
    return { times, total, source: 'srt', rate };
  }

  const units = lines.map(weight);
  const sum = units.reduce((a, b) => a + b, 0);
  if (voiceDuration > 0 && sum > 0) {
    let cur = 0;
    lines.forEach((r, i) => {
      const len = (voiceDuration * units[i]) / sum;
      times.set(r.id, { start: cur, end: cur + len, src: 'fit' });
      cur += len;
    });
    return { times, total: voiceDuration, source: 'fit', rate: sum / voiceDuration };
  }

  let cur = 0;
  lines.forEach((r, i) => {
    const len = units[i] / rate;
    times.set(r.id, { start: cur, end: cur + len, src: 'rate' });
    cur += len;
  });
  return { times, total: cur, source: 'rate', rate };
}

/* 时间点 → 第几句（二分查找）。返回句子 id；在两句之间的空隙算前一句 */
export function lineAt(timeline, order, t) {
  let lo = 0,
    hi = order.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const tm = timeline.times.get(order[mid]);
    if (tm && tm.start <= t + 1e-6) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans < 0 ? (order[0] ?? null) : order[ans];
}

/* 一组句子（一个镜头）合起来的时间段 */
export function spanOf(timeline, ids) {
  let start = Infinity,
    end = -Infinity;
  for (const id of ids) {
    const t = timeline.times.get(id);
    if (!t) continue;
    start = Math.min(start, t.start);
    end = Math.max(end, t.end);
  }
  return end > start ? { start, end } : null;
}

/* 来源说明（界面提示用） */
export const SOURCE_TEXT = {
  srt: '剪映字幕实测',
  fit: '按口播音频时长推算',
  rate: '按语速估算',
};
