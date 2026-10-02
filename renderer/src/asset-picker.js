/* 「本项目素材」选择器：把项目里已经添加过的文件再次关联到当前句子 / 共用画面。
   按需弹出（不是常驻侧栏）；只列当前项目，不掺别的项目；不复制本地文件。
   使用次数按独立画面统计：共用三句算一处。 */
import { state, rowById } from './state.js';
import { esc, toast } from './util.js';
import { countAssetShots, addRefsToShot, kindOf, KIND_LABEL, assetName } from './assets.js';
import { hydrateAssetCards } from './visuals.js';

let targetRowId = null;

const $ = s => document.querySelector(s);

function renderList() {
  const q = ($('#assetPickerQ').value || '').trim().toLowerCase();
  const registry = state.assets || {};
  const items = Object.values(registry)
    .filter(a => !q || (a.name || '').toLowerCase().includes(q) || (a.path || '').toLowerCase().includes(q))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  const host = $('#assetPickerList');
  if (!items.length) {
    host.innerHTML = `<p class="side-empty">${Object.keys(registry).length ? '没有匹配的素材' : '本项目还没有添加过素材'}</p>`;
    return;
  }
  host.innerHTML = items
    .map(a => {
      const n = countAssetShots(state.rows, a.id);
      const kind = a.kind || kindOf(a.path) || 'doc';
      return `<button class="picker-item" data-pick-asset="${a.id}">
      <span class="asset-thumb" data-preview-path="${esc(a.path)}" data-kind="${kind}"></span>
      <span class="asset-caption"><strong>${esc(a.name || assetName(a.path))}</strong>
      <small>${esc(KIND_LABEL[kind] || '素材')} · 使用 ${n} 处</small></span>
    </button>`;
    })
    .join('');
  hydrateAssetCards();
}

export function openAssetPicker(row) {
  if (!row || row.kind !== 'line') return;
  targetRowId = row.id;
  $('#assetPickerMask').classList.add('show');
  $('#assetPickerQ').value = '';
  renderList();
  setTimeout(() => $('#assetPickerQ').focus(), 50);
}
export function closeAssetPicker() {
  $('#assetPickerMask').classList.remove('show');
  targetRowId = null;
}

export function initAssetPicker() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <div class="modal-mask" id="assetPickerMask">
      <div class="modal wide">
        <h3>本项目素材</h3>
        <p class="picker-help">选择已添加过的文件，关联到当前句子或共用画面（不复制本地文件）。</p>
        <input id="assetPickerQ" class="picker-search" placeholder="搜索文件名…">
        <div id="assetPickerList" class="picker-list"></div>
        <div class="m-btns"><button class="btn" id="assetPickerCancel">关闭</button></div>
      </div>
    </div>`,
  );
  $('#assetPickerCancel').onclick = closeAssetPicker;
  $('#assetPickerQ').addEventListener('input', renderList);
  $('#assetPickerMask').addEventListener('click', e => {
    if (e.target.id === 'assetPickerMask') closeAssetPicker();
  });
  $('#assetPickerList').addEventListener('click', e => {
    const item = e.target.closest('[data-pick-asset]');
    if (!item) return;
    const row = rowById(targetRowId);
    const asset = (state.assets || {})[item.dataset.pickAsset];
    if (!row || !asset) return closeAssetPicker();
    const res = addRefsToShot(row, [asset.path]);
    if (res.added.length) {
      closeAssetPicker();
      toast(`已关联「${asset.name || assetName(asset.path)}」· 不复制本地文件`);
    } else if (res.dupes.length) toast('这个画面已经关联过这个素材了');
    else toast('没有可添加的素材');
  });
}
