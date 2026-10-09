/* 项目打包（ZIP）：
   · 导出「项目文件」时二选一：仅项目 JSON，或项目 + 用到的本地素材打成一个 ZIP（先统计好文件数、大小、找不到的文件）
   · 导入 ZIP：选好素材解压到哪（默认「影片 › 分镜台素材 › 项目名」），解压、把路径换成新位置，作为新项目打开
   打包和解压都在主进程里做（边读边写，不占内存），这里只管弹窗、进度和取消。 */
import { state, types } from '../app/state.js';
import * as storage from '../app/storage.js';
import { packPlan, toPacked, fromPacked } from '../core/pack.js';
import { buildProjectJson } from '../core/export-doc.js';
import { safeFileName } from '../core/text.js';
import * as native from '../platform/native.js';
import { toast, esc } from '../ui/dom.js';
import { registerModal } from '../ui/modal.js';
import { registerCommand } from '../ui/commands.js';
import { exportProjectJson, importProjectObject } from '../ui/import-export.js';

const $ = s => document.querySelector(s);
let busy = null; // 'export' | 'import'
let plan = null; // { files: Map, sizes }
let pending = null; // 待导入的压缩包 { zip, title, parent, bytes, files }

export function fmtBytes(n) {
  if (!(n > 0)) return '0 MB';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1) + ' GB';
  return Math.max(0.1, n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1) + ' MB';
}
const shortPath = p => String(p || '').replace(/^\/Users\/[^/]+/, '~');

/* ── 进度条（两个弹窗共用一套写法） ── */
function setProgress(box, done, total, verb) {
  const wrap = box.querySelector('.pack-progress');
  wrap.hidden = false;
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  wrap.querySelector('.pack-bar > div').style.width = pct.toFixed(1) + '%';
  wrap.querySelector('.pack-status').textContent =
    `${verb} ${fmtBytes(done)} / ${fmtBytes(total)} · ${Math.floor(pct)}%`;
}
function resetProgress(box) {
  const wrap = box.querySelector('.pack-progress');
  wrap.hidden = true;
  wrap.querySelector('.pack-bar > div').style.width = '0';
}

/* ── 导出 ── */
function currentProject() {
  return JSON.parse(
    buildProjectJson({
      title: state.title || '未命名项目',
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

async function openExport() {
  if (busy) return toast(busy === 'export' ? '正在打包，等这一个做完' : '正在解压导入，等这一个做完');
  const box = $('#packExportMask');
  resetProgress(box);
  box.querySelector('input[value="json"]').checked = true;
  setExportBusy(false);
  $('#packSummary').textContent = '正在统计用到的素材…';
  box.classList.add('show');
  const files = packPlan(currentProject());
  const sizes = (await native.packSizes([...files.keys()])) || {};
  plan = { files, sizes };
  renderSummary();
}
function renderSummary() {
  if (!plan) return;
  const all = [...plan.files.keys()];
  const ok = all.filter(p => plan.sizes[p]?.exists);
  const bytes = ok.reduce((s, p) => s + (plan.sizes[p].size || 0), 0);
  const lost = all.length - ok.length;
  $('#packSummary').textContent = ok.length
    ? `共 ${ok.length} 个文件，约 ${fmtBytes(bytes)}（表格里用到的视频、图片，以及候选清单、口播音频）${lost ? `；${lost} 个文件找不到，不打包，导入后显示失联` : ''}。对方导入后视频可以直接播放。`
    : `这个项目没有用到本地素材文件${lost ? `（${lost} 个文件找不到）` : ''}，打包后只有项目文件。`;
}
function setExportBusy(on) {
  const box = $('#packExportMask');
  box.querySelectorAll('input[name="packMode"]').forEach(i => (i.disabled = on));
  $('#packGo').disabled = on;
  $('#packCancel').textContent = on ? '取消打包' : '取消';
}
function closeExport() {
  if (busy === 'export') return native.packCancel();
  $('#packExportMask').classList.remove('show');
  plan = null;
}
async function goExport() {
  const mode = $('#packExportMask input[name="packMode"]:checked')?.value;
  if (mode !== 'zip') {
    closeExport();
    return exportProjectJson();
  }
  if (!plan) return;
  storage.persist(true);
  // 找不到的文件不进包，项目里也保持原路径（导入后显示失联，而不是指向包里不存在的文件）
  const present = new Map([...plan.files].filter(([p]) => plan.sizes[p]?.exists));
  const project = toPacked(currentProject(), present);
  const files = [...present].map(([src, rel]) => ({ src, rel }));
  busy = 'export';
  setExportBusy(true);
  setProgress($('#packExportMask'), 0, 1, '正在打包');
  let r;
  try {
    r = await native.packExport({
      name: `${safeFileName(state.title || '未命名项目')}·打包`,
      project: JSON.stringify(project, null, 2),
      files,
    });
  } finally {
    busy = null;
    setExportBusy(false);
  }
  resetProgress($('#packExportMask'));
  if (r?.canceled) return toast('已取消打包');
  if (!r?.ok) return toast('打包失败：' + (r?.error || '未知原因'), null, 'error');
  $('#packExportMask').classList.remove('show');
  plan = null;
  toast(
    `已打包：${r.path.split('/').pop()}（${files.length} 个文件，${fmtBytes(r.bytes)}）`,
    { label: '在访达中显示', cb: () => native.revealAsset(r.path) },
    'ok',
  );
}

/* ── 导入 ── */
export async function importPackFile(file) {
  if (busy) return toast(busy === 'export' ? '正在打包，等这一个做完' : '正在解压导入，等这一个做完');
  if (!file?.path) return toast('没拿到这个压缩包的路径');
  const info = await native.packInspect(file.path);
  if (!info?.ok) return toast(info?.error || '读不了这个压缩包', null, 'error');
  pending = { ...info, zip: file.path, title: info.title || file.name.replace(/\.zip$/i, '') };
  const box = $('#packImportMask');
  resetProgress(box);
  $('#packImpInfo').innerHTML = `「${esc(pending.title)}」· ${pending.files} 个素材文件 · ${fmtBytes(pending.bytes)}`;
  renderDest();
  setImportBusy(false);
  box.classList.add('show');
}
function renderDest() {
  $('#packDest').textContent = `${shortPath(pending.parent)}/${safeFileName(pending.title)}`;
  $('#packDest').title = pending.parent;
}
function setImportBusy(on) {
  $('#packImpGo').disabled = on;
  $('#packDestPick').disabled = on;
  $('#packImpCancel').textContent = on ? '取消解压' : '取消';
}
function closeImport() {
  if (busy === 'import') return native.packCancel();
  $('#packImportMask').classList.remove('show');
  pending = null;
}
async function pickDest() {
  const dir = await native.packPickDest(pending?.parent);
  if (dir && pending) {
    pending.parent = dir;
    renderDest();
  }
}
async function goImport() {
  if (!pending || busy) return;
  const job = pending;
  busy = 'import';
  setImportBusy(true);
  setProgress($('#packImportMask'), 0, job.bytes || 1, '正在解压');
  let r;
  try {
    r = await native.packExtract({ zip: job.zip, parent: job.parent, name: job.title });
  } finally {
    busy = null;
    setImportBusy(false);
  }
  resetProgress($('#packImportMask'));
  if (r?.canceled) return toast('已取消导入，解了一半的文件已清掉');
  if (!r?.ok) return toast('解压失败：' + (r?.error || '未知原因'), null, 'error');
  let proj;
  try {
    proj = fromPacked(JSON.parse(r.project), r.dir);
  } catch {
    return toast('压缩包里的项目文件不是有效的 JSON', null, 'error');
  }
  $('#packImportMask').classList.remove('show');
  pending = null;
  importProjectObject(proj, job.title, { from: `素材在 ${shortPath(r.dir)}` });
}

export function initProjectPack() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="packExportMask"><div class="modal pack-modal"><h3>导出项目文件</h3>
      <label class="pack-opt"><input type="radio" name="packMode" value="json" checked><span><b>仅项目文件（.json）</b><small>体积很小，不含素材文件本身，适合自己备份</small></span></label>
      <label class="pack-opt"><input type="radio" name="packMode" value="zip"><span><b>项目 + 素材打包（.zip）</b><small id="packSummary"></small></span></label>
      <div class="pack-progress" hidden><div class="pack-bar"><div></div></div><div class="pack-status"></div></div>
      <div class="m-btns"><button class="btn" id="packCancel">取消</button><button class="btn primary" id="packGo">导出</button></div></div></div>
    <div class="modal-mask" id="packImportMask"><div class="modal pack-modal"><h3>导入打包的项目</h3>
      <p id="packImpInfo"></p>
      <div class="pack-dest"><span class="pack-dest-label">素材解压到</span><code id="packDest"></code><button class="btn ghost" id="packDestPick">换个位置</button></div>
      <p class="pack-hint">会新建这个文件夹，导入后作为新项目打开，现有项目不受影响。</p>
      <div class="pack-progress" hidden><div class="pack-bar"><div></div></div><div class="pack-status"></div></div>
      <div class="m-btns"><button class="btn" id="packImpCancel">取消</button><button class="btn primary" id="packImpGo">解压并导入</button></div></div></div>`,
  );
  $('#packCancel').onclick = closeExport;
  $('#packGo').onclick = goExport;
  $('#packImpCancel').onclick = closeImport;
  $('#packImpGo').onclick = goImport;
  $('#packDestPick').onclick = pickDest;
  registerModal('packExportMask', { close: closeExport, enter: () => !busy && goExport() });
  registerModal('packImportMask', { close: closeImport, enter: () => !busy && goImport() });
  native.onPackProgress(p => {
    if (p?.op === 'export' && busy === 'export') setProgress($('#packExportMask'), p.done, p.total, '正在打包');
    if (p?.op === 'import' && busy === 'import') setProgress($('#packImportMask'), p.done, p.total, '正在解压');
  });
  registerCommand('pack:export-open', openExport);
  registerCommand('pack:import', importPackFile);
}
