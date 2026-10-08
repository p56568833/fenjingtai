/* 交稿检查：两种目标——
   · 分镜方案：未标注 / 缺画面描述 / 主画面缺失 / 片段待调整 / 改稿待核对 / 字幕没找到（素材还没到位也能通过）
   · 素材交付：在方案检查之外，再看需要画面的镜头有没有关联素材、素材文件是否失联
   成功提示只说检查了什么，不把「方案齐了」说成「素材齐了」。 */
import { state, on, types } from '../app/state.js';
import { checkDelivery, unlinkedShots } from '../core/shots.js';
import { probePaths, isMissing } from '../app/asset-actions.js';
import { esc } from './dom.js';
import { closePop } from './popover.js';
import { registerCommand, runCommand } from './commands.js';

const $ = s => document.querySelector(s);
let reviewOpen = false;
let assetMode = false; // 勾了「也检查素材交付」
let missing = new Set();
export const isReviewOpen = () => reviewOpen;

/* 导出前的提醒只看分镜方案（素材没到位也允许导出清单去找素材） */
export function deliveryIssues() {
  return checkDelivery(state.rows, types().list);
}

async function refreshMissing() {
  const paths = [
    ...new Set(
      Object.values(state.assets || {})
        .map(a => a.path)
        .filter(p => p && !/^https?:/i.test(p)),
    ),
  ];
  const probe = await probePaths(paths);
  missing = new Set(paths.filter(p => isMissing(probe[p])));
}

function renderReview() {
  const host = $('#reviewList');
  if (!host) return;
  const ti = types().list;
  const list = checkDelivery(state.rows, ti, assetMode ? { assets: true, missing, registry: state.assets } : {});
  const unlinked = unlinkedShots(state.rows, ti).length;
  let summary;
  if (list.length) summary = `${list.length} 个镜头待处理${assetMode ? '（含素材交付）' : ''}；可以带缺项导出。`;
  else if (assetMode) summary = '分镜和素材都检查过了：需要画面的镜头都已关联素材，没有失联文件。';
  else
    summary = unlinked
      ? `分镜方案完整（类型、画面描述都已填写）。另有 ${unlinked} 个需要画面的镜头还没关联素材，勾选「也检查素材交付」可以逐个列出。`
      : '分镜方案完整，需要画面的镜头也都已关联素材。';
  $('#reviewSummary').textContent = summary;
  host.innerHTML = list
    .map(
      x =>
        `<button class="review-item" data-jump="${x.id}"><strong>第 ${x.no} 句 · ${esc(x.issues.join(' / '))}</strong><span>${esc(x.text.slice(0, 90))}</span></button>`,
    )
    .join('');
}

export async function openReview() {
  closePop();
  $('#reviewMask').classList.add('show');
  reviewOpen = true;
  renderReview();
  if (assetMode) {
    await refreshMissing();
    if (reviewOpen) renderReview();
  }
}
export function closeReview() {
  $('#reviewMask').classList.remove('show');
  reviewOpen = false;
}

export function initReview() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="reviewMask"><div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="reviewTitle"><h3 id="reviewTitle">交稿检查</h3><label class="review-assets-toggle"><input type="checkbox" id="reviewAssets"> 也检查素材交付（需要画面的镜头是否已关联素材、素材文件是否还在）</label><p id="reviewSummary" role="status"></p><div id="reviewList"></div><div class="m-btns"><button class="btn" id="closeReview">返回修改</button><button class="btn primary" id="reviewExport">继续导出</button></div></div></div>`,
  );
  registerCommand('review:open', openReview);
  on('workspace', () => reviewOpen && renderReview());
  $('#closeReview').onclick = closeReview;
  $('#reviewExport').onclick = () => {
    closeReview();
    runCommand('export:menu');
  };
  $('#reviewAssets').onchange = async e => {
    assetMode = e.target.checked;
    renderReview();
    if (assetMode) {
      await refreshMissing();
      if (reviewOpen) renderReview();
    }
  };
  $('#reviewMask').onclick = e => {
    if (e.target.id === 'reviewMask') closeReview();
  };
  // 点检查项跳过去（data-jump 由 workspace 统一处理），这里先把弹窗关掉
  $('#reviewList').addEventListener('click', e => e.target.closest('[data-jump]') && closeReview(), true);
}
