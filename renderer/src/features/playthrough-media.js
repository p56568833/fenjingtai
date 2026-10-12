/* 预览的两帧交接：当前素材播放时，下一段提前加载并定位到入点。
   解出新帧才撤掉上一帧；不靠定时器强行显示尚未就绪的视频。
   只保留当前、交接中的上一段和下一段，关闭或跳转时释放多余的解码器。 */
import { fileUrl } from '../core/asset-model.js';

export function createPreviewMedia(stage) {
  const records = new Map();
  let wanted = '';
  let visible = '';
  let next = '';
  let onError = null;

  function dispose(key) {
    const rec = records.get(key);
    if (!rec) return;
    records.delete(key);
    rec.dead = true;
    rec.events.abort();
    if (rec.el instanceof HTMLVideoElement) {
      rec.el.pause();
      rec.el.removeAttribute('src');
      rec.el.load();
    }
    rec.el.remove();
  }

  function prune() {
    for (const key of records.keys()) if (key !== wanted && key !== visible && key !== next) dispose(key);
  }

  function reveal(rec) {
    if (rec.dead || !rec.ready || wanted !== rec.key) return;
    visible = rec.key;
    for (const other of records.values()) if (other !== rec) other.el.classList.add('pt-pending');
    rec.el.classList.remove('pt-pending');
    for (const child of [...stage.children]) if (![...records.values()].some(r => r.el === child)) child.remove();
    prune();
  }

  function decoded(rec) {
    if (rec.dead || rec.el.seeking || rec.el.readyState < 2) return;
    rec.ready = true;
    rec.el.dataset.previewReady = 'true';
    reveal(rec);
  }

  // loadeddata / seeked + HAVE_CURRENT_DATA 确认目标帧已经解码。
  // 暂停且透明的预加载视频不会提交绘制帧，不能等 requestVideoFrameCallback 才认就绪。
  const videoReady = rec => decoded(rec);

  function prepare(key, item) {
    if (records.has(key)) return records.get(key);
    const el = document.createElement(item.kind === 'video' ? 'video' : 'img');
    el.className = 'pt-media pt-pending';
    el.dataset.previewKey = key;
    const rec = {
      key,
      el,
      ready: false,
      failed: false,
      dead: false,
      target: item.usage.clip?.in || 0,
      events: new AbortController(),
    };
    records.set(key, rec);
    const listen = (name, fn) => el.addEventListener(name, fn, { signal: rec.events.signal });
    listen('error', () => {
      rec.failed = true;
      if (wanted === key) onError?.();
    });
    if (item.kind === 'video') {
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.dataset.in = String(item.usage.clip?.in || 0);
      el.dataset.out = String(item.usage.clip?.out ?? '');
      listen('loadedmetadata', () => {
        const target = Math.min(rec.target, Math.max(0, el.duration - 0.04));
        if (Math.abs(el.currentTime - target) > 0.001) el.currentTime = target;
        videoReady(rec);
      });
      listen('seeking', () => {
        rec.ready = false;
        el.dataset.previewReady = 'false';
      });
      listen('loadeddata', () => videoReady(rec));
      listen('seeked', () => videoReady(rec));
    } else {
      listen('load', async () => {
        try {
          await el.decode();
          if (rec.dead) return;
          rec.ready = true;
          el.dataset.previewReady = 'true';
          reveal(rec);
        } catch {
          rec.failed = true;
          if (!rec.dead && wanted === key) onError?.();
        }
      });
    }
    stage.append(el);
    el.src = fileUrl(item.asset.path);
    return rec;
  }

  return {
    show(key, item, target, failed) {
      records.get(visible)?.el.pause?.();
      wanted = key;
      if (next === key) next = '';
      onError = failed;
      const rec = prepare(key, item);
      rec.target = target;
      if (rec.failed) failed();
      else if (item.kind === 'image') reveal(rec);
      else if (rec.el.readyState >= 1) {
        if (Math.abs(rec.el.currentTime - target) > 0.04) {
          rec.ready = false;
          rec.el.currentTime = target;
        } else if (rec.ready) reveal(rec);
        else videoReady(rec);
      }
      prune();
      return rec.el;
    },
    prefetch(key, item) {
      next = key || '';
      prune();
      if (item) prepare(key, item);
    },
    clear() {
      wanted = visible = next = '';
      onError = null;
      for (const key of records.keys()) dispose(key);
      stage.replaceChildren();
    },
  };
}
