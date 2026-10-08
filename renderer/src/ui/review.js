/* 交稿检查：列出未标注 / 缺画面描述 / 主画面缺失 / 片段待调整 / 改稿待核对 / 字幕没找到的镜头 */
import { state, on, types } from '../app/state.js';
import { checkDelivery } from '../core/shots.js';
import { esc } from './dom.js';
import { closePop } from './popover.js';
import { registerCommand, runCommand } from './commands.js';

const $ = s => document.querySelector(s);
let reviewOpen = false;
export const isReviewOpen = () => reviewOpen;

export function deliveryIssues() {
  return checkDelivery(state.rows, types().list);
}

function renderReview() {
  const list = deliveryIssues();
  const host = $('#reviewList');
  if (!host) return;
  $('#reviewSummary').textContent = list.length
    ? `${list.length} 个镜头待处理；可以带缺项导出。`
    : '检查通过，所有镜头信息已齐备。';
  host.innerHTML = list
    .map(
      x =>
        `<button class="review-item" data-jump="${x.id}"><strong>第 ${x.no} 句 · ${esc(x.issues.join(' / '))}</strong><span>${esc(x.text.slice(0, 90))}</span></button>`,
    )
    .join('');
}

export function openReview() {
  closePop();
  $('#reviewMask').classList.add('show');
  reviewOpen = true;
  renderReview();
}
export function closeReview() {
  $('#reviewMask').classList.remove('show');
  reviewOpen = false;
}

export function initReview() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="reviewMask"><div class="modal wide"><h3>交稿检查</h3><p id="reviewSummary"></p><div id="reviewList"></div><div class="m-btns"><button class="btn" id="closeReview">返回修改</button><button class="btn primary" id="reviewExport">继续导出</button></div></div></div>`,
  );
  registerCommand('review:open', openReview);
  on('workspace', () => reviewOpen && renderReview());
  $('#closeReview').onclick = closeReview;
  $('#reviewExport').onclick = () => {
    closeReview();
    runCommand('export:menu');
  };
  $('#reviewMask').onclick = e => {
    if (e.target.id === 'reviewMask') closeReview();
  };
  // 点检查项跳过去（data-jump 由 workspace 统一处理），这里先把弹窗关掉
  $('#reviewList').addEventListener('click', e => e.target.closest('[data-jump]') && closeReview(), true);
}
