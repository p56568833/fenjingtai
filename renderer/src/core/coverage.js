/* 素材够不够盖住口播（纯函数，无 DOM、无应用状态）。每个上屏画面三个数：
   · 需要：它在这段口播里分到的秒数（core/shot-layout.js 排出来的那一段；超出口播的部分不算）
   · 可用：标出来的可用片段（使用记录上的 clip）的长度；没标 = 整个文件
   · 文件：本地文件的实际时长（asset.durationSec，界面读出来后记下）；在线视频还没保存时没有
   结论只拿「可用」和「需要」比：ok 够 / short 差多少 / unknown 时长还不知道 / still 图片（不限时长） */
import { LINK_RE } from './asset-model.js';
import { layoutShot } from './shot-layout.js';
import { shots } from './shots.js';
import { typeIndex } from './types.js';

export const COVER_EPS = 0.05; // 小于 0.05 秒的差当作刚好

const finite = x => typeof x === 'number' && Number.isFinite(x);
const validClip = c => !!c && finite(c.in) && finite(c.out) && c.out > c.in;

/* item：layoutShot().items 里的一项；shotDur：这个镜头的口播总长 */
export function coverageOf(item, shotDur) {
  const end = finite(shotDur) ? Math.min(item.end, shotDur) : item.end;
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
   视频只算它可用片段那么长（排给它的时间比片段长，多出来的就是空白）；图片排到多长就盖多长。
   一点没盖住的句子算没画面；盖住了一部分、只差不到 0.5 秒的不算 */
export const GAP_MIN = 0.5;
export function lineCoverage(registry, members, tl) {
  const layout = layoutShot(registry, members, tl);
  if (!layout) return null;
  const spans = layout.items
    .map(it => {
      const c = coverageOf(it, layout.dur);
      const len = it.kind === 'video' && finite(c.usable) ? Math.min(it.end - it.start, c.usable) : it.end - it.start;
      return [layout.start + it.start, layout.start + it.start + Math.max(0, len)];
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
    for (const [a, b] of spans) {
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
    const state = got < 0.05 && need > 0.05 ? 'empty' : need - got < GAP_MIN ? 'ok' : 'part';
    return { row, need, got, state, gaps: state === 'ok' ? [] : state === 'empty' ? [[0, need]] : gaps };
  });
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
