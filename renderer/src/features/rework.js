/* 右侧面板的两个返工入口：
   · 素材卡片上的「不满意」：这个素材要换掉，写下哪里不满意（旧素材先留在画面上，新候选通过后挪到备选）
   · 「再找一个…」：这个画面还缺镜头，写下要什么
   都会进审核页「待返工」，生成返工单交给 AI（见 core/rework.js）。 */
import { state, update } from '../app/state.js';
import { persist } from '../app/storage.js';
import { snapshot } from '../app/undo.js';
import { shotMembers } from '../core/shots.js';
import { usageList, assetName } from '../core/asset-model.js';
import { setRework, setAssetRework } from '../core/rework.js';
import { toast, esc } from '../ui/dom.js';
import { registerModal } from '../ui/modal.js';
import { registerCommand, runCommand } from '../ui/commands.js';
import { renderInspector } from '../ui/inspector.js';

const $ = s => document.querySelector(s);
let target = null; // { rowId, assetId|null }

function open(row, assetId = null) {
  if (!row || row.kind !== 'line') return;
  const members = shotMembers(state.rows, row);
  target = { rowId: members[0].id, assetId };
  const range =
    members.length > 1 ? `第 ${members[0].no}–${members[members.length - 1].no} 句` : `第 ${members[0].no} 句`;
  let cur;
  if (assetId) {
    const a = state.assets?.[assetId];
    cur = members.flatMap(m => usageList(m)).find(u => u.assetId === assetId && u.rework)?.rework || null;
    $('#reworkTitle').textContent = cur ? '修改：这个素材要换' : '不满意这个素材';
    $('#reworkRange').innerHTML = `${esc(range)} · <b>${esc(a?.name || assetName(a?.path || '') || '素材')}</b>`;
    $('#reworkNote').placeholder = '哪里不满意、想换成什么样的？比如：太暗了，要近景；要彩色的';
    $('#reworkHint').textContent = '这个素材先留在画面上；新找来的候选通过后，它挪到备选。';
    $('#reworkOff').textContent = '不用换了';
  } else {
    cur = members.find(m => m.rework && !m.rework.assetId)?.rework || null;
    $('#reworkTitle').textContent = cur ? '修改：这个画面要补的镜头' : '这个画面再找一个镜头';
    $('#reworkRange').textContent = range;
    $('#reworkNote').placeholder = '要什么样的镜头？比如：还缺一个大楼外景';
    $('#reworkHint').textContent = '现有素材不动，新找来的候选通过后加到这个画面。';
    $('#reworkOff').textContent = '不用找了';
  }
  $('#reworkNote').value = cur?.note || '';
  $('#reworkOff').hidden = !cur;
  $('#reworkMask').classList.add('show');
  setTimeout(() => $('#reworkNote').focus(), 30);
}
const close = () => {
  $('#reworkMask').classList.remove('show');
  target = null;
};
function apply(rework, label) {
  const row = target && state.rows.find(r => r.id === target.rowId);
  if (!row) return close();
  const assetId = target.assetId;
  snapshot(label);
  if (assetId) setAssetRework(state.rows, row, assetId, rework);
  else setRework(state.rows, row, rework);
  persist();
  update('rows');
  renderInspector(true);
  close();
  return row;
}
function save() {
  const note = $('#reworkNote').value.trim();
  if (!note && !target?.assetId) return toast('写一下要什么样的镜头');
  const row = apply({ note, at: Date.now() }, target?.assetId ? '标记素材要换' : '这个画面再找一个镜头');
  if (row)
    toast('已加入待返工，生成返工单后交给 AI 找 · ⌘Z 可撤销', {
      label: '去看看',
      cb: () => runCommand('video:rework', row.id),
    });
}
function dismiss() {
  const was = target?.assetId;
  if (apply(null, was ? '不用换了' : '不用找了'))
    toast(`${was ? '这个素材不用换了' : '这个画面不用再找了'} · ⌘Z 可撤销`);
}

export function initRework() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="reworkMask"><div class="modal rework-modal"><h3 id="reworkTitle">不满意这个素材</h3>
      <p class="rework-range" id="reworkRange"></p>
      <label class="rework-label">写给找素材的 AI<textarea id="reworkNote" rows="3"></textarea></label>
      <p class="rework-hint" id="reworkHint"></p>
      <div class="m-btns"><button class="btn ghost" id="reworkOff" hidden>不用换了</button><span class="spacer"></span><button class="btn" id="reworkCancel">取消</button><button class="btn primary" id="reworkSave">加入待返工</button></div></div></div>`,
  );
  $('#reworkCancel').onclick = close;
  $('#reworkSave').onclick = save;
  $('#reworkOff').onclick = dismiss;
  $('#reworkMask').addEventListener('click', e => {
    if (e.target.id === 'reworkMask') close();
  });
  registerModal('reworkMask', { close, enter: save });
  registerCommand('rework:edit', open);
}
