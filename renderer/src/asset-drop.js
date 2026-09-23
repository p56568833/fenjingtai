/* 拖拽添加素材：从访达拖一个或多个文件到表格某句 / 共用画面区域 / 右侧素材面板。
   拖到哪高亮哪（拖到组内任一句 = 整个共用画面接收）；只建立关联，不动原文件；
   同目标重复文件去重；空白处不接收，也不让浏览器直接打开文件。 */
import { rowById } from './state.js';
import { toast } from './util.js';
import { addRefsToShot, kindOf, assetName } from './assets.js';
import { anyModalOpen } from './modal.js';
import { readScriptFile } from './native-bridge.js';

/* 拖进窗口的是稿子 / 字幕 / 项目文件时，不当素材，直接导入：
   MD / TXT / Word → 分句预览；SRT / VTT → 对齐剪映字幕；项目 JSON → 新项目。
   想把 txt / md 当素材关联，拖到右侧「画面与素材」面板即可。 */
export const SCRIPT_EXT = /\.(md|markdown|txt|docx|json|srt|vtt)$/i;
const SCRIPT_MIME =
  /^(text\/(plain|markdown|x-markdown|vtt)|application\/(json|x-subrip|vnd\.openxmlformats-officedocument\.wordprocessingml\.document))$/i;
const looksLikeScript = dt => {
  const items = [...(dt?.items || [])].filter(i => i.kind === 'file');
  return items.length > 0 && items.every(i => SCRIPT_MIME.test(i.type));
};
const inInspector = el => !!(el && el.closest && el.closest('#inspector'));

export async function importDroppedFiles(files) {
  if (anyModalOpen()) {
    toast('先关掉当前弹窗，再把文件拖进来');
    return false;
  }
  const f = files[0];
  if (!f?.path) {
    toast('没拿到这个文件的路径，试试「导入 → 选择文件」');
    return false;
  }
  if (files.length > 1) toast(`一次导入一个文件，先导入「${f.name || assetName(f.path)}」`);
  const r = await readScriptFile(f.path);
  const { importLoadedFile } = await import('./import-export.js');
  importLoadedFile(r);
  return true;
}

/* 拖入的 File 对象 → 本地路径（Electron 32+ 只有 webUtils 这一条通道） */
export function extractPaths(fileList) {
  const out = [];
  for (const f of fileList || []) {
    const p = (window.native?.getPathForFile ? window.native.getPathForFile(f) : '') || f.path || '';
    out.push({ name: f.name || assetName(p) || '', path: p });
  }
  return out;
}

/* 落点解析：句 / 共用画面 / 右侧面板；空白处返回 null */
export function targetRowFor(el) {
  if (!el || !el.closest) return null;
  if (el.closest('#inspector')) {
    const panel = document.querySelector('#inspector');
    const r = panel ? rowById(+panel.dataset.row) : null;
    return r && r.kind === 'line' ? r : null;
  }
  const scene = el.closest('.shared-scene');
  if (scene) return rowById(+scene.dataset.owner);
  const passage = el.closest('.shared-passage');
  if (passage) return rowById(+passage.dataset.noteOwner);
  const row = el.closest('.row[data-id]');
  if (row) return rowById(+row.dataset.id) || null;
  const sent = el.closest('.as[data-id]');
  if (sent) return rowById(+sent.dataset.id) || null;
  return null;
}

/* 高亮「实际接收」的区域：拖到组内句子时，整块共用画面亮起 */
function highlightFor(el, on) {
  let zone =
    el && el.closest ? el.closest('#inspector, .shared-scene, .shared-passage, .row[data-id], .as[data-id]') : null;
  const row = targetRowFor(el);
  if (row && row.groupId) {
    const member = document.querySelector(`.row[data-id="${row.id}"], .as[data-id="${row.id}"]`);
    zone = (member && member.closest('.shared-scene, .shared-passage')) || zone;
  }
  document.querySelectorAll('.drop-target').forEach(z => z !== zone && z.classList.remove('drop-target'));
  if (zone) zone.classList.toggle('drop-target', on);
}

const hasFiles = dt => !!dt && ((dt.types && [...dt.types].includes('Files')) || (dt.files && dt.files.length));

/* 核心入口（DOM 拖拽与自测共用）：files = [{name, path}] */
export function addFilesToShot(row, files) {
  if (!row) {
    toast('拖到句子或共用画面上才会添加素材');
    return null;
  }
  const paths = [],
    skipped = [];
  for (const f of files || []) {
    if (!f.path) {
      skipped.push(f.name || '无法识别的文件');
      continue;
    }
    if (!kindOf(f.path)) {
      skipped.push(f.name || assetName(f.path));
      continue;
    }
    paths.push(f.path);
  }
  if (!paths.length) {
    toast(skipped.length ? `没有可添加的素材（不支持：${skipped.slice(0, 2).join('、')}）` : '没有识别到文件');
    return null;
  }
  const res = addRefsToShot(row, paths); // 一次调用 = 一次撤销，多文件拖入也算一步
  const bits = [];
  if (res.added.length) bits.push(`已添加 ${res.added.length} 个素材`);
  if (res.dupes.length) bits.push(`${res.dupes.length} 个已关联过（自动去重）`);
  if (res.invalid.length) bits.push(`${res.invalid.length} 个不支持`);
  toast(bits.join(' · ') + (res.added.length ? ' · ⌘Z 可撤销' : ''));
  return res;
}

export function handleDropPaths(el, files) {
  const row = targetRowFor(el);
  return addFilesToShot(row, files);
}

export function initAssetDrop() {
  // 文件拖拽期间全程接管默认行为：浏览器不能趁机把文件直接打开
  document.addEventListener('dragenter', e => {
    if (hasFiles(e.dataTransfer)) e.preventDefault();
  });
  document.addEventListener('dragover', e => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const importing = looksLikeScript(e.dataTransfer) && !inInspector(e.target);
    document.body.classList.toggle('drop-import', importing);
    if (importing) document.querySelectorAll('.drop-target').forEach(z => z.classList.remove('drop-target'));
    else highlightFor(e.target, true);
  });
  document.addEventListener('dragleave', e => {
    if (e.relatedTarget && document.contains(e.relatedTarget)) return;
    highlightFor(null, false);
    document.querySelectorAll('.drop-target').forEach(z => z.classList.remove('drop-target'));
    document.body.classList.remove('drop-import');
  });
  document.addEventListener('drop', e => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault(); // 空白处也不许浏览器打开文件
    document.querySelectorAll('.drop-target').forEach(z => z.classList.remove('drop-target'));
    document.body.classList.remove('drop-import');
    const files = extractPaths(e.dataTransfer.files);
    if (!inInspector(e.target) && files.length && files.every(f => SCRIPT_EXT.test(f.path || f.name))) {
      importDroppedFiles(files);
      return;
    }
    handleDropPaths(e.target, files);
  });
  document.addEventListener('dragend', () => {
    document.body.classList.remove('drop-import');
    document.querySelectorAll('.drop-target').forEach(z => z.classList.remove('drop-target'));
  });
}
