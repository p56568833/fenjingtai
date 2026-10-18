/* 镜头的两条轨（纯函数，无 DOM、无应用状态）：
   · 正片轨 = 主画面，排布见 shot-layout.js；拖过以后按手动时间放，中间可以留空。
   · 备选轨 = 备选画面（图片 / 视频），不计时长、不播放，只是「先放在这儿」。位置不绑句子：
     usage.at 记着它在备选轨上的秒数（和主画面同一个格式）；没有位置的放在它配的那几句下面。
   审核通过的视频：它给的那几句在正片轨上还空着就放上去，已经有画面了就放备选轨（placeApproved）。
   备选拖上正片轨：落在某段画面上和它互换，落在空隙里插进去（后面的画面往后让）。 */
import { usageList, kindOf } from './asset-model.js';
import { usageSpan } from './shots.js';
import { layoutShot, usableLength, validAt, MIN_LEN, round1 } from './shot-layout.js';
import { shotEntries } from './shot-edit.js';

export const FILL_GAP = 0.5; // 正片轨上短于 0.5 秒的空当不算空（字幕和手动时间的舍入误差）

const visual = (registry, u) => {
  const a = registry[u.assetId];
  const kind = a?.kind || kindOf(a?.path || '');
  return a && (kind === 'video' || kind === 'image') ? { asset: a, kind } : null;
};

/* 备选轨上的画面：[{ assetId, usage, asset, kind, start, end, row, placed }]，start / end 相对镜头开头。
   placed = 拖过位置（有 at）；row = 叠在第几层（时间上重叠的往下排，0 起） */
export function altItems(registry, members, tl) {
  const layout = layoutShot(registry, members, tl);
  if (!layout || !members.length) return [];
  const { dur, owner } = layout;
  const items = [];
  for (const u of usageList(members[0])) {
    if (u.role !== 'alt') continue;
    const v = visual(registry || {}, u);
    if (!v) continue;
    const it = { assetId: u.assetId, usage: u, asset: v.asset, kind: v.kind, start: 0, end: 0, row: 0, placed: false };
    const len = usableLength(it);
    if (validAt(u.at, owner)) {
      it.start = Math.max(0, Math.min(u.at.start, dur - MIN_LEN));
      it.end = Math.min(dur, Math.max(it.start + MIN_LEN, u.at.end));
      it.placed = true;
    } else {
      // 没拖过：放在它配的那几句下面，视频按可用长度，图片占满那几句
      const sp = usageSpan(members, u.assetId);
      const a = tl.times.get(members[sp.empty ? 0 : sp.from]?.id);
      const b = tl.times.get(members[sp.empty ? members.length - 1 : sp.to]?.id);
      const s = a ? Math.max(0, a.start - layout.start) : 0;
      // 配到最后一句的：连同后面的句间停顿，到镜头结尾
      const e = b && !sp.empty && sp.to < members.length - 1 ? b.end - layout.start : dur;
      it.start = round1(Math.min(s, dur - MIN_LEN));
      it.end = round1(Math.min(dur, it.start + Math.max(MIN_LEN, len ?? e - s)));
    }
    items.push(it);
  }
  items.sort((x, y) => x.start - y.start || x.end - y.end);
  const rowEnds = [];
  for (const it of items) {
    let r = rowEnds.findIndex(end => end <= it.start + 1e-6);
    if (r < 0) r = rowEnds.length;
    rowEnds[r] = it.end;
    it.row = r;
  }
  return items;
}

/* 正片轨上空着的时间：[{ start, end }]（只算长于 FILL_GAP 的） */
export function mainGaps(layout) {
  if (!layout) return [];
  const gaps = [];
  let t = 0;
  for (const it of layout.items) {
    if (it.start - t > FILL_GAP) gaps.push({ start: round1(t), end: round1(it.start) });
    t = Math.max(t, Math.min(it.end, layout.dur));
  }
  if (layout.dur - t > FILL_GAP) gaps.push({ start: round1(t), end: round1(layout.dur) });
  return gaps;
}

/* 审核通过的视频放哪：{ role: 'main' | 'alt', at?: {start, end} }。
   len：这个视频能用几秒；win：它给的那几句在镜头里的时间 {start, end}（相对镜头开头，见 forWindow）。
   keep(id)：正片轨上会被它挤掉的占位画面（照片等）返回 false，不算占位置。
   正片轨上那几句的时间还空着（别的画面占不到 FILL_GAP）→ 正片轨：按句子自动排时就配那几句，
   拖过时间（手动排）时放在那几句开头；已经有画面了 → 备选轨（放在那几句下面）。 */
export function placeApproved(registry, members, tl, len, keep = () => true, win = null) {
  const layout = layoutShot(registry, members, tl);
  if (!layout) return { role: 'main' };
  const items = layout.items.filter(it => keep(it.assetId));
  const w = win || { start: 0, end: layout.dur };
  const taken = items.some(it => Math.min(it.end, w.end) - Math.max(it.start, w.start) > FILL_GAP);
  if (taken) return { role: 'alt' };
  if (!layout.timed) return { role: 'main' };
  const start = round1(w.start);
  return { role: 'main', at: { start, end: round1(Math.min(w.end, start + Math.max(MIN_LEN, len || 0))) } };
}

/* 镜头里 [start, end] 这段时间（相对镜头开头）有没有被正片轨上的画面盖满（空当不超过 FILL_GAP） */
export function rangeFilled(layout, items, start, end) {
  if (!layout || !(end > start)) return false;
  let t = start;
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    const s = Math.max(it.start, start),
      e = Math.min(it.end, layout.dur, end);
    if (e <= s) continue;
    if (s - t > FILL_GAP) return false;
    t = Math.max(t, e);
  }
  return end - t <= FILL_GAP;
}

/* 正片轨填满没有：排上去的画面盖住的秒数够不够口播（留 FILL_GAP 余量）。
   keep 同上：只算候选视频时传进来 */
export function mainFilled(registry, members, tl, keep = () => true) {
  const layout = layoutShot(registry, members, tl);
  if (!layout || !(layout.dur > 0)) return false;
  const items = layout.items.filter(it => keep(it.assetId));
  if (!items.length) return false;
  return !mainGaps({ ...layout, items }).length;
}

/* ── 拖动草稿：只算结果，松手后由 app/ 一次提交 ── */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(x, hi));

/* 备选轨上平移：不受别的画面挡，只不出镜头 */
export function moveAlt(it, start, dur) {
  const len = round1(it.end - it.start);
  const s = round1(clamp(start, 0, Math.max(0, dur - len)));
  return { assetId: it.assetId, start: s, end: round1(s + len) };
}

/* 正片轨上 t 秒落在哪：{ kind: 'on', index } 落在某段画面上；{ kind: 'gap', start, end } 落在空隙里 */
export function mainSlotAt(items, t, dur) {
  const k = items.findIndex(it => it.start <= t + 1e-6 && t < Math.min(it.end, dur) - 1e-6);
  if (k >= 0) return { kind: 'on', index: k };
  const prev = items.filter(it => Math.min(it.end, dur) <= t + 1e-6).at(-1);
  const next = items.find(it => it.start >= t - 1e-6);
  return { kind: 'gap', start: prev ? Math.min(prev.end, dur) : 0, end: next ? next.start : dur };
}

/* 片段长度：视频按可用长度，图片 / 不知道长度的按它在轨上占的长度 */
const lenOf = it => Math.max(MIN_LEN, usableLength(it) ?? it.end - it.start);

/* 备选和正片轨上第 index 段互换：备选占那段的开头，最长和原来那段一样长（视频不够长就到它的末尾）；
   换下来的那段放到备选轨上备选原来的位置。返回 { mains, alts } 两组 entries */
export function swapIntoMain(items, index, alt, dur) {
  const target = items[index];
  if (!target) return null;
  const mains = shotEntries(items);
  const slot = round1(Math.min(target.end, dur) - target.start);
  const len = round1(Math.min(slot, lenOf(alt)));
  mains[index] = { assetId: alt.assetId, start: target.start, end: round1(target.start + len) };
  const back = round1(Math.min(target.end, dur) - target.start);
  const s = round1(clamp(alt.start, 0, Math.max(0, dur - back)));
  return { mains, alts: [{ assetId: target.assetId, start: s, end: round1(s + back) }] };
}

/* 备选插进正片轨 t 秒处（落在空隙里）：从 t 开始放它的长度；
   和后面的画面撞上，后面的整体往后让（中间原来留的空照样保留）。超出口播的部分不放，界面上标红 */
export function insertIntoMain(items, alt, t, dur) {
  const mains = shotEntries(items);
  const len = round1(lenOf(alt));
  const start = round1(clamp(t, 0, Math.max(0, dur - MIN_LEN)));
  const entry = { assetId: alt.assetId, start, end: round1(start + len) };
  const at = mains.findIndex(e => e.start >= start - 1e-6);
  const pos = at < 0 ? mains.length : at;
  mains.splice(pos, 0, entry);
  let edge = entry.end;
  for (let k = pos + 1; k < mains.length; k++) {
    const e = mains[k];
    if (e.start >= edge - 1e-6) break;
    const shift = round1(edge - e.start);
    e.start = round1(e.start + shift);
    e.end = round1(e.end + shift);
    edge = e.end;
  }
  return { mains, index: pos };
}

/* 正片轨上第 index 段拖到备选轨 t 秒处：从正片轨拿掉（别的画面原地不动，留出空），放到备选轨 */
export function dropToAlt(items, index, t, dur) {
  const it = items[index];
  if (!it) return null;
  const mains = shotEntries(items).filter((_, k) => k !== index);
  const len = round1(Math.min(it.end, dur) - it.start);
  const s = round1(clamp(t, 0, Math.max(0, dur - len)));
  return { mains, alts: [{ assetId: it.assetId, start: s, end: round1(s + len) }] };
}
