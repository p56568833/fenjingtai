/* 审核截图组件：队列、缓存与截图展示独立于审核数据操作。 */
import { state } from '../app/state.js';
import { fileUrl } from '../core/asset-model.js';
import { fmtTime } from '../core/text.js';
import { loadMetadata, seekVideoFrame, drawVideoFrame, releaseMedia, videoFrame } from '../ui/media.js';
const frames = new Map();
const queue = [];
const active = new Map();
let running = 0;
const signature = c => JSON.stringify([state.projectId, c.url, c.in, c.out, c.savedPath || '']);
export const getFrames = c => {
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
/* 同时最多解码两个视频；任务绑定项目和素材内容，换项目 / 更新候选就取消旧结果。 */
export function queueFrames(c) {
  const sig = signature(c);
  if (getFrames(c) || queue.some(q => q.c.id === c.id && q.signature === sig)) return;
  if (active.has(c.id)) active.get(c.id).abort();
  queue.push({ c: { ...c }, signature: sig, projectId: state.projectId });
  pump();
}
function pump() {
  while (running < 2 && queue.length) {
    const job = queue.shift();
    const controller = new AbortController();
    active.set(job.c.id, controller);
    running++;
    grab(job, controller.signal).finally(() => {
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
    for (let i = 0; i < 6 && valid(); i++) {
      const t = c.in + (Math.max(0, c.out - c.in) * (i + 0.5)) / 6;
      cells.push({ cell: await frameAt(v, t, fmtTime(t - c.in + orig.in), signal) });
      if (!valid()) break;
      document
        .querySelector(`[data-vr-id="${orig.id}"] .vr-strip`)
        ?.replaceChildren(...cells.map(x => x.cell), ...Array.from({ length: 6 - cells.length }, () => loadingCell()));
    }
  } catch {
    if (valid()) {
      const strip = document.querySelector(`[data-vr-id="${orig.id}"] .vr-strip`);
      if (strip)
        strip.innerHTML = '<div class="vr-cell fail">截图失败（网站不让读或网络不通），点「播放这段」直接看</div>';
    }
    if (frames.get(orig.id) === cached) frames.delete(orig.id);
  } finally {
    if (!valid() && frames.get(orig.id) === cached) frames.delete(orig.id);
    releaseMedia(v);
  }
}
async function frameAt(v, t, label, signal) {
  await seekVideoFrame(v, t, { signal });
  const cv = drawVideoFrame(v);
  const cell = document.createElement('div');
  cell.className = 'vr-cell';
  const tag = document.createElement('i');
  tag.textContent = label;
  cell.append(cv, tag);
  return cell;
}

/* 已通过那一行的小图：自己从视频里解一帧（macOS 系统缩略图常给的是默认播放器的图标，比如 B 站） */
export function paintDoneThumb(c) {
  const path = c.savedPath;
  const projectId = state.projectId;
  videoFrame(path).then(url => {
    const cell = document.querySelector(`#vrList .vr-done[data-vr-id="${c.id}"] .vr-done-thumbs .vr-cell`);
    const cur = state.candidates.find(x => x.id === c.id);
    if (!cell || state.projectId !== projectId || cur?.savedPath !== path) return; // 换了画面 / 片段被换掉：这张不用了
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
