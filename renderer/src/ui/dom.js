/* 界面通用小工具：转义 / 高亮 / toast / 确认弹窗 / 可编辑文字读取 */

export const $ = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];

export const esc = s =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/* 搜索命中加 <mark> 高亮（q 已确保非空且命中） */
export const hiText = (t, q) => {
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(t);
  return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
};

/* 中文输入法正在组合中（打拼音未上屏）时，按键不该触发任何命令 */
export const composing = e => e.isComposing || e.keyCode === 229;

/* 可编辑文字的纯文本：换行（<br> / 段落）都还原成 \n，不会被 textContent 吞掉 */
export function readEditable(el) {
  if (!el) return '';
  const text = el.isConnected ? el.innerText : el.textContent;
  return String(text ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\n$/, '');
}

/* 正在编辑文字（输入框 / 可编辑区域）：全局快捷键要让路 */
export function isEditing(el) {
  const ae = el && el.tagName ? el : document.activeElement;
  return !!(
    ae &&
    (ae.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && !ae.matches('.row-select')))
  );
}

/* toast：相同内容重复触发只重置计时，不重放动画 */
export function toast(msg, action) {
  const t = $('#toast'),
    act = $('#toastAct');
  t._msg = msg;
  t._at = Date.now();
  $('#toastTxt').textContent = msg;
  t._action = action || null;
  act.style.display = action ? '' : 'none';
  if (action) act.textContent = action.label;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2200);
}

let modalCb = null;
export function confirmModal(title, body, okText, cb, { cancelText = '取消', danger = true } = {}) {
  $('#mTitle').textContent = title;
  $('#mCancel').textContent = cancelText;
  $('#mOk').className = 'btn ' + (danger ? 'danger' : 'primary');
  $('#mBody').textContent = body;
  $('#mOk').textContent = okText;
  $('#modalMask').classList.add('show');
  modalCb = cb;
}
export function initModal() {
  const mask = $('#modalMask');
  $('#mCancel').onclick = () => mask.classList.remove('show');
  $('#mOk').onclick = () => {
    mask.classList.remove('show');
    modalCb && modalCb();
  };
  mask.addEventListener('click', e => {
    if (e.target === mask) mask.classList.remove('show');
  });
  $('#toastAct').addEventListener('click', () => {
    const t = $('#toast');
    const a = t._action;
    t.classList.remove('show');
    a?.cb?.();
  });
}

/* 把某句（或它所在的共用画面）带进视口 */
export function revealRow(id, block = 'nearest') {
  const el = document.querySelector(`.row[data-id="${id}"],.as[data-id="${id}"]`);
  (el?.closest('.shared-scene,.shared-passage') || el)?.scrollIntoView({ block });
  return el;
}

/* 播放控制图标（字符 ▶ ⏸ 在不同字体下大小不一，统一用 SVG） */
export const ICON_PLAY =
  '<svg viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z"/></svg>';
export const ICON_PAUSE =
  '<svg viewBox="0 0 24 24"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2"/><rect x="14" y="4" width="4.5" height="16" rx="1.2"/></svg>';
export const ICON_PREV =
  '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="3" height="14" rx="1"/><path d="M20 5.7v12.6a1 1 0 0 1-1.5.86L9 13.6a1.8 1.8 0 0 1 0-3.2l9.5-5.56A1 1 0 0 1 20 5.7Z"/></svg>';
export const ICON_NEXT =
  '<svg viewBox="0 0 24 24"><rect x="17" y="5" width="3" height="14" rx="1"/><path d="M4 5.7v12.6a1 1 0 0 0 1.5.86L15 13.6a1.8 1.8 0 0 0 0-3.2L5.5 4.84A1 1 0 0 0 4 5.7Z"/></svg>';
