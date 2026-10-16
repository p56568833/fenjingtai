/* 时间的界面呈现：表格「时长」格、时长标题。数据来自 app/state.js 的时间轴（字幕 > 口播音频 > 语速）。 */
import { state } from '../app/state.js';
import { timeOf, lineSeconds, timeline } from '../app/project-queries.js';
import { fmtTime } from '../core/text.js';
import { esc } from './base/dom.js';

const dur = r => lineSeconds(r).toFixed(1) + 's';

export function durHeading() {
  return timeline().source === 'srt' ? '时长' : '≈时长';
}

/* 表格「时长」格：只写这句占几秒（几分几秒的时间码收进悬停提示）；有口播时点一下从这句开始播。
   低置信 / 推算的标黄，在悬停提示中说明 */
export function durCellHTML(r) {
  const t = timeOf(r.id);
  const secs = dur(r);
  const play = '';
  const hint = '';
  const cell = (cls, why) => `<span class="tc${cls}"${play} title="${esc(why + hint)}">${secs}</span>`;
  if (!t || t.src === 'rate')
    return cell(state.voice ? ' dur-est' : '', `按语速估算${t ? ` · 从 ${fmtTime(t.start)} 开始` : ''}`);
  if (t.src === 'fit') return cell(' dur-fit', `按口播音频总长、按字数比例推算 · 从 ${fmtTime(t.start)} 开始`);
  if (t.src === 'gap')
    return cell(' dur-est', `对齐字幕之后新加的句子，时间按前后句推算 · 从 ${fmtTime(t.start)} 开始`);
  const why =
    t.st === 'ok'
      ? `字幕时间 ${fmtTime(t.start)}–${fmtTime(t.end)}`
      : t.st === 'low'
        ? `低置信：只有 ${Math.round((r.time?.conf || 0) * 100)}% 的字和字幕一致，时间可能不准`
        : '字幕里没找到这句，时间是按前后句推算的';
  return cell(t.st === 'ok' ? '' : ' dur-' + t.st, why);
}
