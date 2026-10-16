/* 审核截图组件：截图条（.vr-strip）的结构、排队截图、缓存和填图都在这里；
   审核页只负责把 stripHTML() 放进卡片、渲染后调 paintStrips。 */
import { state } from '../app/state.js';
import { fileUrl } from '../core/asset-model.js';
import { fmtTime } from '../core/text.js';
import {
  loadMetadata,
  seekVideoFrame,
  drawVideoFrame,
  releaseMedia,
  videoFrame,
  withDecodeSlot,
} from '../ui/base/media.js';
const frames = new Map();
const queue = [];
const active = new Map();
let running = 0;
const CELLS = 9; // 从片段开头到结尾均匀抽 9 帧，审核页排成 3×3
export const stripHTML = () => `<div class="vr-strip">${'<div class="vr-cell ld">载入中…</div>'.repeat(CELLS)}</div>`;
const stripOf = job => (job.host.isConnected ? job.host.querySelector(`[data-vr-id="${job.c.id}"] .vr-strip`) : null);
/* 渲染后把截图放进卡片：截过的直接放，没截的排队去截 */
export function paintStrips(host, cands) {
  for (const c of cands) {
    const strip = host.querySelector(`[data-vr-id="${c.id}"] .vr-strip`);
    if (!strip) continue;
    const got = getFrames(c);
    if (got && got.length) strip.replaceChildren(...got.map(x => x.cell));
    else queueFrames(c, host);
  }
}
const signature = c => JSON.stringify([state.projectId, c.url, c.in, c.out, c.savedPath || '']);
const getFrames = c => {
  const cached = frames.get(c.id);
  return cached?.signature === signature(c) ? cached.cells : null;
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
function queueFrames(c, host) {
  const sig = signature(c);
  if (getFrames(c) || queue.some(q => q.c.id === c.id && q.signature === sig)) return;
  if (active.has(c.id)) active.get(c.id).abort();
  queue.push({ host, c: { ...c }, signature: sig, projectId: state.projectId });
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
  let c = mediaOf(orig);
  const cells = [];
  const cached = { signature: job.signature, cells };
  const valid = () =>
    !signal.aborted &&
    state.projectId === job.projectId &&
    state.candidates.some(x => x.id === orig.id && signature(x) === job.signature);
  if (!valid()) return;
  frames.set(orig.id, cached);
  while (frames.size > 60) frames.delete(frames.keys().next().value);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  const load = async source => {
    const ready = loadMetadata(v, 30000, { signal });
    v.src = source.split('#')[0];
    await ready;
  };
  try {
    try {
      await load(c.url);
    } catch (error) {
      if (!c.local || !valid()) throw error;
      c = orig;
      await load(c.url);
    }
    if (Number.isFinite(v.duration) && c.in >= v.duration - 0.05)
      throw Object.assign(new Error('入出点超出视频长度'), { outOfRange: v.duration });
    for (let i = 0; i < CELLS && valid(); i++) {
      const t = c.in + (Math.max(0, c.out - c.in) * (i + 0.5)) / CELLS;
      cells.push({ cell: await frameAt(v, t, fmtTime(t - c.in + orig.in), signal, t - c.in) });
      if (!valid()) break;
      stripOf(job)?.replaceChildren(
        ...cells.map(x => x.cell),
        ...Array.from({ length: CELLS - cells.length }, () => loadingCell()),
      );
    }
  } catch (error) {
    if (valid()) {
      const strip = stripOf(job);
      if (strip)
        strip.innerHTML = error?.outOfRange
          ? `<div class="vr-cell fail">入出点 ${fmtTime(c.in)}–${fmtTime(c.out)} 超出了这个视频的长度（${fmtTime(error.outOfRange)}）：清单里的时间写错了，点「换一个」让 AI 改</div>`
          : '<div class="vr-cell fail">截图失败（网站不让读或网络不通），点「播放这段」直接看</div>';
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

/* 已通过那一行的小图：自己从视频里解一帧（macOS 系统缩略图常给的是默认播放器的图标，比如 B 站） */
export function paintDoneThumb(c, host) {
  const path = c.savedPath;
  const projectId = state.projectId;
  videoFrame(path).then(url => {
    const cell = host.querySelector(`.vr-done[data-vr-id="${c.id}"] .vr-done-thumbs .vr-cell`);
    const cur = state.candidates.find(x => x.id === c.id);
    if (!host.isConnected || !cell || state.projectId !== projectId || cur?.savedPath !== path) return; // 换了画面 / 片段被换掉：这张不用了
    if (!url) {
      cell.textContent = '没有缩略图';
      return;
    }
    const img = document.createElement('img');
    img.alt = '';
    img.src = url;
    cell.classList.remove('ld');
    cell.replaceChildren(img);
  });
}
function loadingCell(text = '载入中…') {
  const d = document.createElement('div');
  d.className = 'vr-cell ld';
  d.textContent = text;
  return d;
}
/* 播放 / 截图用的片段：已经保存到本地的直接用本地文件（秒开、不用联网），本地片段从 0 秒开始；
   没保存的用在线地址的建议入出点 */
export const mediaOf = c =>
  c?.savedPath ? { ...c, url: fileUrl(c.savedPath), in: 0, out: Math.max(0.1, c.out - c.in), local: true } : c;
