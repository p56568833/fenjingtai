/* 媒体小工具：探测音视频真实时长（重定位素材、导入口播音频时用） */
import { LINK_RE, kindOf, fileUrl } from '../core/asset-model.js';

export function probeDuration(path, timeoutMs = 4000) {
  return new Promise(resolve => {
    if (!path || LINK_RE.test(path)) return resolve(null);
    const kind = kindOf(path);
    if (kind !== 'video' && kind !== 'audio') return resolve(null);
    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.preload = 'metadata';
    const done = v => {
      clearTimeout(timer);
      el.removeAttribute('src');
      try {
        el.load();
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    el.addEventListener('loadedmetadata', () => done(isFinite(el.duration) ? el.duration : null));
    el.addEventListener('error', () => done(null));
    el.src = fileUrl(path);
  });
}
