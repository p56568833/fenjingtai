/* 标注类型编辑器（本项目）：改名字 / 颜色 / 图标 / 是否需要配画面、排序（= 快捷键 1–9）、增删。
   在弹窗里改的是草稿，点「保存」才生效，一次保存 = 一步撤销。
   删掉正在用的类型时，必须选好这些句子改成什么（别的类型或清除标注）。 */
import { state, types } from '../app/state.js';
import { setProjectTypes } from '../app/types-actions.js';
import { DEFAULT_TYPES, ICONS, MAX_TYPES, PALETTE, newTypeId, defaultTypes, typeUsage } from '../core/types.js';
import { esc, toast } from '../ui/dom.js';
import { registerCommand } from '../ui/commands.js';

const $ = s => document.querySelector(s);
const ICON_NAMES = {
  person: '人物',
  camera: '摄像机',
  film: '胶片',
  sparkle: '星光',
  bolt: '闪电',
  text: '文字',
  image: '图片',
  chart: '图表',
  mic: '麦克风',
  dot: '圆点',
};
let draft = []; // [{...type, _orig?: id}]
let removed = new Map(); // 被删的 id → 改成的 id | null

function rowHTML(t, i) {
  const used = typeUsage(state.rows, t.id);
  return `<div class="te-row" data-i="${i}">
    <span class="te-key">${i + 1}</span>
    <input type="color" class="te-color" value="${esc(t.color)}" title="颜色">
    <span class="te-icon" style="--tc:${esc(t.color)}">${ICONS[t.icon] || ICONS.dot}</span>
    <select class="te-icon-pick" title="图标">${Object.keys(ICONS)
      .map(k => `<option value="${k}" ${t.icon === k ? 'selected' : ''}>${ICON_NAMES[k] || k}</option>`)
      .join('')}</select>
    <input class="te-label" value="${esc(t.label)}" maxlength="12" placeholder="短名（筛选条）">
    <input class="te-full" value="${esc(t.full)}" maxlength="30" placeholder="全名（标注卡）">
    <label class="te-visual" title="勾上：交稿检查要求画面描述和素材，素材清单里会列出"><input type="checkbox" ${t.visual ? 'checked' : ''}> 需要配画面</label>
    <span class="te-used">${used ? `${used} 句` : ''}</span>
    <button class="te-btn" data-te="up" title="上移（快捷键跟着变）" ${i === 0 ? 'disabled' : ''}>↑</button>
    <button class="te-btn" data-te="down" title="下移" ${i === draft.length - 1 ? 'disabled' : ''}>↓</button>
    <button class="te-btn danger" data-te="del" title="删除这个类型" ${draft.length <= 1 ? 'disabled' : ''}>✕</button>
  </div>`;
}

function removedHTML() {
  const list = [...removed.keys()].filter(id => typeUsage(state.rows, id));
  if (!list.length) return '';
  const opts = sel =>
    `<option value="" ${sel == null ? 'selected' : ''}>清除标注</option>` +
    draft.map(t => `<option value="${esc(t.id)}" ${sel === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
  return (
    `<div class="te-removed"><b>删掉的类型里还有句子，改成：</b>` +
    list
      .map(id => {
        const old = types().get(id);
        return `<label>「${esc(old?.label || id)}」${typeUsage(state.rows, id)} 句 → <select data-remap="${esc(id)}">${opts(removed.get(id))}</select></label>`;
      })
      .join('') +
    `</div>`
  );
}

function render() {
  $('#teList').innerHTML = draft.map(rowHTML).join('');
  $('#teRemoved').innerHTML = removedHTML();
  $('#teAdd').disabled = draft.length >= MAX_TYPES;
  $('#teAdd').textContent = draft.length >= MAX_TYPES ? `最多 ${MAX_TYPES} 个（对应 1–9）` : '＋ 添加类型';
}

/* 把输入框里的值收回草稿（不重画，保持焦点） */
function collect() {
  document.querySelectorAll('#teList .te-row').forEach(el => {
    const t = draft[+el.dataset.i];
    if (!t) return;
    t.color = el.querySelector('.te-color').value;
    t.icon = el.querySelector('.te-icon-pick').value;
    t.label = el.querySelector('.te-label').value.trim();
    t.full = el.querySelector('.te-full').value.trim();
    t.visual = el.querySelector('.te-visual input').checked;
  });
  document.querySelectorAll('#teRemoved [data-remap]').forEach(sel => {
    removed.set(sel.dataset.remap, sel.value || null);
  });
}

export function openTypeEditor() {
  draft = types().list.map(t => ({ ...t }));
  removed = new Map();
  $('#teDefault').checked = false;
  $('#typeEditorMask').classList.add('show');
  render();
}
function close() {
  $('#typeEditorMask').classList.remove('show');
}

function save() {
  collect();
  const empty = draft.find(t => !t.label);
  if (empty) return toast('每个类型都要有个名字');
  const labels = draft.map(t => t.label);
  if (new Set(labels).size !== labels.length) return toast('类型名字不能重复');
  const remap = Object.fromEntries(removed);
  setProjectTypes(
    draft.map(t => ({ ...t, full: t.full || t.label })),
    { remap, asDefault: $('#teDefault').checked },
  );
  close();
}

export function initTypeEditor() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="typeEditorMask"><div class="modal wide type-editor">
      <h3>本项目的标注类型</h3>
      <p class="te-help">顺序就是快捷键：第 1 个按 1，第 2 个按 2……最多 9 个。改名字不影响已经标好的句子。</p>
      <div id="teList"></div>
      <div id="teRemoved"></div>
      <div class="te-foot">
        <button class="btn" id="teAdd">＋ 添加类型</button>
        <button class="text-button" id="teReset" title="恢复成 A roll + 四类 B roll">恢复默认五类</button>
        <span class="spacer"></span>
        <label class="auto-label"><input type="checkbox" id="teDefault"> 以后新建项目也用这套类型</label>
      </div>
      <div class="m-btns"><button class="btn" id="teCancel">取消</button><button class="btn primary" id="teSave">保存</button></div>
    </div></div>`,
  );
  registerCommand('types:edit', openTypeEditor);
  $('#teCancel').onclick = close;
  $('#teSave').onclick = save;
  $('#typeEditorMask').addEventListener('click', e => {
    if (e.target.id === 'typeEditorMask') close();
  });
  $('#teAdd').onclick = () => {
    collect();
    if (draft.length >= MAX_TYPES) return;
    const used = new Set(draft.map(t => t.color));
    draft.push({
      id: newTypeId([...draft, ...[...removed.keys()].map(id => ({ id }))]),
      label: '新类型',
      full: '新类型',
      color: PALETTE.find(c => !used.has(c)) || PALETTE[draft.length % PALETTE.length],
      icon: 'dot',
      visual: true,
    });
    render();
    const inputs = document.querySelectorAll('#teList .te-label');
    inputs[inputs.length - 1]?.select();
  };
  $('#teReset').onclick = () => {
    collect();
    const keep = new Set(DEFAULT_TYPES.map(t => t.id));
    for (const t of draft) if (!keep.has(t.id)) removed.set(t.id, null);
    for (const id of keep) removed.delete(id);
    draft = defaultTypes();
    render();
  };
  $('#teList').addEventListener('click', e => {
    const b = e.target.closest('[data-te]');
    if (!b) return;
    collect();
    const i = +b.closest('.te-row').dataset.i;
    if (b.dataset.te === 'up' && i > 0) [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]];
    if (b.dataset.te === 'down' && i < draft.length - 1) [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]];
    if (b.dataset.te === 'del' && draft.length > 1) {
      const [gone] = draft.splice(i, 1);
      if (types().has(gone.id)) removed.set(gone.id, null);
    }
    render();
  });
  // 颜色 / 图标改了：左边的预览图标跟着变
  $('#teList').addEventListener('input', e => {
    const row = e.target.closest('.te-row');
    if (!row) return;
    const icon = row.querySelector('.te-icon');
    if (e.target.classList.contains('te-color')) icon.style.setProperty('--tc', e.target.value);
    if (e.target.classList.contains('te-icon-pick')) icon.innerHTML = ICONS[e.target.value] || ICONS.dot;
  });
}
