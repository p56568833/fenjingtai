/* 每个预览独立拥有播放位置与计时循环。共享口播设备只在本实例播放时作为时钟。 */
export function createPlaybackClock({ voice, voiceEnd, total, onTick, onState, connected, beforePlay }) {
  let playing = false,
    time = 0,
    audio = false,
    lastFrame = 0,
    startedAt = 0,
    raf = 0,
    unsubscribe = null;
  const audioAt = t => voice.available() && t < voiceEnd();
  const currentTime = () => (playing && audio && voice.available() ? voice.currentTime() : time);
  function pause() {
    time = currentTime();
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
    const dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (!audio || !voice.available()) {
      if (audio) {
        audio = false;
        onState();
      }
      tick(time + dt);
      if (time >= total()) pause();
    } else if (voice.currentTime() >= voiceEnd() && total() > voiceEnd()) {
      audio = false;
      voice.pause();
      onState();
      tick(voiceEnd());
    } else if (!voice.isPlaying() && now - startedAt > 800) pause();
    else tick(voice.currentTime());
    if (playing) raf = requestAnimationFrame(frame);
  }
  function play(t = currentTime()) {
    beforePlay?.();
    time = t;
    playing = true;
    audio = audioAt(t);
    if (audio) voice.playRange(t, null);
    else voice.pause();
    startedAt = lastFrame = performance.now();
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
      time = t;
      audio = audioAt(t);
      if (playing) {
        if (audio) voice.seek(t);
        else voice.pause();
      }
      onState();
      tick(t);
      if (playing) play(t);
    },
    attach() {
      unsubscribe?.();
      unsubscribe = voice.onTick(t => {
        if (playing && audio) tick(t);
      });
    },
    detach() {
      pause();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
