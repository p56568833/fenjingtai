/* 镜头里的画面排布（纯函数，无 DOM、无应用状态）：一个镜头（一句 / 一组共用画面）在口播里占一段时间，
   里面可以有多个主画面，按时间先后自动编号 ①②③…，每个占其中一段，没排到的地方就是空白（预览里黑屏）。

   两种排法：
   · 按句子（默认）：每个主画面跟着它的「出现位置」（第几句到第几句）走；几个主画面落在同一段句子上时平分那段时间。
   · 手动：在「对着口播看画面」里拖过 / 填过秒数后，每个主画面带一个 at = {start, end, of}：
       start / end 是相对这个镜头开头的秒数，of 记下设置时镜头第一句的 id。
       镜头的第一句变了（拆分 / 解除共用 / 往前并句）时 of 对不上，自动退回按句子排，不会拿旧秒数乱放。
       口播时长变了（导入音频、对字幕）秒数不动；超出口播的部分不放，并标记 over，界面上标红提醒。

   上屏的画面 = 主画面（图片 / 视频）；一个主画面都没有时退回第一个「未分配」的画面（兼容旧项目）。
   叠加、备选不在这里排。 */
import { isRole } from './shots.js';
import { usageList, kindOf } from './asset-model.js';
import { spanOf } from './timeline.js';

export const MIN_LEN = 0.2; // 一个画面最短 0.2 秒
export const round1 = x => Math.round(x * 10) / 10;

export const validAt = (at, ownerId) =>
  !!at &&
  typeof at === 'object' &&
  Number.isFinite(at.start) &&
  Number.isFinite(at.end) &&
  at.start >= 0 &&
  at.end - at.start >= MIN_LEN - 1e-6 &&
  (ownerId == null || at.of === ownerId);

/* 读进来的 at 清洗：不合法就丢掉（载入 / 导入 / 拷贝时用） */
export function cleanAt(at) {
  if (!at || typeof at !== 'object') return null;
  const start = Number(at.start),
    end = Number(at.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < MIN_LEN - 1e-6) return null;
  if (at.of == null) return null;
  return { start: round1(start), end: round1(end), of: at.of };
}

const visualOf = (registry, u) => {
  const a = registry[u.assetId];
  const kind = a?.kind || kindOf(a?.path || '');
  return kind === 'video' || kind === 'image' ? { asset: a, kind } : null;
};

/* 镜头里要上屏的画面（使用记录按列表顺序）。共用画面里每句都存一份副本，顺序一致，以第一句为准 */
export function pictureUsages(registry, members) {
  if (!members.length) return [];
  const onSomewhere = id => members.some(m => usageList(m).some(u => u.assetId === id && !u.off));
  const list = usageList(members[0]);
  const pick = test =>
    list
      .filter(u => test(u) && onSomewhere(u.assetId))
      .map(u => ({ usage: u, ...visualOf(registry, u) }))
      .filter(x => x.asset);
  const mains = pick(u => u.role === 'main');
  if (mains.length) return mains;
  return pick(u => !isRole(u.role)).slice(0, 1);
}

/* 按句子排：每个画面占它出现的那几句；时间上重叠的几个画面平分重叠的那一整段（按列表顺序先后） */
function bySentence(items, members, tl, base) {
  for (const it of items) {
    const on = members.filter(m => usageList(m).some(u => u.assetId === it.assetId && !u.off));
    const sp = spanOf(
      tl,
      (on.length ? on : members).map(m => m.id),
    );
    it.start = sp ? sp.start - base : 0;
    it.end = sp ? sp.end - base : 0;
  }
  // 按开始时间分簇：互相重叠的放一簇，簇内平分
  const order = [...items].sort((a, b) => a.start - b.start || a.listIndex - b.listIndex);
  let cluster = [];
  let cEnd = -Infinity;
  const flush = () => {
    if (cluster.length > 1) {
      const s = Math.min(...cluster.map(x => x.start)),
        e = Math.max(...cluster.map(x => x.end));
      const step = (e - s) / cluster.length;
      cluster
        .sort((a, b) => a.listIndex - b.listIndex)
        .forEach((x, k) => {
          x.start = s + step * k;
          x.end = s + step * (k + 1);
        });
    }
    cluster = [];
    cEnd = -Infinity;
  };
  for (const it of order) {
    if (cluster.length && it.start >= cEnd - 1e-6) flush();
    cluster.push(it);
    cEnd = Math.max(cEnd, it.end);
  }
  flush();
}

/* 手动排：带 at 的照 at 放；新加进来还没时间的，放进末尾空着的时间（平分），末尾没空就分最后一个画面的后一半 */
function byTimes(items, owner, dur) {
  const placed = items.filter(it => validAt(it.usage.at, owner));
  for (const it of placed) {
    it.start = it.usage.at.start;
    it.end = it.usage.at.end;
    it.auto = false;
  }
  const loose = items.filter(it => it.auto);
  if (!loose.length) return;
  let from = Math.max(0, ...placed.map(x => x.end));
  let to = dur;
  if (to - from < MIN_LEN * loose.length) {
    const last = placed.reduce((a, b) => (b.end > a.end ? b : a), placed[0]);
    const mid = (last.start + Math.min(last.end, dur)) / 2;
    to = Math.min(last.end, dur);
    last.end = mid;
    from = mid;
  }
  const step = Math.max(0, to - from) / loose.length;
  loose.forEach((it, k) => {
    it.start = from + step * k;
    it.end = from + step * (k + 1);
  });
}

/* 一个镜头的排布：{ start, end, dur（口播里的绝对时间）, timed, items: [{n, assetId, usage, asset, kind, start, end, auto, over}] }
   items 里的 start / end 是相对镜头开头的秒数，按开始时间排好、编号 n 从 1 开始 */
export function layoutShot(registry, members, tl) {
  if (!members.length) return null;
  const span = spanOf(
    tl,
    members.map(m => m.id),
  );
  if (!span) return null;
  const dur = span.end - span.start;
  const owner = members[0].id;
  const items = pictureUsages(registry || {}, members).map((p, listIndex) => ({
    assetId: p.usage.assetId,
    usage: p.usage,
    asset: p.asset,
    kind: p.kind,
    listIndex,
    start: 0,
    end: 0,
    auto: true,
    over: false,
  }));
  const timed = items.some(it => validAt(it.usage.at, owner));
  if (timed) byTimes(items, owner, dur);
  else bySentence(items, members, tl, span.start);
  items.sort((a, b) => a.start - b.start || a.listIndex - b.listIndex);
  items.forEach((it, k) => {
    it.n = k + 1;
    it.over = it.end > dur + 0.05;
  });
  return { start: span.start, end: span.end, dur, timed, owner, items };
}

/* 镜头内 rel 秒时正在上屏的画面（超出口播的部分不算）；没有就是空白 */
export const itemAt = (layout, rel) =>
  layout?.items.find(it => it.start <= rel + 1e-6 && rel < Math.min(it.end, layout.dur) - 1e-6) || null;

/* 圈号：① … ⑳，再多就用 (21) */
export const circled = n => (n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`);

/* 拖动 / 填秒数时的约束：不出 [0, dur]、不和前后画面重叠、最短 MIN_LEN。返回修正后的 {start, end} */
export function clampSpan(items, index, start, end, dur, mode = 'both') {
  const prev = index > 0 ? items[index - 1] : null;
  const next = index < items.length - 1 ? items[index + 1] : null;
  const lo = prev ? Math.min(prev.end, dur) : 0;
  const hi = next ? next.start : dur;
  let s = start,
    e = end;
  if (mode === 'move') {
    const len = Math.min(e - s, hi - lo);
    s = Math.max(lo, Math.min(s, hi - len));
    e = s + len;
  } else if (mode === 'start') {
    // 拖开始：结束不动，开始最多到结束前 MIN_LEN
    e = Math.min(hi, e);
    s = Math.max(lo, Math.min(s, e - MIN_LEN));
  } else if (mode === 'end') {
    // 拖结束：开始不动，结束最少到开始后 MIN_LEN
    s = Math.max(lo, s);
    e = Math.min(hi, Math.max(e, s + MIN_LEN));
  } else {
    s = Math.max(lo, Math.min(s, hi - MIN_LEN));
    e = Math.min(hi, Math.max(e, s + MIN_LEN));
  }
  return { start: round1(Math.max(0, s)), end: round1(e) };
}
