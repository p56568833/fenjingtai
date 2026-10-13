/* 共用媒体服务：元数据、解帧、缩略图、超时和释放。页面只负责把结果放进自己的 DOM。 */
import { LINK_RE, kindOf, fileUrl } from '../../core/asset-model.js';
import * as native from '../../platform/native.js';

export function releaseMedia(el) {
  el.removeAttribute('src');
  try {
    el.load();
  } catch {}
}
function waitMedia(el, event, timeoutMs, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const clean = () => {
      clearTimeout(timer);
      el.removeEventListener(event, success);
      el.removeEventListener('error', failure);
      signal?.removeEventListener('abort', aborted);
    };
    const success = () => {
      clean();
      resolve();
    };
    const failure = () => {
      clean();
      reject(new Error('媒体读取失败'));
    };
    const aborted = () => {
      clean();
      reject(new Error('媒体任务已取消'));
    };
    if (signal?.aborted) return aborted();
    el.addEventListener(event, success, { once: true });
    el.addEventListener('error', failure, { once: true });
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => {
      clean();
      reject(new Error('媒体读取超时'));
    }, timeoutMs);
  });
}
export const loadMetadata = (el, timeoutMs = 15000, options = {}) =>
  waitMedia(el, 'loadedmetadata', timeoutMs, options);
export async function seekVideoFrame(el, seconds, { timeoutMs = 15000, signal } = {}) {
  const at = Math.max(0, Number.isFinite(el.duration) ? Math.min(seconds, Math.max(0, el.duration - 0.001)) : seconds);
  if (Math.abs(el.currentTime - at) < 0.001 && el.readyState >= 2) return;
  // 先订阅再 seek，避免同步完成或极短片段漏掉事件。
  const ready = waitMedia(el, 'seeked', timeoutMs, { signal });
  el.currentTime = at;
  await ready;
  if (signal?.aborted) throw new Error('媒体任务已取消');
  // seeked 之后留一帧让解码结果提交；无需常驻回调和迟后的超时。
  await new Promise(resolve => setTimeout(resolve, 60));
  if (signal?.aborted) throw new Error('媒体任务已取消');
}
export function drawVideoFrame(el) {
  if (!el.videoWidth || !el.videoHeight) throw new Error('视频没有可用画面');
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = Math.round((320 * el.videoHeight) / el.videoWidth) || 180;
  canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
  return canvas;
}
export async function probeDuration(path, timeoutMs = 4000) {
  if (!path || LINK_RE.test(path)) return null;
  const kind = kindOf(path);
  if (kind !== 'video' && kind !== 'audio') return null;
  const el = document.createElement(kind);
  el.preload = 'metadata';
  try {
    const ready = loadMetadata(el, timeoutMs);
    el.src = fileUrl(path);
    await ready;
    return Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
  } catch {
    return null;
  } finally {
    releaseMedia(el);
  }
}

/* 按地址合并并发请求、限制解码数与缓存量；表格和审核页共用同一个队列。 */
/* 全应用同时解码的视频数上限：表格缩略图、在线抽帧、审核页截图各有自己的队列，
   但都要先拿到这里的名额，合起来不超过 MAX_DECODES，长稿 + 审核页同时开也不会把机器拖慢 */
const MAX_DECODES = 4;
let decoding = 0;
const waiting = [];
export async function withDecodeSlot(task) {
  if (decoding >= MAX_DECODES) await new Promise(resolve => waiting.push(resolve));
  else decoding++;
  try {
    return await task();
  } finally {
    // 直接把名额交给队首；被唤醒的任务恢复前，新任务不能抢走这个名额。
    const next = waiting.shift();
    if (next) next();
    else decoding--;
  }
}

function mediaQueue(limit, keep, decode) {
  const cache = new Map(),
    pending = new Map(),
    queue = [];
  let running = 0,
    epoch = 0;
  const pump = () => {
    while (running < limit && queue.length) {
      const job = queue.shift();
      running++;
      Promise.resolve()
        .then(() => withDecodeSlot(() => decode(job.path)))
        .catch(() => null)
        .then(result => {
          if (job.epoch === epoch && pending.get(job.path) === job.promise) {
            pending.delete(job.path);
            if (result) {
              cache.delete(job.path);
              cache.set(job.path, result);
              while (cache.size > keep) cache.delete(cache.keys().next().value);
            }
          }
          job.resolve(result);
        })
        .finally(() => {
          running--;
          pump();
        });
    }
  };
  return {
    get(path) {
      if (cache.has(path)) {
        const result = cache.get(path);
        cache.delete(path);
        cache.set(path, result);
        return Promise.resolve(result);
      }
      if (!pending.has(path)) {
        let resolve;
        const promise = new Promise(r => {
          resolve = r;
        });
        pending.set(path, promise);
        queue.push({ path, promise, resolve, epoch });
        pump();
      }
      return pending.get(path);
    },
    invalidate(path) {
      cache.delete(path);
      pending.delete(path);
    },
    clear() {
      epoch++;
      cache.clear();
      pending.clear();
      for (const job of queue.splice(0)) job.resolve(null);
    },
  };
}
const previews = new Map();
export function preview(path, { force = false } = {}) {
  if (force) previews.delete(path);
  if (!previews.has(path)) {
    if (previews.size >= 40) previews.delete(previews.keys().next().value);
    previews.set(
      path,
      Promise.resolve(native.previewImage(path)).catch(() => null),
    );
  }
  return previews.get(path);
}
async function grabFrame(path, remote) {
  const el = document.createElement('video');
  el.muted = true;
  el.preload = 'auto';
  try {
    const ready = loadMetadata(el, remote ? 20000 : 15000);
    el.src = remote ? path.split('#')[0] : fileUrl(path);
    await ready;
    const time = remote
      ? (Number((path.match(/#t=([\d.]+)/) || [])[1]) || 0) + 0.5
      : Math.min(1, el.duration * 0.1) || 0.1;
    await seekVideoFrame(el, time);
    const frame = drawVideoFrame(el);
    return remote ? frame : frame.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  } finally {
    releaseMedia(el);
  }
}
const localFrames = mediaQueue(3, 60, path => grabFrame(path, false));
const remoteFrames = mediaQueue(2, 40, path => grabFrame(path, true));
export const remoteVideoFrame = path => remoteFrames.get(path);
export const videoFrame = path => localFrames.get(path).then(frame => frame || preview(path));
export function invalidateVideoFrame(path) {
  localFrames.invalidate(path);
  remoteFrames.invalidate(path);
  previews.delete(path);
}
export function clearPreviewCache() {
  localFrames.clear();
  remoteFrames.clear();
  previews.clear();
}
