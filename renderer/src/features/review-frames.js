/* 审核截图组件：截图条（.vr-strip）的结构、排队截图、缓存和填图都在这里；
   审核页只负责把 stripHTML() 放进卡片、渲染后调 paintStrips。 */
import { state } from '../app/state.js';
import { fileUrl } from '../core/asset-model.js';
import { fmtTime } from '../core/text.js';
import { cleanBest, playableUrl } from '../core/candidate-values.js';
import { loadMetadata, seekVideoFrame, drawVideoFrame, releaseMedia, withDecodeSlot } from '../ui/base/media.js';
const frames = new Map();
const queue = [];
const active = new Map();
let running = 0;
/* 从精选段开头到结尾均匀抽几帧：4 秒以内的短片段 3 帧，长一点的 6 帧（再多就几乎一样了）；审核页排成每行 3 张 */
const cellsFor = c => (Math.max(0, c.out - c.in) <= 4 ? 3 : 6);
/* n：截几张，不写就按片段长短；待返工页否掉的候选只要 1 张当封面 */
export const stripHTML = (c, n = cellsFor(previewOf(c))) =>
  `<div class="vr-strip" data-n="${n}">${'<div class="vr-cell ld">载入中…</div>'.repeat(n)}</div>`;
const stripOf = job => (job.host.isConnected ? job.host.querySelector(`[data-vr-id="${job.c.id}"] .vr-strip`) : null);
/* 渲染后把截图放进卡片：截过的直接放，没截的排队去截 */
export function paintStrips(host, cands) {
  for (const c of cands) {
    const strip = host.querySelector(`[data-vr-id="${c.id}"] .vr-strip`);
    if (!strip) continue;
    const n = +strip.dataset.n || cellsFor(previewOf(c));
    const got = getFrames(c, n);
    if (got && got.length) strip.replaceChildren(...got.map(x => x.cell));
    else queueFrames(c, host, n);
  }
}
const signature = (c, n) => JSON.stringify([state.projectId, c.url, c.in, c.out, c.savedPath || '', n]);
const getFrames = (c, n) => {
  const cached = frames.get(c.id);
  return cached?.signature === signature(c, n) ? cached.cells : null;
};
export function forgetFrames(ids) {
  for (const id of ids) {
    frames.delete(id);
    active.get(id)?.abort();
  }
  for (let i = queue.length - 1; i >= 0; i--) if (ids.has(queue[i].c.id)) queue.splice(i, 1);
}
export function clearReviewFrames() {
  forgetFrames(new Set([...frames.keys(), ...active.keys(), ...queue.map(q => q.c.id)]));
}
export function retainFrames(candidates) {
  const ids = new Set(candidates.map(c => c.id));
  for (const [id, controller] of active) if (!ids.has(id)) controller.abort();
  for (let i = queue.length - 1; i >= 0; i--) if (!ids.has(queue[i].c.id)) queue.splice(i, 1);
}
/* 审核页自己最多排两个截图任务（还要和全应用共用 withDecodeSlot 的名额）；任务绑定项目和素材内容，换项目 / 更新候选就取消旧结果。 */
function queueFrames(c, host, n) {
  const sig = signature(c, n);
  if (getFrames(c, n) || queue.some(q => q.c.id === c.id && q.signature === sig)) return;
  if (active.has(c.id)) active.get(c.id).abort();
  queue.push({ host, c: { ...c }, n, signature: sig, projectId: state.projectId });
  pump();
}
function pump() {
  while (running < 2 && queue.length) {
    const job = queue.shift();
    const controller = new AbortController();
    active.set(job.c.id, controller);
    running++;
    withDecodeSlot(() => grab(job, controller.signal)).finally(() => {
      if (active.get(job.c.id) === controller) active.delete(job.c.id);
      running--;
      pump();
    });
  }
}
async function grab(job, signal) {
  const orig = job.c;
  let c = previewOf(orig); // 截图和播放一样，只截真正要用的那几秒
  const cells = [];
  const cached = { signature: job.signature, cells };
  const valid = () =>
    !signal.aborted &&
    state.projectId === job.projectId &&
    state.candidates.some(x => x.id === orig.id && signature(x, job.n) === job.signature);
  if (!valid()) return;
  frames.set(orig.id, cached);
  while (frames.size > 60) frames.delete(frames.keys().next().value);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  const load = async source => {
    const ready = loadMetadata(v, 30000, { signal });
    v.src = playableUrl(source);
    await ready;
  };
  try {
    try {
      await load(c.url);
    } catch (error) {
      if (!c.local || !valid()) throw error;
      c = previewOf({ ...orig, savedPath: '' });
      await load(c.url);
    }
    if (Number.isFinite(v.duration) && c.in >= v.duration - 0.05)
      throw Object.assign(new Error('入出点超出视频长度'), { outOfRange: v.duration });
    const n = job.n;
    for (let i = 0; i < n && valid(); i++) {
      const t = c.in + (Math.max(0, c.out - c.in) * (i + 0.5)) / n;
      cells.push({ cell: await frameAt(v, t, fmtTime(t + (c.local ? orig.in : 0)), signal, t - c.in) });
      if (!valid()) break;
      stripOf(job)?.replaceChildren(
        ...cells.map(x => x.cell),
        ...Array.from({ length: n - cells.length }, () => loadingCell()),
      );
    }
  } catch (error) {
    if (valid()) {
      const strip = stripOf(job);
      if (strip)
        strip.innerHTML = error?.outOfRange
          ? `<div class="vr-cell fail">入出点 ${fmtTime(c.in)}–${fmtTime(c.out)} 超出了这个视频的长度（${fmtTime(error.outOfRange)}）：清单里的时间写错了，点「不要」并在意见里写明，让 AI 改</div>`
          : '<div class="vr-cell fail">截图失败（网站不让读或网络不通），可以直接播放看看</div>';
    }
    if (frames.get(orig.id) === cached) frames.delete(orig.id);
  } finally {
    if (!valid() && frames.get(orig.id) === cached) frames.delete(orig.id);
    releaseMedia(v);
  }
}
async function frameAt(v, t, label, signal, rel) {
  await seekVideoFrame(v, t, { signal });
  const cv = drawVideoFrame(v);
  const cell = document.createElement('div');
  cell.className = 'vr-cell';
  // 点这张就从这里开始播（片段里的第几秒）
  cell.dataset.vrAt = rel.toFixed(2);
  cell.title = `从 ${label} 开始播放`;
  const tag = document.createElement('i');
  tag.textContent = label;
  cell.append(cv, tag);
  return cell;
}

function loadingCell(text = '载入中…') {
  const d = document.createElement('div');
  d.className = 'vr-cell ld';
  d.textContent = text;
  return d;
}
/* 播放 / 截图用的片段：已经保存到本地的直接用本地文件（秒开、不用联网），本地片段从 0 秒开始；
   没保存的用在线地址的建议入出点 */
/* 预览播放只放真正要用的那几秒（精选段），前后的下载余量不放：入出点换成精选段 */
export const previewOf = c => {
  const m = mediaOf(c);
  const b = cleanBest(c?.best, c?.in, c?.out);
  if (!b) return m;
  const off = m.local ? c.in : 0;
  const span = { in: b.in - off, out: b.out - off };
  return { ...m, ...span, best: span };
};
export const mediaOf = c =>
  c?.savedPath ? { ...c, url: fileUrl(c.savedPath), in: 0, out: Math.max(0.1, c.out - c.in), local: true } : c;
