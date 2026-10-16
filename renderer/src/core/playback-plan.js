/* 播放与时间轨共用的画面排布和停顿规则，只接受项目与时间轴。 */
import { shots } from './shots.js';
import { spanOf } from './timeline.js';
import { layoutShot, itemAt } from './shot-layout.js';
export function buildPlaybackUnits(project, tl) {
  return shots(project.rows)
    .map(members => {
      const layout = layoutShot(project.assets || {}, members, tl);
      const span = layout ||
        spanOf(
          tl,
          members.map(r => r.id),
        ) || { start: 0, end: 0 };
      return { members, start: span.start, end: span.end, layout };
    })
    .filter(u => u.end > u.start);
}
/* 镜头里此刻正在说的那句；句间停顿算刚说完的那句（不跳回镜头第一句） */
export function rowAtIn(u, t, tl) {
  return u.members.findLast(x => (tl.times.get(x.id)?.start ?? Infinity) <= t + 1e-6) || u.members[0];
}

export function previewItem(u, t, tl) {
  const layout = u?.layout;
  if (!layout) return null;
  const rel = t - u.start;
  const item = itemAt(layout, rel);
  if (item) return item;
  const prev = layout.items.findLast(it => it.end <= rel + 1e-6);
  const last = layout.items.at(-1);
  // 手动时间精确到 0.1 秒，字幕精确到毫秒：镜头末尾的舍入误差也延续末帧。
  if (last && last.start <= rel + 1e-6 && rel >= layout.dur - 0.05 && last.end >= layout.dur - 0.05) return last;
  if (layout.timed || !prev) return null;
  const next = layout.items.find(it => it.start > rel);
  return next && heldThrough(u, prev, next, tl) ? prev : null;
}

/* 按句子排时，prev 和 next 之间的空当没人说话（句间停顿）：prev 一直延续到 next 出现 */
export function heldThrough(u, prev, next, tl) {
  if (u.layout.timed || next.start <= prev.end + 1e-6) return false;
  return !u.members.some(r => {
    const tm = tl.times.get(r.id);
    return tm && tm.start < u.start + next.start - 1e-6 && tm.end > u.start + prev.end + 1e-6;
  });
}
