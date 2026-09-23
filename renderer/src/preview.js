/* 应用内素材预览浮层：图片大图（适应窗口/缩放）+ 视频播放器（播放暂停/进度/时间）
   + 视频片段编辑（入点/出点：当前播放位置或手输、校验、片段预览、清除）。
   全应用只有一个播放器：换素材、关闭、切项目都先停播释放，绝不同时播两个、不留黑屏装成功。 */
import { state, on, rowById } from './state.js';
import { esc, toast, fmtTime, parseTime } from './util.js';
import {
  usageList,
  kindOf,
  clipText,
  checkClip,
  setUsageClip,
  fileUrl,
  assetName,
  LINK_RE,
  AUDIO_EXT,
} from './assets.js';
import { persist } from './storage.js';
import { openAsset as openAssetNative } from './native-bridge.js';

let ctx = null; // {rowId, usageIndex} | {asset}  当前预览对象
let video = null; // 唯一 <video> 元素
let img = null;
let stopAt = null; // 片段预览：放到这个时间点自动停
let loadTimer = null;
let released = true;

const $ = s => document.querySelector(s);

const ERR_TEXT = {
  1: '播放被中断，点重试再试一次',
  2: '读取文件失败（文件可能已变动或失联）',
  3: '无法解码这个视频（编码不受支持）',
  4: '无法播放这个格式的视频',
  timeout: '读取视频超时，可能编码不受支持或文件太大',
};

function playerAsset() {
  if (!ctx) return null;
  if (ctx.asset) return ctx.asset;
  const r = rowById(ctx.rowId);
  const u = r ? usageList(r)[ctx.usageIndex] : null;
  return u ? (state.assets || {})[u.assetId] || null : null;
}
function playerUsage() {
  if (!ctx || ctx.asset) return null;
  const r = rowById(ctx.rowId);
  return r ? { row: r, index: ctx.usageIndex, usage: usageList(r)[ctx.usageIndex] } : null;
}

/* 停播并释放解码资源（换素材 / 关闭 / 切项目都要走） */
function stopPlayer() {
  clearTimeout(loadTimer);
  loadTimer = null;
  stopAt = null;
  if (video) {
    try {
      video.pause();
    } catch {}
    video.removeAttribute('src');
    try {
      video.load();
    } catch {}
    video = null;
  }
  img = null;
  released = true;
}
export const isReleased = () => released;
export function playerCurrentTime() {
  return video && isFinite(video.currentTime) ? video.currentTime : null;
}
export const isPreviewOpenFor = path => !released && !!playerAsset() && playerAsset().path === path;

export function closePreview() {
  stopPlayer();
  ctx = null;
  const mask = $('#previewMask');
  if (mask) {
    mask.classList.remove('show');
    $('#pvStage')?.replaceChildren(); // 把 <video>/<img> 摘掉，彻底释放解码资源
    $('#pvTools')?.replaceChildren();
  }
}

function open({ rowId, usageIndex, asset } = {}) {
  stopPlayer();
  ctx = asset ? { asset } : { rowId, usageIndex };
  released = false;
  $('#previewMask').classList.add('show');
  render();
}

export const openPreview = ({ row, usageIndex }) => open({ rowId: row.id, usageIndex });
export const openPreviewAsset = ({ asset }) => open({ asset });

function render() {
  const asset = playerAsset();
  const stage = $('#pvStage'),
    tools = $('#pvTools');
  if (!asset) {
    closePreview();
    return;
  }
  $('#pvName').textContent = asset.name || assetName(asset.path);
  $('#pvName').title = asset.path;
  const usage = playerUsage();
  $('#pvMeta').textContent = usage && usage.usage?.clip ? `片段 ${clipText(usage.usage.clip)}` : '使用整段';
  stage.replaceChildren();
  tools.replaceChildren();
  const kind = asset.kind || kindOf(asset.path) || 'doc';
  if (LINK_RE.test(asset.path)) {
    stage.innerHTML = `<div class="pv-error"><p>这是一个链接，点下方按钮在浏览器打开。</p></div>`;
    $('#pvSys').textContent = '在浏览器打开';
  } else {
    $('#pvSys').textContent = kind === 'image' ? '用系统预览打开' : '用系统播放器打开';
    if (kind === 'image') renderImage(stage, tools, asset);
    else if (kind === 'video' || kind === 'audio') renderVideo(stage, tools, asset, usage);
    else {
      stage.innerHTML = `<div class="pv-error"><p>这种格式不支持应用内预览（${esc(kind)}）。</p></div>`;
    }
  }
  renderClipPanel(tools, asset, usage);
}

/* ── 图片：适应窗口为基准，可放大缩小 ── */
function renderImage(stage, tools, asset) {
  img = document.createElement('img');
  img.className = 'pv-img';
  img.alt = asset.name || '';
  img.src = fileUrl(asset.path);
  let zoom = 1;
  const apply = () => {
    img.style.transform = `scale(${zoom})`;
    $('#pvZoomLabel') && ($('#pvZoomLabel').textContent = zoom === 1 ? '适应窗口' : Math.round(zoom * 100) + '%');
  };
  img.onerror = () => {
    stage.innerHTML = `<div class="pv-error"><p>图片无法读取（格式不支持或文件已损坏）。</p></div>`;
    tools.replaceChildren();
    renderClipPanel(tools, asset, playerUsage());
  };
  stage.append(img);
  tools.innerHTML = `
    <button class="btn" id="pvFit">适应窗口</button>
    <button class="btn" id="pvOut">缩小</button>
    <button class="btn" id="pvIn">放大</button>
    <span class="pv-zoom" id="pvZoomLabel">适应窗口</span>`;
  $('#pvFit').onclick = () => {
    zoom = 1;
    apply();
  };
  $('#pvIn').onclick = () => {
    zoom = Math.min(8, zoom * 1.25);
    apply();
  };
  $('#pvOut').onclick = () => {
    zoom = Math.max(0.2, zoom / 1.25);
    apply();
  };
  stage.onwheel = e => {
    // onwheel 赋值：重渲染不会累积监听
    e.preventDefault();
    zoom = Math.min(8, Math.max(0.2, zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    apply();
  };
  apply();
}

/* ── 视频 / 音频：不自动播放；加载成功前显示「加载中」，失败明确报因 ── */
function renderVideo(stage, tools, asset, usage) {
  const wrap = document.createElement('div');
  wrap.className = 'pv-video-wrap';
  const loading = document.createElement('div');
  loading.className = 'pv-loading';
  loading.textContent = '加载中…';
  video = document.createElement('video');
  video.className = 'pv-video';
  video.preload = 'metadata';
  video.playsInline = true;
  if (AUDIO_EXT.test(asset.path)) video.classList.add('audio-only');
  wrap.append(loading, video);
  stage.append(wrap);

  tools.innerHTML = `
    <button class="btn primary" id="pvPlay">播放</button>
    <span class="pv-time" id="pvCur">00:00</span>
    <input type="range" id="pvSeek" min="0" max="1000" value="0" step="1" class="pv-seek" aria-label="播放进度">
    <span class="pv-time" id="pvDur">--:--</span>`;

  const show = () => loading.remove();
  const fail = why => {
    stopAt = null;
    show();
    const code = video?.error?.code;
    const why2 = why || ERR_TEXT[code] || ERR_TEXT[4];
    stage.replaceChildren();
    stage.innerHTML = `<div class="pv-error" data-pv-error="${esc(String(code ?? 'unknown'))}">
        <p>${esc(why2)}</p>
        <p class="pv-error-sub">没有把黑屏当成功：这个视频没能解码播放。</p>
        <div class="pv-error-btns"><button class="btn" id="pvSysErr">用系统播放器打开</button><button class="btn" id="pvRetry">重试</button></div>
      </div>`;
    $('#pvSysErr').onclick = async () => {
      const err = await openAssetNative(asset.path);
      if (err) toast(err);
    };
    $('#pvRetry').onclick = () => render();
  };

  video.addEventListener('loadedmetadata', () => {
    show();
    clearTimeout(loadTimer);
    $('#pvDur').textContent = fmtTime(video.duration);
    $('#pvSeek').max = String(Math.max(1, Math.floor(video.duration * 10)));
    // 记下真实时长，供片段范围校验（只是信息缓存，不进撤销）
    if (asset && asset.durationSec !== video.duration) {
      asset.durationSec = video.duration;
      persist();
      renderClipPanel(tools, asset, playerUsage());
    }
    // 打开片段预览时直接落在入点
    const u = playerUsage();
    if (u && u.usage?.clip) {
      video.currentTime = u.usage.clip.in;
      $('#pvCur').textContent = fmtTime(video.currentTime);
    }
  });
  video.addEventListener('error', () => fail());
  video.addEventListener('timeupdate', () => {
    if (!video) return;
    $('#pvCur').textContent = fmtTime(video.currentTime);
    $('#pvSeek').value = String(Math.floor(video.currentTime * 10));
    if (stopAt != null && video.currentTime >= stopAt) {
      video.pause();
      video.currentTime = stopAt;
      stopAt = null;
      $('#pvPlay').textContent = '播放';
    }
  });
  $('#pvPlay').onclick = () => {
    if (!video) return;
    if (video.paused) {
      stopAt = null;
      video.play();
      $('#pvPlay').textContent = '暂停';
    } else {
      video.pause();
      $('#pvPlay').textContent = '播放';
    }
  };
  $('#pvSeek').oninput = () => {
    if (video) {
      stopAt = null;
      video.currentTime = +$('#pvSeek').value / 10;
    }
  };

  video.src = fileUrl(asset.path);
  loadTimer = setTimeout(() => {
    if (video && video.readyState === 0) fail(ERR_TEXT.timeout);
  }, 8000);
}

/* ── 片段编辑：入点 / 出点（当前播放位置或手输）、校验、片段预览、清除 ── */
function renderClipPanel(tools, asset, usage) {
  if (!usage) {
    return;
  } // 不带画面上下文（比如从素材库看）就不给片段编辑
  const kind = asset.kind || kindOf(asset.path) || 'doc';
  if (kind !== 'video') return;
  const clip = usage.usage?.clip || null;
  let panel = tools.querySelector('.clip-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'clip-panel';
    tools.append(panel);
  }
  panel.innerHTML = `
    <div class="clip-title">这次画面使用视频的哪一段 <span class="clip-state">${clip ? esc(clipText(clip)) : '未设置范围＝使用整段'}</span>${clip && clip.needsAdjust ? '<span class="clip-warn">片段待调整</span>' : ''}</div>
    <div class="clip-row">
      <label>入点 <input id="clipIn" placeholder="00:00" value="${clip ? fmtTime(clip.in) : ''}"></label>
      <button class="asset-mini" id="clipInNow" title="把当前播放位置设为入点">←当前</button>
      <label>出点 <input id="clipOut" placeholder="整段" value="${clip ? fmtTime(clip.out) : ''}"></label>
      <button class="asset-mini" id="clipOutNow" title="把当前播放位置设为出点">←当前</button>
      <button class="btn" id="clipApply">应用范围</button>
      <button class="btn" id="clipPreview">预览片段</button>
      <button class="text-button" id="clipClear">清除范围</button>
    </div>
    <p class="clip-error" id="clipError"></p>
    <p class="clip-help">手输支持 12、00:12、1:02:03；范围记在这个画面上，同一个视频别的画面各用各的。快捷键：空格 播放 · I / O 设入点出点 · ← → 前后 1 秒</p>`;

  const err = msg => {
    $('#clipError').textContent = msg || '';
  };
  $('#clipInNow').onclick = () => {
    const t = playerCurrentTime();
    if (t == null) return err('先播放到目标位置');
    $('#clipIn').value = fmtTime(t);
    err('');
  };
  $('#clipOutNow').onclick = () => {
    const t = playerCurrentTime();
    if (t == null) return err('先播放到目标位置');
    $('#clipOut').value = fmtTime(t);
    err('');
  };
  $('#clipApply').onclick = () => {
    const row = rowById(ctx.rowId);
    const u = row && usageList(row)[ctx.usageIndex];
    if (!row || !u) return err('这个关联已经不在了，关闭重开');
    const hasIn = $('#clipIn').value.trim() !== '',
      hasOut = $('#clipOut').value.trim() !== '';
    if (!hasIn && !hasOut) {
      clearRange();
      return;
    }
    if (!hasIn || !hasOut) return err('入点和出点都要填（只想用整段就点「清除范围」）');
    const tin = parseTime($('#clipIn').value),
      tout = parseTime($('#clipOut').value);
    if (tin == null || tout == null) return err('时间格式不对，试试 00:12');
    const duration = video && isFinite(video.duration) && video.duration > 0 ? video.duration : asset.durationSec;
    const bad = checkClip({ in: tin, out: tout }, duration ?? null);
    if (bad) return err(bad);
    setUsageClip(row, ctx.usageIndex, { in: tin, out: tout });
    renderClipPanel($('#pvTools'), playerAsset(), playerUsage());
    toast(`片段已设为 ${fmtTime(tin)}–${fmtTime(tout)}`);
  };
  $('#clipPreview').onclick = () => {
    const u = playerUsage();
    const c = u && u.usage?.clip;
    if (!c) return err('先设置片段范围');
    if (!video) return err('视频还没加载好');
    err('');
    stopAt = c.out;
    video.currentTime = c.in;
    video.play();
    $('#pvPlay').textContent = '暂停';
  };
  const clearRange = () => {
    const row = rowById(ctx.rowId);
    if (!row) return;
    setUsageClip(row, ctx.usageIndex, null);
    stopAt = null;
    renderClipPanel($('#pvTools'), playerAsset(), playerUsage());
    toast('已清除范围，使用整段视频');
  };
  $('#clipClear').onclick = clearRange;
}

/* 重定位素材前探一下新媒体的真实时长（用于片段兼容检查） */
export function probeDuration(path) {
  return new Promise(resolve => {
    if (!path || LINK_RE.test(path)) return resolve(null);
    const kind = kindOf(path);
    if (kind !== 'video' && kind !== 'audio') return resolve(null);
    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.preload = 'metadata';
    const done = v => {
      el.removeAttribute('src');
      try {
        el.load();
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 3000);
    el.addEventListener('loadedmetadata', () => {
      clearTimeout(timer);
      done(isFinite(el.duration) ? el.duration : null);
    });
    el.addEventListener('error', () => {
      clearTimeout(timer);
      done(null);
    });
    el.src = fileUrl(path);
  });
}

/* 播放器快捷键（剪辑软件的习惯）：空格 播放/暂停 · I / O 把当前位置填为入点 / 出点 · ← → 前后 1 秒（按住 Shift 5 秒）
   焦点在输入框里时不接管，照常打字。返回 true = 已处理 */
export function previewKey(e) {
  if (!video || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.target?.matches?.('input, textarea')) return false;
  if (e.key === ' ') {
    e.preventDefault();
    $('#pvPlay')?.click();
    return true;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    stopAt = null;
    const step = (e.shiftKey ? 5 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + step));
    return true;
  }
  const k = e.key.toLowerCase();
  if (k === 'i' && $('#clipInNow')) {
    e.preventDefault();
    $('#clipInNow').click();
    return true;
  }
  if (k === 'o' && $('#clipOutNow')) {
    e.preventDefault();
    $('#clipOutNow').click();
    return true;
  }
  return false;
}

export function initPreview() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <div class="modal-mask preview-mask" id="previewMask">
      <div class="preview-box" role="dialog" aria-label="素材预览">
        <div class="preview-head">
          <strong id="pvName"></strong><span class="pv-meta" id="pvMeta"></span>
          <span class="spacer"></span>
          <button class="btn ghost" id="pvSys">用系统播放器打开</button>
          <button class="btn" id="pvClose" aria-label="关闭预览">✕</button>
        </div>
        <div class="preview-stage" id="pvStage"></div>
        <div class="preview-tools" id="pvTools"></div>
      </div>
    </div>`,
  );
  $('#pvClose').onclick = closePreview;
  $('#previewMask').addEventListener('click', e => {
    if (e.target.id === 'previewMask') closePreview();
  });
  $('#pvSys').onclick = async () => {
    const a = playerAsset();
    if (!a) return;
    const err = await openAssetNative(a.path);
    if (err) toast(err);
  };
  on('project-loaded', closePreview);
}
