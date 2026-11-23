/* 每个预览独立拥有播放位置与计时循环。共享口播设备只在本实例播放时作为时钟。 */
export function createPlaybackClock({ voice, voiceEnd, total, onTick, onState, connected, beforePlay }) {
  let playing = false,
    time = 0,
    audio = false,
    lastFrame = 0,
    raf = 0,
    playSeq = 0,
    startingAudio = false,
    unsubscribe = null;
  const audioAt = t => voice.available() && t < voiceEnd();
  const currentTime = () => (playing && audio && !startingAudio && voice.available() ? voice.currentTime() : time);
  function pause() {
    time = currentTime();
    playSeq++;
    startingAudio = false;
    if (playing) voice.pause();
    playing = false;
    cancelAnimationFrame(raf);
    onState();
  }
  function tick(t) {
    time = t;
    onTick(t);
  }
  function frame(now) {
    if (!playing) return;
    if (!connected()) return pause();
    const dt = Math.min(1, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    if (!audio || !voice.available()) {
      if (audio) {
        audio = false;
        startingAudio = false;
        onState();
      }
      tick(time + dt);
      if (time >= total()) pause();
    } else if (voice.currentTime() >= voiceEnd() && total() > voiceEnd()) {
      audio = false;
      startingAudio = false;
      voice.pause();
      onState();
      tick(voiceEnd());
    } else if (!startingAudio && !voice.isPlaying()) {
      pause();
    } else if (!startingAudio) {
      tick(voice.currentTime());
    }
    if (playing) raf = requestAnimationFrame(frame);
  }
  function startAudio(t) {
    const seq = ++playSeq;
    startingAudio = true;
    Promise.resolve(voice.playRange(t, null)).then(ok => {
      if (seq !== playSeq || !playing || !audio) return;
      startingAudio = false;
      if (ok === false) pause();
    });
  }
  function play(t = currentTime()) {
    beforePlay?.();
    time = t;
    playing = true;
    audio = audioAt(t);
    if (audio) startAudio(t);
    else {
      playSeq++;
      startingAudio = false;
      voice.pause();
    }
    lastFrame = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
    onState();
  }
  return {
    currentTime,
    play,
    pause,
    isPlaying: () => playing,
    usesVoice: () => audio,
    remember(t) {
      time = t;
    },
    seek(t) {
      const wasAudio = audio;
      time = t;
      audio = audioAt(t);
      if (playing) {
        if (audio === wasAudio) {
          if (audio) voice.seek(t);
          else lastFrame = performance.now();
          onState();
          tick(t);
          return;
        }
        tick(t);
        if (playing) play(t);
        return;
      }
      onState();
      tick(t);
    },
    attach() {
      unsubscribe?.();
      unsubscribe = voice.onTick(t => {
        if (playing && audio && !startingAudio) tick(t);
      });
    },
    detach() {
      pause();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
