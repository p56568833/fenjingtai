import { viewState } from '../app/view-state.js';
/* 口播音频播放：底部口播条（播放 / 暂停、进度、正在说的那句、跟随、语速、单句循环）。
   每句的时间来自 app/state 的时间轴：字幕实测 > 按音频长度推算 > 按语速估算。
   对外提供一个播放器（playRange / pause / onTick），连播预览、专注标注、面板「听这段」都用它。 */
import { state } from '../app/state.js';
import { on } from '../app/events.js';
import { timeline, timeOf, rowById } from '../app/project-queries.js';
import { setVoice, setVoiceDuration, clearVoice, relocateVoice, isVoiceFile } from '../app/voice.js';
import { shotMembers } from '../core/shots.js';
import { lineAt, shotSpan } from '../core/timeline.js';
import { fmtTime } from '../core/text.js';
import { fileUrl } from '../core/asset-model.js';
import * as native from '../platform/native.js';
import { toast, esc, confirmModal } from '../ui/base/dom.js';
import { probeDuration } from '../ui/base/media.js';
import { registerCommand, runCommand } from '../ui/base/commands.js';
import { collabSession } from '../app/collab.js';

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
    audio.playbackRate = 1; // 倍速随播放条一起去掉了，以前设过的倍速不再生效
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
  movePlayhead(0);
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
      if (missing) toast('口播音频读不出来：文件可能被移动或删除了，在口播条上点「重新定位」', null, 'error');
      return false;
    }
  },
  pause() {
    audio?.pause();
    movePlayhead(audio?.currentTime || 0);
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
  movePlayhead(t);
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
function movePlayhead(t) {
  const head = $('#segPlayhead');
  if (!head) return;
  const total = state.voice?.duration > 0 ? state.voice.duration : timeline().total;
  if (
    !state.voice ||
    !started ||
    !audio ||
    audio.paused ||
    audio.ended ||
    missing ||
    !state.rows.some(r => r.kind === 'line') ||
    !(total > 0)
  )
    return (head.hidden = true);
  head.hidden = false;
  head.style.left = `${Math.min(1, Math.max(0, t / total)) * 100}%`;
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
  const span = shotSpan(
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
    const t = timeOf(viewState.sel);
    return voicePlayer.playRange(t ? t.start : 0);
  }
  a.play().catch(() => {});
}

async function pickVoice() {
  const path = await native.pickVoice();
  if (path) await useVoiceFile(path);
}
async function useVoiceFile(path) {
  if (!isVoiceFile(path)) return toast('口播音频需要是音频或视频文件（mp3 / wav / m4a / mp4 / mov…）', null, 'warn');
  const apply = async () => {
    releaseAudio();
    const duration = await probeDuration(path, 8000);
    if (duration == null) toast('读不出这个文件的时长，先按语速估算；能播放时会自动补上', null, 'warn');
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
    toast('口播音频已重新定位', null, 'ok');
  }
}

/* ── 口播条 ── */
function renderBar() {
  movePlayhead(audio?.currentTime || 0);
  const bar = $('#voiceBar');
  if (!bar) return;
  // 纯听口播的播放条不要了（听口播都在「对着口播看画面」里）；只在口播文件失联时出来，提醒重新定位
  const show = !!state.voice && missing;
  bar.hidden = !show;
  document.body.classList.toggle('has-voice', show);
  if (!show) return (bar.innerHTML = '');
  // 局域网协作中：口播文件多半在对方电脑上，可以直接取过来；「移除」会连对方的口播一起去掉，协作时不放在这里
  const peer = collabSession();
  const fetch =
    peer?.status === 'online' && state.voice.path?.startsWith('/')
      ? `<button class="btn primary" id="vbFetch" title="通过局域网从 ${esc(peer.peer || '对方')} 的电脑拷一份到你的素材文件夹">从对方电脑取</button>`
      : '';
  bar.innerHTML = `<span class="vb-name">口播音频${peer ? '不在这台电脑上' : '失联'}：${esc(state.voice.name)}</span>${fetch}<button class="btn" id="vbRelocate">重新定位…</button>${peer ? '' : '<button class="text-button" id="vbClear">移除</button>'}`;
}

function initBarEvents() {
  $('#voiceBar').addEventListener('click', e => {
    const id = e.target.closest('button')?.id;
    if (id === 'vbFetch') runCommand('collab:fetch-voice');
    if (id === 'vbRelocate') relocate();
    if (id === 'vbClear') {
      releaseAudio();
      clearVoice();
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
  on('project-committed', change => {
    if (
      change.projectId !== state.projectId ||
      (!change.full && change.rowIds !== null && !change.fields.includes('voice'))
    )
      return;
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
  on('collab-status', renderBar);
  // 重渲染后把「正在说」的高亮补回去
  on('view-painted', () => {
    playingId = null;
    if (audio && state.voice) updatePlaying(audio.currentTime);
  });
  renderBar();
  if (state.voice) ensureAudio();
}
