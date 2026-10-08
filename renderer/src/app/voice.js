/* 口播音频（项目级，一个项目一条）：只记路径和时长，不复制文件。
   有了它，没对字幕时每句的时间按「字数比例铺满音频总长」推算（见 core/timeline.js）。 */
import { state, update, emit } from './state.js';
import { notify } from './events.js';
import { persist } from './storage.js';
import { snapshot } from './undo.js';
import { assetName, AUDIO_EXT, VIDEO_EXT } from '../core/asset-model.js';

export const isVoiceFile = p => AUDIO_EXT.test(p || '') || VIDEO_EXT.test(p || '');

export function setVoice(path, duration) {
  if (!path || !isVoiceFile(path)) {
    notify('口播音频需要是音频或视频文件（mp3 / wav / m4a / mp4 / mov…）');
    return false;
  }
  snapshot(state.voice ? '更换口播音频' : '导入口播音频');
  state.voice = { path, name: assetName(path), duration: isFinite(duration) && duration > 0 ? duration : null };
  persist();
  emit('voice');
  update('rows');
  notify(
    state.timing
      ? `已导入口播音频「${state.voice.name}」，每句时间用对齐好的字幕 · ⌘Z 可撤销`
      : `已导入口播音频「${state.voice.name}」，每句时间按音频长度推算 · ⌘Z 可撤销`,
  );
  return true;
}

/* 音频元数据读到后补上时长（不进撤销） */
export function setVoiceDuration(duration) {
  if (!state.voice || !(isFinite(duration) && duration > 0)) return;
  if (Math.abs((state.voice.duration || 0) - duration) < 0.01) return;
  state.voice.duration = duration;
  persist();
  update('rows');
}

export function clearVoice() {
  if (!state.voice) return;
  snapshot('移除口播音频');
  state.voice = null;
  persist();
  emit('voice');
  update('rows');
  notify('已移除口播音频（本地文件保留）· ⌘Z 可撤销');
}

export function relocateVoice(path) {
  if (!state.voice || !isVoiceFile(path)) return false;
  snapshot('重新定位口播音频');
  state.voice = { ...state.voice, path, name: assetName(path) };
  persist();
  emit('voice');
  update('rows');
  return true;
}
