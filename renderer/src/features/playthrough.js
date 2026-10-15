/* 连播预览（粗剪样片）：口播一路往下播，画面按镜头里的主画面排布自动切换（见 core/shot-layout.js）：
   一个镜头可以有多个主画面 ①②③…，各占一段；排布里空着的地方黑屏（下面照常出字幕）。
   视频从入点开始静音播放、图片静止显示；不需要配画面的类型（如 A roll）显示「真人出镜」卡；
   一个画面都没挂的显示画面描述。没有口播音频时按估算时间静音走一遍。
   「对着口播看画面」= 只播一个镜头的范围。
   窗口下方的「镜头轨」= 当前这个镜头的口播时长，每个主画面一个色块：拖边裁剪内容、拖中间移动或插入换序，
   I / O 裁到播放头；Shift 拖相接边调切换点。松手保存、可撤销，播放头不跟随素材。 */
import { state, on, timeline, rowById, types } from '../app/state.js';
import { shots, shotMembers } from '../core/shots.js';
import { spanOf } from '../core/timeline.js';
import { fmtTime, fmtLen } from '../core/text.js';
import { layoutShot, itemAt, circled, MIN_LEN } from '../core/shot-layout.js';
import { movePicture, trimPicture, rollPictures } from '../core/shot-edit.js';
import { altItems, moveAlt, mainSlotAt, swapIntoMain, insertIntoMain, dropToAlt } from '../core/shot-tracks.js';
import { setShotTimes, arrangeShot, clearShotTimes } from '../app/asset-actions.js';
import { esc, ICON_PLAY, ICON_PAUSE, ICON_PREV, ICON_NEXT } from '../ui/base/dom.js';
import { typeIcon } from '../ui/base/type-view.js';
import { registerCommand } from '../ui/base/commands.js';
import { voicePlayer } from './voice.js';
import { createPreviewMedia } from './playthrough-media.js';

const $ = s => document.querySelector(s);
let open = false;
let units = []; // [{members, start, end, layout}]
let range = null; // {start, end} 本次播放范围
let current = -1; // 当前镜头下标
let playing = false;
let clockT = 0; // 没有口播音频时的虚拟时钟
let voiceClock = false; // 当前时间是否在口播文件内；超出音频的稿件用虚拟时钟
let lastFrame = 0;
let raf = 0;
let untick = null;
let videoEl = null;
let startedAt = 0;
let shownKey = ''; // 当前上屏的是哪个镜头的哪个素材：变了才换画面
let segStart = 0; // 当前素材在口播里开始出现的时间（视频从入点 + 这之后过去的时间播）
let segEnd = 0; // 这段画面排到哪里；之后的自然停顿里视频接着播，直到下一个画面出现
let trackUnit = -1; // 镜头轨现在画的是哪个镜头
let pick = null; // 镜头轨上选中的画面（assetId）
let drag = null; // 正在拖的色块
let dragCleanup = null;
function clearDrag() {
  const cleanup = dragCleanup;
  dragCleanup = null;
  drag = null;
  cleanup?.();
}
let editMsg = ''; // 填的秒数被前后画面挡住时的提示（只显示一次）
let media = null;

const useVoice = () => voicePlayer.available();
const voiceEnd = () => (state.voice?.duration > 0 ? state.voice.duration : Infinity);
const voiceAt = t => useVoice() && t < voiceEnd();

function renderHint() {
  $('#ptHint').textContent = useVoice()
    ? voiceClock
      ? `口播：${state.voice.name}${timeline().source === 'srt' ? '（字幕实测时间）' : '（按音频长度推算每句时间）'}`
      : `当前口播音频只到 ${fmtTime(voiceEnd())}，这段没有对应口播，按估算时间静音预览`
    : state.voice
      ? '口播音频读不出来，按估算时间静音播放'
      : '还没导入口播音频：按估算时间静音播放（时长菜单 → 导入口播音频）';
}

function buildUnits() {
  const tl = timeline();
  units = shots(state.rows)
    .map(members => {
      const layout = layoutShot(state.assets || {}, members, tl);
      const span = layout ||
        spanOf(
          tl,
          members.map(r => r.id),
        ) || { start: 0, end: 0 };
      return { members, start: span.start, end: span.end, layout };
    })
    .filter(u => u.end > u.start);
}
const unitAt = t => {
  for (let i = units.length - 1; i >= 0; i--) if (units[i].start <= t + 1e-6) return i;
  return 0;
};
const unitOfRow = id => units.findIndex(u => u.members.some(r => r.id === id));

/* 镜头里此刻正在说的那句；句间停顿算刚说完的那句（不跳回镜头第一句） */
function rowAtIn(u, t) {
  const tl = timeline();
  return u.members.findLast(x => (tl.times.get(x.id)?.start ?? Infinity) <= t + 1e-6) || u.members[0];
}

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
  $('#ptMeta').innerHTML = html;
}

/* 字幕之间的自然停顿延续上一段画面（视频接着播到下一个画面出现）；手动留白、没有配素材的句子照常空着。 */
function previewItem(u, t) {
  const layout = u?.layout;
  if (!layout) return null;
  const rel = t - u.start;
  const item = itemAt(layout, rel);
  if (item) return item;
  const prev = layout.items.findLast(it => it.end <= rel + 1e-6);
  const last = layout.items.at(-1);
  // 手动时间精确到 0.1 秒，字幕精确到毫秒：镜头末尾的舍入误差也延续末帧。
  if (last && last.start <= rel + 1e-6 && rel >= layout.dur - 0.05 && last.end >= layout.dur - 0.05) return last;
  if (layout.timed || !prev) return null;
  const next = layout.items.find(it => it.start > rel);
  return next && heldThrough(u, prev, next) ? prev : null;
}

/* 按句子排时，prev 和 next 之间的空当没人说话（句间停顿）：prev 一直延续到 next 出现 */
function heldThrough(u, prev, next) {
  if (u.layout.timed || next.start <= prev.end + 1e-6) return false;
  const tl = timeline();
  return !u.members.some(r => {
    const tm = tl.times.get(r.id);
    return tm && tm.start < u.start + next.start - 1e-6 && tm.end > u.start + prev.end + 1e-6;
  });
}

const mediaKey = (i, item) => `${i}|${item.assetId}@${item.start}`;
function prefetchNext(i, t) {
  for (let j = i; j < units.length; j++) {
    const u = units[j];
    const item = u.layout?.items.find(it => u.start + it.start > t + 1e-6 && it.start < u.layout.dur);
    if (item) return media.prefetch(mediaKey(j, item), item);
  }
  media.prefetch('', null);
}

/* ── 画面：按镜头排布换素材，下一段提前准备首帧 ── */
function showUnit(i, t) {
  const u = units[i];
  const r = u ? rowAtIn(u, t) : null;
  const items = u?.layout?.items || [];
  const item = u ? previewItem(u, t) : null;
  const key = item ? mediaKey(i, item) : `${i}|${items.length ? 'gap' : 'card'}`;
  if (i !== trackUnit) renderTrack(i);
  paintMeta(u, r, item);
  if (key === shownKey) return syncVideo(t);
  shownKey = key;
  current = i;
  const stage = $('#ptStage');
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
    if (item.kind === 'video' && el.isConnected) videoEl = el;
  } else {
    media.clear();
    stage.innerHTML = items.length ? '<div class="pt-gap">这段没有画面</div>' : cardHTML(r, color);
  }
  prefetchNext(i, t);
  syncVideo(t, true);
}

/* ── 镜头轨：当前镜头的画面排布，可拖可填 ──
   上面一条正片轨（主画面，播放就放它），下面一条备选轨（不计时长、不播放）。
   色块可以在两条轨之间拖：正片拖到备选轨 = 先撤下来，原来的位置留空；
   备选拖上正片轨落在某段画面上 = 互换，落在空隙里 = 插进去（后面的画面往后让） */
const sec = x => (Math.round(x * 10) / 10).toFixed(1);
const unitRow = () => units[trackUnit]?.members[0] || null;
const clipLen = it => {
  if (it.kind !== 'video') return null;
  if (it.usage.clip) return it.usage.clip.out - it.usage.clip.in;
  return Number.isFinite(it.asset.durationSec) ? it.asset.durationSec : null;
};
const ALT_ROW = 30; // 备选轨一层的高度（时间上重叠的备选往下叠一层）
let trackAlts = []; // 当前镜头备选轨上的画面（altItems 的结果）

function renderTrack(i) {
  trackUnit = i;
  const box = $('#ptTrack');
  const u = units[i];
  $('.pt-progress').hidden = false;
  if (!u) return (box.hidden = true);
  const r = u.members[0];
  const ti = types();
  const items = u.layout?.items || [];
  const tl = timeline();
  trackAlts = u.layout ? altItems(state.assets || {}, u.members, tl) : [];
  const needs = !r.type || ti.needsVisual(r.type);
  if (!items.length && !trackAlts.length && !needs) return (box.hidden = true);
  box.hidden = false;
  const dur = u.end - u.start;
  if (!items.some(it => it.assetId === pick) && !trackAlts.some(it => it.assetId === pick))
    pick = items[0]?.assetId ?? null;
  const pct = x => `${Math.max(0, Math.min(100, (x / dur) * 100))}%`;
  // 刻度：大约每 1 / 2 / 5 / 10 秒一格
  const step = [1, 2, 5, 10, 15, 30].find(s => dur / s <= 14) || 60;
  let ticks = '';
  for (let x = 0; x <= dur + 1e-6; x += step) ticks += `<span class="ptt-tick" style="left:${pct(x)}">${x}s</span>`;
  // 句子分界（第 2 句起），方便对照；备选轨上只画线
  const cuts = u.members.slice(1).map(m => (tl.times.get(m.id)?.start ?? u.start) - u.start);
  const seps = cuts
    .map((at, k) => `<span class="ptt-sep" style="left:${pct(at)}"><b>${u.members[k + 1].no}</b></span>`)
    .join('');
  const bareSeps = cuts.map(at => `<span class="ptt-sep bare" style="left:${pct(at)}"></span>`).join('');
  // 句间停顿里延续的上一段画面：画成同色的淡尾巴，和预览里看到的对上
  const holds = items
    .map((it, k) => {
      const next = items[k + 1];
      if (!next || !heldThrough(u, it, next)) return '';
      const s = Math.min(it.end, dur);
      return `<span class="ptt-hold${k % 2 ? ' even' : ''}" style="left:${pct(s)};width:${pct(Math.min(next.start, dur) - s)}" title="句间停顿，${circled(it.n)} 接着播到 ${circled(next.n)} 出现"></span>`;
    })
    .join('');
  const blocks = items
    .map(it => {
      const end = Math.min(it.end, dur);
      const len = clipLen(it);
      const short = len != null && len < it.end - it.start - 0.05;
      const cls = ['ptt-block', it.assetId === pick ? 'on' : '', it.over ? 'over' : '', it.start >= dur ? 'gone' : '']
        .filter(Boolean)
        .join(' ');
      const title = `${circled(it.n)} ${it.asset.name || ''}\n${sec(it.start)}–${sec(it.end)} 秒${it.over ? '（超出口播）' : ''}${short ? `\n片段只有 ${sec(len)} 秒，后面停在最后一帧` : ''}\n拖到下面的备选轨：先撤下来`;
      return `<div class="${cls}" data-ptt="${esc(it.assetId)}" style="left:${pct(it.start)};width:${pct(Math.max(0, end - it.start))}" title="${esc(title)}"><span class="ptt-grip l" title="拖动裁剪开头；Shift 拖相接边调整切换点"></span><span class="ptt-label">${circled(it.n)} ${esc(it.asset.name || '')}</span>${short ? '<span class="ptt-short" style="left:' + ((len / Math.max(0.01, end - it.start)) * 100).toFixed(1) + '%"></span>' : ''}<span class="ptt-grip r" title="拖动裁剪结尾；Shift 拖相接边调整切换点"></span></div>`;
    })
    .join('');
  const altRows = Math.max(1, ...trackAlts.map(a => a.row + 1));
  const altBlocks = trackAlts
    .map(it => {
      const title = `备选 · ${it.asset.name || ''}\n${sec(it.start)}–${sec(it.end)} 秒（不播放、不计时长）\n拖上正片轨：落在画面上 = 互换，落在空隙里 = 插进去`;
      return `<div class="ptt-block alt${it.assetId === pick ? ' on' : ''}" data-ptt="${esc(it.assetId)}" data-alt="1" style="left:${pct(it.start)};width:${pct(Math.max(0, it.end - it.start))};top:${4 + it.row * ALT_ROW}px;height:${ALT_ROW - 6}px" title="${esc(title)}"><span class="ptt-grip l" title="拖动裁剪开头"></span><span class="ptt-label">${esc(it.asset.name || '')}</span><span class="ptt-grip r" title="拖动裁剪结尾"></span></div>`;
    })
    .join('');
  const timed = !!u.layout?.timed;
  box.innerHTML = `<div class="ptt-bar"><strong>画面时间</strong><span class="ptt-mode">${
    !items.length && !trackAlts.length
      ? ''
      : (timed ? '手动' : '按句子自动') +
        ' · 拖中间移动 / 换序，拖两端裁剪 · 上下拖动在正片和备选之间换 · I / O 裁到播放位置'
  }</span><span class="ptt-warn" id="pttWarn"></span><span class="spacer"></span>${timed ? '<button class="ptt-reset" id="pttReset" title="去掉手动时间，按每个画面的出现位置（第几句到第几句）排">恢复按句子</button>' : ''}</div>
    <div class="ptt-lanes" id="pttLanes">
      <span></span><div class="ptt-ruler" id="pttRuler" title="点击或拖动：跳到这个时间">${ticks}<span class="ptt-rhead" id="pttRHead"></span></div>
      <span class="ptt-lname">正片</span><div class="ptt-lane" id="pttLane">${seps}${holds}${blocks}<span class="ptt-insert" id="pttInsert" hidden></span><span class="ptt-head" id="pttHead"></span>${
        items.length ? '' : '<span class="ptt-empty">正片轨还没有画面：审核通过视频，或把备选拖上来</span>'
      }</div>
      <span class="ptt-lname alt">备选</span><div class="ptt-lane alt" id="pttAlt" style="height:${altRows * ALT_ROW + 4}px">${bareSeps}${altBlocks}<span class="ptt-insert" id="pttAltInsert" hidden></span>${
        trackAlts.length ? '' : '<span class="ptt-empty">排不下的通过视频放在这里；把正片拖下来也行</span>'
      }</div>
    </div>`;
  renderEdit();
  movePlayhead(currentTime());
  // 有镜头轨时上面那条总进度条就多余了（刻度尺本身可以点、可以拖）
  $('.pt-progress').hidden = true;
}

/* 选中画面的提醒（被前后画面挡住 / 超出口播 / 片段不够长），写在「画面时间」那一行，不另占一行 */
function renderEdit() {
  const el = $('#pttWarn');
  const u = units[trackUnit];
  if (!el || !u) return;
  const it = u.layout?.items.find(x => x.assetId === pick);
  const notes = [];
  if (editMsg) notes.push(editMsg);
  editMsg = '';
  if (it) {
    const dur = u.end - u.start;
    const len = clipLen(it);
    if (it.over) notes.push(`${circled(it.n)} 超出口播 ${sec(it.end - dur)} 秒，超出的部分不放`);
    if (len != null && len < it.end - it.start - 0.05)
      notes.push(`${circled(it.n)} 片段只有 ${sec(len)} 秒，后 ${sec(it.end - it.start - len)} 秒停在最后一帧`);
  }
  el.textContent = notes.join(' · ');
}

function movePlayhead(t) {
  const u = units[trackUnit];
  const head = $('#pttHead');
  if (!u || !head) return;
  const rel = Math.max(0, Math.min(u.end - u.start, t - u.start));
  head.style.left = `${(rel / (u.end - u.start)) * 100}%`;
  const rh = $('#pttRHead');
  if (rh) rh.style.left = head.style.left;
}

/* 时间与片段一次提交，一次撤销；拖动不会改变播放头。 */
function commitEdit(draft, label) {
  const row = unitRow();
  if (row && draft?.changed) setShotTimes(row, draft.entries, label);
}
/* 两条轨一起改：mains / alts 两组 entries */
function commitTracks(draft, label) {
  const row = unitRow();
  if (row && draft) arrangeShot(row, { mains: draft.mains || [], alts: draft.alts || [] }, label);
}

function setEdge(which, v) {
  const u = units[trackUnit];
  const items = u?.layout?.items || [];
  const alt = trackAlts.find(x => x.assetId === pick);
  const k = items.findIndex(x => x.assetId === pick);
  if ((k < 0 && !alt) || !Number.isFinite(v)) return;
  const draft = alt
    ? trimPicture([alt], 0, which, v, u.end - u.start)
    : trimPicture(items, k, which, v, u.end - u.start);
  if (!draft) return;
  const got = which === 'start' ? draft.start : draft.end;
  if (Math.abs(v - got) > 0.05) editMsg = '已到相邻画面、口播或素材的边界';
  const label = which === 'start' ? '裁剪画面开头' : '裁剪画面结尾';
  if (alt) draft.changed && commitTracks({ alts: draft.entries }, label);
  else commitEdit(draft, label);
  renderEdit();
}

/* 只展示正在裁的首 / 尾帧，不定位口播，也不写入项目。 */
function showTrimFrame(it, entry, edge) {
  const clip = entry.clip || it.usage.clip;
  const cin = clip?.in || 0;
  const end = Math.min(clip?.out ?? it.asset.durationSec ?? Infinity, cin + entry.end - entry.start);
  const target = edge === 'start' ? cin : Math.max(cin, end - 0.04);
  const preview = { ...it, usage: { ...it.usage, ...(clip ? { clip } : {}) } };
  videoEl?.pause();
  videoEl = null;
  shownKey = '';
  $('#ptStage').classList.remove('pt-short');
  media.show(`trim|${it.assetId}`, preview, target, () => {});
}

/* 拖中间移动 / 插入换序，拖边裁剪；Shift 拖相接边调整两段切换点；上下拖在正片和备选之间换。
   没有磁吸，鼠标落点只受时间线、相邻画面和实际素材长度约束。 */
function onLaneDown(e) {
  const lanes = $('#pttLanes');
  const lane = $('#pttLane');
  const altLane = $('#pttAlt');
  const u = units[trackUnit];
  if (!lanes || !lane || !u || e.button !== 0 || drag) return;
  const rect = lane.getBoundingClientRect();
  const dur = u.end - u.start;
  const toSec = x => ((x - rect.left) / rect.width) * dur;
  const block = e.target.closest('.ptt-block');
  if (!block) {
    seek(u.start + Math.max(0, Math.min(dur, toSec(e.clientX))));
    return;
  }
  e.preventDefault();
  const items = u.layout.items;
  const isAlt = !!block.dataset.alt;
  const k = isAlt ? -1 : items.findIndex(x => x.assetId === block.dataset.ptt);
  const it = isAlt ? trackAlts.find(x => x.assetId === block.dataset.ptt) : items[k];
  if (!it) return;
  if (playing) stop();
  // 显式命中把手；窄素材的中间仍然可以用于排序。
  const grip = e.target.closest('.ptt-grip');
  const mode = grip ? (grip.classList.contains('l') ? 'start' : 'end') : 'move';
  const cutIndex = mode === 'start' ? k - 1 : k;
  const roll =
    !isAlt &&
    !!e.shiftKey &&
    mode !== 'move' &&
    cutIndex >= 0 &&
    items[cutIndex + 1] &&
    Math.abs(items[cutIndex].end - items[cutIndex + 1].start) <= 0.05;
  pick = it.assetId;
  for (const el of lanes.querySelectorAll('.ptt-block')) el.classList.toggle('on', el === block);
  const insert = $('#pttInsert');
  const altInsert = $('#pttAltInsert');
  const feedback = $('#pttWarn');
  const oldFeedback = feedback.textContent;
  drag = {
    sig: shotSig(),
    k,
    it,
    mode,
    x0: e.clientX,
    y0: e.clientY,
    s0: it.start,
    e0: Math.min(it.end, dur),
    moved: false,
    cur: null,
    kind: '',
  };
  const swapTarget = el => {
    for (const b of lane.querySelectorAll('.ptt-block')) b.classList.toggle('swap', b === el);
  };
  dragCleanup = () => {
    lanes.onpointermove = lanes.onpointerup = lanes.onpointercancel = lanes.onlostpointercapture = null;
    block.classList.remove('dragging');
    block.style.transform = '';
    swapTarget(null);
    if (insert) insert.hidden = true;
    if (altInsert) altInsert.hidden = true;
    feedback.textContent = oldFeedback;
    try {
      if (lanes.hasPointerCapture(e.pointerId)) lanes.releasePointerCapture(e.pointerId);
    } catch {}
  };
  // 原生文件名悬浮框会遮住正在拖的素材。
  for (const el of lanes.querySelectorAll('[title]')) el.removeAttribute('title');
  try {
    lanes.setPointerCapture(e.pointerId);
  } catch {}
  // 正片轨的色块按草稿摆（没给的回到原位）
  const placeMains = entries => {
    for (const el of lane.querySelectorAll('.ptt-block')) {
      if (el === block) continue;
      const entry = entries?.find(x => x.assetId === el.dataset.ptt);
      const orig = items.find(x => x.assetId === el.dataset.ptt);
      const src = entry || orig;
      if (!src) continue;
      el.style.left = `${(src.start / dur) * 100}%`;
      el.style.width = `${(Math.max(0, Math.min(src.end, dur) - src.start) / dur) * 100}%`;
    }
  };
  lanes.onpointermove = ev => {
    if (!drag || ev.pointerId !== e.pointerId) return;
    const delta = toSec(ev.clientX) - toSec(drag.x0);
    if ((Math.abs(ev.clientX - drag.x0) > 3 || Math.abs(ev.clientY - drag.y0) > 6) && !drag.moved) {
      drag.moved = true;
      if (playing) stop();
      block.classList.add('dragging');
    }
    if (!drag.moved) return;
    const len = drag.e0 - drag.s0;
    const start = drag.s0 + delta;
    swapTarget(null);
    insert.hidden = true;
    altInsert.hidden = true;
    if (mode === 'move') {
      const mainBox = lane.getBoundingClientRect();
      const altBox = altLane.getBoundingClientRect();
      const toAlt = !isAlt && ev.clientY > (mainBox.bottom + altBox.top) / 2;
      const toMain = isAlt && ev.clientY < (mainBox.bottom + altBox.top) / 2;
      // 色块跟着鼠标走（上下换轨时也跟着），其余色块展示松手后的排布
      block.style.left = `${(Math.max(0, Math.min(dur - len, start)) / dur) * 100}%`;
      block.style.transform = toAlt || toMain ? `translateY(${ev.clientY - drag.y0}px)` : '';
      if (toAlt) {
        drag.kind = 'toAlt';
        drag.cur = dropToAlt(items, k, start, dur);
        placeMains(drag.cur?.mains);
        altInsert.hidden = false;
        altInsert.style.left = `${(drag.cur.alts[0].start / dur) * 100}%`;
        feedback.textContent = '松手放到备选轨：先撤下来，原来的位置留空';
      } else if (toMain) {
        const slot = mainSlotAt(items, Math.max(0, toSec(ev.clientX)), dur);
        if (slot.kind === 'on') {
          drag.kind = 'swap';
          drag.cur = swapIntoMain(items, slot.index, it, dur);
          placeMains(null);
          swapTarget(lane.querySelector(`.ptt-block[data-ptt="${CSS.escape(items[slot.index].assetId)}"]`));
          feedback.textContent = `松手和 ${circled(items[slot.index].n)} 互换`;
        } else {
          drag.kind = 'insert';
          const at = Math.max(slot.start, Math.min(start, Math.max(slot.start, slot.end - MIN_LEN)));
          drag.cur = insertIntoMain(items, it, at, dur);
          placeMains(drag.cur.mains);
          insert.hidden = false;
          insert.style.left = `${(drag.cur.mains[drag.cur.index].start / dur) * 100}%`;
          feedback.textContent = `松手放上正片轨（${sec(drag.cur.mains[drag.cur.index].start)} 秒起）`;
        }
      } else if (isAlt) {
        drag.kind = 'alt';
        const entry = moveAlt(it, start, dur);
        drag.cur = { alts: [entry], changed: Math.abs(entry.start - it.start) > 0.05 };
        placeMains(null);
        feedback.textContent = `备选 ${sec(entry.start)}–${sec(entry.end)} 秒`;
      } else {
        drag.kind = 'main';
        drag.cur = movePicture(items, k, start, dur);
        if (!drag.cur) return;
        placeMains(drag.cur.entries);
        insert.hidden = !drag.cur.reordered;
        insert.style.left = `${(drag.cur.start / dur) * 100}%`;
        feedback.textContent = drag.cur.reordered
          ? `松手放到第 ${drag.cur.index + 1} 个画面`
          : `${sec(drag.cur.start)}–${sec(drag.cur.end)} 秒`;
      }
      return;
    }
    const value = (mode === 'start' ? drag.s0 : drag.e0) + delta;
    drag.kind = isAlt ? 'alt' : 'main';
    drag.cur = isAlt
      ? trimPicture([it], 0, mode, value, dur)
      : roll
        ? rollPictures(items, cutIndex, value, dur)
        : trimPicture(items, k, mode, value, dur);
    const draft = drag.cur;
    if (!draft) return;
    if (isAlt) {
      const entry = draft.entries[0];
      block.style.left = `${(entry.start / dur) * 100}%`;
      block.style.width = `${(Math.max(0, entry.end - entry.start) / dur) * 100}%`;
      draft.alts = draft.entries;
    } else {
      placeMains(draft.entries);
      const own = draft.entries.find(x => x.assetId === it.assetId);
      block.style.left = `${(own.start / dur) * 100}%`;
      block.style.width = `${(Math.max(0, Math.min(own.end, dur) - own.start) / dur) * 100}%`;
    }
    feedback.textContent = roll ? `切换点 ${sec(draft.cut)} 秒` : `${sec(draft.start)}–${sec(draft.end)} 秒`;
    const entry = draft.entries.find(x => x.assetId === it.assetId);
    showTrimFrame(it, entry, mode);
  };
  lanes.onpointerup = ev => {
    if (ev && ev.pointerId !== e.pointerId) return;
    const d = drag;
    clearDrag();
    if (!d) return;
    if (!d.moved || !d.cur) {
      renderTrack(trackUnit);
      if (refreshAfterDrag) refreshSoon();
      return;
    }
    // 拖的这几秒里这个画面被别处改过（协作对方动了它）：草稿是按旧排布算的，不提交，免得盖掉对方的改动
    if (shotSig() !== d.sig) {
      editMsg = '拖动期间这个画面被改过，这次没有保存，请再拖一次';
      refreshSoon();
      return;
    }
    if (d.kind === 'toAlt') commitTracks(d.cur, '画面移到备选轨');
    else if (d.kind === 'swap') commitTracks(d.cur, '备选换上正片轨');
    else if (d.kind === 'insert') commitTracks({ mains: d.cur.mains }, '备选放上正片轨');
    else if (d.kind === 'alt') {
      if (d.cur.changed) commitTracks(d.cur, mode === 'move' ? '移动备选' : '裁剪备选');
    } else
      commitEdit(
        d.cur,
        roll
          ? '调整画面切换点'
          : mode === 'move'
            ? d.cur.reordered
              ? '调换画面顺序'
              : '移动画面时间'
            : mode === 'start'
              ? '裁剪画面开头'
              : '裁剪画面结尾',
      );
    // 被边界挡住也要恢复草稿画面，播放头保持原来的秒数。
    renderTrack(trackUnit);
    refreshSoon();
  };
  lanes.onpointercancel = lanes.onlostpointercapture = () => {
    clearDrag();
    if (open) {
      renderTrack(trackUnit);
      refreshSoon();
    }
  };
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
/* 拖动中途来的刷新（协作对方改了别处、后台保存……）不打断拖动：记下来，松手后再刷新。
   以前会直接取消拖动，色块弹回原位，看着像被句子吸住、怎么也拖不动 */
let refreshAfterDrag = false;
function refreshSoon() {
  if (!open) return;
  if (drag) {
    refreshAfterDrag = true;
    return;
  }
  refreshAfterDrag = false;
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    if (!open || detached()) return;
    if (drag) {
      refreshAfterDrag = true;
      return;
    }
    const keep = units[trackUnit]?.members[0]?.id;
    media.clear();
    videoEl = null;
    buildUnits();
    const i = keep != null ? unitOfRow(keep) : -1;
    if (range && i >= 0) range = { start: units[i].start, end: units[i].end };
    trackUnit = -1;
    shownKey = '';
    metaHtml = '';
    const t = currentTime();
    tick(t);
    if (i >= 0 && trackUnit !== i) renderTrack(i);
  }, 0);
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
  if (playing && !over && v.paused) v.play().catch(() => {});
  if ((!playing || over) && !v.paused) v.pause();
  $('#ptStage').classList.toggle('pt-short', over && t < segEnd);
}

/* ── 时钟：有口播跟口播走，没有就自己走 ── */
const currentTime = () => (voiceClock && useVoice() ? voicePlayer.currentTime() : clockT);

function tick(t) {
  if (!open || detached()) return;
  clockT = t;
  if (range && t >= range.end - 0.02) {
    // 「对着口播看画面」播完这个镜头：接着播下一个镜头（镜头轨和进度条跟着换过去）；最后一个镜头才停
    // 嵌在审核页里时只看这一个画面：播到末尾就停
    const next = docked ? -1 : units.findIndex(x => x.start >= range.end - 0.05);
    if (playing && next >= 0) range = { start: units[next].start, end: units[next].end };
    else {
      if (playing) stop();
      t = Math.min(t, range.end);
    }
  }
  const i = unitAt(t);
  showUnit(i, t);
  const u = units[i];
  const r = u ? rowAtIn(u, t) : null;
  $('#ptSub').textContent = r ? r.text : '';
  $('#ptTime').textContent = `${fmtTime(t)} / ${fmtTime(range ? range.end : timeline().total)}`;
  movePlayhead(t);
  const span = range ? range.end - range.start : timeline().total;
  $('#ptBar').style.width = `${Math.min(100, ((t - (range?.start || 0)) / Math.max(0.01, span)) * 100)}%`;
}

function frame(now) {
  if (!playing) return;
  if (detached()) return stop();
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (!voiceClock || !useVoice()) {
    if (voiceClock) {
      voiceClock = false;
      renderHint();
    }
    clockT += dt;
    tick(clockT);
    if (!range && clockT >= timeline().total) stop();
  } else if (voicePlayer.currentTime() >= voiceEnd() && timeline().total > voiceEnd()) {
    // 录音只覆盖部分稿件：到录音结尾后继续预览后面的画面，不能把画面拖回录音末尾。
    clockT = voiceEnd();
    voiceClock = false;
    voicePlayer.pause();
    renderHint();
    tick(clockT);
  } else if (!voicePlayer.isPlaying() && now - startedAt > 800) {
    // 口播自己停了（播完 / 被别处暂停）：画面也停
    stop();
    return;
  } else {
    // 音频的 timeupdate 约每 250 毫秒才来一次；画面用每一帧的音频位置切换。
    tick(voicePlayer.currentTime());
  }
  raf = requestAnimationFrame(frame);
}

function play() {
  if (!open) return;
  docked?.onPlay?.();
  playing = true;
  startedAt = performance.now();
  let t = currentTime();
  // 停在这个镜头末尾时按播放：直接从下一个镜头开始（没有下一个就从这个镜头开头重播）
  if (range && t >= range.end - 0.05) {
    const next = docked ? -1 : units.findIndex(x => x.start >= range.end - 0.05);
    const u = next >= 0 ? units[next] : units.find(x => x.start <= range.start + 0.01 && x.end >= range.end - 0.01);
    if (u) {
      range = { start: u.start, end: u.end };
      t = u.start;
      clockT = t;
    }
  }
  // 口播一路往下播，镜头之间的衔接由 tick 负责（不在镜头末尾让口播自己停下）
  clockT = t;
  voiceClock = voiceAt(t);
  if (voiceClock) voicePlayer.playRange(t, null);
  else voicePlayer.pause();
  renderHint();
  lastFrame = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
  syncVideo(t, true);
  renderControls();
}
function stop() {
  playing = false;
  cancelAnimationFrame(raf);
  voicePlayer.pause();
  videoEl?.pause();
  renderControls();
}
function seek(t) {
  if (range) t = Math.max(range.start, Math.min(range.end, t));
  clockT = t;
  voiceClock = voiceAt(t);
  if (voiceClock) voicePlayer.seek(t);
  else voicePlayer.pause();
  renderHint();
  // 不重建画面：同一个素材里拖动只挪视频位置（重建 <video> 会先黑一下）
  tick(t);
  syncVideo(t, true);
  if (playing) play();
}

function renderControls() {
  const b = $('#ptPlay');
  if (b) b.innerHTML = playing ? `${ICON_PAUSE}暂停` : `${ICON_PLAY}播放`;
}

/* from：从哪句开始；only：只播这一个镜头 */
function openPlaythrough(fromId, { only = false } = {}) {
  // 正嵌在审核页里：先收回来当弹窗用，关掉弹窗后审核页再接回去
  if (docked) {
    lostDock = docked.onLost || null;
    undockPlaythrough();
  }
  if (open) stop();
  media.clear();
  buildUnits();
  if (!units.length) return;
  let i = unitOfRow(fromId);
  if (i < 0) i = 0;
  const u = units[i];
  range = only ? { start: u.start, end: u.end } : null;
  open = true;
  current = -1;
  shownKey = '';
  metaHtml = '';
  trackUnit = -1;
  pick = null;
  $('#ptMask').classList.add('show');
  $('#ptTitle').textContent = only ? '对着口播看画面' : '连播预览';
  untick?.();
  untick = voicePlayer.onTick(t => playing && voiceClock && tick(t));
  seek(u.start);
  play();
}

export function closePlaythrough() {
  if (!open) return;
  if (docked) return undockPlaythrough();
  clearDrag();
  stop();
  open = false;
  untick?.();
  untick = null;
  videoEl = null;
  media.clear();
  $('#ptMask').classList.remove('show');
  const back = lostDock;
  lostDock = null;
  back?.();
}

/* ── 嵌进审核页：同一个播放器和画面时间轴，挪到审核页给的两个位置里，只看一个画面 ──
   slots.player 放画面 + 字幕 + 播放按钮，slots.track 放两条轨。onPlay：开始播放前调（审核页停掉候选片段）；
   onLost：弹窗版「对着口播看画面」临时借走后、关掉时调（审核页重新接回去）。
   同一个画面重新接回（审核页重画）时保留播放位置 */
let docked = null;
let lostDock = null;
let boxEl = null; // 播放器整块和镜头轨：嵌进审核页时会被挪走（审核页重画时还会短暂离开页面），一直按引用找
let trackEl = null;
const detached = () => !!docked && !boxEl?.isConnected;
export function dockPlaythrough(slots, rowId, { onPlay, onLost } = {}) {
  const box = boxEl;
  const track = trackEl;
  if (!box || !slots?.player || !slots?.track) return false;
  if (open && !docked) closePlaythrough();
  const sameRow = !!docked && docked.rowId === rowId && open;
  const keepT = sameRow ? currentTime() : null;
  docked = { player: slots.player, track: slots.track, rowId, onPlay, onLost };
  box.classList.add('docked');
  if (box.parentNode !== slots.player) slots.player.appendChild(box);
  if (track.parentNode !== slots.track) slots.track.appendChild(track);
  if (sameRow && units.length) {
    // 画面节点换了位置：重建一次画面，时间不动
    shownKey = '';
    metaHtml = '';
    trackUnit = -1;
    media.clear();
    videoEl = null;
    tick(keepT);
    return true;
  }
  stop();
  media.clear();
  buildUnits();
  const i = unitOfRow(rowId);
  if (i < 0) {
    undockPlaythrough();
    return false;
  }
  const u = units[i];
  range = { start: u.start, end: u.end };
  open = true;
  current = -1;
  shownKey = '';
  metaHtml = '';
  trackUnit = -1;
  pick = null;
  untick?.();
  untick = voicePlayer.onTick(t => playing && voiceClock && tick(t));
  seek(u.start);
  return true;
}
/* 当前镜头的素材使用记录（从项目里现取，协作同步换掉句子对象也认得出来）：拖动前后比一比有没有被别处改过 */
function shotSig() {
  const lead = rowById(units[trackUnit]?.members[0]?.id);
  if (!lead) return '';
  return JSON.stringify(shotMembers(state.rows, lead).map(m => m.assetUsages || []));
}
/* 正在拖镜头轨上的色块：审核页这时先不重画（重画会把轨道从页面上拿下来，拖动就断了） */
export const trackDragging = () => !!drag;

export function undockPlaythrough() {
  if (!docked) return;
  clearDrag();
  stop();
  open = false;
  untick?.();
  untick = null;
  videoEl = null;
  media.clear();
  const box = boxEl;
  const track = trackEl;
  box.classList.remove('docked');
  box.insertBefore(track, box.querySelector('.pt-controls'));
  $('#ptMask').appendChild(box);
  docked = null;
}
/* 审核页要放候选片段时：嵌着的这个先停 */
export function pauseDocked() {
  if (docked && playing) stop();
}
export const isDocked = () => !!docked;
/* 嵌着时的空格：播放 / 暂停这个画面 */
export function toggleDocked() {
  if (!docked) return false;
  playing ? stop() : play();
  return true;
}

export function playthroughKey(e) {
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
    playing ? stop() : play();
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
  if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'i' || e.key === 'I' || e.key === 'o' || e.key === 'O')) {
    const u = units[trackUnit];
    if (!u || !pick) return true;
    e.preventDefault();
    setEdge(e.key.toLowerCase() === 'i' ? 'start' : 'end', currentTime() - u.start);
    return true;
  }
  return false;
}

export function initPlaythrough() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask pt-mask" id="ptMask"><div class="pt-box" role="dialog" aria-label="连播预览">
      <div class="pt-head"><strong id="ptTitle">连播预览</strong><span class="pt-hint" id="ptHint"></span><span class="spacer"></span><button class="btn" id="ptClose">关闭 <kbd>Esc</kbd></button></div>
      <div class="pt-stage" id="ptStage"></div>
      <div class="pt-sub" id="ptSub"></div>
      <div class="pt-meta" id="ptMeta"></div>
      <div class="pt-progress"><div id="ptBar"></div></div>
      <div class="pt-track" id="ptTrack" hidden></div>
      <div class="pt-controls"><button class="btn" id="ptPrev" title="上一个镜头（←）" aria-label="上一个镜头">${ICON_PREV}</button><button class="btn primary" id="ptPlay">${ICON_PLAY}播放</button><button class="btn" id="ptNext" title="下一个镜头（→）" aria-label="下一个镜头">${ICON_NEXT}</button><span class="pt-time mono" id="ptTime"></span><span class="spacer"></span><span class="pt-keys"><kbd>空格</kbd> 播放 / 暂停 · <kbd>← →</kbd> 上 / 下一个镜头</span></div>
    </div></div>`,
  );
  boxEl = $('.pt-box');
  trackEl = $('#ptTrack');
  $('#ptClose').onclick = closePlaythrough;
  media = createPreviewMedia($('#ptStage'));
  $('#ptPlay').onclick = () => (playing ? stop() : play());
  $('#ptPrev').onclick = () => playthroughKey({ key: 'ArrowLeft', preventDefault() {} });
  $('#ptNext').onclick = () => playthroughKey({ key: 'ArrowRight', preventDefault() {} });
  $('#ptMask').addEventListener('click', e => {
    if (e.target.id === 'ptMask') closePlaythrough();
  });
  const track = $('#ptTrack');
  track.addEventListener('pointerdown', e => {
    const ruler = e.target.closest('#pttRuler');
    if (ruler) {
      const u = units[trackUnit];
      if (u) scrub(e, ruler, f => u.start + f * (u.end - u.start));
      return;
    }
    if (e.target.closest('#pttLane, #pttAlt')) onLaneDown(e);
  });
  const bar = $('.pt-progress');
  bar.title = '点击或拖动：跳到这个时间';
  bar.addEventListener('pointerdown', e =>
    scrub(e, bar, f => (range ? range.start + f * (range.end - range.start) : f * timeline().total)),
  );
  track.addEventListener('click', e => {
    if (e.target.closest('#pttReset')) {
      const row = unitRow();
      if (row) clearShotTimes(row);
    }
  });
  on('workspace', refreshSoon);
  on('project-changed', refreshSoon);
  on('assets-changed', refreshSoon);
  on('rows', refreshSoon);
  on('history', refreshSoon);
  registerCommand('playthrough:from', id => openPlaythrough(id ?? state.sel));
  registerCommand('playthrough:shot', id => openPlaythrough(id, { only: true }));
  on('project-loaded', closePlaythrough);
}

/* 测试 / 调试用：当前状态 */
export const playthroughState = () => ({
  open,
  playing,
  current,
  units: units.length,
  range,
  row: rowById(units[current]?.members[0]?.id)?.id,
  layout: units[trackUnit]?.layout || null,
  shown: shownKey,
  time: currentTime(),
  voiceClock,
  docked: !!docked,
  alts: trackAlts.map(a => ({ assetId: a.assetId, start: a.start, end: a.end, row: a.row })),
});
