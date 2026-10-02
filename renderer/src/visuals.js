/* 素材可视化：表格卡片 / 右面板条目 / 缩略图（三态：无缩略图、格式不支持、文件失联）。
   数据都在 assets.js（素材库 + 使用记录 + 片段），这里只负责长什么样。 */
import { esc } from './util.js';
import { shots } from './production.js';
import { state } from './state.js';
import {
  usageList,
  usagePath,
  assetName as baseName,
  kindOf,
  KIND_LABEL,
  clipText,
  probePaths,
  isMissing,
  VIDEO_EXT,
  LINK_RE,
} from './assets.js';

export { baseName as assetName };
export const isVideo = ref => VIDEO_EXT.test(ref);

/* 共用画面标签：第 x–y 句共用一个画面 */
export function sharedScenes(rows) {
  const result = new Map();
  let number = 0;
  for (const members of shots(rows)) {
    if (!members[0].groupId) continue;
    const first = members[0],
      last = members[members.length - 1];
    result.set(first.groupId, { number: ++number, members, label: `第 ${first.no}–${last.no} 句共用一个画面` });
  }
  return result;
}

/* 旧接口兼容：r 的全部素材引用路径（一行一个，来自使用记录） */
export const assetRefs = r =>
  usageList(r)
    .map(u => usagePath(state.assets || {}, u))
    .filter(Boolean);

const thumbText = kind => (kind === 'video' ? '▶ 视频' : kind === 'image' ? '图片' : kind === 'link' ? '链接' : '素材');

/* 缩略图容器：data-preview-path 供懒加载与重试定位 */
const thumbHTML = (path, kind) =>
  `<span class="asset-thumb" data-preview-path="${esc(path)}" data-kind="${kind}">${thumbText(kind)}</span>`;

export function assetCards(r) {
  const registry = state.assets || {};
  const usages = usageList(r);
  if (!usages.length)
    return r.type && r.type !== 'a' ? `<button class="asset-empty" data-detail="${r.id}">＋ 尚未关联素材</button>` : '';
  return usages
    .map(u => {
      const a = registry[u.assetId] || u;
      const path = a.path || '';
      const kind = a.kind || kindOf(path) || 'doc';
      const label = [KIND_LABEL[kind] || '素材', u.clip ? `片段 ${clipText(u.clip)}` : ''].filter(Boolean).join(' · ');
      return `<button class="row-asset" data-detail="${r.id}" title="${esc(path)}">${thumbHTML(path, kind)}<span class="asset-caption"><strong>${esc(a.name || baseName(path))}</strong><small>${esc(label)} · 查看详情</small></span></button>`;
    })
    .join('');
}

export function inspectorAssets(r, { missing } = {}) {
  const registry = state.assets || {};
  const usages = usageList(r);
  if (!usages.length) return '<p class="asset-none">尚未关联素材</p>';
  return (
    usages
      .map((u, index) => {
        const a = registry[u.assetId] || u;
        const path = a.path || '';
        const kind = a.kind || kindOf(path) || 'doc';
        const gone = missing ? missing.has(path) : false;
        const bits = [KIND_LABEL[kind] || '素材'];
        if (u.clip) bits.push(`片段 ${clipText(u.clip)}`);
        let stateLine = bits.join(' · ');
        let stateCls = '';
        if (gone) {
          stateLine = '文件失联 · 原路径保留在下方';
          stateCls = ' missing';
        } else if (u.clip && u.clip.needsAdjust) {
          stateLine += ' · 片段待调整';
          stateCls = ' warn';
        }
        return `<div class="inspector-asset${stateCls}" data-usage-index="${index}">
      <button class="asset-open" data-preview-usage="${index}" title="${esc(path)}">
        ${thumbHTML(path, kind)}
        <span class="asset-caption"><strong>${esc(a.name || baseName(path))}</strong><small>${esc(stateLine)}</small></span>
      </button>
      <div class="asset-actions">
        ${kind === 'video' && !gone ? `<button class="asset-mini" data-clip-usage="${index}">片段</button>` : ''}
        ${gone ? `<button class="asset-mini" data-relocate-usage="${index}">重新定位</button>` : ''}
        <button class="asset-mini" data-sys-open="${esc(path)}">系统打开</button>
        <button class="asset-remove" data-remove-usage="${index}" aria-label="移除 ${esc(a.name || baseName(path))}" title="只解除关联，保留本地文件">移除</button>
      </div>
    </div>`;
      })
      .join('') +
    `<p class="asset-path-hint">原路径：${usages.map(u => esc(usagePath(state.assets || {}, u))).join('<br>')}</p>`
  );
}

/* ── 缩略图懒加载：成功放图；失败分三态（无缩略图 / 格式不支持 / 文件失联），可重试，不无限转圈 ── */
const previews = new Map();
export function preview(path, { force = false } = {}) {
  if (force) previews.delete(path);
  if (!previews.has(path)) {
    if (previews.size >= 40) previews.delete(previews.keys().next().value);
    previews.set(
      path,
      Promise.resolve(window.native?.previewImage(path)).catch(() => null),
    );
  }
  return previews.get(path);
}
export const clearPreviewCache = () => previews.clear();

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

async function loadThumb(el) {
  const path = el.dataset.previewPath;
  if (!path || el.querySelector('img')) return;
  if (LINK_RE.test(path)) {
    thumbPlaceholder(el, path, 'link', false);
    return;
  }
  el.textContent = '…';
  const probe = await probePaths([path]);
  if (!el.isConnected || el.dataset.previewPath !== path) return;
  if (isMissing(probe[path])) {
    thumbPlaceholder(el, path, null, true);
    return;
  }
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
    if (el.querySelector('img')) return;
    observer.observe(el);
  });
}
export function refreshThumb(path) {
  document.querySelectorAll(`.asset-thumb[data-preview-path="${CSS.escape(path)}"]`).forEach(el => {
    el.dataset.thumbFailed = '';
    el.classList.remove('thumb-missing', 'thumb-unsupported', 'thumb-nopreview');
    loadThumb(el);
  });
}
