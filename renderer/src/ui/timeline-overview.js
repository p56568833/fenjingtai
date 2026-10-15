/* 全片总览：真实录音作为尺子，选中句子的时间与素材状态独立于播放位置。 */
import { state, timeline, rowById } from '../app/state.js';
import { projectPictureCoverage } from '../app/line-coverage.js';
import { lineAt } from '../core/timeline.js';
import { fmtTime } from '../core/text.js';
import { runCommand } from './base/commands.js';

const $ = selector => document.querySelector(selector);
export const overviewTotal = () => (state.voice?.duration > 0 ? state.voice.duration : timeline().total);

export function renderOverviewSelection() {
  const row = rowById(state.sel),
    tm = row?.kind === 'line' ? timeline().times.get(row.id) : null;
  const label = $('#segSelection'),
    point = $('#segPointer'),
    timeLabel = $('#segTimeLabel'),
    bottomPoint = $('#segPointerBottom');
  if (!label) return;
  const total = overviewTotal();
  const hasSelection = !!tm && total > 0;
  label.hidden = point.hidden = timeLabel.hidden = bottomPoint.hidden = !hasSelection;
  if (!hasSelection) return;
  const start = Math.max(0, Math.min(1, tm.start / total));
  const cov = projectPictureCoverage().byLine.get(row.id);
  const status = cov?.missingGaps.length ? '素材失联' : cov?.state === 'ok' ? '已挂' : '待挂';
  $('#segTimeline').style.setProperty('--seg-position', `${start * 100}%`);
  $('#segTime').textContent = fmtTime(tm.start);
  $('#segLine').textContent = `第 ${row.no} 句`;
  label.setAttribute('aria-label', `第 ${row.no} 句，${fmtTime(tm.start)}，${status}`);
  const seek = $('#segSeek');
  if (document.activeElement !== seek) seek.value = String(Math.min(total, Math.max(0, tm.start)));
  seek.setAttribute('aria-valuetext', `第 ${row.no} 句，${fmtTime(tm.start)}，${status}`);
}

export function renderOverview(lines = state.rows.filter(r => r.kind === 'line')) {
  const total = overviewTotal();
  const overview = $('#segOverview');
  if (!overview) return;
  overview.hidden = !lines.length;
  if (overview.dataset.project !== String(state.projectId) || !state.voice) $('#segPlayhead').hidden = true;
  overview.dataset.project = String(state.projectId);
  overview.dataset.total = String(total);
  overview.setAttribute(
    'aria-label',
    `全片素材覆盖，${state.voice?.duration > 0 ? '录音总长' : '预计总长'} ${fmtTime(total)}`,
  );
  const result = projectPictureCoverage({ refresh: true });
  // UI 只把统一结果映射成颜色，不再自行计算失联、停顿或画面缺口。
  $('#segSegments').innerHTML = result.segments
    .filter(s => s.status !== 'gap')
    .map(s => {
      const start = Math.max(0, Math.min(total, s.start)),
        end = Math.max(start, Math.min(total, s.end));
      if (end <= start) return '';
      return `<span class="seg ${s.status === 'missing' ? 'missing' : 'mounted'}" style="left:${(start / total) * 100}%;width:${((end - start) / total) * 100}%"></span>`;
    })
    .join('');
  const seek = $('#segSeek');
  seek.max = String(Math.max(total, 0.01));
  seek.disabled = !lines.length || !(total > 0);
  renderOverviewSelection();
}

export function initOverview() {
  const seek = $('#segSeek');
  const selectTime = seconds => {
    const order = state.rows.filter(r => r.kind === 'line').map(r => r.id);
    const id = lineAt(timeline(), order, seconds);
    if (id != null && id !== state.sel) runCommand('nav:jump', id);
  };
  seek.addEventListener('input', () => selectTime(Number(seek.value)));
  // 原生滑块会为滑块头预留宽度，长录音上几像素就可能错开数句。
  // 直接用可见色条的完整宽度换算时间，灰色缺口与蓝色素材使用同一把尺子。
  const selectPoint = event => {
    const rect = $('#segbar').getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const seconds = fraction * overviewTotal();
    seek.value = String(seconds);
    selectTime(seconds);
  };
  let dragging = null;
  seek.addEventListener('pointerdown', event => {
    if (seek.disabled || event.button !== 0 || dragging != null) return;
    event.preventDefault();
    seek.focus({ preventScroll: true });
    dragging = event.pointerId;
    seek.setPointerCapture(event.pointerId);
    selectPoint(event);
  });
  seek.addEventListener('pointermove', event => {
    if (dragging === event.pointerId) selectPoint(event);
  });
  seek.addEventListener('pointerup', event => {
    if (dragging !== event.pointerId) return;
    selectPoint(event);
    dragging = null;
    seek.releasePointerCapture(event.pointerId);
    renderOverviewSelection();
  });
  const stopDrag = () => (dragging = null);
  seek.addEventListener('pointercancel', stopDrag);
  seek.addEventListener('lostpointercapture', stopDrag);
  seek.addEventListener('keydown', event => {
    const order = state.rows.filter(r => r.kind === 'line').map(r => r.id);
    let index = order.indexOf(state.sel);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      index = Math.max(0, Math.min(order.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = order.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    if (order[index] != null) {
      runCommand('nav:jump', order[index]);
      seek.value = String(Math.min(overviewTotal(), timeline().times.get(order[index])?.start || 0));
    }
  });
}
