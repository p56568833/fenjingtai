/* 视频审核里的片段播放器：只显示建议片段这几秒的进度条、叠口播字幕、可同时放口播音频。
   口播对齐：精选段的开头对齐到它在正片轨上的位置；还没放上去的对齐到它给的那几句开口（见 slotOf）。 */
import { state } from '../app/state.js';
import { collabSession, ensureCandidateFile } from '../app/collab.js';
import { rowById, lines, timeOf, renumber, timeline } from '../app/project-queries.js';
import { fileUrl } from '../core/asset-model.js';
import { shotMembers } from '../core/shots.js';
import { cleanBest, forRange, localVideoPath, playableUrl } from '../core/candidate-values.js';
import { candidateWindow } from '../core/candidate-placement.js';
import { layoutShot } from '../core/shot-layout.js';
import { isBilingualProject, resolvePlaybackSub } from '../core/bilingual.js';
import { esc } from '../ui/base/dom.js';
import { getCcMode, cycleCcMode, ccModeLabel, ccModeTitle, onCcModeChange } from './cc-pref.js';
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

/* 这个候选配的句子：清单里 for 写的那几句（一句，或整个画面） */
export function targetLines(c) {
  const lead = rowById(c.rowId);
  if (!lead) return { members: [], target: [], whole: true };
  const members = shotMembers(state.rows, lead);
  const r = forRange(c, members);
  return { members, target: members.slice(r.from, r.to + 1), whole: r.whole };
}

/* 这个视频在口播里对应的那段（绝对秒数）。已经放在正片轨上的：就是它在轨上的位置；
   还没放上去的：它给的那几句——从第一句开口到最后一句后面那句开口。不知道时间返回 null */
export function slotOf(c) {
  renumber();
  const { members } = targetLines(c);
  if (!members.length) return null;
  const tl = timeline();
  if (c.assetId) {
    const layout = layoutShot(state.assets || {}, members, tl);
    const it = layout?.items.find(x => x.assetId === c.assetId);
    if (it) return { start: layout.start + it.start, end: layout.start + Math.min(it.slotEnd ?? it.end, layout.dur) };
  }
  const w = candidateWindow(c, members, tl);
  return w ? { start: w.start, end: w.end } : null;
}

/* 片段在口播时间轴上的位置（所见即所得）：候选带剪辑余量时只预览真正会上屏的那一段，
   保存和导出到剪映的文件仍保留完整 in–out 余量供剪辑拉长。 */
function voWindow(c) {
  const best = cleanBest(c.best, c.in, c.out);
  const playIn = best ? best.in : c.in;
  const rawOut = best ? best.out : c.out;
  const rawDur = Math.max(0.1, rawOut - playIn);
  const { members } = targetLines(c);
  const slot = slotOf(c);
  if (!slot || slot.end <= slot.start) {
    return {
      playIn,
      playOut: playIn + rawDur,
      dur: rawDur,
      start: 0,
      slotStart: 0,
      targetEnd: rawDur,
      segs: [],
      members,
      ok: false,
    };
  }
  const slotStart = slot.start;
  const targetEnd = slot.end;
  const slotDur = Math.max(0.1, targetEnd - slotStart);
  const dur = Math.min(rawDur, slotDur);
  const playOut = playIn + dur;
  const start = slotStart;
  // 只取当前画面自己的句子，绝不把后面画面的句子标进来
  const segs = [];
  for (const r of members) {
    const tm = timeOf(r.id);
    if (!tm || tm.end <= slotStart + 0.05 || tm.start >= targetEnd - 0.05) continue;
    segs.push({ id: r.id, no: r.no, at: Math.max(tm.start, slotStart) - start });
  }
  return { playIn, playOut, dur, start, slotStart, targetEnd, segs, members, ok: true };
}
function lineAt(t, pool = lines()) {
  for (const r of pool) {
    const tm = timeOf(r.id);
    if (tm && t >= tm.start && t < tm.end) return r;
  }
  return null;
}

const voStartOf = w => Math.max(0, w.slotStart);
const voEndOf = w => Math.min(w.targetEnd, w.start + w.dur);

const fmt = s => {
  s = Math.max(0, s);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export function playerHTML(c) {
  const hasVoice = !!state.voice;
  const w = voWindow(c);
  const bilingual = isBilingualProject(state);
  const ccMode = bilingual ? getCcMode() : 'zh';
  const ccBtn = bilingual
    ? `<button class="vr-cc-btn${ccMode !== 'off' ? ' on' : ''}" type="button" data-vr-cc title="${esc(ccModeTitle(ccMode))}">${esc(ccModeLabel(ccMode))}</button>`
    : '';
  return `<div class="vr-stage" hidden>
      <div class="vr-screen">
        <video class="vr-player" playsinline muted preload="none" hidden></video>
        <div class="vr-sub"></div>
        <div class="vr-wait" hidden>载入中…</div>
      </div>
      <div class="vr-bar">
        <button class="vr-pp" data-vr-pp="${c.id}" title="播放 / 暂停（空格）">▶</button>
        <div class="vr-track" data-vr-track="${c.id}"><div class="vr-rail"><div class="vr-fill"></div></div><i class="vr-thumb"></i></div>
        <span class="vr-time">0:00 / ${fmt(w.dur)}</span>
        ${ccBtn}
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

/* 进度条：整条统一底色按所见即所得上屏时长播；多句画面把每句句号标在各自段落开头，单句画面不重复标 */
function paintTrack(card, _c, w) {
  const track = card.querySelector('.vr-track');
  const bar = card.querySelector('.vr-bar');
  track.querySelectorAll('.vr-tick, .vr-seg-no').forEach(x => x.remove());
  bar?.classList.toggle('has-segs', false);
  if (!w.ok) return;
  if (w.segs.length > 1) {
    const vis = w.segs.filter(s => s.at < w.dur - 0.08);
    if (vis.length) {
      bar?.classList.add('has-segs');
      let lastLabelPct = -99;
      for (const s of vis) {
        const pct = Math.min(98, Math.max(0, (s.at / w.dur) * 100));
        if (s.at > 0.06) {
          const tick = document.createElement('i');
          tick.className = 'vr-tick';
          tick.style.left = pct + '%';
          tick.title = `第 ${s.no} 句`;
          track.append(tick);
        }
        if (pct - lastLabelPct >= 6) {
          const label = document.createElement('span');
          label.className = 'vr-seg-no';
          label.textContent = String(s.no);
          if (s.at <= 0.06) label.style.left = '0';
          else if (pct > 90) label.style.right = '0';
          else label.style.left = `calc(${pct}% + 4px)`;
          track.append(label);
          lastLabelPct = pct;
        }
      }
    }
  }
  const short = w.targetEnd - w.start - w.dur;
  const time = card.querySelector('.vr-time');
  time.title = short > 0.5 ? `画面比配的口播短 ${short.toFixed(1)} 秒` : '';
  time.classList.toggle('short', short > 0.5);
}

function paintCcBtn(card) {
  const btn = card?.querySelector('[data-vr-cc]');
  if (!btn) return;
  const mode = getCcMode();
  btn.textContent = ccModeLabel(mode);
  btn.classList.toggle('on', mode !== 'off');
  btn.title = ccModeTitle(mode);
}

function paintNow(card, _c, w, v) {
  const t = Math.max(0, Math.min(w.dur, v.currentTime - w.playIn));
  const pct = (t / w.dur) * 100 + '%';
  card.querySelector('.vr-fill').style.width = pct;
  const thumb = card.querySelector('.vr-thumb');
  if (thumb) thumb.style.left = pct;
  const short = w.targetEnd - w.start - w.dur;
  card.querySelector('.vr-time').textContent =
    `${fmt(t)} / ${fmt(w.dur)}` + (short > 0.5 ? ` · 画面比口播短 ${short.toFixed(0)} 秒` : '');
  const voTime = w.start + t;
  const inRange = w.ok && voTime >= w.slotStart - 0.02 && voTime < w.targetEnd;
  const r = inRange ? lineAt(voTime, w.members) : null;
  const subEl = card.querySelector('.vr-sub');
  if (!isBilingualProject(state)) {
    subEl.innerHTML = r ? `<span>${esc(r.text)}</span>` : '';
  } else {
    if (inRange) {
      const res = resolvePlaybackSub({
        row: r,
        time: voTime,
        subTiming: state.subTiming,
        tl: timeline(),
        displayMode: getCcMode(),
        bilingual: true,
      });
      subEl.innerHTML = res.showOverlay
        ? `${res.overlayZh ? `<div class="vr-sub-zh"><span>${esc(res.overlayZh)}</span></div>` : ''}${res.overlayEn ? `<div class="vr-sub-en"><span>${esc(res.overlayEn)}</span></div>` : ''}`
        : '';
    } else {
      subEl.innerHTML = '';
    }
    paintCcBtn(card);
  }
  card.querySelector('.vr-pp').textContent = v.paused ? '▶' : '❚❚';
}

export function cycleClipCc() {
  return cycleCcMode();
}

onCcModeChange(() => {
  if (active) {
    paintCcBtn(active.card);
    paintNow(active.card, active.c, active.w, active.v);
  }
  if (typeof document !== 'undefined') {
    document.querySelectorAll('#vrList [data-vr-cc]').forEach(btn => {
      const mode = getCcMode();
      btn.textContent = ccModeLabel(mode);
      btn.classList.toggle('on', mode !== 'off');
      btn.title = ccModeTitle(mode);
    });
  }
});

/* 视频还没跳到入点（刚开始播、跳转还没完成）时，currentTime 还是 0 附近：
   这时按「句子开头 + (视频位置 - 入点)」算口播位置会倒退几分钟，放出别处的口播。没到入点、还没进目标句、或超过上屏结尾都不放口播 */
const atClip = (w, v) => v.currentTime >= w.playIn - 0.3 && v.currentTime <= w.playOut + 0.3;
function playVoiceChecked(session, from, to) {
  const seq = (session.voiceSeq = (session.voiceSeq || 0) + 1);
  Promise.resolve(voicePlayer.playRange(from, to)).then(ok => {
    if (ok === false && active === session && session.voiceSeq === seq && !session.v.paused) session.usingVoice = false;
  });
}
function syncVoice(w, v) {
  if (active?.v !== v || !active.usingVoice) return;
  if (!voicePlayer.available()) {
    active.usingVoice = false;
    return;
  }
  const want = w.start + Math.max(0, v.currentTime - w.playIn);
  const start = voStartOf(w);
  const end = voEndOf(w);
  if (!atClip(w, v) || want < start || want >= end - 0.03) return voicePlayer.pause();
  if (Math.abs(voicePlayer.currentTime() - want) > 0.35) voicePlayer.seek(want);
  if (!v.paused && !voicePlayer.isPlaying()) playVoiceChecked(active, want, end);
}

/* 播放这段：一点就加载并从入点开始播（from：从片段里的这个时间开始，审核页点截图时用）；按钮和画面中间会提示「载入中…」 */
export function playClip(card, c, { onState, onEnd, from = null } = {}) {
  stopAllVideos();
  const v = card.querySelector('.vr-player');
  const stage = card.querySelector('.vr-stage');
  const wait = card.querySelector('.vr-wait');
  stage.hidden = false;
  v.hidden = false;
  v.preload = 'auto';
  const wantSrc = playableUrl(c.url);
  if (v.getAttribute('src') !== wantSrc || v.error) {
    v.src = wantSrc;
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
    const want = w.start + Math.max(0, v.currentTime - w.playIn);
    const start = voStartOf(w);
    const end = voEndOf(w);
    if (session.usingVoice && atClip(w, v) && want >= start && want < end - 0.03) playVoiceChecked(session, want, end);
  };
  v.ontimeupdate = () => {
    if (active !== session) return;
    if (v.currentTime >= w.playOut) {
      v.pause();
      if (session.usingVoice) voicePlayer.pause();
      v.currentTime = w.playIn;
      onEnd?.();
      if (active !== session) return;
    } else if (v.currentTime < w.playIn - 0.5 && !v.seeking) v.currentTime = w.playIn; // 跳转没生效、从头播起来了：拉回入点
    paintNow(card, c, w, v);
    syncVoice(w, v);
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
  v.onended = () => active === session && onEnd?.(); // 原片比出点先结束
  v.onerror = () => {
    if (active !== session) return;
    const localSrc = localVideoPath(c.url);
    if (localSrc && !session.triedPeer && collabSession()) {
      session.triedPeer = true;
      wait.hidden = false;
      wait.classList.remove('err');
      wait.textContent = '正在从同事电脑载入…';
      onState?.('正在载入…');
      ensureCandidateFile(c.id, state.projectId).then(got => {
        if (active !== session) return;
        if (got?.ok && got.path) {
          wait.textContent = '载入中…';
          v.removeEventListener('loadedmetadata', go);
          v.addEventListener('loadedmetadata', go, { once: true });
          v.src = fileUrl(got.path);
          v.load();
          return;
        }
        wait.hidden = false;
        wait.classList.add('err');
        wait.textContent = got?.offline ? '视频在同事电脑上，对方上线后才能播放' : '同事电脑上找不到这段视频文件';
        onState?.(got?.offline ? '等待对方上线' : '播放失败');
        stopClip();
      });
      return;
    }
    wait.hidden = false;
    wait.classList.add('err');
    wait.textContent = '视频加载失败，请检查网络或文件后重试';
    onState?.('播放失败 · 再试一次');
    stopClip();
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
    if (Number.isFinite(v.duration) && w.playIn >= v.duration - 0.05) {
      wait.hidden = false;
      wait.classList.add('err');
      wait.textContent = `入出点 ${fmt(w.playIn)}–${fmt(w.playOut)} 超出了这个视频的长度（${fmt(v.duration)}）：清单里的时间写错了`;
      onState?.('片段时间写错了');
      stopClip();
      return;
    }
    wait.classList.remove('err');
    wait.textContent = '载入中…';
    v.currentTime = from == null ? w.playIn : Math.max(w.playIn, Math.min(w.playOut - 0.2, from));
    v.play().catch(() => {});
  };
  session.cleanup = () => {
    v.removeEventListener('loadedmetadata', go);
    v.ontimeupdate = v.onwaiting = v.onplaying = v.onpause = v.onerror = v.onended = null;
    if (box) box.onchange = null;
  };
  wait.classList.remove('err');
  wait.textContent = '载入中…';
  wait.hidden = false;
  onState?.('载入中…');
  if (v.readyState >= 1) go();
  else v.addEventListener('loadedmetadata', go, { once: true });
}

/* 自制进度条上的播放 / 暂停与拖动 */
export function togglePause(card, c) {
  const v = card?.querySelector('.vr-player');
  if (!v || !v.getAttribute('src') || v.error || active?.v !== v) return false;
  if (v.paused) v.play().catch(() => {});
  else v.pause();
  return true;
}
export function seekTrack(card, _c, track, clientX) {
  const v = card?.querySelector('.vr-player');
  if (!v || active?.v !== v) return;
  const { w } = active;
  const rect = track.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  v.currentTime = w.playIn + f * w.dur;
  if (active.usingVoice) {
    if (!voicePlayer.available()) {
      active.usingVoice = false;
      return;
    }
    const want = w.start + f * w.dur;
    const start = voStartOf(w);
    const end = voEndOf(w);
    if (want >= start && want < end - 0.03) {
      voicePlayer.seek(want);
      if (!v.paused && !voicePlayer.isPlaying()) playVoiceChecked(active, want, end);
    } else {
      voicePlayer.pause();
    }
  }
}

export function stopAllVideos() {
  stopClip();
  document.querySelectorAll('#vrList video').forEach(v => v.pause());
}
