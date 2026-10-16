import { createPlaybackClock } from './playback-clock.js';
import { buildPlaybackUnits, rowAtIn, previewItem } from '../core/playback-plan.js';
/* 播放视图实例：拥有画面、媒体资源和时间轨；宿主决定弹窗或嵌入展示。 */
import { state } from '../app/state.js';
import { timeline, rowById, types } from '../app/project-queries.js';

import { fmtTime, fmtLen } from '../core/text.js';
import { circled } from '../core/shot-layout.js';

import { rememberDuration } from '../app/asset-actions.js';

import { esc, ICON_PLAY, ICON_PAUSE, ICON_PREV, ICON_NEXT } from '../ui/base/dom.js';

import { typeIcon } from '../ui/base/type-view.js';

import { voicePlayer } from './voice.js';
import { createPreviewMedia } from './playthrough-media.js';

import { createShotTrack } from './shot-track.js';
export function createPlaybackView({ root, playerHost = root, trackHost = null, embedded = false, onPlay }) {
  const prefix = embedded ? 'review-' : '';
  const markup = html => html.replace(/id="(pt\w+)"/g, (_, id) => 'data-pt="' + id + '" id="' + prefix + id + '"');
  playerHost.innerHTML = markup(`<div class="pt-box${embedded ? ' docked' : ''}" role="dialog" aria-label="连播预览">
      <div class="pt-head"><strong id="ptTitle">连播预览</strong><span class="pt-hint" id="ptHint"></span><span class="spacer"></span><button class="btn" id="ptClose">关闭 <kbd>Esc</kbd></button></div>
      <div class="pt-stage" id="ptStage"></div>
      <div class="pt-sub" id="ptSub"></div>
      <div class="pt-meta" id="ptMeta"></div>
      <div class="pt-progress"><div id="ptBar"></div></div>
      ${trackHost ? '' : '<div class="pt-track" id="ptTrack" hidden></div>'}
      <div class="pt-controls"><button class="btn" id="ptPrev" title="上一个镜头（←）" aria-label="上一个镜头">${ICON_PREV}</button><button class="btn primary" id="ptPlay">${ICON_PLAY}播放</button><button class="btn" id="ptNext" title="下一个镜头（→）" aria-label="下一个镜头">${ICON_NEXT}</button><span class="pt-time mono" id="ptTime"></span><span class="spacer"></span><span class="pt-keys"><kbd>空格</kbd> 播放 / 暂停 · <kbd>← →</kbd> 上 / 下一个镜头</span></div>
    </div>`);
  if (trackHost) trackHost.innerHTML = markup('<div class="pt-track" id="ptTrack" hidden></div>');
  const $ = s => root.querySelector(s);
  let open = false;
  let units = []; // [{members, start, end, layout}]
  let range = null; // {start, end} 本次播放范围
  let current = -1; // 当前镜头下标
  let videoEl = null;
  let shownKey = ''; // 当前上屏的是哪个镜头的哪个素材：变了才换画面
  let segStart = 0; // 当前素材在口播里开始出现的时间（视频从入点 + 这之后过去的时间播）
  let segEnd = 0; // 这段画面排到哪里；之后的自然停顿里视频接着播，直到下一个画面出现
  let trackUnit = -1; // 镜头轨现在画的是哪个镜头
  let media = null;

  const useVoice = () => voicePlayer.available();
  const voiceEnd = () => (state.voice?.duration > 0 ? state.voice.duration : Infinity);

  function renderHint() {
    $('[data-pt="ptHint"]').textContent = useVoice()
      ? clock.usesVoice()
        ? `口播：${state.voice.name}${timeline().source === 'srt' ? '（字幕实测时间）' : '（按音频长度推算每句时间）'}`
        : `当前口播音频只到 ${fmtTime(voiceEnd())}，这段没有对应口播，按估算时间静音预览`
      : state.voice
        ? '口播音频读不出来，按估算时间静音播放'
        : '还没导入口播音频：按估算时间静音播放（时长菜单 → 导入口播音频）';
  }

  const buildUnits = () => {
    units = buildPlaybackUnits(state, timeline());
  };
  const unitAt = t => {
    for (let i = units.length - 1; i >= 0; i--) if (units[i].start <= t + 1e-6) return i;
    return 0;
  };
  const unitOfRow = id => units.findIndex(u => u.members.some(r => r.id === id));
  /* 画面下面那行：类型 · 第几句 · 正在放的画面。每次都按当前排布重算（调换 / 拖过顺序后编号跟着变），内容没变不重画 */
  let metaHtml = '';
  function paintMeta(u, r, item) {
    let html = '';
    if (u && r) {
      const t0 = types().get(r.type);
      const color = types().color(r.type) || '#8a93a6';
      html =
        `<span class="pt-type" style="--tc:${color}">${t0 ? typeIcon(t0) + esc(t0.label) : '未标注'}</span>` +
        `<span>第 ${u.members[0].no}${u.members.length > 1 ? '–' + u.members[u.members.length - 1].no : ''} 句 · ${fmtLen(u.end - u.start)}</span>` +
        (item
          ? `<span>${circled(item.n)} ${esc(item.asset.name || '')}${item.usage.clip ? ` · 片段 ${fmtTime(item.usage.clip.in)}–${fmtTime(item.usage.clip.out)}` : ''}</span>`
          : '');
    }
    if (html === metaHtml) return;
    metaHtml = html;
    $('[data-pt="ptMeta"]').innerHTML = html;
  }

  /* 字幕之间的自然停顿延续上一段画面（视频接着播到下一个画面出现）；手动留白、没有配素材的句子照常空着。 */
  const mediaKey = (i, item) => `${i}|${item.assetId}@${item.start}`;
  function prefetchNext(i, t) {
    for (let j = i; j < units.length; j++) {
      const u = units[j];
      const item = u.layout?.items.find(it => u.start + it.start > t + 1e-6 && it.start < u.layout.dur);
      if (item) return media.prefetch(mediaKey(j, item), item);
    }
    media.prefetch('', null);
  }

  /* 播放时顺便记下视频真实时长：裁剪结尾最远能拉回到原片末尾。在线视频只用地址里那一段，不记整条文件的长度 */
  function noteDuration(item, el) {
    if (/#t=/.test(item.asset.path || '')) return;
    const keep = () => el.duration > 0 && Number.isFinite(el.duration) && rememberDuration(item.asset, el.duration);
    if (el.readyState >= 1) keep();
    else el.addEventListener('loadedmetadata', keep, { once: true });
  }

  /* ── 画面：按镜头排布换素材，下一段提前准备首帧 ── */
  function showUnit(i, t) {
    const u = units[i];
    const r = u ? rowAtIn(u, t, timeline()) : null;
    const items = u?.layout?.items || [];
    const item = u ? previewItem(u, t, timeline()) : null;
    const key = item ? mediaKey(i, item) : `${i}|${items.length ? 'gap' : 'card'}`;
    if (i !== trackUnit) renderTrack(i);
    paintMeta(u, r, item);
    if (key === shownKey) return syncVideo(t);
    shownKey = key;
    current = i;
    const stage = $('[data-pt="ptStage"]');
    videoEl?.pause();
    videoEl = null;
    stage.classList.remove('pt-short');
    if (!u) return media.clear();
    segStart = u.start + (item ? item.start : 0);
    segEnd = u.start + (item ? Math.min(item.end, u.layout.dur) : 0);
    const ti = types();
    const color = ti.color(r.type) || '#8a93a6';
    if (item) {
      const target = (item.usage.clip?.in || 0) + Math.max(0, t - segStart);
      const el = media.show(key, item, target, () => {
        if (shownKey !== key) return;
        media.clear();
        videoEl = null;
        stage.innerHTML = cardHTML(
          r,
          color,
          `${item.kind === 'video' ? '视频' : '图片'}读不出来（文件失联或格式不支持）`,
        );
      });
      if (item.kind === 'video' && el.isConnected) {
        videoEl = el;
        noteDuration(item, el);
      }
    } else {
      media.clear();
      stage.innerHTML = items.length ? '<div class="pt-gap">这段没有画面</div>' : cardHTML(r, color);
    }
    prefetchNext(i, t);
    syncVideo(t, true);
  }

  /* 刻度尺 / 顶部进度条：点一下跳到那里，按住拖动可以来回找画面 */
  function scrub(e, el, toTime) {
    if (e.button !== 0) return;
    e.preventDefault();
    const go = ev => {
      const r = el.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width)));
      seek(toTime(f));
    };
    go(e);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    el.onpointermove = go;
    el.onpointerup = () => (el.onpointermove = el.onpointerup = null);
  }

  /* 数据变了（拖完、撤销、面板里改了角色 / 位置…）：重排当前镜头，画面和镜头轨一起刷新 */
  let refreshQueued = false;
  function refreshSoon() {
    if (!open) return;
    if (track.deferRefresh()) return;
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(() => {
      refreshQueued = false;
      refreshNow();
    }, 0);
  }
  /* 按项目里现在的数据重排当前镜头，画面和镜头轨一起刷新 */
  function refreshNow() {
    if (!open || !root.isConnected) return;
    if (track.deferRefresh()) return;
    {
      const keep = units[trackUnit]?.members[0]?.id;
      const mediaSignature = () =>
        JSON.stringify(
          units.map(u => [
            u.start,
            u.end,
            u.layout?.items.map(it => [it.assetId, it.asset.path, it.start, it.end, it.usage.clip]),
          ]),
        );
      const previousMedia = mediaSignature();
      buildUnits();
      const changedMedia = previousMedia !== mediaSignature();
      if (changedMedia) {
        media.clear();
        videoEl = null;
      }
      const i = keep != null ? unitOfRow(keep) : -1;
      if (range && i >= 0) range = { start: units[i].start, end: units[i].end };
      trackUnit = -1;
      if (changedMedia || /\|(?:card|gap)$/.test(shownKey)) shownKey = '';
      metaHtml = '';
      const t = currentTime();
      tick(t);
      if (i >= 0 && trackUnit !== i) renderTrack(i);
    }
  }

  function cardHTML(r, color, why = '') {
    const ti = types();
    const t = ti.get(r.type);
    const needs = !r.type || ti.needsVisual(r.type);
    const head = !r.type ? '还没标注类型' : needs ? '还没关联素材' : t.full;
    return `<div class="pt-card" style="--tc:${color}">
    <div class="pt-card-type">${t ? typeIcon(t) : ''}${esc(head)}</div>
    ${r.note ? `<div class="pt-card-note">${esc(r.note)}</div>` : needs ? '<div class="pt-card-note dim">（没有画面描述）</div>' : ''}
    ${why ? `<div class="pt-card-why">${esc(why)}</div>` : ''}
  </div>`;
  }

  /* 视频跟着时钟走：位置 = 入点 + 镜头内已过时间；超过出点就停在最后一帧 */
  function syncVideo(t, force = false) {
    const v = videoEl;
    const u = units[current];
    if (!v || !u || !(v.readyState >= 1)) return;
    const cin = +v.dataset.in || 0;
    const cout = v.dataset.out === '' ? v.duration : +v.dataset.out;
    const want = Math.min(cin + (t - segStart), Math.max(cin, (cout || v.duration) - 0.04));
    const over = cin + (t - segStart) >= (cout || v.duration);
    if (Math.abs(v.currentTime - want) > (force ? 0.04 : 0.3)) v.currentTime = Math.max(0, want);
    if (clock.isPlaying() && !over && v.paused) v.play().catch(() => {});
    if ((!clock.isPlaying() || over) && !v.paused) v.pause();
    $('[data-pt="ptStage"]').classList.toggle('pt-short', over && t < segEnd);
  }

  /* ── 时钟：有口播跟口播走，没有就自己走 ── */
  const currentTime = () => clock.currentTime();

  function tick(t) {
    if (!open || !root.isConnected) return;
    clock.remember(t);
    if (range && t >= range.end - 0.02) {
      // 「对着口播看画面」播完这个镜头：接着播下一个镜头（镜头轨和进度条跟着换过去）；最后一个镜头才停
      // 嵌在审核页里时只看这一个画面：播到末尾就停
      const next = embedded ? -1 : units.findIndex(x => x.start >= range.end - 0.05);
      if (clock.isPlaying() && next >= 0) range = { start: units[next].start, end: units[next].end };
      else {
        if (clock.isPlaying()) stop();
        t = Math.min(t, range.end);
      }
    }
    // 停在这个范围的末尾时（正好是下一个画面的开头），画面和时间轴仍留在这个画面，不跳到下一个
    const i = unitAt(range ? Math.min(t, range.end - 1e-3) : t);
    showUnit(i, t);
    const u = units[i];
    const r = u ? rowAtIn(u, t, timeline()) : null;
    paintSub(r ? r.text : '');
    $('[data-pt="ptTime"]').textContent = `${fmtTime(t)} / ${fmtTime(range ? range.end : timeline().total)}`;
    track.movePlayhead(t);
    const span = range ? range.end - range.start : timeline().total;
    $('[data-pt="ptBar"]').style.width = `${Math.min(100, ((t - (range?.start || 0)) / Math.max(0.01, span)) * 100)}%`;
  }

  /* 字幕：嵌在审核页时字幕区固定三行高，播放器不跟着字幕长短伸缩；三行放不下就把字缩小一号 */
  function paintSub(text) {
    const el = $('[data-pt="ptSub"]');
    if (el.textContent === text) return;
    el.textContent = text;
    el.classList.remove('fit');
    if (embedded && el.scrollHeight > el.clientHeight + 1) el.classList.add('fit');
  }

  function play() {
    if (!open) return;
    let t = currentTime();
    if (range && t >= range.end - 0.05) {
      const next = embedded ? -1 : units.findIndex(x => x.start >= range.end - 0.05);
      const u = next >= 0 ? units[next] : units.find(x => x.start <= range.start + 0.01 && x.end >= range.end - 0.01);
      if (u) {
        range = { start: u.start, end: u.end };
        t = u.start;
      }
    }
    clock.play(t);
    syncVideo(t, true);
  }
  function stop() {
    clock.pause();
    videoEl?.pause();
  }
  function seek(t) {
    if (range) t = Math.max(range.start, Math.min(range.end, t));
    clock.seek(t);
    syncVideo(t, true);
  }

  function renderControls() {
    const b = $('[data-pt="ptPlay"]');
    if (b) b.innerHTML = clock.isPlaying() ? `${ICON_PAUSE}暂停` : `${ICON_PLAY}播放`;
  }

  function renderTrack(i) {
    trackUnit = i;
    track.render(units[i]);
  }
  function start(fromId, { only = false, autoplay = false } = {}) {
    if (open) stop();
    track.reset();
    media.clear();
    buildUnits();
    if (!units.length) return false;
    let i = unitOfRow(fromId);
    if (i < 0) i = 0;
    const u = units[i];
    range = only ? { start: u.start, end: u.end } : null;
    open = true;
    current = -1;
    shownKey = metaHtml = '';
    trackUnit = -1;
    clock.attach();
    seek(u.start);
    if (autoplay) play();
    return true;
  }
  function close() {
    if (!open) return;
    track.reset();
    stop();
    open = false;
    clock.detach();
    videoEl = null;
    media.clear();
  }
  function showTrimFrame(it, entry, edge) {
    const clip = entry.clip || it.usage.clip;
    const cin = clip?.in || 0;
    const end = Math.min(clip?.out ?? it.asset.durationSec ?? Infinity, cin + entry.end - entry.start);
    const target = edge === 'start' ? cin : Math.max(cin, end - 0.04);
    const preview = { ...it, usage: { ...it.usage, ...(clip ? { clip } : {}) } };
    videoEl?.pause();
    videoEl = null;
    shownKey = '';
    $('[data-pt="ptStage"]').classList.remove('pt-short');
    media.show('trim|' + it.assetId, preview, target, () => {});
  }
  function handleKey(e) {
    // 镜头轨的秒数输入框里正常打字（回车 = 确定，Esc 照常关窗口）
    if (e.target?.closest?.('.ptt-num')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.target.blur();
        return true;
      }
      return e.key !== 'Escape';
    }
    if (e.key === ' ') {
      e.preventDefault();
      clock.isPlaying() ? stop() : play();
      return true;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const i = Math.max(0, Math.min(units.length - 1, current + (e.key === 'ArrowRight' ? 1 : -1)));
      if (units[i]) {
        if (range) range = { start: units[i].start, end: units[i].end };
        seek(units[i].start);
      }
      return true;
    }
    return track.key(e);
  }

  const clock = createPlaybackClock({
    voice: voicePlayer,
    voiceEnd,
    total: () => timeline().total,
    connected: () => open && root.isConnected,
    onTick: tick,
    onState() {
      if (!clock.isPlaying()) videoEl?.pause();
      renderHint();
      renderControls();
    },
    beforePlay: onPlay,
  });
  media = createPreviewMedia($('[data-pt="ptStage"]'));
  const track = createShotTrack({
    root,
    markup,
    currentTime,
    seek,
    stop,
    isPlaying: () => clock.isPlaying(),
    previewTrim: showTrimFrame,
    scrub,
    refreshSoon,
    refreshNow,
  });
  $('[data-pt="ptPlay"]').onclick = () => (clock.isPlaying() ? stop() : play());
  $('[data-pt="ptPrev"]').onclick = () => handleKey({ key: 'ArrowLeft', preventDefault() {} });
  $('[data-pt="ptNext"]').onclick = () => handleKey({ key: 'ArrowRight', preventDefault() {} });
  const bar = $('.pt-progress');
  bar.title = '点击或拖动：跳到这个时间';
  bar.addEventListener('pointerdown', e =>
    scrub(e, bar, f => (range ? range.start + f * (range.end - range.start) : f * timeline().total)),
  );
  return {
    start,
    close,
    pause: stop,
    refresh: refreshSoon,
    handleKey,
    remote() {
      track.remote();
      refreshSoon();
    },
    toggle() {
      if (!open) return false;
      clock.isPlaying() ? stop() : play();
      return true;
    },
    refreshShot(rowId) {
      if (!open || unitOfRow(rowId) !== current) start(rowId, { only: true });
    },
    isOpen: () => open,
    isDragging: track.isDragging,
    destroy() {
      close();
      track.destroy();
    },
    snapshot: () => ({
      open,
      playing: clock.isPlaying(),
      current,
      units: units.length,
      range,
      row: rowById(units[current]?.members[0]?.id)?.id,
      layout: units[trackUnit]?.layout || null,
      shown: shownKey,
      time: currentTime(),
      voiceClock: clock.usesVoice(),
      docked: embedded,
      alts: track.alts(),
    }),
  };
}
