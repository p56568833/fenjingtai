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

/* 原片范围（和剪辑软件一样）：裁剪只在这个范围里收放，裁掉的部分随时能拉回来，不会越裁越少。
   在线视频还没保存时只有地址里 #t=入,出 那一段；本地文件是整个文件，还不知道时长时结尾不设上限。 */
const sourceOf = it => {
  const m = String(it.asset?.path || '').match(/#t=([\d.]+),([\d.]+)/);
  const d = it.asset?.durationSec;
  const [from, to] = m && +m[2] > +m[1] ? [+m[1], +m[2]] : [0, Number.isFinite(d) && d > 0 ? d : Infinity];
  const clip = it.usage?.clip;
  const cin = Number.isFinite(clip?.in) ? clip.in : from;
  const usable = usableLength(it) ?? Math.max(MIN_LEN, it.end - it.start);
  // 已有片段落在范围外（旧数据）时把范围放宽到片段本身，不把它挤掉
  return { cin, usable, from: Math.min(from, cin), to: Math.max(to, cin + usable) };
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
    const min = video ? Math.max(lo, it.start - (src.cin - src.from)) : lo;
    const max = Math.min(oldEnd - MIN_LEN, video ? it.start + src.usable - MIN_LEN : Infinity);
    if (ceil1(min) > floor1(max)) return null;
    entry.start = round1(clamp(round1(value), ceil1(min), floor1(max)));
    entry.end = round1(oldEnd);
  } else {
    // 结尾最远拉到原片末尾，不凭空拉长；标了剪辑里补足（定格 / 放慢）的可以拉过去，片段本身不变
    const free = !video || it.usage?.fitDone;
    const max = Math.min(hi, free ? Infinity : Math.max(oldEnd, it.start + src.to - src.cin));
    if (ceil1(it.start + MIN_LEN) > floor1(max)) return null;
    entry.end = round1(clamp(round1(value), ceil1(it.start + MIN_LEN), floor1(max)));
  }
  const changed = Math.abs(entry.start - it.start) > 0.05 || Math.abs(entry.end - oldEnd) > 0.05;
  if (video && changed) {
    const cin = edge === 'start' ? Math.max(src.from, src.cin + entry.start - it.start) : src.cin;
    const endLimit = edge === 'start' ? src.cin + Math.min(src.usable, oldEnd - it.start) : src.to;
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
  const lo = Math.max(a.start + MIN_LEN, b.kind === 'video' ? b.start - (sb.cin - sb.from) : 0);
  const hi = Math.min(
    Math.min(b.end, dur) - MIN_LEN,
    a.kind === 'video' && !a.usage?.fitDone ? Math.max(a.end, a.start + sa.to - sa.cin) : dur,
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
