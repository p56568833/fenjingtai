/* 视频审核里的片段播放器：只显示建议片段这几秒的进度条、叠口播字幕、可同时放口播音频。
   口播时间轴：片段第 0 秒对齐到它「配的那句」（候选的 for 字段；没写就是整个画面的第一句）的开头。 */
import { state, rowById, lines, timeOf, renumber } from '../app/state.js';
import { shotMembers } from '../core/shots.js';
import { parseLines } from '../core/candidates.js';
import { esc } from '../ui/dom.js';
import { voicePlayer } from './voice.js';

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

/* 这个候选配的句子：for 写了且落在画面里 → 那几句；否则整个画面 */
export function targetLines(c) {
  const lead = rowById(c.rowId);
  if (!lead) return { members: [], target: [], whole: true };
  const members = shotMembers(state.rows, lead);
  const r = c.for ? parseLines(c.for) : null;
  const target = r ? members.filter(m => m.no >= Math.min(r.from, r.to) && m.no <= Math.max(r.from, r.to)) : [];
  return target.length ? { members, target, whole: false } : { members, target: members, whole: true };
}
const noRange = rows =>
  rows.length > 1 ? `第 ${rows[0].no}–${rows[rows.length - 1].no} 句` : rows.length ? `第 ${rows[0].no} 句` : '';
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

/* 卡片上的「配：第 200 句『…』」 */
export function forLineHTML(c) {
  const { target, whole } = targetLines(c);
  if (!target.length) return '';
  const quote = clip(target.map(r => r.text).join(''), 46);
  return `<p class="vr-for"><b>配</b>${whole ? `整段（${noRange(target)}）` : `${noRange(target)}「${esc(quote)}」`}</p>`;
}

/* 画面上方的整段口播：一句一行（句号用 CSS 画在左边，不进文字），当前候选配的那几句高亮、其余淡一点 */
export function voHTML(members) {
  return members.map(m => `<span class="vo-s" data-vo-no="${m.no}">${esc(m.text)}</span>`).join('');
}
export function paintVoHighlight(c) {
  const host = document.querySelector('#vrList .vr-vo');
  if (!host) return;
  const nos = new Set(c ? targetLines(c).target.map(r => r.no) : []);
  const whole = c ? targetLines(c).whole : true;
  const all = host.querySelectorAll('[data-vo-no]');
  all.forEach(s => s.classList.toggle('on', !whole && nos.has(+s.dataset.voNo)));
  // 只配其中几句时，没配到的句子淡下去，一眼看出这个候选管哪几句
  host.classList.toggle('partial', !whole && nos.size > 0 && nos.size < all.length);
}

/* 片段在口播时间轴上的位置 */
function voWindow(c) {
  renumber();
  const { target } = targetLines(c);
  const dur = Math.max(0.1, c.out - c.in);
  const first = target[0] && timeOf(target[0].id);
  const last = target.length && timeOf(target[target.length - 1].id);
  const start = first ? first.start : 0;
  return { dur, start, targetEnd: last ? last.end : start + dur, ok: !!first };
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
  active.v.pause();
  if (active.usingVoice) voicePlayer.pause();
  active = null;
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

function syncVoice(c, w, v) {
  if (!active?.usingVoice) return;
  const want = w.start + (v.currentTime - c.in);
  if (Math.abs(voicePlayer.currentTime() - want) > 0.35) voicePlayer.seek(want);
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
  active = { c, card, v, w, usingVoice: usingVoice() };
  paintTrack(card, c, w);
  const startVoice = () => {
    active && (active.usingVoice = usingVoice());
    if (active?.usingVoice) voicePlayer.playRange(w.start + (v.currentTime - c.in), w.start + w.dur);
  };
  v.ontimeupdate = () => {
    if (v.currentTime >= c.out) {
      v.pause();
      v.currentTime = c.in;
    }
    paintNow(card, c, w, v);
    syncVoice(c, w, v);
  };
  v.onwaiting = () => {
    wait.hidden = false;
    onState?.('载入中…');
    if (active?.usingVoice) voicePlayer.pause();
  };
  v.onplaying = () => {
    wait.hidden = true;
    onState?.('↻ 重播这段');
    if (active?.v === v) startVoice();
    paintNow(card, c, w, v);
  };
  v.onpause = () => {
    if (active?.v === v && active.usingVoice) voicePlayer.pause();
    paintNow(card, c, w, v);
  };
  v.onerror = () => {
    wait.hidden = true;
    onState?.('播放失败 · 再试一次');
  };
  if (box)
    box.onchange = () => {
      setVoiceOn(box.checked);
      if (!box.checked) voicePlayer.pause();
      else if (!v.paused) startVoice();
    };
  const go = () => {
    v.currentTime = c.in;
    v.play().catch(() => {});
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
