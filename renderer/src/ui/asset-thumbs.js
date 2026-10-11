/* 缩略图懒加载：成功放图；失败分三态（无缩略图 / 格式不支持 / 文件失联），可重试，不无限转圈。
   容器由 asset-html.js 的 thumbHTML 生成（.asset-thumb[data-preview-path]）。 */
import { probePaths, isMissing } from '../app/asset-actions.js';
import { assetName as baseName, LINK_RE } from '../core/asset-model.js';
import { preview, videoFrame, remoteVideoFrame, invalidateVideoFrame } from './base/media.js';

function thumbPlaceholder(el, path, kind, missing) {
  el.replaceChildren();
  el.classList.remove('thumb-missing', 'thumb-unsupported', 'thumb-nopreview');
  if (missing) {
    el.classList.add('thumb-missing');
    el.textContent = '文件失联';
    return;
  }
  if (!kind || kind === 'doc' || kind === 'link') {
    el.classList.add('thumb-unsupported');
    el.textContent = kind === 'link' ? '链接' : '格式不支持';
    return;
  }
  el.classList.add('thumb-nopreview');
  const label = document.createElement('span');
  label.textContent = '无缩略图';
  const retry = document.createElement('button');
  retry.className = 'thumb-retry';
  retry.dataset.thumbRetry = path;
  retry.textContent = '重试';
  retry.title = '重新生成缩略图';
  el.append(label, retry);
}

/* 在线视频（视频审核通过、还没保存到本地）：直接从网上取片段入点那一帧当缩略图，不下载文件。
   取到的帧按地址缓存（表格每次重画不再重新联网），同时最多取 2 个。
   跨域视频画到 canvas 上后不能导出成图片，所以缓存的是 canvas 本身，用时再画一份 */
function paintRemote(el, path, src) {
  if (!el.isConnected || el.dataset.previewPath !== path) return;
  if (!src) {
    el.classList.add('thumb-nopreview');
    el.textContent = '在线视频';
    return;
  }
  const cv = document.createElement('canvas');
  cv.width = src.width;
  cv.height = src.height;
  try {
    cv.getContext('2d').drawImage(src, 0, 0);
  } catch {}
  const play = document.createElement('span');
  play.className = 'video-play';
  play.textContent = '▶';
  const tag = document.createElement('span');
  tag.className = 'thumb-online';
  tag.textContent = '在线';
  el.replaceChildren(cv, play, tag);
}
function remoteVideoThumb(el, path) {
  if (el.querySelector('canvas')) return;
  el.textContent = '…';
  remoteVideoFrame(path).then(frame => paintRemote(el, path, frame));
}

/* 本地视频：自己解一帧当缩略图。不用系统缩略图——macOS 的系统缩略图对很多视频给的是「默认打开它的那个 App」的图标
   （比如装了哔哩哔哩客户端，所有 mp4 都显示成 B 站图标），不是画面本身。
   同时最多解 3 个，解好的帧缓存起来，表格重画时不重复解码。 */
function localVideoThumb(el, path) {
  el.textContent = '…';
  videoFrame(path).then(data => {
    if (!el.isConnected || el.dataset.previewPath !== path) return;
    if (data) showFrame(el, data);
    else systemThumb(el, path);
  });
}
function showFrame(el, data) {
  const img = document.createElement('img');
  img.src = data;
  img.alt = baseName(el.dataset.previewPath || '');
  const play = document.createElement('span');
  play.className = 'video-play';
  play.textContent = '▶';
  el.replaceChildren(img, play);
}
async function systemThumb(el, path) {
  const data = await preview(path, { force: el.dataset.thumbFailed === '1' });
  if (!el.isConnected || el.dataset.previewPath !== path) return;
  if (!data) {
    el.dataset.thumbFailed = '1';
    thumbPlaceholder(el, path, el.dataset.kind, false);
    return;
  }
  el.dataset.thumbFailed = '';
  const img = document.createElement('img');
  img.src = data;
  img.alt = baseName(path);
  el.replaceChildren(img);
  if (el.dataset.kind === 'video') {
    const play = document.createElement('span');
    play.className = 'video-play';
    play.textContent = '▶';
    el.append(play);
  }
}

async function loadThumb(el) {
  const path = el.dataset.previewPath;
  if (!path || el.querySelector('img, canvas')) return;
  if (LINK_RE.test(path)) {
    if (el.dataset.kind === 'video') remoteVideoThumb(el, path);
    else thumbPlaceholder(el, path, 'link', false);
    return;
  }
  el.textContent = '…';
  const probe = await probePaths([path]);
  if (!el.isConnected || el.dataset.previewPath !== path) return;
  if (isMissing(probe[path])) {
    thumbPlaceholder(el, path, null, true);
    return;
  }
  if (el.dataset.kind === 'video' && el.dataset.thumbFailed !== '1') return localVideoThumb(el, path);
  systemThumb(el, path);
}

const observer = new IntersectionObserver(
  entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      loadThumb(entry.target);
    }
  },
  { rootMargin: '200px' },
);

export function hydrateAssetCards() {
  observer.disconnect();
  document.querySelectorAll('.asset-thumb[data-preview-path]').forEach(el => {
    if (el.querySelector('img, canvas')) return;
    observer.observe(el);
  });
}
export function refreshThumb(path) {
  invalidateVideoFrame(path);
  document.querySelectorAll(`.asset-thumb[data-preview-path="${CSS.escape(path)}"]`).forEach(el => {
    el.dataset.thumbFailed = '';
    el.classList.remove('thumb-missing', 'thumb-unsupported', 'thumb-nopreview');
    loadThumb(el);
  });
}
