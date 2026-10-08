/* 素材的可视化：表格素材卡片 / 行徽标 / 右面板条目 / 缩略图（三态：无缩略图、格式不支持、文件失联）。
   数据在 core/asset-model.js（素材库 + 使用记录 + 片段），这里只负责长什么样。 */
import { state, rowById, timeline } from '../app/state.js';
import { layoutShot, circled } from '../core/shot-layout.js';
import { probePaths, isMissing } from '../app/asset-actions.js';
import { shots, shotMembers, spanText, roleLabel, ROLES, ROLE_ORDER } from '../core/shots.js';
import {
  usageList,
  usagePath,
  assetName as baseName,
  kindOf,
  KIND_LABEL,
  clipText,
  VIDEO_EXT,
  LINK_RE,
  fileUrl,
} from '../core/asset-model.js';
import * as native from '../platform/native.js';
import { esc } from './dom.js';
import { pop } from './motion.js';

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

/* 按角色排：主画面 → 叠加 → 未分配 → 备选；保留原下标（面板按钮靠它定位） */
export function orderedUsages(r) {
  const rank = u => {
    const i = ROLE_ORDER.indexOf(u.role in ROLES ? u.role : null);
    return i < 0 ? 2 : i;
  };
  return usageList(r)
    .map((u, index) => ({ u, index }))
    .sort((x, y) => rank(x.u) - rank(y.u) || x.index - y.index);
}
const roleClass = role => (role in ROLES ? `role-${role}` : 'role-none');

export function assetCards(r) {
  const registry = state.assets || {};
  const usages = usageList(r);
  if (!usages.length) return '';
  const members = shotMembers(state.rows, r);
  const list = orderedUsages(r);
  const alts = list.filter(x => x.u.role === 'alt');
  // 表格里只摆真正要用的（主画面 / 叠加 / 未分配），备选收成一个入口，避免看起来每张都要轮着放
  const cards = list
    .filter(x => x.u.role !== 'alt')
    .map(({ u }) => {
      const a = registry[u.assetId] || u;
      const path = a.path || '';
      const kind = a.kind || kindOf(path) || 'doc';
      const where = spanText(members, u.assetId);
      const label = [
        where && where !== '整段' ? where : '',
        KIND_LABEL[kind] || '素材',
        u.clip ? `片段 ${clipText(u.clip)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `<button class="row-asset ${roleClass(u.role)}" data-detail="${r.id}" title="${esc(path)}">${thumbHTML(path, kind)}<span class="asset-caption"><span class="role-tag ${roleClass(u.role)}">${esc(roleLabel(u.role))}</span><strong>${esc(a.name || baseName(path))}</strong><small>${esc(label)}</small></span></button>`;
    })
    .join('');
  const altBtn = alts.length
    ? `<button class="asset-alts" data-detail="${r.id}" title="${esc(alts.map(x => (registry[x.u.assetId] || x.u).name || '').join('\n'))}">备选 ${alts.length} 个 · 查看</button>`
    : '';
  return cards + altBtn;
}

/* 面板里每条素材的角色按钮 */
function roleControls(u, index) {
  const chips = ['main', 'overlay', 'alt']
    .map(
      role =>
        `<button class="role-chip ${roleClass(role)}${u.role === role ? ' on' : ''}" data-role-usage="${index}" data-role="${role}" aria-pressed="${u.role === role}">${ROLES[role]}</button>`,
    )
    .join('');
  return `<div class="asset-role" role="group" aria-label="素材角色">${chips}</div>`;
}

export function inspectorAssets(r, { missing } = {}) {
  const registry = state.assets || {};
  const usages = usageList(r);
  const members = shotMembers(state.rows, r);
  const ids = new Set(members.map(m => m.id));
  const cands = (state.candidates || []).filter(c => ids.has(c.rowId));
  const todo = cands.filter(c => !c.decision).length;
  const vr = cands.length
    ? `<button class="asset-mini vr-open" data-vr-open="${r.id}">视频候选 ${cands.length} 个${todo ? ` · ${todo} 个待审` : ''} · 去审核</button>`
    : '';
  if (!usages.length) return vr + '<p class="asset-none">尚未关联素材</p>';
  // 每个上屏画面的编号和出现秒数（相对这段口播开头）
  const layout = layoutShot(registry, members, timeline());
  const placed = new Map((layout?.items || []).map(it => [it.assetId, it]));
  const sec = x => (Math.round(x * 10) / 10).toFixed(1);
  return (
    vr +
    (usages.some(u => !(u.role in ROLES))
      ? `<button class="asset-mini auto-roles" id="autoRoles">还有素材未分配 · 第一个当主画面，其余放备选</button>`
      : '') +
    orderedUsages(r)
      .map(({ u, index }) => {
        const a = registry[u.assetId] || u;
        const path = a.path || '';
        const kind = a.kind || kindOf(path) || 'doc';
        const gone = missing ? missing.has(path) : false;
        const bits = [KIND_LABEL[kind] || '素材'];
        if (u.clip) bits.push(`片段 ${clipText(u.clip)}`);
        const it = placed.get(u.assetId);
        if (it)
          bits.unshift(
            `${circled(it.n)} 出现 ${sec(it.start)}–${sec(it.end)} 秒${layout.timed ? '' : '（按句子）'}${it.over ? ' · 超出口播' : ''}`,
          );
        let stateLine = bits.join(' · ');
        let stateCls = '';
        if (gone) {
          stateLine = '文件失联 · 原路径保留在下方';
          stateCls = ' missing';
        } else if (u.clip && u.clip.needsAdjust) {
          stateLine += ' · 片段待调整';
          stateCls = ' warn';
        }
        return `<div class="inspector-asset${stateCls} ${roleClass(u.role)}" data-usage-index="${index}">
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
      ${roleControls(u, index)}
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
      Promise.resolve(native.previewImage(path)).catch(() => null),
    );
  }
  return previews.get(path);
}
export const clearPreviewCache = () => {
  previews.clear();
  remoteCache.clear();
};

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
const remoteCache = new Map(); // path → canvas | false（取不到）
const remoteQueue = [];
let remoteBusy = 0;
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
  if (remoteCache.has(path)) return paintRemote(el, path, remoteCache.get(path));
  el.textContent = '…';
  remoteQueue.push({ el, path });
  pumpRemote();
}
function pumpRemote() {
  while (remoteBusy < 2 && remoteQueue.length) {
    const { el, path } = remoteQueue.shift();
    if (remoteCache.has(path)) {
      paintRemote(el, path, remoteCache.get(path));
      continue;
    }
    if (!el.isConnected) continue; // 已经被重画掉的格子不用再取
    remoteBusy++;
    grabRemote(path).then(src => {
      remoteBusy--;
      remoteCache.set(path, src);
      paintRemote(el, path, src);
      // 同一个地址排在后面的格子直接用缓存
      for (const q of remoteQueue.filter(x => x.path === path)) paintRemote(q.el, path, src);
      pumpRemote();
    });
  }
}
function grabRemote(path) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    const t0 = Number((path.match(/#t=([\d.]+)/) || [])[1]) || 0;
    const done = ok => {
      clearTimeout(timer);
      let cv = false;
      if (ok && v.videoWidth) {
        cv = document.createElement('canvas');
        cv.width = 320;
        cv.height = Math.round((320 * v.videoHeight) / v.videoWidth) || 180;
        try {
          cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
        } catch {
          cv = false;
        }
      }
      v.removeAttribute('src');
      v.load();
      resolve(cv);
    };
    const timer = setTimeout(() => done(false), 20000);
    v.addEventListener('loadedmetadata', () => (v.currentTime = t0 + 0.5), { once: true });
    v.addEventListener('seeked', () => setTimeout(() => done(true), 80), { once: true });
    v.addEventListener('error', () => done(false), { once: true });
    v.src = path.split('#')[0];
  });
}

/* 本地视频：自己解一帧当缩略图。不用系统缩略图——macOS 的系统缩略图对很多视频给的是「默认打开它的那个 App」的图标
   （比如装了哔哩哔哩客户端，所有 mp4 都显示成 B 站图标），不是画面本身。
   同时最多解 3 个，解好的帧缓存起来，表格重画时不重复解码。 */
const frameCache = new Map(); // path → dataURL
let frameBusy = 0;
const frameQueue = [];
function localVideoThumb(el, path) {
  if (frameCache.has(path)) return showFrame(el, frameCache.get(path));
  el.textContent = '…';
  frameQueue.push({ el, path });
  pumpFrames();
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
function pumpFrames() {
  while (frameBusy < 3 && frameQueue.length) {
    const { el, path } = frameQueue.shift();
    if (!el.isConnected || el.dataset.previewPath !== path) continue;
    if (frameCache.has(path)) {
      showFrame(el, frameCache.get(path));
      continue;
    }
    frameBusy++;
    grabFrame(path).then(data => {
      frameBusy--;
      if (data) frameCache.set(path, data);
      for (const node of document.querySelectorAll(`.asset-thumb[data-preview-path="${CSS.escape(path)}"]`)) {
        if (node.querySelector('img, canvas')) continue;
        if (data) showFrame(node, data);
        else systemThumb(node, path); // 解不出来（格式不支持）再退回系统缩略图
      }
      pumpFrames();
    });
  }
}
function grabFrame(path) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    let settled = false;
    const finish = data => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      resolve(data);
    };
    const timer = setTimeout(() => finish(null), 15000);
    v.addEventListener(
      'loadedmetadata',
      () => (v.currentTime = Math.min(1, (v.duration || 0) * 0.1) || 0.1), // 避开第一帧常见的黑场
      { once: true },
    );
    v.addEventListener(
      'seeked',
      () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = 320;
          cv.height = Math.round((320 * v.videoHeight) / v.videoWidth) || 180;
          cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
          finish(cv.toDataURL('image/jpeg', 0.8));
        } catch {
          finish(null);
        }
      },
      { once: true },
    );
    v.addEventListener('error', () => finish(null), { once: true });
    v.src = fileUrl(path);
  });
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
  frameCache.delete(path);
  document.querySelectorAll(`.asset-thumb[data-preview-path="${CSS.escape(path)}"]`).forEach(el => {
    el.dataset.thumbFailed = '';
    el.classList.remove('thumb-missing', 'thumb-unsupported', 'thumb-nopreview');
    loadThumb(el);
  });
}

/* ── 行徽标：片段待调整 / 待核对 + 素材卡片（只在内容变了时重画） ── */
let missingSet = new Set(); // 文件失联探测结果（与「无缩略图」「格式不支持」分开统计）
export const missingPaths = () => missingSet;

function statusText(r) {
  const clipTodo = usageList(r).some(u => u.clip && u.clip.needsAdjust);
  return [clipTodo ? '片段待调整' : '', r.needsReview ? '待核对' : ''].filter(Boolean).join(' · ');
}

/* 素材卡片变化的动效：新挂上的素材弹进来；主画面 / 备选换了角色的轻轻跳一下。
   按句子记住上一次有哪些卡片（整表重画后也认得出哪些是新的）；换项目时清空。 */
const cardMemo = new Map();
let cardMemoPid = null;
function animateCards(id, assets) {
  if (cardMemoPid !== state.projectId) {
    cardMemo.clear();
    cardMemoPid = state.projectId;
  }
  const now = new Map(
    [...assets.querySelectorAll('.row-asset')].map(b => [b.title, b.className.match(/role-[\w-]+/)?.[0] || '']),
  );
  const before = cardMemo.get(id);
  cardMemo.set(id, now);
  if (!before) return;
  assets.querySelectorAll('.row-asset').forEach((b, i) => {
    if (!before.has(b.title)) setTimeout(() => pop(b, { scale: 0.6, duration: 520 }), i * 60);
    else if (before.get(b.title) !== now.get(b.title)) pop(b, { scale: 0.9 });
  });
}

function badgeOne(el) {
  const r = rowById(+(el.dataset.owner || el.dataset.id));
  if (!r) return;
  let badge = el.querySelector('.production-badge');
  if (!badge) {
    badge = document.createElement('button');
    badge.className = 'production-badge';
    badge.dataset.detail = String(r.id);
    el.querySelector('.typebox')?.append(badge);
  }
  const text = statusText(r);
  if (badge.textContent !== text) badge.textContent = text;
  badge.hidden = !text;
  const assets = el.querySelector('.row-assets');
  if (assets) {
    // 位置（off）存在组内每句上，所以签名要看整组
    const signature = JSON.stringify([shotMembers(state.rows, r).map(m => m.assetUsages || []), r.type]);
    if (assets.dataset.signature !== signature) {
      assets.innerHTML = assetCards(r);
      assets.dataset.signature = signature;
      animateCards(r.id, assets);
    }
  }
}

/* ids 给了就只刷这几句所在的行 / 共用画面；不给就全部 */
export function rowBadges(ids) {
  if (ids) {
    for (const id of ids) {
      const row = document.querySelector(`.row[data-id="${id}"]`);
      const el = row?.closest('.shared-scene') || row;
      if (el) badgeOne(el);
    }
  } else document.querySelectorAll('.row:not(.shared-scene-row),.shared-scene').forEach(badgeOne);
  hydrateAssetCards();
}

/* 探测素材文件是否还在；结果有变化才回调（重画徽标 / 面板） */
export async function refreshMissing(onChange) {
  const paths = [
    ...new Set(
      Object.values(state.assets || {})
        .map(a => a.path)
        .filter(Boolean),
    ),
  ];
  const probe = await probePaths(paths);
  const next = new Set(paths.filter(p => isMissing(probe[p])));
  const changed = next.size !== missingSet.size || [...next].some(p => !missingSet.has(p));
  missingSet = next;
  if (changed) onChange?.();
}
export const resetMissing = () => {
  missingSet = new Set();
};
