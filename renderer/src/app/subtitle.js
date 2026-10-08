/* 剪映字幕对齐的数据操作：应用对齐结果 / 清除。对齐算法在 core/subtitle-align.js。 */
import { state, update } from './state.js';
import { notify } from './events.js';
import { persist } from './storage.js';
import { snapshot } from './undo.js';
import { alignScript } from '../core/subtitle-align.js';

/* 用一份字幕给当前稿子算对齐结果（不改数据，给预览用） */
export function planAlignment(name, cues) {
  const lines = state.rows.filter(r => r.kind === 'line');
  const { times, stats } = alignScript(
    lines.map(r => ({ id: r.id, text: r.text })),
    cues,
  );
  return { name: name || '字幕', cues, times, stats };
}

export function applyAlignment({ name, cues, times, stats }) {
  snapshot(state.timing ? '重新对齐字幕' : '对齐剪映字幕');
  for (const r of state.rows) {
    if (r.kind !== 'line') continue;
    const t = times.get(r.id);
    if (t) r.time = t;
    else delete r.time;
  }
  state.timing = { name, at: Date.now(), duration: stats.duration, cues };
  persist();
  update('rows');
  notify(
    `已对齐字幕：${stats.ok} 句对上${stats.low + stats.est ? `，${stats.low + stats.est} 句待核对（时长列标黄）` : ''}`,
  );
}

export function clearTiming() {
  if (!state.timing && !state.rows.some(r => r.time)) return;
  snapshot('清除字幕时间');
  for (const r of state.rows) delete r.time;
  state.timing = null;
  persist();
  update('rows');
  notify('已清除字幕时间 · ⌘Z 可撤销');
}
