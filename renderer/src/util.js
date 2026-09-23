import { state } from './state.js';
/* 通用小工具：时长估算 / 转义 / toast / 确认弹窗 */
/* 估算朗读量（按「中文字」计）：汉字、数字各算 1；英文按单词算，一个词约等于 1.8 个汉字的时长
   （以前按字母计，一个英文单词会被当成五六个字，含英文的句子时长严重偏长） */
export function speechUnits(t) {
  const s = t || '';
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const digits = (s.match(/[0-9]/g) || []).length;
  const words = (s.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) || []).length;
  return cjk + digits + words * 1.8;
}
export const durNum = t => speechUnits(t) / state.speechRate;
export const dur = t => durNum(t).toFixed(1) + 's';
/* 一句的时长（秒）：对齐过剪映字幕就用真实时间，否则按语速估算 */
export const hasRealTime = r =>
  !!(r && r.time && Number.isFinite(r.time.start) && Number.isFinite(r.time.end) && r.time.end > r.time.start);
export const lineSeconds = r => (hasRealTime(r) ? r.time.end - r.time.start : durNum(r?.text || ''));

/* 表格「时长」格：对齐过字幕显示「时间码 + 真实时长」，低置信 / 推算的标黄并说明；否则按语速估算 */
export function durCellHTML(r) {
  if (!hasRealTime(r))
    return r?.time?.st === 'est'
      ? `<span class="tc dur-est" title="字幕里没找到这句">—</span>${dur(r.text)}`
      : dur(r?.text || '');
  const t = r.time,
    secs = (t.end - t.start).toFixed(1) + 's';
  const why =
    t.st === 'ok'
      ? `字幕时间 ${fmtTime(t.start)}–${fmtTime(t.end)}`
      : t.st === 'low'
        ? `低置信：只有 ${Math.round(t.conf * 100)}% 的字和字幕一致，时间可能不准`
        : '字幕里没找到这句，时间是按前后句推算的';
  return `<span class="tc${t.st === 'ok' ? '' : ' dur-' + t.st}" title="${esc(why)}">${t.st === 'ok' ? '' : '≈'}${fmtTime(t.start)}</span>${secs}`;
}
export const esc = s =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
/* 搜索命中加 <mark> 高亮（表格/总览共用，q 已确保非空且命中） */
export const hiText = (t, q) => {
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(t);
  return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
};

/* 中文输入法正在组合中（打拼音未上屏）时，按键不该触发任何命令 */
export const composing = e => e.isComposing || e.keyCode === 229;

/* 视频片段时间：存秒（浮点），显示 / 输入 mm:ss（超 1 小时显示 h:mm:ss） */
export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60),
    m = Math.floor(sec / 60) % 60,
    h = Math.floor(sec / 3600);
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
export function parseTime(str) {
  if (str == null) return null;
  const t = String(str).trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  const h = m[1] ? +m[1] : 0,
    mm = +m[2],
    ss = parseFloat(m[3]);
  if (mm > 59 || ss >= 60) return null;
  return h * 3600 + mm * 60 + ss;
}

/* toast：相同内容 2 秒内重复触发只重置计时，不重放动画（连续合并不吵） */
export function toast(msg, action) {
  const t = document.querySelector('#toast'),
    act = document.querySelector('#toastAct');
  t._msg = msg;
  t._at = Date.now();
  document.querySelector('#toastTxt').textContent = msg;
  t._action = action || null;
  act.style.display = action ? '' : 'none';
  if (action) act.textContent = action.label;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2200);
}

let modalCb = null;
export function confirmModal(title, body, okText, cb, { cancelText = '取消', danger = true } = {}) {
  document.querySelector('#mTitle').textContent = title;
  document.querySelector('#mCancel').textContent = cancelText;
  document.querySelector('#mOk').className = 'btn ' + (danger ? 'danger' : 'primary');
  document.querySelector('#mBody').textContent = body;
  document.querySelector('#mOk').textContent = okText;
  document.querySelector('#modalMask').classList.add('show');
  modalCb = cb;
}
export function initModal() {
  const mask = document.querySelector('#modalMask');
  document.querySelector('#mCancel').onclick = () => mask.classList.remove('show');
  document.querySelector('#mOk').onclick = () => {
    mask.classList.remove('show');
    modalCb && modalCb();
  };
  mask.addEventListener('click', e => {
    if (e.target === mask) mask.classList.remove('show');
  }); // 点遮罩=取消
}
