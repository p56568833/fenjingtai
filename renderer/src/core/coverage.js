/* 素材够不够盖住口播（纯函数，无 DOM、无应用状态）。每个上屏画面三个数：
   · 需要：它在这段口播里分到的秒数（core/shot-layout.js 排出来的那一段；超出口播的部分不算）
   · 可用：标出来的可用片段（使用记录上的 clip）的长度；没标 = 整个文件
   · 文件：本地文件的实际时长（asset.durationSec，界面读出来后记下）；在线视频还没保存时没有
   结论只拿「可用」和「需要」比：ok 够 / short 差多少 / unknown 时长还不知道 / still 图片（不限时长） */
import { LINK_RE } from './asset-model.js';

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
