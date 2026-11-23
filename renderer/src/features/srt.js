/* 字幕对齐、中文字幕挂载、双语 SRT 拆轨、批量粘贴译文与 SRT 导出。
   单时钟源不变式：align 改 r.time / state.timing；sub 只改 r.sub / state.subTiming（绝不覆盖 r.time）；
   bilingual 一步完成英文对齐 + 中文挂载；空项目导入双语 SRT 直接生成英文稿 + 中文字幕。 */
import { state } from '../app/state.js';
import { on } from '../app/events.js';
import { timeline } from '../app/project-queries.js';
import { applyImport, applyBatchSubs } from '../app/actions.js';
import {
  planAlignment,
  applyAlignment,
  planSubTiming,
  applySubTiming,
  applyBilingualAlignment,
  clearSubTiming,
} from '../app/subtitle.js';
import { parseSubtitles } from '../core/subtitle-align.js';
import { splitSentences } from '../core/parse.js';
import {
  isBilingualProject,
  detectScriptLang,
  inspectSubtitleCues,
  rowsFromBilingualSrt,
  mapSubCuesToLines,
  parseBatchTranslations,
  hasManualSubEdits,
  buildSrtDocument,
} from '../core/bilingual.js';
import { fmtTime, fmtLen, safeFileName } from '../core/text.js';
import * as native from '../platform/native.js';
import { toast, esc } from '../ui/base/dom.js';
import { registerCommand } from '../ui/base/commands.js';
import { registerModal } from '../ui/base/modal.js';

const $ = s => document.querySelector(s);
let pending = null;

const isSrtText = text => !/^\uFEFF?\s*WEBVTT/.test(text);
const MODE_LABELS = {
  align: '对齐时间轴',
  sub: '挂载中文字幕',
  bilingual: '双语字幕一步到位',
};
const FOOT_ALIGN =
  '剪映专业版导出字幕：导出时勾选「字幕导出」，格式选 SRT。对齐按文字逐字匹配，错字、口误、删改过的句子会标出来。';
const FOOT_BILINGUAL = '支持双语 SRT / VTT 自动拆轨，也支持单独挂载中文译文字幕；挂载后仍可在表格中逐句微调。';

function scriptLines() {
  return state.rows.filter(r => r.kind === 'line');
}

function getAlignPlan(ctx) {
  if (ctx.plans.align) return ctx.plans.align;
  let alignCues = ctx.cues;
  let alignRaw = ctx.raw;
  if (ctx.info.kind === 'bilingual') {
    const lang = detectScriptLang(
      scriptLines()
        .map(r => r.text)
        .join(' '),
    );
    alignCues = lang === 'zh' && ctx.info.zhCues?.length ? ctx.info.zhCues : ctx.info.enCues || ctx.cues;
    alignRaw = '';
  }
  ctx.plans.align = planAlignment(ctx.name, alignCues, alignRaw);
  return ctx.plans.align;
}

function getSubPlan(ctx) {
  if (ctx.plans.sub) return ctx.plans.sub;
  const subCues = ctx.info.kind === 'bilingual' ? ctx.info.zhCues || [] : ctx.cues;
  const subRaw = ctx.info.kind === 'bilingual' ? '' : ctx.raw;
  ctx.plans.sub = planSubTiming(ctx.name, subCues, subRaw);
  return ctx.plans.sub;
}

function getBilingualPlans(ctx) {
  if (ctx.plans.bilingual) return ctx.plans.bilingual;
  const enCues = ctx.info.enCues || [];
  const zhCues = ctx.info.zhCues || [];
  const enPlan = planAlignment(ctx.name, enCues, '');
  const lines = scriptLines();
  const virtualTl =
    enPlan.times && enPlan.times.size ? { times: enPlan.times, total: enPlan.stats.duration || 1 } : timeline();
  const subMapped = mapSubCuesToLines(lines, virtualTl, zhCues);
  const subPlan = {
    projectId: state.projectId,
    name: ctx.name || '中文字幕',
    cues: zhCues,
    raw: '',
    mapped: subMapped.mapped,
    stats: {
      matched: subMapped.matched,
      total: subMapped.total,
      cues: subMapped.cues,
      duration: subMapped.duration,
    },
  };
  ctx.plans.bilingual = { enPlan, subPlan };
  return ctx.plans.bilingual;
}

/* 入口：file = { name, content }（来自文件对话框 / 拖入 / 已存的字幕） */
export function startSrtAlign(file, { silent = false, preferredMode = null } = {}) {
  const cues = Array.isArray(file?.cues) ? file.cues : parseSubtitles(file?.content);
  if (!cues.length) {
    toast('没从这个文件里读到字幕时间（需要 SRT / VTT 格式）', null, 'error');
    return false;
  }
  const lines = scriptLines();
  const info = inspectSubtitleCues(cues, lines);
  /* 原文只存 SRT：导出剪映时原样写回「字幕.srt」；VTT 等其他格式导出时按条目还原 */
  const raw = typeof file.content === 'string' ? (isSrtText(file.content) ? file.content : '') : file.raw || '';
  const name = file.name || '字幕';

  if (!lines.length) {
    if (info.kind === 'bilingual') {
      const built = rowsFromBilingualSrt(cues);
      if (!built.rows.length) {
        toast('没从这个文件里读到字幕内容', null, 'error');
        return false;
      }
      pending = {
        projectId: state.projectId,
        name,
        cues,
        raw,
        info,
        emptyImport: true,
        built,
        showModeBar: true,
        modes: ['bilingual'],
        mode: 'bilingual',
        plans: {},
      };
      if (silent) return applyAlign();
      renderPreview();
      $('#srtMask').classList.add('show');
      return true;
    }
    toast('当前项目还没有句子，先导入稿子再对齐字幕', null, 'info');
    return false;
  }

  const showModeBar =
    info.kind === 'bilingual' ||
    isBilingualProject(state) ||
    info.kind === 'translation' ||
    preferredMode === 'sub' ||
    preferredMode === 'bilingual';
  const modes = ['align'];
  if (showModeBar) modes.push('sub');
  if (info.kind === 'bilingual') modes.push('bilingual');
  const fallbackMode = info.kind === 'bilingual' ? 'bilingual' : info.kind === 'translation' ? 'sub' : 'align';
  const mode = preferredMode && modes.includes(preferredMode) ? preferredMode : fallbackMode;

  pending = {
    projectId: state.projectId,
    name,
    cues,
    raw,
    info,
    emptyImport: false,
    showModeBar,
    modes,
    mode,
    plans: {},
  };
  if (silent) return applyAlign();
  renderPreview();
  $('#srtMask').classList.add('show');
  return true;
}

function renderModeBar() {
  const bar = $('#srtModeBar');
  if (!pending?.showModeBar) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  bar.hidden = false;
  if (pending.emptyImport) {
    bar.innerHTML =
      '<button type="button" class="srt-mode-btn on" data-srt-mode="bilingual">导入双语字幕为英文稿 + 中文字幕</button>';
    return;
  }
  bar.innerHTML = pending.modes
    .map(
      m =>
        `<button type="button" class="srt-mode-btn${pending.mode === m ? ' on' : ''}" data-srt-mode="${m}">${MODE_LABELS[m]}</button>`,
    )
    .join('');
}

function pairHTML(noText, enText, zhText) {
  return `<div class="srt-pair"><div class="srt-pair-en"><small>${esc(noText)}</small>${esc(enText)}</div><div class="srt-pair-zh">${zhText ? esc(zhText) : '<em>（未匹配到中文字幕）</em>'}</div></div>`;
}

function renderPreview() {
  if (!pending) return;
  renderModeBar();
  const { name, mode } = pending;

  if (pending.emptyImport) {
    const { rows, duration } = pending.built;
    const withSub = rows.filter(r => r.sub).length;
    $('#srtTitle').textContent = `导入双语字幕 · ${name}`;
    $('#srtSummary').innerHTML =
      `识别为双语字幕（约 ${esc(fmtLen(duration))}）：将生成 <b>${rows.length} 句</b>英文口播，并附带 <b>${withSub} 句</b>中文字幕与精确时间码。`;
    $('#srtList').innerHTML =
      rows
        .slice(0, 40)
        .map((r, i) => pairHTML(`第 ${i + 1} 句 · ${fmtTime(r.time.start)}`, r.text, r.sub || ''))
        .join('') + (rows.length > 40 ? `<p><small>还有 ${rows.length - 40} 句…</small></p>` : '');
    $('#srtHint').textContent = '应用后会直接生成英配中字项目，每句自带时间码与中文字幕。可以 ⌘Z 撤销。';
    $('#srtFootHint').textContent = FOOT_BILINGUAL;
    $('#srtApply').textContent = '导入双语字幕';
    return;
  }

  if (mode === 'align') {
    const { stats, times } = getAlignPlan(pending);
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
            const why =
              t.st === 'low' ? `低置信（${Math.round(t.conf * 100)}% 字相同）` : '没在字幕里找到，按前后句推算';
            return `<p><small>${fmtTime(t.start)} · ${esc(why)}</small>${esc(r.text)}</p>`;
          })
          .join('') + (problems.length > 80 ? `<p><small>还有 ${problems.length - 80} 句…</small></p>` : '')
      : '<p class="srt-good">每一句都在字幕里找到了。</p>';
    $('#srtHint').textContent = state.timing
      ? '应用后会替换当前项目已有的字幕时间。可以 ⌘Z 撤销。'
      : '应用后表格显示每句的真实时间码，时长、节奏色条和导出改用真实时间。可以 ⌘Z 撤销。';
    $('#srtFootHint').textContent = FOOT_ALIGN;
    $('#srtApply').textContent = '应用时间';
    return;
  }

  const lines = scriptLines();
  if (mode === 'sub') {
    const plan = getSubPlan(pending);
    const { stats, mapped } = plan;
    const hasTiming = timeline().source !== 'rate';
    $('#srtTitle').textContent = `挂载中文字幕 · ${name}`;
    $('#srtSummary').innerHTML =
      `中文字幕 ${stats.cues} 条 · 匹配 <b>${stats.matched} / ${stats.total}</b> 句` +
      (hasTiming ? '' : ' · <span class="warn">当前按句序估算匹配，对齐英文字幕后时间会更精准</span>');
    $('#srtList').innerHTML =
      lines
        .slice(0, 50)
        .map((r, i) => pairHTML(`第 ${r.no || i + 1} 句`, r.text, mapped.get(r.id) || ''))
        .join('') + (lines.length > 50 ? `<p><small>还有 ${lines.length - 50} 句…</small></p>` : '');
    $('#srtHint').textContent = '挂载后不会改动英文口播的时间轴，并自动开启英配中字模式。可以 ⌘Z 撤销。';
    $('#srtFootHint').textContent = FOOT_BILINGUAL;
    $('#srtApply').textContent = '挂载中文字幕';
    return;
  }

  // bilingual 模式（已有句子）
  const { enPlan, subPlan } = getBilingualPlans(pending);
  $('#srtTitle').textContent = `双语字幕一步到位 · ${name}`;
  $('#srtSummary').innerHTML =
    `英文对齐：<b>对上 ${enPlan.stats.ok}</b>` +
    (enPlan.stats.low ? ` · <span class="warn">低置信 ${enPlan.stats.low}</span>` : '') +
    (enPlan.stats.est ? ` · <span class="warn">未对上 ${enPlan.stats.est}</span>` : '') +
    `；中文匹配：<b>${subPlan.stats.matched} / ${subPlan.stats.total}</b> 句（共 ${subPlan.stats.cues} 条）`;
  $('#srtList').innerHTML =
    lines
      .slice(0, 50)
      .map((r, i) => {
        const t = enPlan.times.get(r.id);
        const label = t ? `第 ${r.no || i + 1} 句 · ${fmtTime(t.start)}` : `第 ${r.no || i + 1} 句`;
        return pairHTML(label, r.text, subPlan.mapped.get(r.id) || '');
      })
      .join('') + (lines.length > 50 ? `<p><small>还有 ${lines.length - 50} 句…</small></p>` : '');
  $('#srtHint').textContent = '应用后会用英文轨对齐每句时间轴，同时挂载中文字幕并开启英配中字模式。可以 ⌘Z 撤销。';
  $('#srtFootHint').textContent = FOOT_BILINGUAL;
  $('#srtApply').textContent = '一键应用双语字幕';
}

function closeSrt() {
  pending = null;
  $('#srtMask')?.classList.remove('show');
}

function applyAlign() {
  if (!pending) return false;
  const ctx = pending;
  closeSrt();
  if (ctx.projectId !== state.projectId) return false;
  if (ctx.emptyImport) {
    const cleanName = ctx.name.replace(/\.(srt|vtt|ass)$/i, '');
    const title = !state.title || state.title === '未命名项目' ? cleanName || '未命名项目' : state.title;
    applyImport(ctx.built.rows, title, {
      mode: 'replace',
      langMode: 'en-zh',
      timing: ctx.built.enCues?.length ? { name: ctx.name, cues: ctx.built.enCues, raw: '' } : null,
      subTiming: ctx.built.zhCues?.length ? { name: ctx.name, cues: ctx.built.zhCues, raw: '' } : null,
      archived: false,
    });
    return true;
  }
  if (ctx.mode === 'sub') {
    applySubTiming(getSubPlan(ctx));
    return true;
  }
  if (ctx.mode === 'bilingual') {
    const { enPlan, subPlan } = getBilingualPlans(ctx);
    applyBilingualAlignment(enPlan, subPlan);
    return true;
  }
  applyAlignment(getAlignPlan(ctx));
  return true;
}

/* 改稿后重新对齐：用项目里存着的那份字幕重跑一遍 */
function realignSaved() {
  if (!state.timing?.cues?.length) {
    toast('这个项目还没有对齐过字幕', null, 'info');
    return;
  }
  startSrtAlign(
    { name: state.timing.name, cues: state.timing.cues, raw: state.timing.raw },
    { preferredMode: 'align' },
  );
}

function pickSrt() {
  const pid = state.projectId;
  return native
    .importFile('srt')
    .then(r => {
      if (!r || state.projectId !== pid) return;
      if (r.error) toast(r.error, null, 'error');
      else startSrtAlign(r);
    })
    .catch(err => toast('导入字幕失败：' + (err?.message || '未知原因'), null, 'error'));
}

function pickSubSrt() {
  const pid = state.projectId;
  return native
    .importFile('srt')
    .then(r => {
      if (!r || state.projectId !== pid) return;
      if (r.error) toast(r.error, null, 'error');
      else startSrtAlign(r, { preferredMode: 'sub' });
    })
    .catch(err => toast('导入中文字幕失败：' + (err?.message || '未知原因'), null, 'error'));
}

function clearSub() {
  const hasLineSubs = state.rows.some(r => r.kind === 'line' && typeof r.sub === 'string' && r.sub.trim());
  if (!state.subTiming && !hasLineSubs) {
    toast('这个项目还没有中文字幕', null, 'info');
    return false;
  }
  return clearSubTiming({ clearLineSubs: true });
}

/* ── 批量粘贴中文译文 ── */
function closeSubPaste() {
  $('#subPasteMask')?.classList.remove('show');
}

function renderSubPastePreview() {
  const lines = scriptLines();
  const raw = $('#subPasteArea').value;
  const res = parseBatchTranslations(raw, lines, splitSentences);
  const summary = $('#subPasteSummary');
  const preview = $('#subPastePreview');
  const applyBtn = $('#subPasteApply');
  if (!raw.trim()) {
    summary.textContent = `已对应 0 / ${lines.length} 句`;
    preview.innerHTML = '';
    applyBtn.disabled = true;
    return;
  }
  let msg = `已对应 <b>${res.matched} / ${res.total}</b> 句`;
  if (res.extra > 0) msg += ` · <span class="warn">多出 ${res.extra} 句（超出部分不会填入）</span>`;
  else if (res.matched < res.total) msg += ` · <span class="warn">还有 ${res.total - res.matched} 句未填</span>`;
  summary.innerHTML = msg;
  const shown = lines.slice(0, Math.min(30, res.matched));
  preview.innerHTML =
    shown.map((r, i) => pairHTML(`第 ${r.no || i + 1} 句`, r.text, res.mapped.get(r.id) || '')).join('') +
    (res.matched > 30 ? `<p><small>还有 ${res.matched - 30} 句…</small></p>` : '');
  applyBtn.disabled = !res.matched;
}

function openSubPaste() {
  const lines = scriptLines();
  if (!lines.length) {
    toast('当前项目还没有句子，先导入稿子再粘贴中文字幕', null, 'info');
    return false;
  }
  $('#subPasteIntro').textContent =
    `当前项目共 ${lines.length} 句口播。逐行粘贴中文译文，或整段粘贴（会自动按中文标点拆句对应）。`;
  $('#subPasteArea').value = '';
  renderSubPastePreview();
  $('#subPasteMask').classList.add('show');
  setTimeout(() => {
    if ($('#subPasteMask')?.classList.contains('show')) $('#subPasteArea')?.focus();
  }, 60);
  return true;
}

function applySubPaste() {
  const lines = scriptLines();
  const res = parseBatchTranslations($('#subPasteArea').value, lines, splitSentences);
  if (!res.matched) {
    toast('先粘贴中文译文再填入', null, 'info');
    return false;
  }
  closeSubPaste();
  applyBatchSubs(res.mapped, { activateMode: true });
  return true;
}

/* ── 导出 SRT 字幕 ── */
function closeSrtExport() {
  $('#srtExportMask')?.classList.remove('show');
}

function selectedExportTrack() {
  return document.querySelector('#srtExportMask input[name="srtExportTrack"]:checked')?.value || 'zh';
}

function renderSrtExportHint() {
  const track = selectedExportTrack();
  const tl = timeline();
  const lines = scriptLines();
  const doc = buildSrtDocument({ project: state, tl, track });
  const hint = $('#srtExportHint');
  const goBtn = $('#srtExportGo');
  goBtn.disabled = !doc.count;
  if (track === 'zh') {
    if (!doc.count) {
      hint.textContent = '当前项目还没有中文字幕，请先挂载中文 SRT、批量粘贴译文或逐句填写后再导出。';
      return;
    }
    const fromSub = state.subTiming?.cues?.length && !hasManualSubEdits(lines, tl, state.subTiming);
    const src = fromSub
      ? '来自已导入的中文字幕轨'
      : tl.source === 'srt'
        ? '按句子时间轴与表格中文字幕生成'
        : '按估算时间与表格中文字幕生成';
    hint.textContent = `将导出 ${doc.count} 条中文字幕（${src}）。`;
    return;
  }
  if (track === 'en') {
    if (!doc.count) {
      hint.textContent = '当前项目还没有可导出的原文字幕。';
      return;
    }
    const src =
      state.timing?.cues?.length || state.timing?.raw?.trim()
        ? '来自已对齐的原文字幕'
        : tl.source === 'srt'
          ? '按句子时间轴生成'
          : '按估算时间生成';
    hint.textContent = `将导出 ${doc.count} 条原文字幕（${src}）。`;
    return;
  }
  if (!doc.count) {
    hint.textContent = '当前项目还没有可导出的双语字幕。';
    return;
  }
  const zhCount = lines.filter(r => typeof r.sub === 'string' && r.sub.trim()).length;
  const src = tl.source === 'srt' ? '按句子时间轴生成' : '按估算时间生成';
  hint.textContent = `将导出 ${doc.count} 条双语字幕（其中 ${zhCount} 条含中文译文，${src}）。`;
}

function openSrtExport() {
  const lines = scriptLines();
  if (!lines.length && !state.timing?.cues?.length && !state.subTiming?.cues?.length) {
    toast('当前项目还没有可导出的句子或字幕', null, 'info');
    return false;
  }
  const track = isBilingualProject(state) ? 'zh' : 'en';
  const radio = document.querySelector(`#srtExportMask input[name="srtExportTrack"][value="${track}"]`);
  if (radio) radio.checked = true;
  renderSrtExportHint();
  $('#srtExportMask').classList.add('show');
  return true;
}

async function runSrtExport() {
  const track = selectedExportTrack();
  const doc = buildSrtDocument({ project: state, tl: timeline(), track });
  if (!doc.count || !doc.srt) {
    toast('当前没有可导出的字幕内容', null, 'warn');
    return false;
  }
  const filename = `${safeFileName(state.title || '未命名项目')}.${track}.srt`;
  closeSrtExport();
  try {
    const r = await native.exportFile(filename, doc.srt);
    if (r?.ok) toast(`已导出字幕：${filename}（${doc.count} 条）`, null, 'ok');
    else if (r?.canceled) toast('已取消导出', null, 'info');
    else toast('导出字幕失败：' + (r?.error || '写不进这个位置'), null, 'error');
  } catch (err) {
    toast('导出字幕失败：' + (err?.message || '未知原因'), null, 'error');
  }
  return true;
}

export function initSrt() {
  registerCommand('srt:pick', pickSrt);
  registerCommand('srt:start', (file, opts) => startSrtAlign(file, opts));
  registerCommand('srt:realign', realignSaved);
  registerCommand('srt:pick-sub', pickSubSrt);
  registerCommand('srt:clear-sub', clearSub);
  registerCommand('sub:paste', openSubPaste);
  registerCommand('srt:export', openSrtExport);

  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="srtMask"><div class="modal wide srt-review">
      <h3 id="srtTitle"></h3>
      <div class="srt-mode-bar" id="srtModeBar" hidden></div>
      <p id="srtSummary"></p>
      <div id="srtList"></div>
      <p class="srt-hint" id="srtHint"></p>
      <p class="srt-hint" id="srtFootHint">${FOOT_ALIGN}</p>
      <div class="m-btns"><button class="btn" id="srtCancel">取消</button><button class="btn primary" id="srtApply">应用时间</button></div>
    </div></div>
    <div class="modal-mask" id="subPasteMask"><div class="modal wide sub-paste-modal">
      <h3 id="subPasteTitle">批量粘贴中文字幕</h3>
      <p class="srt-hint" id="subPasteIntro"></p>
      <textarea class="paste-area" id="subPasteArea" placeholder="把中文译文粘贴到这里：每行一句，也可以整段粘贴自动拆句…"></textarea>
      <p id="subPasteSummary"></p>
      <div id="subPastePreview"></div>
      <div class="m-btns"><button class="btn" id="subPasteCancel" type="button">取消</button><button class="btn primary" id="subPasteApply" type="button" disabled>填入中文字幕</button></div>
    </div></div>
    <div class="modal-mask" id="srtExportMask"><div class="modal srt-export-modal">
      <h3>导出 SRT 字幕</h3>
      <p class="srt-hint">导出标准 UTF-8 格式的 .srt 字幕，可直接上传 YouTube 或导入剪辑软件。</p>
      <div class="srt-export-opts" role="radiogroup" aria-label="字幕轨道">
        <label class="srt-export-opt"><input type="radio" name="srtExportTrack" value="zh"><span><b>中文字幕（.zh.srt）</b><small>仅导出中文字幕，适合 YouTube CC 轨</small></span></label>
        <label class="srt-export-opt"><input type="radio" name="srtExportTrack" value="en"><span><b>英文字幕 / 口播原文（.en.srt）</b><small>导出口播原文字幕</small></span></label>
        <label class="srt-export-opt"><input type="radio" name="srtExportTrack" value="bilingual"><span><b>中英双语字幕（.bilingual.srt）</b><small>每条字幕上中文、下英文</small></span></label>
      </div>
      <p class="srt-hint" id="srtExportHint"></p>
      <div class="m-btns"><button class="btn" id="srtExportCancel" type="button">取消</button><button class="btn primary" id="srtExportGo" type="button">导出 SRT</button></div>
    </div></div>`,
  );

  $('#srtCancel').onclick = closeSrt;
  $('#srtApply').onclick = applyAlign;
  $('#srtMask').addEventListener('click', e => {
    if (e.target.id === 'srtMask') closeSrt();
  });
  $('#srtModeBar').addEventListener('click', e => {
    const btn = e.target.closest('[data-srt-mode]');
    if (!btn || !pending || pending.emptyImport) return;
    const next = btn.dataset.srtMode;
    if (pending.modes.includes(next) && next !== pending.mode) {
      pending.mode = next;
      renderPreview();
    }
  });

  $('#subPasteCancel').onclick = closeSubPaste;
  $('#subPasteApply').onclick = applySubPaste;
  $('#subPasteArea').addEventListener('input', renderSubPastePreview);
  $('#subPasteMask').addEventListener('click', e => {
    if (e.target.id === 'subPasteMask') closeSubPaste();
  });
  registerModal('subPasteMask', {
    close: closeSubPaste,
    onKey: e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        applySubPaste();
        return true;
      }
    },
  });

  $('#srtExportCancel').onclick = closeSrtExport;
  $('#srtExportGo').onclick = () => void runSrtExport();
  $('#srtExportMask').addEventListener('click', e => {
    if (e.target.id === 'srtExportMask') closeSrtExport();
  });
  document.querySelectorAll('#srtExportMask input[name="srtExportTrack"]').forEach(radio => {
    radio.addEventListener('change', renderSrtExportHint);
  });
  registerModal('srtExportMask', {
    close: closeSrtExport,
    enter: () => !$('#srtExportGo')?.disabled && void runSrtExport(),
  });

  on('project-loaded', () => {
    closeSrt();
    closeSubPaste();
    closeSrtExport();
  });
}
