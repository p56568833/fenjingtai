/* 镜头轨编辑：移动保持片段内容，插入换序保持各段时长，裁边同步视频入出点。
   所有计算只返回草稿，松手后由 app/ 一次提交。播放头不参与约束或吸附。 */
import { MIN_LEN, round1, usableLength } from './shot-layout.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(x, hi));
const ceil1 = x => Math.ceil((x - 1e-6) * 10) / 10;
const floor1 = x => Math.floor((x + 1e-6) * 10) / 10;
export const shotEntries = items =>
  items.map(it => ({
    assetId: it.assetId,
    start: round1(it.start),
    end: round1(Math.max(it.end, it.start + MIN_LEN)),
  }));

/* 前沿越过邻段的一半后换到它的另一边：被越过的画面原地不动，拖的这段紧挨着放到它另一边（鼠标拖得更远、那边有空时放在鼠标处）。
   那边的空不够放下时，被越过的画面才往拖走后空出来的位置挪，挪到刚好放得下为止。各段长度都不变。 */
export function movePicture(items, index, start, dur) {
  const entries = shotEntries(items);
  const original = entries[index];
  if (!original || original.start >= dur) return null;
  const len = round1(Math.min(original.end, dur) - original.start);
  // 拖的这段前沿越过邻段的一半就换过去（往右看右边沿，往左看左边沿）
  const mid = k => (items[k].start + Math.min(items[k].end, dur)) / 2;
  let dest = index;
  while (dest + 1 < items.length && items[dest + 1].start < dur && start + len > mid(dest + 1)) dest++;
  if (dest === index) while (dest > 0 && start < mid(dest - 1)) dest--;
  // 拖走后它原来那段的左右边界（被越过的画面最多挪到这里）
  const lo = index ? Math.min(entries[index - 1].end, dur) : 0;
  const hi = index + 1 < entries.length ? Math.min(entries[index + 1].start, dur) : dur;
  if (dest === index) {
    original.start = round1(clamp(round1(start), ceil1(lo), floor1(hi - len)));
    original.end = round1(original.start + len);
  } else if (dest > index) {
    // 往右越过 index+1 … dest：放在 dest 的右边，到下一段（或口播末尾）之前
    const crossed = entries.slice(index + 1, dest + 1);
    const limit = dest + 1 < entries.length ? Math.min(entries[dest + 1].start, dur) : dur;
    const shift = round1(clamp(entries[dest].end + len - limit, 0, crossed[0].start - lo));
    for (const e of crossed) {
      e.start = round1(e.start - shift);
      e.end = round1(e.end - shift);
    }
    original.start = round1(clamp(round1(start), entries[dest].end, Math.max(entries[dest].end, limit - len)));
    original.end = round1(original.start + len);
    entries.splice(index, 1);
    entries.splice(dest, 0, original);
  } else {
    // 往左越过 dest … index-1：放在 dest 的左边，上一段（或开头）之后
    const crossed = entries.slice(dest, index);
    const limit = dest ? Math.min(entries[dest - 1].end, dur) : 0;
    const shift = round1(clamp(limit + len - entries[dest].start, 0, hi - Math.min(crossed.at(-1).end, dur)));
    for (const e of crossed) {
      e.start = round1(e.start + shift);
      e.end = round1(e.end + shift);
    }
    const end = clamp(round1(start + len), Math.min(entries[dest].start, limit + len), entries[dest].start);
    original.start = round1(end - len);
    original.end = round1(end);
    entries.splice(index, 1);
    entries.splice(dest, 0, original);
  }
  const before = shotEntries(items);
  const changed = entries.some(
    (e, n) => e.assetId !== before[n].assetId || e.start !== before[n].start || e.end !== before[n].end,
  );
  return { entries, changed, reordered: dest !== index, index: dest, ...entries[dest] };
}

const sourceOf = it => {
  const cin = it.usage?.clip?.in || 0;
  const usable = usableLength(it);
  const duration = it.asset?.durationSec;
  // 已知原片长度时允许把裁掉的内容拉回来；不知道长度时止于已知片段末尾。
  const limit =
    Number.isFinite(duration) && duration > cin ? duration : cin + (usable ?? Math.max(MIN_LEN, it.end - it.start));
  return { cin, usable: usable ?? Math.max(MIN_LEN, it.end - it.start), limit };
};

export function trimPicture(items, index, edge, value, dur) {
  const it = items[index];
  if (!it || it.start >= dur) return null;
  const entries = shotEntries(items);
  const entry = entries[index];
  const oldEnd = Math.min(it.end, dur);
  const lo = index ? Math.min(items[index - 1].end, dur) : 0;
  const hi = index + 1 < items.length ? Math.min(items[index + 1].start, dur) : dur;
  const video = it.kind === 'video';
  const src = sourceOf(it);
  if (edge === 'start') {
    const min = video ? Math.max(lo, it.start - src.cin) : lo;
    const max = Math.min(oldEnd - MIN_LEN, video ? it.start + src.usable - MIN_LEN : Infinity);
    if (ceil1(min) > floor1(max)) return null;
    entry.start = round1(clamp(round1(value), ceil1(min), floor1(max)));
    entry.end = round1(oldEnd);
  } else {
    const max = Math.min(hi, video ? Math.max(oldEnd, it.start + src.limit - src.cin) : Infinity);
    if (ceil1(it.start + MIN_LEN) > floor1(max)) return null;
    entry.end = round1(clamp(round1(value), ceil1(it.start + MIN_LEN), floor1(max)));
  }
  const changed = Math.abs(entry.start - it.start) > 0.05 || Math.abs(entry.end - oldEnd) > 0.05;
  if (video && changed) {
    const cin = edge === 'start' ? Math.max(0, src.cin + entry.start - it.start) : src.cin;
    const endLimit = edge === 'start' ? src.cin + Math.min(src.usable, oldEnd - it.start) : src.limit;
    entry.clip = {
      in: round1(cin),
      out: round1(Math.min(endLimit, cin + entry.end - entry.start)),
      ...(it.usage?.clip?.needsAdjust ? { needsAdjust: true } : {}),
    };
  }
  return { entries, changed, ...entry };
}

/* Shift 拖相接的边：同时裁左右两段，外侧边和整段口播长度保持不动。 */
export function rollPictures(items, index, value, dur) {
  const a = items[index],
    b = items[index + 1];
  if (!a || !b || Math.abs(a.end - b.start) > 0.05) return null;
  const sa = sourceOf(a),
    sb = sourceOf(b);
  const lo = Math.max(a.start + MIN_LEN, b.kind === 'video' ? b.start - sb.cin : 0);
  const hi = Math.min(
    Math.min(b.end, dur) - MIN_LEN,
    a.kind === 'video' ? Math.max(a.end, a.start + sa.limit - sa.cin) : dur,
    b.kind === 'video' ? b.start + sb.usable - MIN_LEN : dur,
  );
  if (ceil1(lo) > floor1(hi)) return null;
  const cut = round1(clamp(round1(value), ceil1(lo), floor1(hi)));
  const room = items.map((it, n) => ({
    ...it,
    ...(n === index ? { end: cut } : n === index + 1 ? { start: cut } : {}),
  }));
  const left = trimPicture(
    items.map((it, n) => (n === index + 1 ? { ...it, start: cut } : it)),
    index,
    'end',
    cut,
    dur,
  );
  const right = trimPicture(
    items.map((it, n) => (n === index ? { ...it, end: cut } : it)),
    index + 1,
    'start',
    cut,
    dur,
  );
  if (!left || !right) return null;
  const entries = shotEntries(room);
  entries[index] = left.entries[index];
  entries[index + 1] = right.entries[index + 1];
  return { entries, changed: left.changed || right.changed, cut, ...entries[index] };
}
