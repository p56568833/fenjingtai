/* 专注标注：一次只看一句（共用画面算一个），大字居中、前后各留两句上下文，
   按 1–5 标完自动跳到下一句——长稿逐句过类型时不用找行、不用挪鼠标。
   全部改动走 actions（照常可撤销、落盘），退出时光标停在最后处理的那一句。 */
import { state, on, rowById } from './state.js';
import { TYPES, TYPE_ORDER, KEY2TYPE } from './types.js';
import { shots } from './production.js';
import { setType, markSentences, setNote } from './actions.js';
import { historyCommand } from './undo.js';
import { rememberCursor } from './storage.js';
import { esc, toast, lineSeconds, hasRealTime, fmtTime, composing } from './util.js';
import { closePop } from './popover.js';
import { renderSelectionOnly } from './render.js';

const $ = s => document.querySelector(s);
let open = false;
let curId = null; // 当前画面第一句的 id
let lastType = null; // 「R 同上」用
let closedAt = 0;
let onlyTodo = true;
try {
  onlyTodo = localStorage.getItem('fjz:focusTodo') !== 'false';
} catch {
  /* 读不到偏好用默认 */
}

const units = () => shots(state.rows); // [[row, ...], ...] 共用画面整组算一个
const unitOf = (list, id) => list.findIndex(g => g.some(r => r.id === id));
const isTodo = g => !g[0].type;

function sectionOf(id) {
  let name = '';
  for (const r of state.rows) {
    if (r.kind === 'section') name = r.text;
    if (r.id === id) return name;
  }
  return name;
}

/* 从 index 出发按方向找下一个（只看未标注时跳过已标的）；找不到返回 -1 */
function step(list, index, dir) {
  for (let i = index + dir; i >= 0 && i < list.length; i += dir) if (!onlyTodo || isTodo(list[i])) return i;
  return -1;
}

export function openFocusMode() {
  if (open || performance.now() - closedAt < 400) return; // 菜单和键盘同时发来时不要关了又开
  const list = units();
  if (!list.length) {
    toast('还没有句子，先导入稿子');
    return;
  }
  closePop();
  let i = unitOf(list, state.sel);
  if (i < 0) i = 0;
  if (onlyTodo && !isTodo(list[i])) {
    const next = step(list, i, 1);
    const any = next >= 0 ? next : step(list, -1, 1);
    if (any >= 0) i = any;
  }
  curId = list[i][0].id;
  open = true;
  state.focusMode = true;
  $('#fcTodo').checked = onlyTodo;
  $('#focusMask').classList.add('show');
  render();
}

export function closeFocusMode() {
  if (!open) return;
  open = false;
  state.focusMode = false;
  closedAt = performance.now();
  $('#focusMask').classList.remove('show');
  if (curId != null && rowById(curId)) {
    state.sel = curId;
    state.multi = null;
    renderSelectionOnly();
    rememberCursor();
    document.querySelector(`.row[data-id="${curId}"],.as[data-id="${curId}"]`)?.scrollIntoView({ block: 'center' });
  }
}

const textOf = g => g.map(r => r.text).join('');
function timeLabel(g) {
  const a = g[0],
    b = g[g.length - 1];
  const secs = g.reduce((s, r) => s + lineSeconds(r), 0);
  if (hasRealTime(a) && hasRealTime(b)) return `${fmtTime(a.time.start)} · ${secs.toFixed(1)} 秒`;
  return `约 ${secs.toFixed(1)} 秒`;
}

function render() {
  if (!open) return;
  const list = units();
  let i = unitOf(list, curId);
  if (i < 0) {
    // 当前句被删 / 合并了：退回第一句
    i = 0;
    curId = list[0]?.[0].id ?? null;
  }
  const lines = state.rows.filter(r => r.kind === 'line');
  const done = lines.filter(r => r.type).length;
  $('#fcProgress').textContent = `已标 ${done} / ${lines.length}`;
  $('#fcBarFill').style.width = lines.length ? `${(done / lines.length) * 100}%` : '0';
  const g = list[i];
  if (!g) {
    $('#fcStage').innerHTML = '<div class="fc-done">没有句子</div>';
    return;
  }
  $('#fcSection').textContent = sectionOf(g[0].id) ? `· ${sectionOf(g[0].id)}` : '';
  const ctx = (from, to) =>
    list
      .slice(Math.max(0, from), Math.max(0, to))
      .map(u => {
        const t = u[0].type ? TYPES[u[0].type] : null;
        return `<p class="fc-ctx" style="--c:${t ? t.color : 'transparent'}">${esc(textOf(u))}</p>`;
      })
      .join('');
  const t = g[0].type ? TYPES[g[0].type] : null;
  const shared =
    g.length > 1 ? `<span class="fc-shared">第 ${g[0].no}–${g[g.length - 1].no} 句共用一个画面</span>` : '';
  const finished = onlyTodo && !isTodo(g) && step(list, i, 1) < 0 && step(list, i, -1) < 0;
  $('#fcStage').innerHTML = `
    <div class="fc-prev">${ctx(i - 2, i)}</div>
    <div class="fc-current" style="--c:${t ? t.color : 'var(--seg-none)'}">
      <div class="fc-meta"><span>第 ${g[0].no} 句</span><span>${timeLabel(g)}</span>${shared}
        <span class="fc-type ${t ? t.cls : 't-none'}">${t ? t.icon + esc(t.full) : '未标注'}</span></div>
      <div class="fc-text">${esc(textOf(g))}</div>
      ${finished ? '<div class="fc-done">这一轮的未标注都标完了。取消勾选「只看未标注」可以回头检查。</div>' : ''}
    </div>
    <div class="fc-next">${ctx(i + 1, i + 3)}</div>`;
  $('#fcTypes').innerHTML =
    TYPE_ORDER.map((k, n) => {
      const ty = TYPES[k];
      return `<button class="fc-type-btn${g[0].type === k ? ' on' : ''}" data-fc-type="${k}" style="--c:${ty.color}"><kbd>${n + 1}</kbd>${ty.icon}${esc(ty.label)}</button>`;
    }).join('') +
    `<button class="fc-type-btn" data-fc-type=""><kbd>0</kbd>清除</button>` +
    (lastType
      ? `<button class="fc-type-btn" data-fc-repeat="1"><kbd>R</kbd>同上：${esc(TYPES[lastType].label)}</button>`
      : '');
  const note = $('#fcNote');
  if (document.activeElement !== note) note.value = g[0].note || '';
  note.dataset.id = String(g[0].id);
}

function go(dir) {
  const list = units();
  const i = unitOf(list, curId);
  const j = step(list, i, dir);
  if (j < 0) {
    toast(
      dir > 0
        ? onlyTodo
          ? '后面没有未标注的句子了'
          : '已经是最后一句'
        : onlyTodo
          ? '前面没有未标注的句子了'
          : '已经是第一句',
    );
    return false;
  }
  curId = list[j][0].id;
  render();
  return true;
}

function mark(type) {
  const list = units();
  const g = list[unitOf(list, curId)];
  if (!g) return;
  const ids = g.map(r => r.id);
  if (state.view === 'check') markSentences(ids, type);
  else setType(ids, type);
  if (type) lastType = type;
  if (type) {
    // 标完就走；只看未标注时自动找下一个未标的
    const j = step(list, unitOf(list, curId), 1);
    if (j >= 0) curId = list[j][0].id;
  }
  render();
}

function saveNote() {
  const note = $('#fcNote');
  const id = +note.dataset.id;
  const r = rowById(id);
  if (r && (r.note || '') !== note.value.trim()) {
    setNote(id, note.value.trim());
    toast('画面描述已保存');
  }
}

/* 专注标注打开时的全部按键（由 modal.js 转发）；返回 true = 已处理 */
export function focusKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (composing(e)) return false;
  if (e.target && e.target.id === 'fcNote') {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveNote();
      e.target.blur();
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.target.value = rowById(+e.target.dataset.id)?.note || '';
      e.target.blur();
      return true;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      saveNote();
      e.target.blur();
      return true;
    }
    return false; // 其余按键正常打字
  }
  if (e.key === 'Escape' || (mod && (e.key === 'e' || e.key === 'E'))) {
    e.preventDefault();
    closeFocusMode();
    return true;
  }
  if (mod && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    historyCommand(e.shiftKey ? 'redo' : 'undo', 'key');
    return true;
  }
  if (mod || e.altKey) return false;
  if (Object.hasOwn(KEY2TYPE, e.key)) {
    e.preventDefault();
    mark(KEY2TYPE[e.key]);
    return true;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    mark(null);
    return true;
  }
  if ((e.key === 'r' || e.key === 'R') && lastType) {
    e.preventDefault();
    mark(lastType);
    return true;
  }
  if ([' ', 'ArrowRight', 'ArrowDown', 'j'].includes(e.key)) {
    e.preventDefault();
    go(1);
    return true;
  }
  if (['ArrowLeft', 'ArrowUp', 'k'].includes(e.key)) {
    e.preventDefault();
    go(-1);
    return true;
  }
  if (e.key === 'Tab' || e.key === 'n' || e.key === 'Enter') {
    e.preventDefault();
    $('#fcNote').focus();
    return true;
  }
  return false;
}

export function initFocus() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask focus-mask" id="focusMask"><div class="focus-box" role="dialog" aria-label="专注标注">
      <div class="focus-head"><strong>专注标注</strong><span class="fc-section" id="fcSection"></span><span class="spacer"></span>
        <label class="auto-label"><input type="checkbox" id="fcTodo"> 只看未标注</label>
        <span class="fc-progress" id="fcProgress"></span><button class="btn" id="fcClose">退出 <kbd>Esc</kbd></button></div>
      <div class="focus-bar"><div id="fcBarFill"></div></div>
      <div class="focus-stage" id="fcStage"></div>
      <div class="focus-types" id="fcTypes"></div>
      <textarea id="fcNote" rows="2" placeholder="画面描述（按 Tab 开始写，Enter 保存，Shift+Enter 换行）"></textarea>
      <div class="focus-keys"><kbd>1–5</kbd> 标注并下一句 · <kbd>0</kbd> 清除 · <kbd>R</kbd> 同上一个 · <kbd>空格</kbd>/<kbd>→</kbd> 下一句 · <kbd>←</kbd> 上一句 · <kbd>Tab</kbd> 写画面描述 · <kbd>⌘Z</kbd> 撤销 · <kbd>Esc</kbd> 退出</div>
    </div></div>`,
  );
  $('#fcClose').onclick = closeFocusMode;
  $('#fcTodo').onchange = e => {
    onlyTodo = e.target.checked;
    try {
      localStorage.setItem('fjz:focusTodo', String(onlyTodo));
    } catch {
      /* 记不住偏好不影响使用 */
    }
    render();
  };
  $('#fcTypes').addEventListener('click', e => {
    const b = e.target.closest('[data-fc-type],[data-fc-repeat]');
    if (!b) return;
    mark(b.dataset.fcRepeat ? lastType : b.dataset.fcType || null);
  });
  $('#fcStage').addEventListener('click', e => {
    // 点上下文里的句子直接跳过去
    const p = e.target.closest('.fc-ctx');
    if (!p) return;
    const list = units();
    const idx = [...$('#fcStage').querySelectorAll('.fc-ctx')].indexOf(p);
    const i = unitOf(list, curId);
    const prevCount = $('#fcStage').querySelectorAll('.fc-prev .fc-ctx').length;
    const target = idx < prevCount ? i - prevCount + idx : i + 1 + (idx - prevCount);
    if (list[target]) {
      curId = list[target][0].id;
      render();
    }
  });
  $('#fcNote').addEventListener('blur', saveNote);
  on('rows', render); // 撤销 / 重做 / 删改句子后跟着刷新
  on('project-loaded', closeFocusMode);
  document.querySelector('#btnFocus')?.addEventListener('click', openFocusMode);
}
