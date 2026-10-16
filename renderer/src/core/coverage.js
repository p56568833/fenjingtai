/* 素材够不够盖住口播（纯函数，无 DOM、无应用状态）。每个上屏画面三个数：
   · 需要：它在这段口播里分到的秒数（core/shot-layout.js 排出来的那一段；超出口播的部分不算）
   · 可用：标出来的可用片段（使用记录上的 clip）的长度；没标 = 整个文件
   · 文件：本地文件的实际时长（asset.durationSec，界面读出来后记下）；在线视频还没保存时没有
   结论只拿「可用」和「需要」比：ok 够 / short 差多少 / unknown 时长还不知道 / still 图片（不限时长）
   使用记录上标了 fitDone（剪辑里已经补足，比如放慢、定格）：不够也算够，fixed 记下原本差多少 */
import { LINK_RE } from './asset-model.js';
import { layoutShot } from './shot-layout.js';
import { shots } from './shots.js';
import { typeIndex } from './types.js';

export const COVER_EPS = 0.05; // 小于 0.05 秒的差当作刚好

const finite = x => typeof x === 'number' && Number.isFinite(x);
const validClip = c => !!c && finite(c.in) && finite(c.out) && c.out > c.in;

/* item：layoutShot().items 里的一项；shotDur：这个镜头的口播总长 */
export function coverageOf(item, shotDur) {
  const slot = item.slotEnd ?? item.end; // 排给它的时间（画面本身截到可用长度，需要的秒数照排给它的算）
  const end = finite(shotDur) ? Math.min(slot, shotDur) : slot;
  const need = Math.max(0, end - item.start);
  if (item.kind !== 'video') return { need, verdict: 'still' };
  const path = item.asset?.path || '';
  const online = LINK_RE.test(path);
  const file = !online && finite(item.asset?.durationSec) ? item.asset.durationSec : null;
  const clip = validClip(item.usage?.clip) ? item.usage.clip : null;
  let usable = clip ? clip.out - clip.in : file;
  // 在线视频（还没保存）没标片段：地址里的 #t=入,出 就是要截的那段
  if (usable == null && online) {
    const m = path.match(/#t=([\d.]+),([\d.]+)/);
    if (m && +m[2] > +m[1]) usable = +m[2] - +m[1];
  }
  const out = { need, usable, file, clip, whole: !clip, online };
  if (usable == null) return { ...out, verdict: 'unknown' };
  if (usable + COVER_EPS >= need) return { ...out, verdict: 'ok', spare: Math.max(0, usable - need) };
  if (item.usage?.fitDone) return { ...out, verdict: 'ok', spare: 0, fixed: true, lack: need - usable };
  return { ...out, verdict: 'short', lack: need - usable };
}

/* 一个镜头里所有上屏画面的结论：Map(assetId → coverage) */
export function shotCoverage(layout) {
  const map = new Map();
  if (!layout) return map;
  for (const it of layout.items) map.set(it.assetId, { ...coverageOf(it, layout.dur), n: it.n });
  return map;
}

/* ── 每句有没有画面 ──
   按镜头里的画面排布（和预览播出来一样）看每句口播被画面盖住了几秒：
   视频只算它可用片段那么长（排给它的时间比片段长，多出来的就是空白；标了剪辑已补足的按排给它的时间算）；图片排到多长就盖多长。
   一点没盖住的句子算没画面；盖住了一部分、只差不到 0.5 秒的不算 */
export const GAP_MIN = 0.5;
export function lineCoverage(registry, members, tl, { missing = new Set() } = {}) {
  const layout = layoutShot(registry, members, tl);
  if (!layout) return null;
  const spans = layout.items
    .map(it => {
      const c = coverageOf(it, layout.dur);
      const len =
        it.kind === 'video' && finite(c.usable) && !c.fixed ? Math.min(it.end - it.start, c.usable) : it.end - it.start;
      return [layout.start + it.start, layout.start + it.start + Math.max(0, len), missing.has(it.asset?.path)];
    })
    .sort((a, b) => a[0] - b[0]);
  return members.map(row => {
    const t = tl.times.get(row.id);
    const need = t ? Math.max(0, t.end - t.start) : 0;
    const t0 = t?.start ?? 0,
      t1 = t?.end ?? 0;
    let got = 0,
      reach = -Infinity;
    const gaps = []; // 这句里没盖住的几段（相对句子开头的秒数）
    let cur = t0;
    for (const [a, b, lost] of spans) {
      if (lost) continue;
      const lo = Math.max(a, reach, t0),
        hi = Math.min(b, t1);
      if (hi > lo) {
        got += hi - lo;
        if (lo - cur > 0.05) gaps.push([cur - t0, lo - t0]);
        cur = Math.max(cur, hi);
      }
      reach = Math.max(reach, b);
    }
    if (t1 - cur > 0.05) gaps.push([cur - t0, t1 - t0]);
    got = Math.min(need, got);
    // 一点都没盖住的句子再短也算没画面；盖住了一部分的，差不到 0.5 秒才算够
    let state = got < 0.05 && need > 0.05 ? 'empty' : need - got < GAP_MIN ? 'ok' : 'part';
    const missingGaps = [];
    // 失联只影响它原来覆盖的部分。可用画面有重叠时优先认作已覆盖，不改变素材排布。
    for (const [from, to] of gaps) {
      const cuts = [
        ...new Set([
          t0 + from,
          t0 + to,
          ...spans.flatMap(([a, b, lost]) =>
            lost ? [Math.max(t0 + from, Math.min(t0 + to, a)), Math.max(t0 + from, Math.min(t0 + to, b))] : [],
          ),
        ]),
      ].sort((a, b) => a - b);
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i],
          b = cuts[i + 1],
          mid = (a + b) / 2;
        if (b > a && spans.some(([start, end, lost]) => lost && start <= mid && mid < end)) {
          const last = missingGaps.at(-1);
          if (last && Math.abs(last[1] - (a - t0)) < 1e-6) last[1] = b - t0;
          else missingGaps.push([a - t0, b - t0]);
        }
      }
    }
    if (missingGaps.length && state === 'ok') state = 'part';
    const effectiveGaps = state === 'ok' ? [] : state === 'empty' ? [[0, need]] : gaps;
    const cuts = [...new Set([0, need, ...effectiveGaps.flat(), ...missingGaps.flat()])].sort((a, b) => a - b);
    const segments = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i],
        b = cuts[i + 1],
        mid = (a + b) / 2;
      if (b <= a) continue;
      const status = missingGaps.some(([from, to]) => from <= mid && mid < to)
        ? 'missing'
        : effectiveGaps.some(([from, to]) => from <= mid && mid < to)
          ? 'gap'
          : 'covered';
      const last = segments.at(-1);
      if (last?.status === status) last.end = t0 + b;
      else segments.push({ start: t0 + a, end: t0 + b, status });
    }
    return { row, need, got, state, gaps: effectiveGaps, missingGaps, segments, hasPicture: layout.items.length > 0 };
  });
}

/* 统一的项目覆盖结果。UI 只负责显示；停顿衔接、真实缺口和失联判定只在这里做。 */
export function buildPictureCoverage(rows, registry, tl, { missing = new Set(), types } = {}) {
  const ti = typeIndex(types),
    byLine = new Map(),
    byShot = new Map();
  for (const members of shots(rows)) {
    const cov = lineCoverage(registry, members, tl, { missing }) || [];
    const needsVisual = !members[0].type || ti.needsVisual(members[0].type);
    const shot = { members, lines: cov, needsVisual };
    byShot.set(members[0].id, shot);
    for (const line of cov) {
      line.needsVisual = needsVisual;
      byLine.set(line.row.id, line);
    }
  }
  const segments = [],
    pauses = [];
  const append = segment => {
    if (!(segment.end > segment.start)) return;
    const last = segments.at(-1);
    if (last?.status === segment.status && Math.abs(last.end - segment.start) < 0.001) last.end = segment.end;
    else segments.push({ ...segment });
  };
  let previous = null;
  for (const row of rows.filter(r => r.kind === 'line')) {
    const line = byLine.get(row.id),
      time = tl.times.get(row.id);
    if (!line || !time) {
      previous = null;
      continue;
    }
    if (previous && time.start > previous.time.end) {
      const left = previous.line.segments.at(-1)?.status,
        right = line.segments[0]?.status;
      const joined = (left === 'covered' || left === 'missing') && (right === 'covered' || right === 'missing');
      const status = joined ? (left === 'missing' || right === 'missing' ? 'missing' : 'covered') : 'gap';
      const pause = { start: previous.time.end, end: time.start, status, kind: 'pause' };
      pauses.push(pause);
      append(pause);
    }
    for (const segment of line.segments) append(segment);
    previous = { time, line };
  }
  return { byLine, byShot, segments, pauses };
}

/* 整个项目里需要画面、已经放了画面、却还有句子没画面（或只盖住一部分）的镜头：
   [{ lead, lines: lineCoverage 里不是 ok 的那几句 }]，按稿子顺序。
   不需要画面的类型、还没标类型的不算；一个画面都还没放的镜头也不算（那是「还没关联素材」，还在找） */
export function blankShots(rows, registry, tl, types) {
  const ti = typeIndex(types);
  const out = [];
  for (const members of shots(rows)) {
    const lead = members[0];
    if (!lead.type || !ti.needsVisual(lead.type)) continue;
    const cov = lineCoverage(registry, members, tl) || [];
    const lines = cov.filter(x => x.state !== 'ok');
    if (lines.length && !cov.every(x => x.state === 'empty')) out.push({ lead, lines });
  }
  return out;
}
/* 「第 436–437 句」「第 436、438 句」 */
export function linesText(nos) {
  const runs = [];
  for (const n of nos) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return `第 ${runs.map(([a, b]) => (a === b ? a : `${a}–${b}`)).join('、')} 句`;
}
