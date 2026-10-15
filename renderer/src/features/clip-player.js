/* 视频审核里的片段播放器：只显示建议片段这几秒的进度条、叠口播字幕、可同时放口播音频。
   口播对齐：精选段的开头对齐到它在正片轨上的位置；还没放上去的按清单里的先后估（见 slotOf）。 */
import { state, rowById, lines, timeOf, renumber, timeline } from '../app/state.js';
import { shotMembers } from '../core/shots.js';
import { planOf, usableSeconds, cleanBest } from '../core/candidates.js';
import { layoutShot } from '../core/shot-layout.js';
import { esc } from '../ui/base/dom.js';
import { voicePlayer } from './voice.js';
import { releaseMedia } from '../ui/base/media.js';

const VOICE_PREF = 'fjz:vrVoice';
const voiceOn = () => {
  try {
    return localStorage.getItem(VOICE_PREF) !== '0'; // 默认带口播声音
  } catch {
    return true;
  }
};
export const setVoiceOn = on => {
  try {
    localStorage.setItem(VOICE_PREF, on ? '1' : '0');
  } catch {}
};

/* 这个候选配的句子：方案里的视频都配整个画面 */
export function targetLines(c) {
  const lead = rowById(c.rowId);
  if (!lead) return { members: [], target: [], whole: true };
  const members = shotMembers(state.rows, lead);
  return { members, target: members, whole: true };
}

/* 这个视频在口播里对应的那段（绝对秒数）。已经放在正片轨上的：就是它在轨上的位置；
   还没放上去的：按清单里的先后估——画面开头 + 同一方案里排在前面、没被否掉的视频的可用长度，
   最后一个配到画面末尾。不知道时间返回 null */
export function slotOf(c) {
  renumber();
  const { members } = targetLines(c);
  const first = members[0] && timeOf(members[0].id);
  if (!first) return null;
  const last = timeOf(members[members.length - 1].id) || first;
  if (c.assetId) {
    const layout = layoutShot(state.assets || {}, members, timeline());
    const it = layout?.items.find(x => x.assetId === c.assetId);
    if (it) return { start: layout.start + it.start, end: layout.start + Math.min(it.end, layout.dur) };
  }
  const ids = new Set(members.map(m => m.id));
  const seq = state.candidates
    .filter(
      x => ids.has(x.rowId) && planOf(x) === planOf(c) && (x === c || (x.decision !== 'no' && x.decision !== 're')),
    )
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const k = seq.indexOf(c);
  const start = Math.min(
    last.end,
    first.start + seq.slice(0, Math.max(0, k)).reduce((t, x) => t + usableSeconds(x), 0),
  );
  const end = k === seq.length - 1 ? last.end : Math.min(last.end, start + usableSeconds(c));
  return { start, end };
}

/* 片段在口播时间轴上的位置：start = 视频入点对应的口播秒数（精选段开头对齐到排到的位置），targetEnd = 排到的那段的结尾 */
function voWindow(c) {
  const dur = Math.max(0.1, c.out - c.in);
  const slot = slotOf(c);
  if (!slot) return { dur, start: 0, targetEnd: dur, ok: false };
  const bestIn = cleanBest(c.best, c.in, c.out)?.in ?? c.in;
  return { dur, start: Math.max(0, slot.start - (bestIn - c.in)), targetEnd: slot.end, ok: true };
}
function lineAt(t) {
  for (const r of lines()) {
    const tm = timeOf(r.id);
    if (tm && t >= tm.start && t < tm.end) return r;
  }
  return null;
}

const fmt = s => {
  s = Math.max(0, s);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export function playerHTML(c) {
  const hasVoice = !!state.voice;
  return `<div class="vr-stage" hidden>
      <div class="vr-screen">
        <video class="vr-player" playsinline muted preload="none" hidden></video>
        <div class="vr-sub"></div>
        <div class="vr-wait" hidden>载入中…</div>
      </div>
      <div class="vr-bar">
        <button class="vr-pp" data-vr-pp="${c.id}" title="播放 / 暂停（空格）">▶</button>
        <div class="vr-track" data-vr-track="${c.id}"><div class="vr-cover"></div><div class="vr-fill"></div></div>
        <span class="vr-time">0:00 / ${fmt(c.out - c.in)}</span>
        ${
          hasVoice
            ? `<label class="vr-voice" title="同时播放口播音频（按句子时间对齐）"><input type="checkbox" data-vr-voice ${voiceOn() ? 'checked' : ''}> 口播声音</label>`
            : `<span class="vr-voice off" title="项目里还没有导入口播音频，只显示字幕">只显示字幕</span>`
        }
      </div>
    </div>`;
}

let active = null; // { c, card, v, w, usingVoice }

export function stopClip() {
  if (!active) return;
  const old = active;
  active = null;
  old.cleanup?.();
  old.v.pause();
  if (old.usingVoice) voicePlayer.pause();
  releaseMedia(old.v);
}

/* 进度条：片段内的位置；句子分界画成刻度（标句号）；配的那几句画成浅色底 */
function paintTrack(card, c, w) {
  const track = card.querySelector('.vr-track');
  track.querySelectorAll('.vr-tick').forEach(x => x.remove());
  if (!w.ok) return;
  const cover = Math.min(1, Math.max(0, (w.targetEnd - w.start) / w.dur));
  track.querySelector('.vr-cover').style.width = cover * 100 + '%';
  for (const r of lines()) {
    const tm = timeOf(r.id);
    if (!tm || tm.start <= w.start + 0.05 || tm.start >= w.start + w.dur) continue;
    const tick = document.createElement('i');
    tick.className = 'vr-tick';
    tick.style.left = ((tm.start - w.start) / w.dur) * 100 + '%';
    tick.dataset.no = r.no;
    track.append(tick);
  }
  const short = w.targetEnd - w.start - w.dur;
  const time = card.querySelector('.vr-time');
  time.title = short > 0.5 ? `画面比配的口播短 ${short.toFixed(1)} 秒` : '';
  time.classList.toggle('short', short > 0.5);
}

function paintNow(card, c, w, v) {
  const t = Math.max(0, Math.min(w.dur, v.currentTime - c.in));
  card.querySelector('.vr-fill').style.width = (t / w.dur) * 100 + '%';
  const short = w.targetEnd - w.start - w.dur;
  card.querySelector('.vr-time').textContent =
    `${fmt(t)} / ${fmt(w.dur)}` + (short > 0.5 ? ` · 画面比口播短 ${short.toFixed(0)} 秒` : '');
  const r = w.ok ? lineAt(w.start + t) : null;
  card.querySelector('.vr-sub').innerHTML = r ? `<span>${esc(r.text)}</span>` : '';
  card.querySelector('.vr-pp').textContent = v.paused ? '▶' : '❚❚';
}

/* 视频还没跳到入点（刚开始播、跳转还没完成）时，currentTime 还是 0 附近：
   这时按「句子开头 + (视频位置 - 入点)」算口播位置会倒退几分钟，放出别处的口播。没到入点就先不放口播 */
const atClip = (c, v) => v.currentTime >= c.in - 0.3 && v.currentTime <= c.out + 0.3;
function syncVoice(c, w, v) {
  if (active?.v !== v || !active.usingVoice) return;
  if (!atClip(c, v)) return voicePlayer.pause();
  const want = w.start + Math.max(0, v.currentTime - c.in);
  if (Math.abs(voicePlayer.currentTime() - want) > 0.35) voicePlayer.seek(want);
  if (!v.paused && !voicePlayer.isPlaying()) voicePlayer.playRange(want, w.start + w.dur);
}

/* 播放这段：一点就加载并从入点开始播；按钮和画面中间会提示「载入中…」 */
export function playClip(card, c, { onState } = {}) {
  stopAllVideos();
  const v = card.querySelector('.vr-player');
  const stage = card.querySelector('.vr-stage');
  const wait = card.querySelector('.vr-wait');
  stage.hidden = false;
  v.hidden = false;
  v.preload = 'auto';
  if (!v.getAttribute('src')) {
    v.src = c.url.split('#')[0];
    v.load();
  }
  const w = voWindow(c);
  const box = card.querySelector('[data-vr-voice]');
  const usingVoice = () => !!(box?.checked && state.voice && voicePlayer.available() && w.ok);
  const session = { c, card, v, w, usingVoice: usingVoice() };
  active = session;
  paintTrack(card, c, w);
  const startVoice = () => {
    if (active !== session) return;
    session.usingVoice = usingVoice();
    if (session.usingVoice && atClip(c, v))
      voicePlayer.playRange(w.start + Math.max(0, v.currentTime - c.in), w.start + w.dur);
  };
  v.ontimeupdate = () => {
    if (active !== session) return;
    if (v.currentTime >= c.out) {
      v.pause();
      v.currentTime = c.in;
    } else if (v.currentTime < c.in - 0.5 && !v.seeking) v.currentTime = c.in; // 跳转没生效、从头播起来了：拉回入点
    paintNow(card, c, w, v);
    syncVoice(c, w, v);
  };
  v.onwaiting = () => {
    if (active !== session) return;
    wait.hidden = false;
    onState?.('载入中…');
    if (active?.usingVoice) voicePlayer.pause();
  };
  v.onplaying = () => {
    if (active !== session) return;
    wait.hidden = true;
    onState?.('↻ 重播这段');
    if (active?.v === v) startVoice();
    paintNow(card, c, w, v);
  };
  v.onpause = () => {
    if (active !== session) return;
    if (active?.v === v && active.usingVoice) voicePlayer.pause();
    paintNow(card, c, w, v);
  };
  v.onerror = () => {
    if (active !== session) return;
    wait.hidden = true;
    onState?.('播放失败 · 再试一次');
  };
  if (box)
    box.onchange = () => {
      setVoiceOn(box.checked);
      if (active !== session) return;
      session.usingVoice = usingVoice();
      if (!box.checked) voicePlayer.pause();
      else if (!v.paused) startVoice();
    };
  const go = () => {
    if (active !== session) return;
    // 入点比视频本身还长（比如 AI 把剪好的几秒小片段当原片给，入出点却还写原片里的时间）：跳不过去，说清楚，不要卡在结尾
    if (Number.isFinite(v.duration) && c.in >= v.duration - 0.05) {
      wait.hidden = false;
      wait.classList.add('err');
      wait.textContent = `入出点 ${fmt(c.in)}–${fmt(c.out)} 超出了这个视频的长度（${fmt(v.duration)}）：清单里的时间写错了`;
      onState?.('片段时间写错了');
      stopClip();
      return;
    }
    wait.classList.remove('err');
    wait.textContent = '载入中…';
    v.currentTime = c.in;
    v.play().catch(() => {});
  };
  session.cleanup = () => {
    v.removeEventListener('loadedmetadata', go);
    v.ontimeupdate = v.onwaiting = v.onplaying = v.onpause = v.onerror = null;
    if (box) box.onchange = null;
  };
  wait.hidden = false;
  onState?.('载入中…');
  if (v.readyState >= 1) go();
  else v.addEventListener('loadedmetadata', go, { once: true });
}

/* 自制进度条上的播放 / 暂停与拖动 */
export function togglePause(card, c) {
  const v = card.querySelector('.vr-player');
  if (!v.getAttribute('src') || active?.v !== v) return false;
  if (v.paused) v.play().catch(() => {});
  else v.pause();
  return true;
}
export function seekTrack(card, c, track, clientX) {
  const v = card.querySelector('.vr-player');
  if (active?.v !== v) return;
  const rect = track.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  v.currentTime = c.in + f * (c.out - c.in);
  if (active.usingVoice) voicePlayer.seek(active.w.start + f * (c.out - c.in));
}

export function stopAllVideos() {
  stopClip();
  document.querySelectorAll('#vrList video').forEach(v => v.pause());
}
