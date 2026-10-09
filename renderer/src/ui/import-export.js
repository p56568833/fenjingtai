/* 导入导出：文件 / 粘贴；MD（含批注回读）/ 素材清单 / CSV / 项目 JSON。
   桌面版导出走系统保存对话框。解析与生成都是 core/ 里的纯函数，这里只管流程和弹窗。 */
import { state, update, types, timeline } from '../app/state.js';
import * as storage from '../app/storage.js';
import { clearUndo } from '../app/undo.js';
import { applyImport } from '../app/actions.js';
import { probePaths, isMissing } from '../app/asset-actions.js';
import { normalizeProjectRows, reconcileDraft } from '../core/shots.js';
import { buildAnnotatedMd, buildAssetListMd, buildCsv, buildProjectJson } from '../core/export-doc.js';
import { parseAny, migrateSections, mdTypes } from '../core/parse.js';
import { normalizeTypes } from '../core/types.js';
import { CANDIDATE_TYPE, sanitizeProjectCandidates } from '../core/candidates.js';
import { safeFileName } from '../core/text.js';
import * as native from '../platform/native.js';
import { toast, confirmModal, esc } from './dom.js';
import { openMenu, closePop, popOpenFor, markPopAnchor, openDurPopover } from './popover.js';
import { armAnimation } from './anim.js';
import { deliveryIssues } from './review.js';
import { registerCommand, runCommand } from './commands.js';

const $ = s => document.querySelector(s);
let pendingImport = null; // { rows, title, types? }

export function previewImport(rows, title, fileTypes = null) {
  pendingImport = { rows, title, types: fileTypes };
  $('#importMode').value = 'new';
  $('#importTitle').value = title;
  $('#importPreviewMask').classList.add('show');
  renderImportPreview();
}
function renderImportPreview() {
  if (!pendingImport) return;
  const mode = $('#importMode').value;
  const result = mode === 'update' ? reconcileDraft(state.rows, pendingImport.rows) : null;
  const rows = result ? result.rows : pendingImport.rows;
  $('#importSummary').textContent = result
    ? `保留 ${result.kept} 句的标注 · ${result.review} 句新增或改过（需重新标注） · ${result.removed} 句原文未匹配。重复句子不继承标注。`
    : `识别出 ${rows.filter(r => r.kind === 'line').length} 句、${rows.filter(r => r.kind === 'section').length} 个章节。`;
  $('#importWarning').textContent =
    mode === 'new'
      ? '将创建新项目，现有项目保留。'
      : mode === 'update'
        ? '按完全一致且不重复的原文匹配。更新前会保留一份原项目副本。'
        : '当前项目内容将被替换，视频候选和字幕对齐一并清空；替换前会保留一份原项目副本。';
  $('#importPreview').innerHTML = rows
    .map(r => (r.kind === 'section' ? `<h4>${esc(r.text)}</h4>` : `<p>${esc(r.text)}</p>`))
    .join('');
}
function acceptImport() {
  if (!pendingImport) return;
  const { rows, title, types: fileTypes } = pendingImport;
  const name = $('#importTitle').value.trim() || title;
  const mode = $('#importMode').value;
  const rate = state.speechRate;
  if (mode === 'new') {
    storage.createProject(name, rows, {}, fileTypes ? { types: fileTypes } : {});
    clearUndo();
  } else {
    const result = mode === 'update' ? reconcileDraft(state.rows, rows).rows : rows;
    storage.archiveCurrentCopy('改稿前');
    applyImport(result, mode === 'update' ? state.title : name, { mode });
    state.speechRate = rate;
    storage.persist();
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
export function importProjectObject(proj, name, { from = '' } = {}) {
  if (!proj || typeof proj !== 'object' || Array.isArray(proj))
    return toast('这个 JSON 不是分镜台的项目文件', null, 'error');
  if (Number(proj.v) > 4) return toast('这个项目文件来自更新版本的分镜台，请先升级软件再导入', null, 'error');
  const projTypes = proj.types ? normalizeTypes(proj.types) : normalizeTypes(null);
  let rows;
  const info = {};
  try {
    rows = normalizeProjectRows(migrateSections(proj.rows || []), projTypes, info);
  } catch (error) {
    return toast(error.message, null, 'error');
  }
  if (!rows.length) return toast('这个 JSON 里没有句子', null, 'error');
  const assets = proj.assets && typeof proj.assets === 'object' && !Array.isArray(proj.assets) ? proj.assets : {};
  const candidates = sanitizeProjectCandidates(proj.candidates, {
    idMap: info.idMap,
    rowIds: new Set(rows.filter(r => r.kind === 'line').map(r => r.id)),
    assets,
  });
  const rate = Number(proj.speechRate);
  storage.createProject(proj.title || name, rows, assets, {
    types: projTypes,
    ...(proj.voice && typeof proj.voice.path === 'string' ? { voice: proj.voice } : {}),
    ...(proj.timing && Array.isArray(proj.timing.cues) ? { timing: proj.timing } : {}),
    ...(candidates.length ? { candidates } : {}),
    ...(typeof proj.mediaDir === 'string' && proj.mediaDir ? { mediaDir: proj.mediaDir } : {}),
    speechRate: rate >= 1 && rate <= 10 ? rate : 4.5,
  });
  storage.persist();
  clearUndo();
  armAnimation();
  update('rows');
  const extra = candidates.length ? ` · ${candidates.length} 个视频候选` : '';
  toast(
    `已作为新项目导入「${state.title}」· ${rows.filter(r => r.kind === 'line').length} 句${extra}${from ? ` · ${from}` : ''}`,
  );
}

function importText(txt, name, isJson) {
  if (isJson) return importAsNewProject(name, txt);
  const fileTypes = mdTypes(txt);
  const rows = parseAny(txt, fileTypes || types().list);
  if (!rows.length) return toast('没识别出句子，检查一下文件内容');
  previewImport(rows, name.replace(/\.(md|markdown|txt|docx)$/i, ''), fileTypes);
}

/* 读好的文件（文件对话框 / 拖进窗口）统一从这里分流：
   字幕 SRT / VTT → 对齐当前项目的时间；项目 JSON → 导入为新项目；MD / TXT / Word → 分句预览 */
export function importLoadedFile(r) {
  if (!r) return;
  if (r.error) return toast(r.error);
  const ext = String(r.ext || r.name.split('.').pop() || '').toLowerCase();
  if (ext === 'srt' || ext === 'vtt') return runCommand('srt:start', r);
  if (ext === 'zip') return runCommand('pack:import', r); // 打包的项目：选位置、解压、建新项目
  if (!String(r.content || '').trim()) return toast('这个文件是空的');
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
export async function importFromFile() {
  importLoadedFile(await native.importFile());
}

/* ── 导出 ── */
async function download(name, content) {
  const r = await native.exportFile(name, content);
  if (r && r.ok === false) {
    toast('导出失败：' + (r.error || '写不进这个位置'), null, 'error');
    return false;
  }
  toast(r ? `已导出：${name}` : '已取消导出', null, r ? 'ok' : 'info');
  return !!r;
}

export async function doExport(kind, checked = false) {
  if (kind === 'pdf') return runCommand('pdf:open');
  if (kind === 'json') return runCommand('pack:export-open'); // 先选：仅项目文件 / 连同素材打包
  const issues = deliveryIssues();
  if (!checked && kind !== 'json' && issues.length) {
    confirmModal(
      '交稿还有待处理项',
      `${issues.length} 个镜头存在未标注、缺画面描述、主画面缺失或片段待调整。可取消后打开交稿检查，也可带缺项导出。`,
      '带缺项导出',
      () => doExport(kind, true),
      { danger: false },
    );
    return;
  }
  const title = state.title || '未命名项目';
  const file = safeFileName(title);
  const registry = state.assets || {};
  // 失联文件在导出里标出来（清单 / CSV / MD 都写「文件失联」，剪辑拿到清单能看见）
  const paths = [
    ...new Set(
      Object.values(registry)
        .map(a => a.path)
        .filter(p => p && !/^https?:/i.test(p)),
    ),
  ];
  const probe = await probePaths(paths);
  const missing = new Set(paths.filter(p => isMissing(probe[p])));
  const ctx = {
    title,
    rows: state.rows,
    issues,
    registry,
    missing,
    types: types().list,
    timeline: timeline(),
    speechRate: state.speechRate,
  };

  if (kind === 'md') await download(`${file}·带批注.md`, buildAnnotatedMd(ctx));
  if (kind === 'list') await download(`素材清单·${file}.md`, buildAssetListMd(ctx));
  if (kind === 'csv') await download(`${file}.csv`, buildCsv(ctx));
}

/* 仅导出项目 JSON（不含素材文件本身） */
export async function exportProjectJson() {
  const title = state.title || '未命名项目';
  storage.persist(true);
  await download(
    `${safeFileName(title)}·项目.json`,
    buildProjectJson({
      title,
      rows: state.rows,
      assets: state.assets || {},
      speechRate: state.speechRate,
      timing: state.timing,
      types: types().list,
      voice: state.voice,
      candidates: state.candidates,
      mediaDir: state.mediaDir,
    }),
  );
}

/* ── 菜单与装配 ── */
export function openPaste() {
  $('#pasteMask').classList.add('show');
  setTimeout(() => $('#pasteArea').focus(), 60);
}

function openImportMenu(anchor) {
  openMenu(
    anchor,
    `
      <div class="p-title">导入</div>
      <div class="pop-item" data-imp="file"><svg class="mi" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg><span class="main">选择稿子文件<span class="desc">MD / TXT / Word / 项目 JSON / 打包 ZIP，整篇自动分句；也可以直接拖进窗口</span></span></div>
      <div class="pop-item" data-imp="paste"><svg class="mi" viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg><span class="main">粘贴稿子文本<span class="desc">整篇复制进来，也认得出带批注的 MD</span></span></div>
      <div class="pop-sep"></div>
      <div class="pop-item" data-imp="voice"><svg class="mi" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg><span class="main">${state.voice ? '更换口播音频' : '口播音频'}<span class="desc">录好的口播（音频或视频）：逐句播放、对着画面预览</span></span></div>
      <div class="pop-item" data-imp="srt"><svg class="mi" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M13 15h4M7 11h10"/></svg><span class="main">对齐剪映字幕（SRT）<span class="desc">录完口播后，把每句换成精确的时间码</span></span></div>
      <div class="pop-sep"></div>
      <div class="pop-item" data-imp="jsonnew"><svg class="mi" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v5M9.5 13.5h5"/></svg><span class="main">项目 JSON / 打包 ZIP 导入为新项目<span class="desc">从别的机器整体搬过来；打包的 ZIP 会把素材一起解压出来</span></span></div>`,
  );
  markPopAnchor(anchor);
}

function openExportMenu(anchor) {
  const n = deliveryIssues().length;
  openMenu(
    anchor,
    `
      <div class="p-title">导出「${esc(state.title)}」</div>
      <div class="pop-item" data-x="review"><svg class="mi" viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg><span class="main">交稿检查<span class="desc">${n ? `${n} 个镜头待处理` : '分镜方案完整 · 可再勾选检查素材交付'}</span></span></div>
      <div class="pop-sep"></div>
      <div class="pop-item" data-x="pdf"><svg class="mi" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg><span class="main">PDF 分镜脚本<span class="desc">按镜头排版，发给别人直接看 · ⇧⌘E</span></span></div>
      <div class="pop-sep"></div>
      <div class="pop-item" data-x="md"><span class="pdot" style="background:var(--accent)"></span><span class="main">带批注的 MD<span class="desc">回写成批注稿，接回原来的工作流</span></span></div>
      <div class="pop-item" data-x="list"><span class="pdot" style="background:#12945f"></span><span class="main">素材清单 MD<span class="desc">按类型分组，照单找素材</span></span></div>
      <div class="pop-item" data-x="csv"><span class="pdot" style="background:#d9820b"></span><span class="main">CSV 表格<span class="desc">进 Excel / 飞书表格</span></span></div>
      <div class="pop-item" data-x="json"><span class="pdot" style="background:#7c4de8"></span><span class="main">项目文件<span class="desc">项目的全部数据（含视频审核结果）；可选连同用到的素材打包成 ZIP，发给别人直接用</span></span></div>`,
  );
  markPopAnchor(anchor);
}

export function initImportExport() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="importPreviewMask"><div class="modal wide import-review"><h3>确认分句与导入方式</h3><label>项目名称<input id="importTitle"></label><label>导入方式<select id="importMode"><option value="new">导入为新项目（推荐）</option><option value="update">更新当前稿件，保留未变句子的标注</option><option value="replace">替换当前项目内容</option></select></label><p id="importSummary"></p><p id="importWarning"></p><div id="importPreview"></div><div class="m-btns"><button class="btn" id="cancelImport">取消</button><button class="btn primary" id="acceptImport">确认导入</button></div></div></div>`,
  );
  registerCommand('import:file', importFromFile);
  registerCommand('import:paste', openPaste);
  registerCommand('import:loaded', importLoadedFile);
  registerCommand('export', doExport);
  registerCommand('export:menu', () => openExportMenu($('#btnExport')));

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
  $('#btnDur').onclick = toggle($('#btnDur'), openDurPopover);

  document.addEventListener(
    'click',
    async e => {
      const pop = document.querySelector('.popover');
      const imp = e.target.closest && e.target.closest('.pop-item[data-imp]');
      if (imp && pop) {
        closePop();
        const w = imp.dataset.imp;
        if (w === 'file') importFromFile();
        if (w === 'paste') openPaste();
        if (w === 'srt') runCommand('srt:pick');
        if (w === 'voice') runCommand('voice:pick');
        if (w === 'jsonnew') {
          const r = await native.importFile();
          if (r?.error) toast(r.error);
          else if (r?.ext === 'zip') runCommand('pack:import', r);
          else if (r) importAsNewProject(r.name, r.content);
        }
        return;
      }
      const x = e.target.closest && e.target.closest('.pop-item[data-x]');
      if (x && pop) {
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
    if (!rows.length) return toast('先粘点内容进来');
    $('#pasteMask').classList.remove('show');
    $('#pasteArea').value = '';
    previewImport(rows, '粘贴的口播稿', fileTypes);
  };
}
