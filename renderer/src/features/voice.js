/* 口播音频播放：底部口播条（播放 / 暂停、进度、正在说的那句、跟随、语速、单句循环）。
   每句的时间来自 app/state 的时间轴：字幕实测 > 按音频长度推算 > 按语速估算。
   对外提供一个播放器（playRange / pause / onTick），连播预览、专注标注、面板「听这段」都用它。 */
import { state, on, timeline, timeOf, rowById } from '../app/state.js';
import { setVoice, setVoiceDuration, clearVoice, relocateVoice, isVoiceFile } from '../app/voice.js';
import { shotMembers } from '../core/shots.js';
import { lineAt, spanOf } from '../core/timeline.js';
import { fmtTime } from '../core/text.js';
import { fileUrl } from '../core/asset-model.js';
import * as native from '../platform/native.js';
import { toast, esc, confirmModal, ICON_PLAY, ICON_PAUSE } from '../ui/dom.js';
import { probeDuration } from '../ui/media.js';
import { registerCommand, runCommand } from '../ui/commands.js';

const $ = s => document.querySelector(s);
let audio = null;
let loadedPath = '';
let stopAt = null; // 播到这个时间点自动停（听一段 / 单句循环）
let loopRange = null; // {start, end}
let follow = true;
let playingId = null;
let started = false; // 播过才标「正在说」，没播时不在第一句下面划线
let missing = false;
const tickers = new Set();

const pref = (k, d) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const setPref = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

/* ── 播放器 ── */
function ensureAudio() {
  if (!state.voice) return null;
  if (!audio) {
    audio = new Audio();
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () => {
      missing = false;
      setVoiceDuration(audio.duration);
      renderBar();
    });
    audio.addEventListener('error', () => {
      missing = true;
      renderBar();
    });
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('play', () => {
      started = true;
      renderBar();
    });
    audio.addEventListener('pause', renderBar);
    audio.addEventListener('ended', () => {
      stopAt = null;
      renderBar();
    });
    audio.playbackRate = +pref('fjz:voiceRate', '1') || 1;
  }
  if (loadedPath !== state.voice.path) {
    loadedPath = state.voice.path;
    missing = false;
    audio.src = fileUrl(state.voice.path);
  }
  return audio;
}
function releaseAudio() {
  if (!audio) return;
  audio.pause();
  audio.removeAttribute('src');
  try {
    audio.load();
  } catch {}
  loadedPath = '';
  stopAt = null;
  loopRange = null;
  started = false;
  playingId = null;
  document.querySelectorAll('.playing').forEach(el => el.classList.remove('playing'));
}

export const voicePlayer = {
  available: () => !!state.voice && !missing,
  isPlaying: () => !!audio && !audio.paused,
  currentTime: () => (audio ? audio.currentTime : 0),
  /* 从 start 播到 end（end 省略 = 一直播下去） */
  async playRange(start, end = null) {
    const a = ensureAudio();
    if (!a) return false;
    stopAt = end;
    try {
      a.currentTime = Math.max(0, start);
      await a.play();
      return true;
    } catch {
      missing = !isFinite(a.duration);
      renderBar();
      if (missing) toast('口播音频读不出来：文件可能被移动或删除了，在口播条上点「重新定位」');
      return false;
    }
  },
  pause() {
    audio?.pause();
  },
  seek(t) {
    const a = ensureAudio();
    if (a) a.currentTime = Math.max(0, t);
  },
  onTick(fn) {
    tickers.add(fn);
    return () => tickers.delete(fn);
  },
};

function onTime() {
  if (!audio) return;
  const t = audio.currentTime;
  if (loopRange && t >= loopRange.end) {
    audio.currentTime = loopRange.start;
    return;
  }
  if (stopAt != null && t >= stopAt) {
    audio.pause();
    stopAt = null;
  }
  for (const fn of tickers) fn(t);
  updatePlaying(t);
}

/* ── 正在说的那句：高亮、跟随滚动、节奏色条上的播放头 ── */
function updatePlaying(t) {
  const tl = timeline();
  const order = state.rows.filter(r => r.kind === 'line').map(r => r.id);
  const id = lineAt(tl, order, t);
  const cur = $('#vbTime');
  if (cur) cur.textContent = `${fmtTime(t)} / ${fmtTime(tl.total || audio?.duration || 0)}`;
  const seek = $('#vbSeek');
  if (seek && document.activeElement !== seek) seek.value = String(Math.round((t / Math.max(1, tl.total)) * 1000));
  movePlayhead(id, t);
  if (!started) return;
  if (id === playingId) return;
  playingId = id;
  document.querySelectorAll('.playing').forEach(el => el.classList.remove('playing'));
  const el = document.querySelector(`.row[data-id="${id}"],.as[data-id="${id}"]`);
  el?.classList.add('playing');
  const r = rowById(id);
  const txt = $('#vbLine');
  if (txt) {
    txt.textContent = r ? `第 ${r.no} 句 · ${r.text}` : '';
    txt.dataset.id = r ? String(r.id) : '';
    txt.classList.remove('idle');
  }
  if (follow && voicePlayer.isPlaying() && el && !document.querySelector('.modal-mask.show')) {
    const box = el.getBoundingClientRect();
    if (box.top < 120 || box.bottom > innerHeight - 120) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
function movePlayhead(id, t) {
  const head = $('#segPlayhead');
  if (!head) return;
  const seg = document.querySelector(`#segbar .seg[data-jump="${id}"]`);
  const tm = timeOf(id);
  if (!seg || !tm) return (head.hidden = true);
  const frac = Math.min(1, Math.max(0, (t - tm.start) / Math.max(0.01, tm.end - tm.start)));
  head.hidden = false;
  head.style.left = seg.offsetLeft + seg.offsetWidth * frac + 'px';
}

/* ── 命令 ── */
function playFromLine(id) {
  const t = timeOf(id);
  if (!t) return;
  loopRange = null;
  voicePlayer.playRange(t.start);
}
function playShot(id) {
  const r = rowById(id);
  if (!r) return;
  const span = spanOf(
    timeline(),
    shotMembers(state.rows, r).map(x => x.id),
  );
  if (span) voicePlayer.playRange(span.start, span.end);
}
function toggle() {
  const a = ensureAudio();
  if (!a) return;
  if (!a.paused) return a.pause();
  // 第一次播 / 播完了：从当前选中的句子开始
  if (a.currentTime === 0 || a.ended || stopAt != null) {
    const t = timeOf(state.sel);
    return voicePlayer.playRange(t ? t.start : 0);
  }
  a.play().catch(() => {});
}

async function pickVoice() {
  const path = await native.pickVoice();
  if (path) await useVoiceFile(path);
}
async function useVoiceFile(path) {
  if (!isVoiceFile(path)) return toast('口播音频需要是音频或视频文件（mp3 / wav / m4a / mp4 / mov…）');
  const apply = async () => {
    releaseAudio();
    const duration = await probeDuration(path, 8000);
    if (duration == null) toast('读不出这个文件的时长，先按语速估算；能播放时会自动补上');
    setVoice(path, duration);
  };
  if (state.voice && state.voice.path !== path)
    confirmModal('更换口播音频？', `换成「${path.split('/').pop()}」。可以 ⌘Z 撤销。`, '更换', apply, {
      danger: false,
    });
  else await apply();
}
async function relocate() {
  const path = await native.pickVoice();
  if (!path) return;
  releaseAudio();
  if (relocateVoice(path)) {
    const d = await probeDuration(path, 8000);
    if (d) setVoiceDuration(d);
    toast('口播音频已重新定位');
  }
}

/* ── 口播条 ── */
function renderBar() {
  const bar = $('#voiceBar');
  if (!bar) return;
  bar.hidden = !state.voice;
  document.body.classList.toggle('has-voice', !!state.voice);
  if (!state.voice) return;
  const playing = voicePlayer.isPlaying();
  const tl = timeline();
  const how = tl.source === 'srt' ? '字幕实测时间' : '按音频长度推算每句时间';
  bar.innerHTML = missing
    ? `<span class="vb-name">口播音频失联：${esc(state.voice.name)}</span><button class="btn" id="vbRelocate">重新定位…</button><button class="text-button" id="vbClear">移除</button>`
    : `<button class="btn primary vb-play" id="vbPlay" data-state="${playing ? 'playing' : 'paused'}" title="播放 / 暂停（空格）" aria-label="${playing ? '暂停' : '播放'}">${playing ? ICON_PAUSE : ICON_PLAY}</button>
      <span class="vb-time mono" id="vbTime">${fmtTime(audio?.currentTime || 0)} / ${fmtTime(tl.total || state.voice.duration || 0)}</span>
      <input type="range" id="vbSeek" class="vb-seek" min="0" max="1000" value="0" aria-label="口播进度">
      <button class="vb-line idle" id="vbLine" title="点击选中这句">空格播放 · 从选中的句子开始</button>
      <span class="vb-src" title="${esc(how)}">${tl.source === 'srt' ? '字幕时间' : '≈ 推算时间'}</span>
      <label class="auto-label" title="播放时表格跟着滚到正在说的那句"><input type="checkbox" id="vbFollow" ${follow ? 'checked' : ''}> 跟随</label>
      <select id="vbRate" title="播放速度">${[0.75, 1, 1.25, 1.5, 2].map(v => `<option value="${v}" ${(+pref('fjz:voiceRate', '1') || 1) === v ? 'selected' : ''}>${v}×</option>`).join('')}</select>
      <button class="btn" id="vbLoop" title="反复播放选中的这句（再点一次取消）">${loopRange ? '取消循环' : '循环本句'}</button>
      <button class="btn" id="vbPreview" title="从选中的句子开始：口播接着播，画面按镜头自动切换">▶ 连播预览</button>
      <button class="text-button vb-more" id="vbMore" title="更换 / 移除口播音频">···</button>`;
  if (audio) updatePlaying(audio.currentTime);
}

function initBarEvents() {
  const bar = $('#voiceBar');
  bar.addEventListener('click', e => {
    const id = e.target.closest('button')?.id;
    if (id === 'vbPlay') toggle();
    if (id === 'vbRelocate') relocate();
    if (id === 'vbClear') {
      releaseAudio();
      clearVoice();
    }
    if (id === 'vbLine') {
      const lineId = +$('#vbLine').dataset.id;
      if (lineId) runCommand('nav:jump', lineId);
    }
    if (id === 'vbLoop') {
      if (loopRange) loopRange = null;
      else {
        const t = timeOf(state.sel);
        if (t) {
          loopRange = { start: t.start, end: t.end };
          voicePlayer.playRange(t.start);
        }
      }
      renderBar();
    }
    if (id === 'vbPreview') runCommand('playthrough:from', state.sel);
    if (id === 'vbMore')
      confirmModal(
        '口播音频',
        `${state.voice.path}\n\n时长 ${fmtTime(state.voice.duration || 0)}。更换后每句时间按新音频重算（对齐过字幕的话仍用字幕时间）。`,
        '更换…',
        pickVoice,
        { cancelText: '关闭', danger: false },
      );
  });
  bar.addEventListener('input', e => {
    if (e.target.id === 'vbSeek') voicePlayer.seek((+e.target.value / 1000) * Math.max(1, timeline().total));
  });
  bar.addEventListener('change', e => {
    if (e.target.id === 'vbFollow') {
      follow = e.target.checked;
      setPref('fjz:voiceFollow', String(follow));
    }
    if (e.target.id === 'vbRate') {
      setPref('fjz:voiceRate', e.target.value);
      if (audio) audio.playbackRate = +e.target.value;
    }
  });
  // 时间码格：点哪句从哪句播
  document.addEventListener('click', e => {
    const p = e.target.closest('[data-play]');
    if (p && state.voice) {
      e.stopPropagation();
      playFromLine(+p.dataset.play);
    }
  });
}

export function initVoice() {
  follow = pref('fjz:voiceFollow', 'true') !== 'false';
  initBarEvents();
  registerCommand('voice:pick', pickVoice);
  registerCommand('voice:set', useVoiceFile);
  registerCommand('voice:clear', () => {
    releaseAudio();
    clearVoice();
  });
  registerCommand('voice:toggle', toggle);
  registerCommand('voice:play-from', playFromLine);
  registerCommand('voice:play-shot', playShot);
  on('voice', () => {
    if (!state.voice || state.voice.path !== loadedPath) releaseAudio();
    renderBar();
    if (state.voice) ensureAudio();
  });
  on('project-loaded', () => {
    releaseAudio();
    missing = false;
    renderBar();
    if (state.voice) ensureAudio();
  });
  // 重渲染后把「正在说」的高亮补回去
  on('rows', () => {
    playingId = null;
    if (audio && state.voice) updatePlaying(audio.currentTime);
  });
  renderBar();
  if (state.voice) ensureAudio();
}
