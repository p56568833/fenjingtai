/* 导出 PDF 分镜脚本：选项弹窗 → 生成素材缩略图 → 排版（print-doc.js）→ 主进程 printToPDF 落盘 */
import { state, types, timeline } from '../app/state.js';
import { buildPrintDoc, planDocument, assetRefs, PDF_DEFAULTS } from '../core/print-doc.js';
import { safeFileName } from '../core/text.js';
import * as native from '../platform/native.js';
import { toast } from '../ui/dom.js';
import { registerCommand } from '../ui/commands.js';

const $ = s => document.querySelector(s);
const PREF_KEY = 'fjz:pdf';
let busy = false;

function loadPrefs() {
  try {
    return { ...PDF_DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') };
  } catch {
    return { ...PDF_DEFAULTS };
  }
}
function savePrefs(p) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {}
}

const PREVIEWABLE = /\.(png|jpe?g|webp|gif|mp4|mov|mkv|webm|m4v|avi)$/i;
const localPreviewable = ref => /^\//.test(ref) && PREVIEWABLE.test(ref);

/* 缩成 640px 宽的 JPEG 再嵌进 PDF：原图动辄几 MB，几十张就能把 PDF 撑到上百 MB */
function shrink(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const w = Math.min(640, img.naturalWidth || 640),
        h = Math.round((w * (img.naturalHeight || 360)) / (img.naturalWidth || 640));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(c.toDataURL('image/jpeg', 0.82));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function collectThumbs(rows, registry) {
  const refs = [
    ...new Set(
      rows
        .filter(r => r.kind === 'line')
        .flatMap(r => assetRefs(r, registry))
        .filter(localPreviewable),
    ),
  ];
  const thumbs = new Map();
  let i = 0;
  const worker = async () => {
    while (i < refs.length) {
      const ref = refs[i++];
      try {
        const data = await native.previewImage(ref);
        if (data) {
          const small = await shrink(data);
          if (small) thumbs.set(ref, small);
        }
      } catch {}
    }
  };
  await Promise.all([1, 2, 3, 4].map(worker));
  return thumbs;
}

function renderSummary() {
  const plan = planDocument(state.rows, state.speechRate, state.assets, { types: types().list, timeline: timeline() });
  const refs = state.rows.filter(r => r.kind === 'line').flatMap(r => assetRefs(r, state.assets));
  $('#pdfSummary').textContent = plan.shots.length
    ? `${plan.shots.length} 个镜头 · ${plan.lines} 句口播${plan.named ? ` · ${plan.chapters.length} 个章节` : ''}`
    : '这个项目还没有句子';
  $('#pdfAssetCount').textContent = refs.length
    ? `${new Set(refs).size} 个引用 · 本地图片会嵌入 PDF，只显示文件名不带本机路径`
    : '项目里暂无素材';
}

export function openPdfExport() {
  if (busy) {
    toast('PDF 正在生成，请稍候');
    return;
  }
  const p = loadPrefs();
  $(`#pdfMask input[name="pdfOrient"][value="${p.landscape ? 'landscape' : 'portrait'}"]`).checked = true;
  $('#pdfCover').checked = !!p.cover;
  $('#pdfAssets').checked = !!p.assets;
  renderSummary();
  $('#pdfMask').classList.add('show');
  setTimeout(() => $('#pdfOk').focus(), 60);
}
const closePdf = () => $('#pdfMask').classList.remove('show');

async function runExport() {
  if (busy) return;
  const opts = {
    landscape: $('#pdfMask input[name="pdfOrient"]:checked')?.value === 'landscape',
    cover: $('#pdfCover').checked,
    assets: $('#pdfAssets').checked,
  };
  savePrefs(opts);
  closePdf();
  busy = true;
  const project = structuredClone({
    title: state.title || '未命名项目',
    rows: state.rows,
    speechRate: state.speechRate,
    assets: state.assets,
    types: types().list,
    voice: state.voice,
  });
  const tl = timeline();
  const title = project.title;
  try {
    toast('正在排版 PDF…');
    const thumbs = opts.assets ? await collectThumbs(project.rows, project.assets) : new Map();
    const doc = buildPrintDoc(project, { ...opts, thumbs, timeline: tl });
    const name = `${safeFileName(title)}·分镜脚本.pdf`;
    const r = await native.exportPdf(name, {
      html: doc.html,
      header: doc.header,
      footer: doc.footer,
      landscape: doc.landscape,
    });
    if (r?.ok) toast(`已导出：${r.path.split(/[\\/]/).pop()}`, { label: '打开', cb: () => native.openAsset(r.path) });
    else if (r?.canceled) toast('已取消导出');
    else toast('PDF 生成失败' + (r?.error ? `：${r.error}` : ''));
  } catch (error) {
    toast('PDF 生成失败：' + (error?.message || error));
  } finally {
    busy = false;
  }
}

const PAGE_ICON = orient =>
  `<span class="pdf-page ${orient}" aria-hidden="true"><i class="pp-head"></i>${'<i class="pp-row"><b></b><b></b></i>'.repeat(orient === 'portrait' ? 5 : 3)}</span>`;

export function initPdfExport() {
  registerCommand('pdf:open', openPdfExport);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="pdfMask"><div class="modal pdf-modal" role="dialog" aria-labelledby="pdfTitle">
    <h3 id="pdfTitle">导出 PDF 分镜脚本</h3>
    <p>发给剪辑、合作方或客户看的只读文档：每行一个镜头，左边逐句口播，右边画面设计；共用画面的几句合在同一行。</p>
    <div class="pdf-layouts" role="radiogroup" aria-label="纸张方向">
      <label class="pdf-layout"><input type="radio" name="pdfOrient" value="portrait">${PAGE_ICON('portrait')}<span><b>竖版 A4</b><small>手机看、打印都顺手</small></span></label>
      <label class="pdf-layout"><input type="radio" name="pdfOrient" value="landscape">${PAGE_ICON('landscape')}<span><b>横版 A4</b><small>电脑屏幕、投屏讨论</small></span></label>
    </div>
    <div class="pdf-checks">
      <label><input type="checkbox" id="pdfCover"><span>封面概览<small>全片节奏色条、画面构成、章节目录</small></span></label>
      <label><input type="checkbox" id="pdfAssets"><span>素材缩略图与链接<small id="pdfAssetCount"></small></span></label>
    </div>
    <div class="pdf-foot"><span id="pdfSummary"></span><div class="m-btns"><button class="btn ghost" id="pdfCancel">取消</button><button class="btn primary" id="pdfOk">导出 PDF</button></div></div>
  </div></div>`,
  );
  $('#pdfCancel').onclick = closePdf;
  $('#pdfOk').onclick = runExport;
  $('#pdfMask').addEventListener('click', e => {
    if (e.target.id === 'pdfMask') closePdf();
  });
}
