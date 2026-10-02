import { normalizeProjectRows, reconcileDraft, checkDelivery } from './production.js';
import { buildAnnotatedMd, buildAssetListMd, buildCsv, buildProjectJson } from './export-doc.js';
import { probePaths, isMissing } from './assets.js';
/* 导入导出：文件 / 粘贴 / 示例；MD（含批注回读）/ 素材清单 / CSV / 项目 JSON。
   桌面版导出走系统保存对话框。 */
import { state, update } from './state.js';
import { toast, confirmModal, esc } from './util.js';
import { parseAny, migrateSections } from './parse.js';
import { applyImport } from './actions.js';
import * as storage from './storage.js';
import { clearUndo } from './undo.js';
import { openMenu, closePop, popOpenFor, markPopAnchor, openDurPopover } from './popover.js';
import { armAnimation } from './anim.js';
import { openPdfExport } from './pdf-export.js';
import { startSrtAlign, pickSrt } from './srt.js';

let pendingImport = null;
export function previewImport(rows, title) {
  pendingImport = { rows, title };
  document.querySelector('#importMode').value = 'new';
  document.querySelector('#importTitle').value = title;
  document.querySelector('#importPreviewMask').classList.add('show');
  renderImportPreview();
}
function renderImportPreview() {
  if (!pendingImport) return;
  const mode = document.querySelector('#importMode').value;
  const result = mode === 'update' ? reconcileDraft(state.rows, pendingImport.rows) : null;
  const rows = result ? result.rows : pendingImport.rows;
  document.querySelector('#importSummary').textContent = result
    ? `保留 ${result.kept} 句的标注 · ${result.review} 句待核对 · ${result.removed} 句原文未匹配。重复句子需重新核对。`
    : `识别出 ${rows.filter(r => r.kind === 'line').length} 句、${rows.filter(r => r.kind === 'section').length} 个章节。`;
  document.querySelector('#importWarning').textContent =
    mode === 'new'
      ? '将创建新项目，现有项目保留。'
      : mode === 'update'
        ? '按完全一致且不重复的原文匹配。更新前会保留一份原项目副本。'
        : '当前项目内容将被替换；替换前会保留一份原项目副本。';
  document.querySelector('#importPreview').innerHTML = rows
    .map(r =>
      r.kind === 'section'
        ? `<h4>${esc(r.text)}</h4>`
        : `<p>${esc(r.text)}${r.needsReview ? ' <small>待核对</small>' : ''}</p>`,
    )
    .join('');
}
function acceptImport() {
  if (!pendingImport) return;
  const { rows, title } = pendingImport;
  const name = document.querySelector('#importTitle').value.trim() || title;
  const mode = document.querySelector('#importMode').value;
  const rate = state.speechRate;
  if (mode === 'new') {
    storage.createProject(name, rows);
    clearUndo();
  } else {
    const result = mode === 'update' ? reconcileDraft(state.rows, rows).rows : rows;
    storage.archiveCurrentCopy('改稿前');
    applyImport(result, mode === 'update' ? state.title : name);
    state.speechRate = rate;
    storage.persist();
  }
  document.querySelector('#projTitle').textContent = state.title;
  pendingImport = null;
  document.querySelector('#importPreviewMask').classList.remove('show');
  update('rows');
  toast(mode === 'new' ? '已导入为新项目' : '稿件已更新，原项目副本已保留');
}

/* 项目 JSON 一律导入为新项目（不覆盖现有工作，更安全） */
function importAsNewProject(name, txt) {
  let proj;
  try {
    proj = JSON.parse(txt);
  } catch (err) {
    toast('JSON 解析失败');
    return;
  }
  let rows;
  try {
    rows = normalizeProjectRows(migrateSections(proj.rows || []));
  } catch (error) {
    toast(error.message);
    return;
  }
  if (!rows.length) {
    toast('这个 JSON 里没有句子');
    return;
  }
  storage.createProject(
    proj.title || name.replace(/\.json$/i, ''),
    rows,
    proj.assets && typeof proj.assets === 'object' ? proj.assets : {},
  );
  state.timing = proj.timing && Array.isArray(proj.timing.cues) ? proj.timing : null;
  state.speechRate = Number(proj.speechRate) >= 1 && Number(proj.speechRate) <= 10 ? Number(proj.speechRate) : 4.5;
  storage.persist();
  clearUndo();
  armAnimation();
  update('rows');
  document.querySelector('#projTitle').textContent = state.title;
  toast(`已作为新项目导入「${state.title}」· ${rows.filter(r => r.kind === 'line').length} 句`);
}

async function importText(txt, name, isJson) {
  if (isJson) {
    importAsNewProject(name, txt);
    return;
  }
  const rows = parseAny(txt);
  if (!rows.length) {
    toast('没识别出句子，检查一下文件内容');
    return;
  }
  previewImport(rows, name.replace(/\.(md|markdown|txt|docx)$/i, ''));
}

/* 读好的文件（文件对话框 / 拖进窗口）统一从这里分流：
   字幕 SRT / VTT → 对齐当前项目的时间；项目 JSON → 导入为新项目；MD / TXT / Word → 分句预览 */
export function importLoadedFile(r) {
  if (!r) return;
  if (r.error) {
    toast(r.error);
    return;
  }
  const ext = String(r.ext || r.name.split('.').pop() || '').toLowerCase();
  if (ext === 'srt' || ext === 'vtt') {
    startSrtAlign(r);
    return;
  }
  if (!String(r.content || '').trim()) {
    toast('这个文件是空的');
    return;
  }
  importText(r.content, r.name, ext === 'json');
}

/* 弹系统文件对话框选稿子导入（导入菜单和原生菜单 ⌘O 共用） */
export async function importFromFile() {
  importLoadedFile(await window.native.importFile());
}

/* ── 导出 ── */
async function download(name, content) {
  const ok = await window.native.exportFile(name, content);
  toast(ok ? `已导出：${name}` : '已取消导出');
  return ok;
}

export async function doExport(kind, checked = false) {
  if (kind === 'pdf') {
    openPdfExport();
    return;
  }
  const issues = checkDelivery(state.rows);
  if (!checked && kind !== 'json' && issues.length) {
    confirmModal(
      '交稿还有待处理项',
      `${issues.length} 个镜头存在未标注、缺画面描述、素材未就绪、片段待调整或改稿待核对。可取消后打开交稿检查，也可带缺项导出。`,
      '带缺项导出',
      () => doExport(kind, true),
    );
    return;
  }
  const title = state.title || '未命名项目';
  const registry = state.assets || {};
  // 失联文件在导出里标出来（清单/CSV/MD 都写「文件失联」，剪辑拿到清单能看见）
  const paths = [
    ...new Set(
      Object.values(registry)
        .map(a => a.path)
        .filter(p => p && !/^https?:/i.test(p)),
    ),
  ];
  const probe = await probePaths(paths);
  const missing = new Set(paths.filter(p => isMissing(probe[p])));
  const ctx = { title, rows: state.rows, issues, registry, missing };

  if (kind === 'md') await download(`${title}·带批注.md`, buildAnnotatedMd(ctx));
  if (kind === 'list')
    await download(`素材清单·${title}.md`, buildAssetListMd({ ...ctx, speechRate: state.speechRate }));
  if (kind === 'csv') await download(`${title}.csv`, buildCsv(ctx));
  if (kind === 'json') {
    storage.persist(true);
    await download(
      `${title}·项目.json`,
      buildProjectJson({
        title,
        rows: state.rows,
        assets: registry,
        speechRate: state.speechRate,
        timing: state.timing,
      }),
    );
  }
}

/* ── 菜单与装配 ── */
/* 粘贴导入弹窗（导入菜单 / 勾选视图空态按钮共用） */
export function openPaste() {
  document.querySelector('#pasteMask').classList.add('show');
  setTimeout(() => document.querySelector('#pasteArea').focus(), 60);
}

export function initImportExport() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="importPreviewMask"><div class="modal wide import-review"><h3>确认分句与导入方式</h3><label>项目名称<input id="importTitle"></label><label>导入方式<select id="importMode"><option value="new">导入为新项目（推荐）</option><option value="update">更新当前稿件，保留未变句子的标注</option><option value="replace">替换当前项目内容</option></select></label><p id="importSummary"></p><p id="importWarning"></p><div id="importPreview"></div><div class="m-btns"><button class="btn" id="cancelImport">取消</button><button class="btn primary" id="acceptImport">确认导入</button></div></div></div>`,
  );
  document.querySelector('#importMode').onchange = renderImportPreview;
  document.querySelector('#acceptImport').onclick = acceptImport;
  document.querySelector('#cancelImport').onclick = () => {
    pendingImport = null;
    document.querySelector('#importPreviewMask').classList.remove('show');
  };
  document.querySelector('#importPreviewMask').onclick = e => {
    if (e.target.id === 'importPreviewMask') document.querySelector('#cancelImport').click();
  };

  document.querySelector('#btnImport').onclick = e => {
    e.stopPropagation();
    if (popOpenFor(e.currentTarget)) {
      closePop();
      return;
    }
    openMenu(
      e.currentTarget,
      `
      <div class="p-title">导入稿子</div>
      <div class="pop-item" data-imp="file"><svg class="mi" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg><span class="main">选择文件<span class="desc">MD / TXT / Word / 项目 JSON，整篇自动分句；也可以直接拖进窗口</span></span></div>
      <div class="pop-item" data-imp="paste"><svg class="mi" viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg><span class="main">粘贴稿子文本<span class="desc">整篇复制进来，也认得出带批注的 MD</span></span></div>
      <div class="pop-item" data-imp="srt"><svg class="mi" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M13 15h4M7 11h10"/></svg><span class="main">对齐剪映字幕（SRT）<span class="desc">录完口播后，把每句换成真实时间码</span></span></div>
      <div class="pop-sep"></div>
      <div class="pop-item" data-imp="jsonnew"><svg class="mi" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v5M9.5 13.5h5"/></svg><span class="main">项目 JSON 导入为新项目<span class="desc">从网页版或别的机器整体搬过来</span></span></div>`,
    );
    markPopAnchor(e.currentTarget);
  };

  document.querySelector('#btnExport').onclick = e => {
    e.stopPropagation();
    if (popOpenFor(e.currentTarget)) {
      closePop();
      return;
    }
    openMenu(
      e.currentTarget,
      `
      <div class="p-title">导出「${esc(state.title)}」</div>
      <div class="pop-item" data-x="pdf"><svg class="mi" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg><span class="main">PDF 分镜脚本<span class="desc">按镜头排版，发给别人直接看</span></span></div>
      <div class="pop-sep"></div>
      <div class="pop-item" data-x="md"><span class="pdot" style="background:var(--c-a)"></span><span class="main">带批注的 MD<span class="desc">回写成批注稿，接回原来的工作流</span></span></div>
      <div class="pop-item" data-x="list"><span class="pdot" style="background:var(--c-real)"></span><span class="main">素材清单 MD<span class="desc">按类型分组，照单找素材</span></span></div>
      <div class="pop-item" data-x="csv"><span class="pdot" style="background:var(--c-stock)"></span><span class="main">CSV 表格<span class="desc">进 Excel / 飞书表格</span></span></div>
      <div class="pop-item" data-x="json"><span class="pdot" style="background:var(--c-ai)"></span><span class="main">项目文件 JSON<span class="desc">备份存档，可导回这个软件</span></span></div>`,
    );
    markPopAnchor(e.currentTarget);
  };

  document.querySelector('#btnDur').onclick = e => {
    e.stopPropagation();
    if (popOpenFor(e.currentTarget)) {
      closePop();
      return;
    }
    openDurPopover(e.currentTarget);
    markPopAnchor(e.currentTarget);
  };

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
        if (w === 'srt') pickSrt();
        if (w === 'jsonnew') {
          const r = await window.native.importFile();
          if (r?.error) toast(r.error);
          else if (r) importAsNewProject(r.name, r.content);
        }
        return;
      }
      const x = e.target.closest && e.target.closest('.pop-item[data-x]');
      if (x && pop) {
        closePop();
        doExport(x.dataset.x);
      }
    },
    true,
  );

  // 粘贴导入
  document.querySelector('#pasteCancel').onclick = () => document.querySelector('#pasteMask').classList.remove('show');
  document.querySelector('#pasteMask').addEventListener('click', e => {
    if (e.target.id === 'pasteMask') e.target.classList.remove('show');
  });
  document.querySelector('#pasteOk').onclick = () => {
    const txt = document.querySelector('#pasteArea').value;
    const rows = parseAny(txt);
    if (!rows.length) {
      toast('先粘点内容进来');
      return;
    }
    document.querySelector('#pasteMask').classList.remove('show');
    document.querySelector('#pasteArea').value = '';
    previewImport(rows, '粘贴的口播稿');
  };
}
