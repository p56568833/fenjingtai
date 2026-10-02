import { sharedScenes, assetRefs, assetCards, hydrateAssetCards, inspectorAssets, refreshThumb } from './visuals.js';
import { state, on, update, rowById, currentSelection } from './state.js';
import { esc, toast, confirmModal } from './util.js';
import { snapshot } from './undo.js';
import { persist, rememberCursor } from './storage.js';
import { updateCheckNote } from './render-check.js';
import { renderStats } from './render-stats.js';
import { closePop, openMenu, markPopAnchor } from './popover.js';
import {
  STATUS,
  shotMembers,
  setShotField,
  validGroup,
  sameGroupSelection,
  groupRows,
  repairCandidates,
  repairPunctuation,
  checkDelivery,
} from './production.js';
import { usageList, setShotRefsFromText, removeUsage, addRefsToShot, probePaths, isMissing } from './assets.js';
import { openPreview } from './preview.js';
import { openAssetPicker } from './asset-picker.js';
import { relocateFlow } from './shot-menu.js';
import { pickAssets, openAsset as openAssetNative } from './native-bridge.js';

let fieldSession = null;
let detailOpen = false,
  outlineOpen = true,
  reviewOpen = false,
  lastProject = null;
let missingSet = new Set(); // 文件失联探测结果（与「无缩略图」「格式不支持」分开统计）
const $ = s => document.querySelector(s);

export function jumpTo(id) {
  if (!rowById(id)) return;
  closePop();
  state.filter = 'all';
  state.multi = null;
  const r = rowById(id);
  state.sel =
    r.kind === 'section' ? (state.rows.slice(state.rows.indexOf(r) + 1).find(x => x.kind === 'line')?.id ?? null) : id;
  update('rows');
  const el =
    r.kind === 'section'
      ? document.querySelector(`[data-sid="${id}"]`)
      : document.querySelector(`.row[data-id="${id}"],.as[data-id="${id}"]`);
  el?.scrollIntoView({ block: 'center' });
  rememberCursor();
}
export function nextUnmarked() {
  const lines = state.rows.filter(r => r.kind === 'line');
  const i = lines.findIndex(r => r.id === state.sel);
  const ordered = [...lines.slice(i + 1), ...lines.slice(0, i + 1)];
  const next = ordered.find(r => !r.type);
  if (next) jumpTo(next.id);
  else toast('所有句子都已标注');
}
export function revealSavedCursor() {
  requestAnimationFrame(() => {
    const el = document.querySelector(`.row[data-id="${state.sel}"],.as[data-id="${state.sel}"]`);
    el?.scrollIntoView({ block: 'center' });
  });
}
function renderOutline() {
  const sections = [];
  let section = { text: '开场', id: null, lines: [] };
  for (const r of state.rows) {
    if (r.kind === 'section') {
      if (section.lines.length) sections.push(section);
      section = { text: r.text, id: r.id, lines: [] };
    } else section.lines.push(r);
  }
  if (section.lines.length) sections.push(section);
  $('#outline').innerHTML =
    `<div class="side-title">章节 <span>${sections.length}</span></div>` +
      sections
        .map(s => {
          const todo = s.lines.filter(r => !r.type).length;
          const active = s.lines.some(r => r.id === state.sel);
          return `<button class="outline-item ${active ? 'active' : ''}" data-jump="${s.id ?? s.lines[0].id}"><span>${esc(s.text)}</span><small>${s.lines.length} 句 · ${todo ? '未标 ' + todo : '已标完'}</small></button>`;
        })
        .join('') || '<div class="side-empty">导入口播稿后开始</div>';
}
function renderToolbar() {
  const ids = currentSelection().filter(id => rowById(id)?.kind === 'line');
  const groups = new Set(ids.map(id => rowById(id).groupId).filter(Boolean));
  const multiBtn = $('#btnMultiMode');
  multiBtn.textContent = state.multiMode ? '完成选择' : '多选句子';
  multiBtn.classList.toggle('active', state.multiMode);
  multiBtn.setAttribute('aria-pressed', String(state.multiMode));
  const count = $('#selCount');
  count.hidden = !ids.length;
  count.textContent = ids.length ? `已选 ${ids.length} 句` : '';
  const groupBtn = $('#btnGroup');
  const already = ids.length > 1 && sameGroupSelection(state.rows, ids);
  const ok = validGroup(state.rows, ids) && !already;
  groupBtn.disabled = !ok;
  groupBtn.title = already
    ? '这些句子已经在同一个共用画面里'
    : ok
      ? '选择同一章节内连续的两句或更多，再共用一个画面'
      : ids.length < 2
        ? '勾选连续两句以上才能共用'
        : '只能共用同一章节里连续的句子';
  $('#btnUngroup').hidden = !groups.size;
}
function rowBadges() {
  const rows = [...document.querySelectorAll('.row:not(.shared-scene-row),.shared-scene')];
  rows.forEach(el => {
    const r = rowById(+(el.dataset.owner || el.dataset.id));
    if (!r) return;
    let badge = el.querySelector('.production-badge');
    if (!badge) {
      badge = document.createElement('button');
      badge.className = 'production-badge';
      badge.dataset.detail = String(r.id);
      el.querySelector('.typebox')?.append(badge);
    }
    const status =
      r.status === 'todo' || !r.status ? (assetRefs(r).length ? '素材待确认' : '待找素材') : STATUS[r.status];
    const clipTodo = usageList(r).some(u => u.clip && u.clip.needsAdjust);
    const text = [
      r.type && r.type !== 'a' ? '状态：' + status : '',
      clipTodo ? '片段待调整' : '',
      r.needsReview ? '待核对' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    badge.textContent = text;
    badge.hidden = !text;
    const assets = el.querySelector('.row-assets');
    if (assets) {
      const signature = JSON.stringify([r.assetUsages || [], r.assets, r.type]);
      if (assets.dataset.signature !== signature) {
        assets.innerHTML = assetCards(r);
        assets.dataset.signature = signature;
      }
    }
  });
  hydrateAssetCards();
}
async function refreshMissing() {
  const paths = [
    ...new Set(
      Object.values(state.assets || {})
        .map(a => a.path)
        .filter(p => p),
    ),
  ];
  const probe = await probePaths(paths);
  const next = new Set(paths.filter(p => isMissing(probe[p])));
  const changed = next.size !== missingSet.size || [...next].some(p => !missingSet.has(p));
  missingSet = next;
  if (!changed) return;
  rowBadges();
  if (detailOpen && !$('#inspector').contains(document.activeElement)) renderInspector(true);
}
function renderInspector(force = false) {
  const panel = $('#inspector');
  panel.hidden = !detailOpen;
  document.querySelector('.workspace').classList.toggle('has-inspector', detailOpen);
  $('#btnDetail').setAttribute('aria-expanded', String(detailOpen));
  if (!detailOpen) return;
  if (!force && panel.contains(document.activeElement)) return;
  const r = rowById(state.sel);
  if (!r || r.kind !== 'line') {
    panel.innerHTML = '<div class="side-title">画面与素材</div><p class="side-empty">先选择一句口播。</p>';
    return;
  }
  const members = shotMembers(state.rows, r);
  fieldSession = null;
  panel.dataset.row = String(r.id);
  panel.dataset.project = state.projectId;
  panel.innerHTML = `<div class="side-title">${members.length > 1 ? sharedScenes(state.rows).get(r.groupId)?.label : '第 ' + r.no + ' 句'}<button class="text-button" id="closeDetail" aria-label="关闭素材面板">✕</button></div>
    <p class="detail-excerpt">${esc(members.map(x => x.text).join(''))}</p>
    <label>画面描述<textarea id="detailNote" rows="4" placeholder="画面里有什么？如何呈现？">${esc(r.note || '')}</textarea></label>
    <label>制作状态<select id="detailStatus">${Object.entries(STATUS)
      .map(
        ([k, v]) =>
          `<option value="${k}" ${r.status === k ? 'selected' : ''}>${k === 'todo' && assetRefs(r).length ? '素材待确认' : v}</option>`,
      )
      .join('')}</select></label>
    <div class="asset-list-title">素材与片段</div><div class="asset-list">${inspectorAssets(r, { missing: missingSet })}</div>
    <div class="detail-buttons"><button class="btn" id="attachAsset">添加素材</button><button class="btn" id="attachFromLib">从本项目素材</button></div>
    <p class="asset-removal-help">也可以把文件直接拖进这里或句子上 · 移除只解除关联，保留本地文件 · ⌘Z 可撤销</p>
    <details class="asset-paths"><summary>编辑链接或文件路径</summary><textarea id="detailAssets" rows="3" placeholder="一行一个链接或文件路径">${esc(assetRefs(r).join('\n'))}</textarea></details>
    <div class="detail-buttons"><button class="btn primary" id="saveDetail">保存</button></div>
    ${r.needsReview ? '<button class="btn" id="confirmReviewed">已核对这段改稿</button>' : ''}
    <p class="detail-help">${members.length > 1 ? '保存会同步到共用此画面的所有句子；视频片段也共用一份设置。' : '画面描述与表格备注同步。'} 链接与路径会随项目保存；本地素材需随交稿另行打包。</p>`;
  hydrateAssetCards();
  refreshMissing();
}
/* 原文视图的选区卡 / 行菜单：打开右侧面板看这个画面的素材 */
export function openInspectorFor(id) {
  const r = rowById(id);
  if (!r || r.kind !== 'line') return;
  state.sel = id;
  state.multi = null;
  detailOpen = true;
  update('selection');
  renderInspector(true);
}
function saveDetail() {
  const r = rowById(state.sel);
  if (!r || !$('#detailNote')) return;
  const note = $('#detailNote').value,
    status = $('#detailStatus').value,
    refs = $('#detailAssets').value;
  const changed =
    (r.note || '') !== note ||
    (r.status || '') !== status ||
    assetRefs(r).join('\n') !==
      refs
        .split('\n')
        .map(x => x.trim())
        .filter(Boolean)
        .join('\n');
  if (changed) {
    snapshot('更新画面与素材');
    setShotField(state.rows, r, 'status', status);
    setShotRefsFromText(r, refs);
    setShotField(state.rows, r, 'note', note).forEach(x => {
      const n = document.querySelector(`.note[data-id="${x.id}"]`);
      if (n) n.textContent = note;
      updateCheckNote(x.id);
    });
    persist();
    update('rows');
  }
  renderInspector(true);
  toast('画面与素材已保存');
}
function renderReview() {
  const list = checkDelivery(state.rows);
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
function refresh() {
  renderOutline();
  renderToolbar();
  rowBadges();
  renderInspector();
  if (reviewOpen) renderReview();
  if (lastProject !== state.projectId) {
    lastProject = state.projectId;
    missingSet = new Set();
    revealSavedCursor();
    renderInspector(true);
  }
  refreshMissing();
}
export function initWorkspace() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="reviewMask"><div class="modal wide"><h3>交稿检查</h3><p id="reviewSummary"></p><div id="reviewList"></div><div class="m-btns"><button class="btn" id="closeReview">返回修改</button><button class="btn primary" id="reviewExport">继续导出</button></div></div></div>`,
  );
  on('workspace', refresh);
  on('cursor', () => {
    rememberCursor();
    renderToolbar();
    renderOutline();
    renderInspector();
  });
  on('annotated', ({ type }) => {
    if (state.autoAdvance && type && !state.focusMode) nextUnmarked();
  });
  $('#btnOutline').onclick = () => {
    outlineOpen = !outlineOpen;
    $('#outline').hidden = !outlineOpen;
    $('#btnOutline').setAttribute('aria-expanded', String(outlineOpen));
  };
  $('#btnNext').onclick = nextUnmarked;
  $('#autoAdvance').checked = state.autoAdvance = localStorage.getItem('fjz:autoAdvance') === 'true';
  $('#autoAdvance').onchange = e => {
    state.autoAdvance = e.target.checked;
    localStorage.setItem('fjz:autoAdvance', String(state.autoAdvance));
  };
  $('#btnDetail').onclick = () => {
    detailOpen = !detailOpen;
    renderInspector(true);
  };
  $('#btnReview').onclick = openReview;
  $('#closeReview').onclick = () => {
    $('#reviewMask').classList.remove('show');
    reviewOpen = false;
  };
  $('#reviewExport').onclick = () => {
    $('#closeReview').click();
    $('#btnExport').click();
  };
  $('#reviewMask').onclick = e => {
    if (e.target.id === 'reviewMask') $('#closeReview').click();
  };
  $('#btnRepair').onclick = () => {
    const fixes = repairCandidates(state.rows);
    if (!fixes.length) {
      toast('没有发现可自动修复的孤立标点');
      return;
    }
    confirmModal(
      '合并孤立标点？',
      `发现 ${fixes.length} 行仅有标点，将并回上一句。已有类型、备注或素材的行会保留。可以用 ⌘Z 撤销。`,
      '修复',
      () => {
        snapshot('修复孤立标点');
        state.rows = repairPunctuation(state.rows);
        if (!rowById(state.sel)) state.sel = state.rows.find(r => r.kind === 'line')?.id ?? null;
        state.multi = null;
        persist();
        update('rows');
        toast(`已修复 ${fixes.length} 行`);
      },
    );
  };
  $('#btnHelp').onclick = e => {
    openMenu(
      e.currentTarget,
      `<div class="p-title">操作帮助</div><div class="help-copy">表格：点「多选句子」显示勾选框，完成后点「完成选择」<br>原文：点「多选句子」后逐句点选<br>勾选同一章节里连续两句以上 → 共用一个画面<br>共用区域「···」：加入下一句 / 移出最后一句 / 解除共用<br>组内句子「···」：从这句开始使用另一个画面<br>1–5：标注类型 · 0 或 ⌫：清除 · ⌘⌫：删除句子<br>⌘E：专注标注（一次一句，标完自动下一句，R 重复上一个类型）<br>↑↓：切换句子 · Shift 点选：连续多选<br>⌘ 点选：表格不连续多选<br>双击正文：改字 · Enter：句尾插新句、句中拆分<br>句首退格：并回上一句<br>MD / TXT / Word / 项目 JSON 直接拖进窗口即可导入<br>剪映导出的 SRT 字幕拖进来（或 ⇧⌘O）：每句换成真实时间码<br>素材可从访达拖到句子 / 共用画面 / 这个面板（txt、md 当素材请拖到右侧面板）<br>视频素材可设入点出点：预览里空格播放、I / O 设入出点<br>⌘F：搜索 · ⌘Z：撤销 · ⇧⌘Z：重做<br>⌘T：原文 / 表格 · ⌘L：切换主题 · ⌘+ / ⌘−：缩放<br>共用画面的句子同步类型、描述、素材与状态。</div>`,
    );
    markPopAnchor(e.currentTarget);
  };
  document.addEventListener('click', async e => {
    if (e.target.closest('#btnMultiMode')) {
      state.multiMode = !state.multiMode;
      state.sel = null;
      state.multi = null;
      closePop();
      update('selection');
      return;
    }
    const jump = e.target.closest('[data-jump]');
    if (jump) {
      if (reviewOpen) $('#closeReview').click();
      jumpTo(+jump.dataset.jump);
      return;
    }
    if (e.target.closest('#btnGroup')) {
      const ids = [...currentSelection()];
      if (!validGroup(state.rows, ids)) return;
      if (sameGroupSelection(state.rows, ids)) {
        toast('这些句子已经在同一个共用画面里');
        return;
      }
      confirmModal(
        '让这几句话共用一个画面？',
        '原文仍逐句保留，画面描述、素材和制作状态共用；类型采用选区中第一个已标类型。有差异的描述会合并保留，以后修改会同步到这些句子，可随时解除或调整范围。',
        '共用一个画面',
        () => {
          snapshot('共用画面');
          const members = groupRows(state.rows, ids);
          const selId = members ? members[0].id : ids[0];
          state.multiMode = false;
          state.multi = null;
          state.sel = selId;
          persist();
          update('rows');
          const selEl = document.querySelector(`.row[data-id="${selId}"],.as[data-id="${selId}"]`);
          (selEl?.closest('.shared-scene,.shared-passage') || selEl)?.scrollIntoView({ block: 'nearest' });
          toast('已设为共用画面');
        },
      );
      return;
    }
    if (e.target.closest('#btnUngroup')) {
      const groups = new Set(
        currentSelection()
          .map(id => rowById(id)?.groupId)
          .filter(Boolean),
      );
      if (!groups.size) return;
      snapshot('解除共用画面');
      state.rows.forEach(r => {
        if (groups.has(r.groupId)) delete r.groupId;
      });
      persist();
      update('rows');
      toast('已解除共用 · ⌘Z 可撤销');
      return;
    }
    const detail = e.target.closest('[data-detail]');
    if (detail) {
      state.sel = +detail.dataset.detail;
      state.multi = null;
      detailOpen = true;
      update('selection');
      renderInspector(true);
      return;
    }
    if (e.target.closest('#closeDetail')) {
      detailOpen = false;
      renderInspector();
      return;
    }
    if (e.target.closest('#saveDetail')) {
      saveDetail();
      return;
    }
    if (e.target.closest('#attachAsset')) {
      const pid = state.projectId,
        r = rowById(state.sel);
      const paths = await pickAssets();
      if (pid !== state.projectId || !r || !paths?.length) return;
      const res = addRefsToShot(r, paths);
      renderInspector(true);
      toast(res.added.length ? `已添加 ${res.added.length} 个素材 · ⌘Z 可撤销` : '这些素材都已关联过');
      return;
    }
    if (e.target.closest('#attachFromLib')) {
      const r = rowById(+$('#inspector').dataset.row || state.sel);
      const target = r && r.kind === 'line' ? r : rowById(state.sel);
      if (target) openAssetPicker(target);
      return;
    }
    const remove = e.target.closest('[data-remove-usage]');
    if (remove) {
      const r = rowById(+$('#inspector').dataset.row);
      if (!r) return;
      removeUsage(r, +remove.dataset.removeUsage);
      renderInspector(true);
      return;
    }
    const relocate = e.target.closest('[data-relocate-usage]');
    if (relocate) {
      const r = rowById(+$('#inspector').dataset.row);
      if (!r) return;
      await relocateFlow(r, +relocate.dataset.relocateUsage);
      renderInspector(true);
      return;
    }
    const clipBtn = e.target.closest('[data-clip-usage]');
    if (clipBtn) {
      const r = rowById(+$('#inspector').dataset.row);
      if (r) openPreview({ row: r, usageIndex: +clipBtn.dataset.clipUsage });
      return;
    }
    const pvBtn = e.target.closest('[data-preview-usage]');
    if (pvBtn) {
      const r = rowById(+$('#inspector').dataset.row);
      if (r) openPreview({ row: r, usageIndex: +pvBtn.dataset.previewUsage });
      return;
    }
    const sys = e.target.closest('[data-sys-open]');
    if (sys) {
      const error = await openAssetNative(sys.dataset.sysOpen);
      if (error) toast(error);
      return;
    }
    const retry = e.target.closest('[data-thumb-retry]');
    if (retry) {
      refreshThumb(retry.dataset.thumbRetry);
      return;
    }
    if (e.target.closest('#confirmReviewed')) {
      snapshot('核对改稿');
      setShotField(state.rows, rowById(state.sel), 'needsReview', false);
      persist();
      update('rows');
      renderInspector(true);
    }
  });
  $('#inspector').addEventListener('focusin', e => {
    if (e.target.matches('textarea,select')) fieldSession = null;
  });
  const persistField = e => {
    const panel = $('#inspector'),
      r = rowById(+panel.dataset.row);
    if (!r || panel.dataset.project !== state.projectId) return;
    const key = e.target.id;
    if (key === 'detailNote') {
      if ((r.note || '') === e.target.value) return;
      if (fieldSession !== key) {
        snapshot('编辑画面与素材');
        fieldSession = key;
      }
      setShotField(state.rows, r, 'note', e.target.value).forEach(x => {
        const note = document.querySelector(`.note[data-id="${x.id}"]`);
        if (note) note.textContent = x.note;
        updateCheckNote(x.id);
      });
      persist();
      renderStats();
      rowBadges();
      return;
    }
    if (key === 'detailAssets') {
      if (fieldSession !== key) {
        snapshot('编辑画面与素材');
        fieldSession = key;
      }
      setShotRefsFromText(r, e.target.value);
      persist();
      panel.querySelector('.asset-list').innerHTML = inspectorAssets(r, { missing: missingSet });
      hydrateAssetCards();
      rowBadges();
      return;
    }
    if (key === 'detailStatus') {
      if ((r.status || '') === e.target.value) return;
      if (fieldSession !== key) {
        snapshot('编辑画面与素材');
        fieldSession = key;
      }
      setShotField(state.rows, r, 'status', e.target.value);
      persist();
      rowBadges();
    }
  };
  $('#inspector').addEventListener('input', persistField);
  $('#inspector').addEventListener('change', persistField);
  // Note-column resize keeps both header and rows on the same grid.
  const handle = document.createElement('span');
  handle.className = 'column-resizer';
  handle.title = '拖动调整备注列宽';
  $('#thead').lastElementChild.append(handle);
  handle.onpointerdown = e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const start = e.clientX,
      w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--note-width')) || 250;
    handle.onpointermove = ev =>
      document.documentElement.style.setProperty(
        '--note-width',
        Math.max(160, Math.min(420, w + start - ev.clientX)) + 'px',
      );
    handle.onpointerup = () => {
      handle.onpointermove = null;
      localStorage.setItem(
        'fjz:noteWidth',
        getComputedStyle(document.documentElement).getPropertyValue('--note-width'),
      );
    };
  };
  const width = localStorage.getItem('fjz:noteWidth');
  if (/^\d+px$/.test(width || '')) document.documentElement.style.setProperty('--note-width', width);
}
