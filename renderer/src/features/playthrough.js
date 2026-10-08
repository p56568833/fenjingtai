/* 连播预览（粗剪样片）：口播一路往下播，画面按镜头里的主画面排布自动切换（见 core/shot-layout.js）：
   一个镜头可以有多个主画面 ①②③…，各占一段；排布里空着的地方黑屏（下面照常出字幕）。
   视频从入点开始静音播放、图片静止显示；不需要配画面的类型（如 A roll）显示「真人出镜」卡；
   一个画面都没挂的显示画面描述。没有口播音频时按估算时间静音走一遍。
   「对着口播看画面」= 只播一个镜头的范围。
   窗口下方的「镜头轨」= 当前这个镜头的口播时长，每个主画面一个色块：拖边改开始 / 结束、拖中间整体平移、
   点中后可以直接填秒数，或者播到想要的位置按 I / O 打点。改动即保存、可撤销。 */
import { state, on, timeline, rowById, types } from '../app/state.js';
import { shots } from '../core/shots.js';
import { spanOf } from '../core/timeline.js';
import { fmtTime, fmtLen } from '../core/text.js';
import { fileUrl } from '../core/asset-model.js';
import { layoutShot, itemAt, circled, clampSpan, MIN_LEN } from '../core/shot-layout.js';
import { setShotTimes, clearShotTimes } from '../app/asset-actions.js';
import { esc, ICON_PLAY, ICON_PAUSE, ICON_PREV, ICON_NEXT } from '../ui/dom.js';
import { typeIcon } from '../ui/type-view.js';
import { registerCommand } from '../ui/commands.js';
import { voicePlayer } from './voice.js';

const $ = s => document.querySelector(s);
let open = false;
let units = []; // [{members, start, end, layout}]
let range = null; // {start, end} 本次播放范围
let current = -1; // 当前镜头下标
let playing = false;
let clockT = 0; // 没有口播音频时的虚拟时钟
let lastFrame = 0;
let raf = 0;
let untick = null;
let videoEl = null;
let startedAt = 0;
let shownKey = ''; // 当前上屏的是哪个镜头的哪个素材：变了才换画面
let segStart = 0; // 当前素材在口播里开始出现的时间（视频从入点 + 这之后过去的时间播）
let trackUnit = -1; // 镜头轨现在画的是哪个镜头
let pick = null; // 镜头轨上选中的画面（assetId）
let drag = null; // 正在拖的色块
let editMsg = ''; // 填的秒数被前后画面挡住时的提示（只显示一次）

const useVoice = () => voicePlayer.available();

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

/* 镜头里此刻正在说的那句 */
function rowAtIn(u, t) {
  const tl = timeline();
  const hit = u.members.find(x => {
    const tm = tl.times.get(x.id);
    return tm && tm.start <= t + 1e-6 && t < tm.end;
  });
  return hit || (t < u.start ? u.members[0] : u.members[u.members.length - 1]);
}

/* ── 画面：按镜头排布换素材（空着的地方黑屏） ── */
function showUnit(i, t) {
  const u = units[i];
  const r = u ? rowAtIn(u, t) : null;
  const items = u?.layout?.items || [];
  const item = u ? itemAt(u.layout, t - u.start) : null;
  const key = `${i}|${item ? `${item.assetId}@${item.start}` : items.length ? 'gap' : 'card'}`;
  if (i !== trackUnit) renderTrack(i);
  if (key === shownKey) return syncVideo(t);
  shownKey = key;
  current = i;
  const stage = $('#ptStage');
  videoEl = null;
  if (!u) return stage.replaceChildren();
  segStart = u.start + (item ? item.start : 0);
  const ti = types();
  const color = ti.color(r.type) || '#8a93a6';
  if (item && item.kind === 'video') {
    const v = document.createElement('video');
    v.className = 'pt-media';
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = fileUrl(item.asset.path);
    v.dataset.in = String(item.usage.clip?.in || 0);
    v.dataset.out = String(item.usage.clip?.out ?? '');
    v.addEventListener('loadedmetadata', () => syncVideo(currentTime(), true), { once: true });
    v.addEventListener('error', () => {
      if (v.isConnected) stage.innerHTML = cardHTML(r, color, '视频读不出来（文件失联或格式不支持）');
    });
    swapIn(stage, v, 'seeked');
    videoEl = v;
  } else if (item && item.kind === 'image') {
    const img = document.createElement('img');
    img.className = 'pt-media';
    img.src = fileUrl(item.asset.path);
    img.onerror = () =>
      img.isConnected && (stage.innerHTML = cardHTML(r, color, '图片读不出来（文件失联或格式不支持）'));
    swapIn(stage, img, 'load');
  } else if (items.length) {
    stage.innerHTML = '<div class="pt-gap">这段没有画面</div>';
  } else {
    stage.innerHTML = cardHTML(r, color);
  }
  const t0 = ti.get(r.type);
  $('#ptMeta').innerHTML =
    `<span class="pt-type" style="--tc:${color}">${t0 ? typeIcon(t0) + esc(t0.label) : '未标注'}</span>` +
    `<span>第 ${u.members[0].no}${u.members.length > 1 ? '–' + u.members[u.members.length - 1].no : ''} 句 · ${fmtLen(u.end - u.start)}</span>` +
    (item
      ? `<span>${circled(item.n)} ${esc(item.asset.name || '')}${item.usage.clip ? ` · 片段 ${fmtTime(item.usage.clip.in)}–${fmtTime(item.usage.clip.out)}` : ''}</span>`
      : '');
  syncVideo(t, true);
}

/* ── 镜头轨：当前镜头的画面排布，可拖可填 ── */
const sec = x => (Math.round(x * 10) / 10).toFixed(1);
const unitRow = () => units[trackUnit]?.members[0] || null;
const clipLen = it => {
  if (it.kind !== 'video') return null;
  if (it.usage.clip) return it.usage.clip.out - it.usage.clip.in;
  return Number.isFinite(it.asset.durationSec) ? it.asset.durationSec : null;
};

function renderTrack(i) {
  trackUnit = i;
  const box = $('#ptTrack');
  const u = units[i];
  $('.pt-progress').hidden = false;
  if (!u) return (box.hidden = true);
  const r = u.members[0];
  const ti = types();
  const items = u.layout?.items || [];
  const needs = !r.type || ti.needsVisual(r.type);
  if (!items.length && !needs) return (box.hidden = true);
  box.hidden = false;
  const dur = u.end - u.start;
  if (!items.some(it => it.assetId === pick)) pick = items[0]?.assetId ?? null;
  const pct = x => `${Math.max(0, Math.min(100, (x / dur) * 100))}%`;
  // 刻度：大约每 1 / 2 / 5 / 10 秒一格
  const step = [1, 2, 5, 10, 15, 30].find(s => dur / s <= 14) || 60;
  let ticks = '';
  for (let x = 0; x <= dur + 1e-6; x += step) ticks += `<span class="ptt-tick" style="left:${pct(x)}">${x}s</span>`;
  // 句子分界（第 2 句起），方便对照
  const tl = timeline();
  const seps = u.members
    .slice(1)
    .map(m => {
      const at = (tl.times.get(m.id)?.start ?? u.start) - u.start;
      return `<span class="ptt-sep" style="left:${pct(at)}"><b>${m.no}</b></span>`;
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
      const title = `${circled(it.n)} ${it.asset.name || ''}\n${sec(it.start)}–${sec(it.end)} 秒${it.over ? '（超出口播）' : ''}${short ? `\n片段只有 ${sec(len)} 秒，后面停在最后一帧` : ''}`;
      return `<div class="${cls}" data-ptt="${esc(it.assetId)}" style="left:${pct(it.start)};width:${pct(Math.max(0, end - it.start))}" title="${esc(title)}"><span class="ptt-grip l"></span><span class="ptt-label">${circled(it.n)} ${esc(it.asset.name || '')}</span>${short ? '<span class="ptt-short" style="left:' + ((len / Math.max(0.01, end - it.start)) * 100).toFixed(1) + '%"></span>' : ''}<span class="ptt-grip r"></span></div>`;
    })
    .join('');
  const timed = !!u.layout?.timed;
  box.innerHTML = `<div class="ptt-bar"><strong>画面时间</strong><span class="ptt-mode">${
    !items.length ? '' : (timed ? '手动' : '按句子自动') + ' · 拖色块调整，点中后按 I / O 把播放位置设为开始 / 结束'
  }</span><span class="ptt-warn" id="pttWarn"></span><span class="spacer"></span>${timed ? '<button class="ptt-reset" id="pttReset" title="去掉手动时间，按每个画面的出现位置（第几句到第几句）排">恢复按句子</button>' : ''}</div>
    <div class="ptt-ruler" id="pttRuler" title="点击或拖动：跳到这个时间">${ticks}<span class="ptt-rhead" id="pttRHead"></span></div>
    <div class="ptt-lane" id="pttLane">${seps}${blocks}<span class="ptt-head" id="pttHead"></span>${
      items.length
        ? ''
        : '<span class="ptt-empty">这段还没有主画面：在「画面与素材」里把素材设成主画面，就能在这里调它出现的秒数</span>'
    }</div>`;
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

/* 把这个镜头里所有画面的时间写回（拖动一个时其他画面也固定下来） */
function commitTimes(changed, label) {
  const u = units[trackUnit];
  const row = unitRow();
  if (!u || !row) return;
  const dur = u.end - u.start;
  const entries = u.layout.items.map(it => {
    const c = changed.assetId === it.assetId ? changed : null;
    return {
      assetId: it.assetId,
      start: c ? c.start : it.start,
      end: c ? c.end : Math.max(it.end, it.start + MIN_LEN),
    };
  });
  // 自动排的画面末端可能超出口播一点（按句子排时句尾），写进去前收进口播范围
  for (const e of entries) if (e.assetId !== changed.assetId) e.end = Math.min(e.end, Math.max(dur, e.start + MIN_LEN));
  setShotTimes(row, entries, label);
}

/* 选中画面的开始 / 结束改成 v 秒（输入框、I / O 打点） */
function setEdge(which, v) {
  const u = units[trackUnit];
  const items = u?.layout?.items || [];
  const k = items.findIndex(x => x.assetId === pick);
  if (k < 0 || !Number.isFinite(v)) return;
  const it = items[k];
  const dur = u.end - u.start;
  const next = which === 'start' ? { start: v, end: Math.max(it.end, v + MIN_LEN) } : { start: it.start, end: v };
  const c = clampSpan(items, k, next.start, next.end, dur, which);
  const asked = which === 'start' ? next.start : next.end;
  const got = which === 'start' ? c.start : c.end;
  if (Math.abs(asked - got) > 0.05) {
    const by =
      which === 'start'
        ? k > 0 && got <= Math.min(items[k - 1].end, dur) + 0.05
          ? `已到 ${circled(items[k - 1].n)} 的结尾为止`
          : '最早从 0 秒开始'
        : k < items.length - 1 && got >= items[k + 1].start - 0.05
          ? `已到 ${circled(items[k + 1].n)} 的开头为止，要更长先把 ${circled(items[k + 1].n)} 往后挪`
          : `这段口播只有 ${sec(dur)} 秒`;
    editMsg = `想设 ${sec(asked)} 秒：${by}`;
  }
  commitTimes({ assetId: it.assetId, ...c }, which === 'start' ? '设置画面开始时间' : '设置画面结束时间');
  renderEdit(); // 没有实际改动（被挡住）时也把提示显示出来
}

/* 拖动：边 = 改开始 / 结束，中间 = 平移。吸附到句子分界、播放头、前后画面的边（6 像素内） */
function onLaneDown(e) {
  const lane = $('#pttLane');
  const u = units[trackUnit];
  if (!lane || !u || e.button !== 0) return;
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
  const k = items.findIndex(x => x.assetId === block.dataset.ptt);
  const it = items[k];
  const bx = e.clientX - block.getBoundingClientRect().left;
  const bw = block.getBoundingClientRect().width;
  const mode = bx <= 7 ? 'start' : bx >= bw - 7 ? 'end' : 'move';
  pick = it.assetId;
  const tl = timeline();
  const snaps = [
    0,
    dur,
    currentTime() - u.start,
    ...u.members.slice(1).map(m => (tl.times.get(m.id)?.start ?? u.start) - u.start),
    ...items.filter(x => x !== it).flatMap(x => [x.start, Math.min(x.end, dur)]),
  ];
  const tol = (6 / rect.width) * dur;
  const snap = x => {
    const hit = snaps.reduce((b, p) => (Math.abs(p - x) < Math.abs(b - x) ? p : b), Infinity);
    return Math.abs(hit - x) <= tol ? hit : x;
  };
  drag = { k, it, mode, x0: e.clientX, s0: it.start, e0: Math.min(it.end, dur), moved: false, cur: null };
  block.classList.add('dragging');
  try {
    lane.setPointerCapture(e.pointerId);
  } catch {}
  lane.onpointermove = ev => {
    const d = toSec(ev.clientX) - toSec(drag.x0);
    if (Math.abs(ev.clientX - drag.x0) > 3) drag.moved = true;
    if (!drag.moved) return;
    let s = drag.s0,
      en = drag.e0;
    if (mode === 'move') {
      s = snap(drag.s0 + d);
      en = s + (drag.e0 - drag.s0);
      const se = snap(en);
      if (se !== en) {
        s += se - en;
        en = se;
      }
    } else if (mode === 'start') s = snap(drag.s0 + d);
    else en = snap(drag.e0 + d);
    drag.cur = clampSpan(items, k, s, en, dur, mode);
    block.style.left = `${(drag.cur.start / dur) * 100}%`;
    block.style.width = `${((Math.min(drag.cur.end, dur) - drag.cur.start) / dur) * 100}%`;
  };
  lane.onpointerup = () => {
    lane.onpointermove = lane.onpointerup = null;
    const d = drag;
    drag = null;
    block.classList.remove('dragging');
    if (!d.moved || !d.cur) {
      // 只是点一下：选中它，停着的时候顺便跳到它开头看一眼
      renderTrack(trackUnit);
      if (!playing) seek(u.start + it.start + 0.01);
      return;
    }
    commitTimes({ assetId: it.assetId, ...d.cur }, mode === 'move' ? '移动画面时间' : '调整画面出现时间');
    if (!playing) seek(u.start + (mode === 'end' ? Math.max(d.cur.start, d.cur.end - 0.1) : d.cur.start) + 0.01);
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
function refreshSoon() {
  if (!open || refreshQueued || drag) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    if (!open) return;
    const keep = units[trackUnit]?.members[0]?.id;
    buildUnits();
    const i = keep != null ? unitOfRow(keep) : -1;
    if (range && i >= 0) range = { start: units[i].start, end: units[i].end };
    trackUnit = -1;
    shownKey = '';
    const t = currentTime();
    tick(t);
    if (i >= 0 && trackUnit !== i) renderTrack(i);
  }, 0);
}

/* 换画面时先把新画面叠在下面加载，等它出了第一帧再撤掉旧的：拖进度条 / 切镜头时不会闪黑 */
function swapIn(stage, el, readyEvent) {
  el.classList.add('pt-pending');
  stage.append(el);
  const done = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.remove('pt-pending');
    for (const old of [...stage.children]) if (old !== el) old.remove();
  };
  const timer = setTimeout(done, 1500); // 读得慢 / 读不出来时也别一直挂着旧画面
  el.addEventListener(readyEvent, done, { once: true });
  if (readyEvent === 'load' && el.complete) done();
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
  if (force || Math.abs(v.currentTime - want) > 0.3) v.currentTime = Math.max(0, want);
  if (playing && !over && v.paused) v.play().catch(() => {});
  if ((!playing || over) && !v.paused) v.pause();
  $('#ptStage').classList.toggle('pt-short', over);
}

/* ── 时钟：有口播跟口播走，没有就自己走 ── */
const currentTime = () => (useVoice() ? voicePlayer.currentTime() : clockT);

function tick(t) {
  if (!open) return;
  if (range && t >= range.end - 0.02) {
    // 「对着口播看画面」播完这个镜头：接着播下一个镜头（镜头轨和进度条跟着换过去）；最后一个镜头才停
    const next = units.findIndex(x => x.start >= range.end - 0.05);
    if (playing && next >= 0) range = { start: units[next].start, end: units[next].end };
    else {
      if (playing) stop();
      t = Math.min(t, range.end);
    }
  }
  const i = unitAt(t);
  showUnit(i, t);
  const u = units[i];
  const r =
    u?.members.find(x => {
      const tm = timeline().times.get(x.id);
      return tm && tm.start <= t + 1e-6 && t < tm.end;
    }) || u?.members[0];
  $('#ptSub').textContent = r ? r.text : '';
  $('#ptTime').textContent = `${fmtTime(t)} / ${fmtTime(range ? range.end : timeline().total)}`;
  movePlayhead(t);
  const span = range ? range.end - range.start : timeline().total;
  $('#ptBar').style.width = `${Math.min(100, ((t - (range?.start || 0)) / Math.max(0.01, span)) * 100)}%`;
}

function frame(now) {
  if (!playing) return;
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (!useVoice()) {
    clockT += dt;
    tick(clockT);
    if (!range && clockT >= timeline().total) stop();
  } else if (!voicePlayer.isPlaying() && now - startedAt > 800) {
    // 口播自己停了（播完 / 被别处暂停）：画面也停
    stop();
    return;
  }
  raf = requestAnimationFrame(frame);
}

function play() {
  if (!open) return;
  playing = true;
  startedAt = performance.now();
  let t = currentTime();
  // 停在这个镜头末尾时按播放：直接从下一个镜头开始（没有下一个就从这个镜头开头重播）
  if (range && t >= range.end - 0.05) {
    const next = units.findIndex(x => x.start >= range.end - 0.05);
    const u = next >= 0 ? units[next] : units.find(x => x.start <= range.start + 0.01 && x.end >= range.end - 0.01);
    if (u) {
      range = { start: u.start, end: u.end };
      t = u.start;
      clockT = t;
      if (useVoice()) voicePlayer.seek(t);
    }
  }
  // 口播一路往下播，镜头之间的衔接由 tick 负责（不在镜头末尾让口播自己停下）
  if (useVoice()) voicePlayer.playRange(t, null);
  lastFrame = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
  syncVideo(t, true);
  renderControls();
}
function stop() {
  playing = false;
  cancelAnimationFrame(raf);
  if (useVoice()) voicePlayer.pause();
  videoEl?.pause();
  renderControls();
}
function seek(t) {
  if (range) t = Math.max(range.start, Math.min(range.end, t));
  clockT = t;
  if (useVoice()) voicePlayer.seek(t);
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
  buildUnits();
  if (!units.length) return;
  let i = unitOfRow(fromId);
  if (i < 0) i = 0;
  const u = units[i];
  range = only ? { start: u.start, end: u.end } : null;
  open = true;
  current = -1;
  shownKey = '';
  trackUnit = -1;
  pick = null;
  $('#ptMask').classList.add('show');
  $('#ptTitle').textContent = only ? '对着口播看画面' : '连播预览';
  $('#ptHint').textContent = useVoice()
    ? `口播：${state.voice.name}${timeline().source === 'srt' ? '（字幕实测时间）' : '（按音频长度推算每句时间）'}`
    : state.voice
      ? '口播音频读不出来，按估算时间静音播放'
      : '还没导入口播音频：按估算时间静音播放（时长菜单 → 导入口播音频）';
  untick?.();
  untick = voicePlayer.onTick(t => playing && tick(t));
  seek(u.start);
  play();
}

export function closePlaythrough() {
  if (!open) return;
  stop();
  open = false;
  untick?.();
  untick = null;
  videoEl = null;
  $('#ptStage').replaceChildren();
  $('#ptMask').classList.remove('show');
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
  $('#ptClose').onclick = closePlaythrough;
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
    if (e.target.closest('#pttLane')) onLaneDown(e);
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
});
