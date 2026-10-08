/* 时间的界面呈现：表格「时长」格、时长标题。数据来自 app/state.js 的时间轴（字幕 > 口播音频 > 语速）。 */
import { state, timeOf, lineSeconds, timeline } from '../app/state.js';
import { fmtTime } from '../core/text.js';
import { esc } from './dom.js';

export const dur = r => lineSeconds(r).toFixed(1) + 's';

export function durHeading() {
  const src = timeline().source;
  return src === 'srt' ? '时间码' : src === 'fit' ? '≈时间码' : '≈时长';
}

/* 表格「时长」格：时间码（可点击从这句开始播口播）+ 时长；低置信 / 推算的标黄并说明 */
export function durCellHTML(r) {
  const t = timeOf(r.id);
  const secs = dur(r);
  const play = state.voice ? ` data-play="${r.id}" role="button" tabindex="-1"` : '';
  const hint = state.voice ? ' · 点击从这句开始播口播' : '';
  if (!t || t.src === 'rate') {
    return state.voice
      ? `<span class="tc dur-est"${play} title="按语速估算${hint}">≈${fmtTime(t?.start ?? 0)}</span>${secs}`
      : secs;
  }
  if (t.src === 'fit')
    return `<span class="tc dur-fit"${play} title="${esc('按口播音频总长、按字数比例推算' + hint)}">≈${fmtTime(t.start)}</span>${secs}`;
  if (t.src === 'gap')
    return `<span class="tc dur-est"${play} title="${esc('对齐字幕之后新加的句子，时间按前后句推算' + hint)}">≈${fmtTime(t.start)}</span>${secs}`;
  const why =
    t.st === 'ok'
      ? `字幕时间 ${fmtTime(t.start)}–${fmtTime(t.end)}`
      : t.st === 'low'
        ? `低置信：只有 ${Math.round((r.time?.conf || 0) * 100)}% 的字和字幕一致，时间可能不准`
        : '字幕里没找到这句，时间是按前后句推算的';
  return `<span class="tc${t.st === 'ok' ? '' : ' dur-' + t.st}"${play} title="${esc(why + hint)}">${t.st === 'ok' ? '' : '≈'}${fmtTime(t.start)}</span>${secs}`;
}
