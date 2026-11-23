/* 导入导出：稿件文件 / 粘贴导入，PDF / 项目文件导出。
   桌面版导出走系统保存对话框。解析与生成都是 core/ 里的纯函数，这里只管流程和弹窗。 */
import { state } from '../app/state.js';
import { update } from '../app/project-events.js';
import { types } from '../app/project-queries.js';
import * as storage from '../app/storage.js';
import { clearUndo } from '../app/undo.js';
import { saveCurrentProject } from '../app/project-change.js';
import { applyImport, rowIdOptions } from '../app/actions.js';
import { normalizeProjectRows, reconcileDraft } from '../core/project-import.js';
import { buildProjectJson } from '../core/project-json.js';
import { parseAny, migrateSections, mdTypes } from '../core/parse.js';
import { normalizeProjectData, projectData } from '../core/project-data.js';
import { normalizeReworkRequests } from '../core/candidate-scope.js';
import { CANDIDATE_TYPE } from '../core/candidate-values.js';
import { sanitizeProjectCandidates } from '../core/candidates.js';
import { safeFileName } from '../core/text.js';
import { isBilingualProject, detectScriptLang } from '../core/bilingual.js';
import * as native from '../platform/native.js';
import { toast, esc } from './base/dom.js';
import { openMenu, closePop, popOpenFor, markPopAnchor } from './base/popover.js';
import { clearTiming } from '../app/subtitle.js';
import { armAnimation } from './base/anim.js';
import { deliveryIssues } from './review.js';
import { registerCommand, runCommand } from './base/commands.js';

const $ = s => document.querySelector(s);
let pendingImport = null; // { rows, title, types? }

export function previewImport(rows, title, fileTypes = null) {
  pendingImport = { rows, title, types: fileTypes };
  $('#importMode').value = 'new';
  $('#importTitle').value = title;
  $('#importPreviewMask').classList.add('show');
  renderImportPreview();
}
function isEnglishImport(rows) {
  const lines = rows.filter(r => r.kind === 'line');
  if (lines.length < 2) return false;
  return detectScriptLang(lines.map(r => r.text).join(' ')) === 'en';
}

function renderImportPreview() {
  if (!pendingImport) return;
  const mode = $('#importMode').value;
  const titleInput = $('#importTitle');
  titleInput.disabled = mode === 'update';
  titleInput.title = mode === 'update' ? '更新当前稿件时保留原项目名称' : '';
  const result = mode === 'update' ? reconcileDraft(state.rows, pendingImport.rows, rowIdOptions()) : null;
  const rows = result ? result.rows : pendingImport.rows;
  const subCount = rows.filter(r => r.kind === 'line' && typeof r.sub === 'string' && r.sub.trim()).length;
  const enScript = isEnglishImport(rows);
  const subNote = subCount
    ? ` · 含 ${subCount} 句中文字幕（自动开启英配中字模式）`
    : enScript
      ? ' · 识别为英文稿（将自动开启英配中字模式）'
      : '';
  $('#importSummary').textContent = result
    ? `保留 ${result.kept} 句的标注 · ${result.review} 句新增或改过（需重新标注） · ${result.removed} 句原文未匹配${subNote}。重复句子不继承标注。`
    : `识别出 ${rows.filter(r => r.kind === 'line').length} 句、${rows.filter(r => r.kind === 'section').length} 个章节${subNote}。`;
  $('#importWarning').textContent =
    mode === 'new'
      ? '将创建新项目，现有项目保留。'
      : mode === 'update'
        ? '按完全一致且不重复的原文匹配。更新前会保留一份原项目副本。'
        : '当前项目内容将被替换，视频候选和字幕对齐一并清空；替换前会保留一份原项目副本。';
  $('#importPreview').innerHTML = rows
    .map(r =>
      r.kind === 'section'
        ? `<h4>${esc(r.text)}</h4>`
        : `<p>${esc(r.text)}${r.sub ? `<span class="imp-sub">${esc(r.sub)}</span>` : ''}</p>`,
    )
    .join('');
}
function acceptImport() {
  if (!pendingImport) return;
  const { rows, title, types: fileTypes } = pendingImport;
  const name = $('#importTitle').value.trim() || title;
  const mode = $('#importMode').value;
  const autoEnZh =
    rows.some(r => r.kind === 'line' && typeof r.sub === 'string' && r.sub.trim()) || isEnglishImport(rows);
  if (mode === 'new') {
    storage.createProject(
      name,
      rows,
      {},
      {
        ...(fileTypes ? { types: fileTypes } : {}),
        ...(autoEnZh ? { langMode: 'en-zh' } : {}),
      },
    );
    clearUndo();
  } else {
    const result = mode === 'update' ? reconcileDraft(state.rows, rows, rowIdOptions()).rows : rows;
    storage.archiveCurrentCopy('改稿前');
    applyImport(result, mode === 'update' ? state.title : name, {
      mode,
      ...(autoEnZh ? { langMode: 'en-zh' } : {}),
    });
  }
  pendingImport = null;
  $('#importPreviewMask').classList.remove('show');
  update('rows');
  if (mode === 'new') toast('已导入为新项目', null, 'ok');
}

/* 项目 JSON 一律导入为新项目（不覆盖现有工作，更安全） */
function importAsNewProject(name, txt) {
  let proj;
  try {
    proj = JSON.parse(txt);
  } catch {
    return toast('JSON 解析失败：文件内容不是有效的 JSON', null, 'error');
  }
  importProjectObject(proj, name.replace(/\.json$/i, ''));
}

/* 解析好的项目数据 → 新项目（项目 JSON 和打包 ZIP 共用）；opts.from：提示里补一句来源 */
function importProjectObject(proj, name, { from = '' } = {}) {
  if (!proj || typeof proj !== 'object' || Array.isArray(proj))
    return toast('这个 JSON 不是分镜台的项目文件', null, 'error');
  if (Number(proj.v) > 4) return toast('这个项目文件来自更新版本的分镜台，请先升级软件再导入', null, 'error');
  const data = normalizeProjectData(proj);
  const projTypes = data.types;
  let rows;
  const info = {};
  try {
    rows = normalizeProjectRows(migrateSections(proj.rows || []), projTypes, info);
  } catch (error) {
    return toast(error.message, null, 'error');
  }
  if (!rows.length) return toast('这个 JSON 里没有句子', null, 'error');
  const assets = data.assets;
  const candidates = sanitizeProjectCandidates(data.candidates, {
    idMap: info.idMap,
    rowIds: new Set(rows.filter(r => r.kind === 'line').map(r => r.id)),
    assets,
  });
  storage.createProject(data.title || name, rows, assets, {
    ...data,
    title: data.title || name,
    rows,
    assets,
    candidates,
    reworkRequests: normalizeReworkRequests(data.reworkRequests, info.idMap),
  });
  clearUndo();
  armAnimation();
  update('rows');
  const extra = candidates.length ? ` · ${candidates.length} 个视频候选` : '';
  toast(
    `已作为新项目导入「${state.title}」· ${rows.filter(r => r.kind === 'line').length} 句${extra}${from ? ` · ${from}` : ''}`,
    null,
    'ok',
  );
}

function importText(txt, name, isJson) {
  if (isJson) return importAsNewProject(name, txt);
  const fileTypes = mdTypes(txt);
  const rows = parseAny(txt, fileTypes || types().list);
  if (!rows.length) return toast('没识别出句子，检查一下文件内容', null, 'warn');
  previewImport(rows, name.replace(/\.(md|markdown|txt|docx)$/i, ''), fileTypes);
}

/* 读好的文件（文件对话框 / 拖进窗口）统一从这里分流：
   字幕 SRT / VTT / ASS → 对齐当前项目的时间；项目 JSON → 导入为新项目；MD / TXT / Word → 分句预览 */
export function importLoadedFile(r) {
  if (!r) return;
  if (r.error) return toast(r.error, null, 'error');
  const ext = String(r.ext || r.name.split('.').pop() || '').toLowerCase();
  if (ext === 'srt' || ext === 'vtt' || ext === 'ass') return runCommand('srt:start', r);
  if (ext === 'zip') return runCommand('pack:import', r); // 打包的项目：选位置、解压、建新项目
  if (!String(r.content || '').trim()) return toast('这个文件是空的', null, 'warn');
  if (ext === 'json') {
    // Claude 找好的视频候选清单：进视频审核，挂到当前项目，不新建项目
    let doc = null;
    try {
      doc = JSON.parse(r.content);
    } catch {}
    if (doc?.type === CANDIDATE_TYPE) return runCommand('video:import', doc, r.path || '');
  }
  importText(r.content, r.name, ext === 'json');
}

/* 弹系统文件对话框选稿子导入（导入菜单和原生菜单 ⌘O 共用） */
async function importFromFile() {
  importLoadedFile(await native.importFile());
}

/* 弹系统文件对话框选视频候选清单 JSON（只筛 .json；误选了项目文件也能自动兜底打开） */
async function importCandidatesFile() {
  const r = await native.importFile('json');
  if (!r) return;
  if (r.error) return toast(r.error, null, 'error');
  if (!String(r.content || '').trim()) return toast('这个 JSON 文件是空的', null, 'warn');
  let doc;
  try {
    doc = JSON.parse(r.content);
  } catch {
    return toast('JSON 解析失败：文件内容不是有效的 JSON', null, 'error');
  }
  if (doc?.type === CANDIDATE_TYPE) return runCommand('video:import', doc, r.path || '');
  if (doc && typeof doc === 'object' && Array.isArray(doc.rows))
    return importProjectObject(doc, r.name.replace(/\.json$/i, ''));
  toast('这个 JSON 不是视频候选清单（需要分镜台候选清单格式）', null, 'warn');
}

/* ── 导出 ── */
async function download(name, content) {
  const r = await native.exportFile(name, content);
  if (r?.ok) {
    toast(`已导出：${name}`, null, 'ok');
    return true;
  }
  if (r?.canceled) toast('已取消导出', null, 'info');
  else toast('导出失败：' + (r?.error || '写不进这个位置'), null, 'error');
  return false;
}

function doExport(kind) {
  if (kind === 'json') return runCommand('pack:export-open');
  if (kind === 'jianying') return runCommand('jianying:export');
  if (kind === 'srt') return runCommand('srt:export');
}

/* 仅导出项目 JSON（不含素材文件本身） */
async function exportProjectJson() {
  const title = state.title || '未命名项目';
  saveCurrentProject();
  const data = projectData(state, 'exchange');
  data.title = title;
  await download(`${safeFileName(title)}·项目.json`, buildProjectJson(data));
}

/* ── 菜单与装配 ── */
function openPaste() {
  $('#pasteMask').classList.add('show');
  setTimeout(() => $('#pasteArea').focus(), 60);
}

const ICON_DOC =
  '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>';
const ICON_PASTE =
  '<svg viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/></svg>';
const ICON_CAND =
  '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9.5 5 2.5-5 2.5z"/></svg>';
const ICON_MIC =
  '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const ICON_SRT =
  '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M13 15h4M7 11h10"/></svg>';
const ICON_LANG =
  '<svg viewBox="0 0 24 24"><path d="M4 5h8M8 3v2m-2 0c0 4 2 7 6 9m-4-7c-1 3-3 5-5 7"/><path d="M13 20l4-10 4 10m-6.5-3h5"/></svg>';
const ICON_PROJ =
  '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v5M9.5 13.5h5"/></svg>';
const ICON_JY =
  '<svg viewBox="0 0 24 24"><path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/><path d="m4 9 1.6-4h4L8 9m4 0 1.6-4h4L16 9"/></svg>';
const ICON_PACK =
  '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 10v7m-3-3 3 3 3-3"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5m0 3.5h.01"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.2 4.2L19 7"/></svg>';

function voiceSlotHTML() {
  if (!state.voice) {
    return `<button type="button" class="io-row" data-imp="voice"><span class="io-ico green">${ICON_MIC}</span><span class="io-meta"><span class="io-name">口播音频</span><span class="io-desc">录音或视频，逐句听配音对画面</span></span><span class="io-pill">导入</span></button>`;
  }
  const name = state.voice.name || '已导入口播';
  return `<div class="io-slot"><span class="io-ico green on">${ICON_MIC}</span><span class="io-meta"><span class="io-name">口播音频<i class="io-dot" aria-hidden="true"></i></span><span class="io-desc io-file" title="${esc(name)}">${esc(name)}</span></span><span class="io-acts"><button type="button" class="io-act" data-imp="voice" title="更换口播音频">更换</button><button type="button" class="io-act icon danger" data-imp="voice-clear" title="移除口播音频（保留本地文件，⌘Z 可撤销）" aria-label="移除口播音频">×</button></span></div>`;
}

function subtitleSlotHTML(bi) {
  const label = bi ? '英文字幕' : '剪映字幕';
  if (!state.timing) {
    return `<button type="button" class="io-row" data-imp="srt"><span class="io-ico amber">${ICON_SRT}</span><span class="io-meta"><span class="io-name">${label}<em class="io-tag">SRT</em></span><span class="io-desc">把每句口播换成精确时间码</span></span><span class="io-pill">对齐</span></button>`;
  }
  const name = state.timing.name || label;
  return `<div class="io-slot"><span class="io-ico amber on">${ICON_SRT}</span><span class="io-meta"><span class="io-name">${label}<i class="io-dot" aria-hidden="true"></i></span><span class="io-desc io-file" title="${esc(name)}">${esc(name)}</span></span><span class="io-acts"><button type="button" class="io-act" data-imp="srt-realign" title="改过稿子后，用同一份字幕重新对齐">重对</button><button type="button" class="io-act" data-imp="srt" title="换一份字幕重新对齐">更换</button><button type="button" class="io-act icon danger" data-imp="srt-clear" title="清除字幕时间（⌘Z 可撤销）" aria-label="清除字幕时间">×</button></span></div>`;
}

function bilingualBoxHTML(bi) {
  const modeOn = state.langMode === 'en-zh';
  const subLines = state.rows.filter(r => r.kind === 'line' && typeof r.sub === 'string' && r.sub.trim()).length;
  const hasZhSub = !!(state.subTiming?.cues?.length || subLines);
  const subStatus = state.subTiming?.name || (subLines ? `已填 ${subLines} 句中文字幕` : '支持 SRT 导入或整段粘贴');
  const subBar = bi
    ? `<div class="io-sub-bar"><span class="io-meta"><span class="io-sub-name">中文字幕${hasZhSub ? '<i class="io-dot" aria-hidden="true"></i>' : ''}</span><span class="io-desc io-file" title="${esc(subStatus)}">${esc(subStatus)}</span></span><span class="io-acts"><button type="button" class="io-act" data-imp="srt-sub">${hasZhSub ? '换 SRT' : '导入 SRT'}</button><button type="button" class="io-act" data-imp="sub-paste">粘贴译文</button>${hasZhSub ? '<button type="button" class="io-act icon danger" data-imp="srt-sub-clear" title="清除中文字幕（⌘Z 可撤销）" aria-label="清除中文字幕">×</button>' : ''}</span></div>`
    : '';
  return `<div class="io-mode-box${bi ? ' active' : ''}">
    <button type="button" class="io-switch-row" data-imp="lang-mode" role="switch" aria-checked="${modeOn}">
      <span class="io-ico sky${modeOn ? ' on' : ''}">${ICON_LANG}</span>
      <span class="io-meta"><span class="io-name">英配中字模式</span><span class="io-desc">审英文稿 · 听英配 · 看中文字幕</span></span>
      <span class="io-switch${modeOn ? ' on' : ''}" aria-hidden="true"><i></i></span>
    </button>
    ${subBar}
  </div>`;
}

function openImportMenu(anchor, { refresh = false } = {}) {
  const bi = isBilingualProject(state);
  openMenu(
    anchor,
    `
      <div class="io-head"><span class="io-title">导入</span><span class="io-tip">文件可直接拖进窗口</span></div>
      <div class="io-grid">
        <button type="button" class="io-tile" data-imp="file"><span class="io-ico blue">${ICON_DOC}</span><span class="io-tile-txt"><strong>选择稿子</strong><small>MD / TXT / Word</small></span></button>
        <button type="button" class="io-tile" data-imp="paste"><span class="io-ico blue">${ICON_PASTE}</span><span class="io-tile-txt"><strong>粘贴稿子</strong><small>自动分句 / 批注</small></span></button>
      </div>
      <div class="io-sec-label">素材与字幕</div>
      <div class="io-group">
        <button type="button" class="io-row" data-imp="candidates"><span class="io-ico violet">${ICON_CAND}</span><span class="io-meta"><span class="io-name">视频候选清单<em class="io-tag">JSON</em></span><span class="io-desc">AI 找好的候选批次，导入后直接进审核页</span></span><span class="io-arrow" aria-hidden="true">›</span></button>
        ${voiceSlotHTML()}
        ${subtitleSlotHTML(bi)}
      </div>
      ${bilingualBoxHTML(bi)}
      <div class="io-sep"></div>
      <button type="button" class="io-row foot" data-imp="jsonnew"><span class="io-ico slate">${ICON_PROJ}</span><span class="io-meta"><span class="io-name">打开项目文件<em class="io-tag">JSON / ZIP</em></span><span class="io-desc">导入为新项目，不影响当前稿件</span></span><span class="io-arrow" aria-hidden="true">›</span></button>`,
    { className: refresh ? 'import-menu io-refresh' : 'import-menu', hoverGlide: false },
  );
  markPopAnchor(anchor);
}

function openExportMenu(anchor) {
  const n = deliveryIssues().length;
  const srtCard = isBilingualProject(state)
    ? `<button type="button" class="io-row exp-card" data-x="srt"><span class="io-ico amber">${ICON_SRT}</span><span class="io-meta"><span class="io-name">字幕文件<em class="io-tag">SRT</em></span><span class="io-desc">导出中文字幕、英文字幕或中英双语</span></span><span class="io-arrow" aria-hidden="true">›</span></button>`
    : '';
  openMenu(
    anchor,
    `
      <div class="io-head"><span class="io-title">导出</span><span class="io-proj" title="${esc(state.title)}">${esc(state.title)}</span></div>
      <button type="button" class="exp-health${n ? ' warn' : ' ok'}" data-x="review">
        <span class="exp-health-left">${n ? ICON_WARN : ICON_OK}<span>交稿检查</span></span>
        <span class="exp-health-right"><span>${n ? `${n} 处待处理` : '方案完整'}</span><span class="io-arrow" aria-hidden="true">›</span></span>
      </button>
      <div class="exp-stack">
        <button type="button" class="io-row exp-card primary" data-x="jianying">
          <span class="io-ico brand">${ICON_JY}</span>
          <span class="io-meta"><span class="io-name">导出到剪映<kbd class="io-kbd" aria-label="快捷键 Shift Command E">⇧⌘E</kbd></span><span class="io-desc">生成可编辑草稿，在剪映中继续剪辑</span></span>
          <span class="io-arrow" aria-hidden="true">›</span>
        </button>
        ${srtCard}
        <button type="button" class="io-row exp-card" data-x="json">
          <span class="io-ico slate">${ICON_PACK}</span>
          <span class="io-meta"><span class="io-name">项目文件<em class="io-tag">JSON / ZIP</em></span><span class="io-desc">备份或发给同事，可一并打包所用素材</span></span>
          <span class="io-arrow" aria-hidden="true">›</span>
        </button>
      </div>`,
    { className: 'export-menu', hoverGlide: false },
  );
  markPopAnchor(anchor);
}

export function initImportExport() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="importPreviewMask"><div class="modal wide import-review"><h3>确认分句与导入方式</h3><label>项目名称<input id="importTitle"></label><label>导入方式<select id="importMode"><option value="new">导入为新项目（推荐）</option><option value="update">更新当前稿件，保留未变句子的标注</option><option value="replace">替换当前项目内容</option></select></label><p id="importSummary"></p><p id="importWarning"></p><div id="importPreview"></div><div class="m-btns"><button class="btn" id="cancelImport">取消</button><button class="btn primary" id="acceptImport">确认导入</button></div></div></div>`,
  );
  registerCommand('import:file', importFromFile);
  registerCommand('import:candidates', importCandidatesFile);
  registerCommand('import:paste', openPaste);
  registerCommand('import:loaded', importLoadedFile);
  registerCommand('export', doExport);
  registerCommand('export:menu', () => openExportMenu($('#btnExport')));
  registerCommand('export:project-json', exportProjectJson);
  registerCommand('project:import-object', importProjectObject);

  $('#importMode').onchange = renderImportPreview;
  $('#acceptImport').onclick = acceptImport;
  $('#cancelImport').onclick = () => {
    pendingImport = null;
    $('#importPreviewMask').classList.remove('show');
  };
  $('#importPreviewMask').onclick = e => {
    if (e.target.id === 'importPreviewMask') $('#cancelImport').click();
  };

  const toggle = (btn, open) => e => {
    e.stopPropagation();
    if (popOpenFor(e.currentTarget)) return closePop();
    open(e.currentTarget);
    markPopAnchor(e.currentTarget);
  };
  $('#btnImport').onclick = toggle($('#btnImport'), openImportMenu);
  $('#btnExport').onclick = toggle($('#btnExport'), openExportMenu);

  document.addEventListener(
    'click',
    async e => {
      // 空项目里的起步按钮：和菜单里的「粘贴稿子文本 / 选择稿子文件」是同一件事
      const start = e.target.closest && e.target.closest('.empty-start [data-start]');
      if (start) return start.dataset.start === 'paste' ? openPaste() : importFromFile();
      const pop = document.querySelector('.popover:not(.pop-leaving)');
      const imp = pop && e.target.closest && e.target.closest('[data-imp]');
      if (imp && pop.contains(imp)) {
        const w = imp.dataset.imp;
        if (w === 'lang-mode') {
          e.stopPropagation();
          runCommand('lang:toggle');
          openImportMenu($('#btnImport'), { refresh: true });
          return;
        }
        closePop();
        if (w === 'file') importFromFile();
        if (w === 'paste') openPaste();
        if (w === 'candidates') importCandidatesFile();
        if (w === 'srt') runCommand('srt:pick');
        if (w === 'voice') runCommand('voice:pick');
        if (w === 'voice-clear') runCommand('voice:clear');
        if (w === 'srt-realign') runCommand('srt:realign');
        if (w === 'srt-clear') clearTiming();
        if (w === 'srt-sub') runCommand('srt:pick-sub');
        if (w === 'sub-paste') runCommand('sub:paste');
        if (w === 'srt-sub-clear') runCommand('srt:clear-sub');
        if (w === 'jsonnew') {
          const r = await native.importFile();
          if (!r) return;
          if (r.error) toast(r.error, null, 'error');
          else {
            const ext = String(r.ext || r.name?.split('.').pop() || '').toLowerCase();
            if (ext === 'zip') runCommand('pack:import', r);
            else if (ext === 'json') {
              let doc = null;
              try {
                doc = JSON.parse(r.content);
              } catch {}
              if (doc?.type === CANDIDATE_TYPE) runCommand('video:import', doc, r.path || '');
              else importAsNewProject(r.name, r.content);
            } else toast('请选择项目文件（.json）或打包的项目（.zip）', null, 'warn');
          }
        }
        return;
      }
      const x = pop && e.target.closest && e.target.closest('[data-x]');
      if (x && pop.contains(x)) {
        closePop();
        if (x.dataset.x === 'review') runCommand('review:open');
        else doExport(x.dataset.x);
      }
    },
    true,
  );

  // 粘贴导入
  $('#pasteCancel').onclick = () => $('#pasteMask').classList.remove('show');
  $('#pasteMask').addEventListener('click', e => {
    if (e.target.id === 'pasteMask') e.target.classList.remove('show');
  });
  $('#pasteOk').onclick = () => {
    const txt = $('#pasteArea').value;
    const fileTypes = mdTypes(txt);
    const rows = parseAny(txt, fileTypes || types().list);
    if (!rows.length) return toast('先粘点内容进来', null, 'info');
    $('#pasteMask').classList.remove('show');
    $('#pasteArea').value = '';
    previewImport(rows, '粘贴的口播稿', fileTypes);
  };
}
