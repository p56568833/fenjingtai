/* 剪映字幕对齐（界面）：选 / 拖入 SRT → 预览对齐结果 → 应用（一步可撤销）。
   对齐后每句带真实时间 r.time = {start, end, conf, st}，st：ok 对上 / low 低置信 / est 按前后推算；
   项目级 state.timing 记来源字幕（含字幕原文，改稿后可「重新对齐」）。
   时长、节奏色条、交稿检查、导出都会优先用真实时间。 */
import { state } from '../app/state.js';
import { planAlignment, applyAlignment } from '../app/subtitle.js';
import { parseSubtitles } from '../core/subtitle-align.js';
import { fmtTime } from '../core/text.js';
import * as native from '../platform/native.js';
import { toast, esc } from '../ui/dom.js';
import { registerCommand } from '../ui/commands.js';

const $ = s => document.querySelector(s);
let pending = null; // { name, cues, times, stats }

const fmtLen = sec => (sec >= 60 ? `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒` : `${Math.round(sec)} 秒`);

/* 入口：file = { name, content }（来自文件对话框 / 拖入 / 已存的字幕） */
export function startSrtAlign(file, { silent = false } = {}) {
  const cues = Array.isArray(file.cues) ? file.cues : parseSubtitles(file.content);
  if (!cues.length) {
    toast('没从这个文件里读到字幕时间（需要 SRT / VTT 格式）');
    return false;
  }
  const lines = state.rows.filter(r => r.kind === 'line');
  if (!lines.length) {
    toast('当前项目还没有句子，先导入稿子再对齐字幕');
    return false;
  }
  pending = planAlignment(file.name, cues);
  if (silent) return applyAlign();
  renderPreview();
  $('#srtMask').classList.add('show');
  return true;
}

function renderPreview() {
  const { name, stats, times } = pending;
  $('#srtTitle').textContent = `对齐剪映字幕 · ${name}`;
  $('#srtSummary').innerHTML =
    `字幕 ${stats.cues} 条，约 ${esc(fmtLen(stats.duration))}。稿子 ${stats.lines} 句：` +
    `<b>对上 ${stats.ok}</b> · <span class="warn">低置信 ${stats.low}</span> · <span class="warn">未对上 ${stats.est}</span>`;
  const problems = state.rows.filter(r => r.kind === 'line' && times.get(r.id)?.st !== 'ok');
  $('#srtList').innerHTML = problems.length
    ? problems
        .slice(0, 80)
        .map(r => {
          const t = times.get(r.id);
          const why = t.st === 'low' ? `低置信（${Math.round(t.conf * 100)}% 字相同）` : '没在字幕里找到，按前后句推算';
          return `<p><small>${fmtTime(t.start)} · ${esc(why)}</small>${esc(r.text)}</p>`;
        })
        .join('') + (problems.length > 80 ? `<p><small>还有 ${problems.length - 80} 句…</small></p>` : '')
    : '<p class="srt-good">每一句都在字幕里找到了。</p>';
  $('#srtHint').textContent = state.timing
    ? '应用后会替换当前项目已有的字幕时间。可以 ⌘Z 撤销。'
    : '应用后表格显示每句的真实时间码，时长、节奏色条和导出改用真实时间。可以 ⌘Z 撤销。';
}

function applyAlign() {
  if (!pending) return false;
  const plan = pending;
  pending = null;
  $('#srtMask').classList.remove('show');
  applyAlignment(plan);
  return true;
}

/* 改稿后重新对齐：用项目里存着的那份字幕重跑一遍 */
export function realignSaved() {
  if (!state.timing?.cues?.length) {
    toast('这个项目还没有对齐过字幕');
    return;
  }
  startSrtAlign({ name: state.timing.name, cues: state.timing.cues });
}

export function pickSrt() {
  return native.importFile('srt').then(r => {
    if (!r) return;
    if (r.error) toast(r.error);
    else startSrtAlign(r);
  });
}

export function initSrt() {
  registerCommand('srt:pick', pickSrt);
  registerCommand('srt:start', file => startSrtAlign(file));
  registerCommand('srt:realign', realignSaved);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="srtMask"><div class="modal wide srt-review">
      <h3 id="srtTitle"></h3>
      <p id="srtSummary"></p>
      <div id="srtList"></div>
      <p class="srt-hint" id="srtHint"></p>
      <p class="srt-hint">剪映专业版导出字幕：导出时勾选「字幕导出」，格式选 SRT。对齐按文字逐字匹配，错字、口误、删改过的句子会标出来。</p>
      <div class="m-btns"><button class="btn" id="srtCancel">取消</button><button class="btn primary" id="srtApply">应用时间</button></div>
    </div></div>`,
  );
  $('#srtCancel').onclick = () => {
    pending = null;
    $('#srtMask').classList.remove('show');
  };
  $('#srtApply').onclick = applyAlign;
  $('#srtMask').addEventListener('click', e => {
    if (e.target.id === 'srtMask') $('#srtCancel').click();
  });
}
