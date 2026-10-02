import { state, update, currentSelection } from './state.js';
import { shotMembers, shots, checkDelivery } from './production.js';
import { parseAny } from './parse.js';
import { undo, clearUndo } from './undo.js';
import { setType, setNote, markSentences } from './actions.js';
import { previewImport } from './import-export.js';
import { jumpTo, nextUnmarked, openReview } from './workspace.js';
import { openDurPopover } from './popover.js';
import * as storage from './storage.js';
const $ = s => document.querySelector(s),
  $$ = s => [...document.querySelectorAll(s)];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const click = s => $(s).click();
const input = (s, value) => {
  const el = $(s);
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (s, k) => $(s).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
export async function runWorkspaceTests(t) {
  const original = state.projectId;
  storage.createProject('新版工作流测试', parseAny('## 开场\n甲：“好。”乙。丙。\n## 后半段\n丁。戊。'));
  clearUndo();
  update('rows');
  const first = state.rows.find(r => r.kind === 'line').id;
  const second = first + 1,
    third = first + 2;
  t('章节目录显示所有有内容章节', $$('.outline-item').length === 2);
  setType([first], 'a');
  state.sel = first;
  nextUnmarked();
  t('下一个未标注可定位', state.sel === second);
  state.autoAdvance = true;
  setType([second], 'real');
  t('可选自动跳转', state.sel === third);
  state.autoAdvance = false;
  state.view = 'table';
  update('rows');
  t(
    '默认隐藏多选框',
    getComputedStyle($('.row-select')).display === 'none' && $('#selectionHeading').textContent === '#',
  );
  click('#btnMultiMode');
  t('多选按钮显示勾选框', getComputedStyle($('.row-select')).display !== 'none');
  t('多选模式从空选区开始', state.multiMode && currentSelection().length === 0);
  t('空选区共用按钮置灰', $('#btnGroup').disabled && $('#btnGroup').title.includes('连续两句'));
  click(`[data-select="${first}"]`);
  click(`[data-select="${second}"]`);
  t(
    '逐句勾选即可启用合并',
    currentSelection().length === 2 && !$('#btnGroup').disabled && $$('.row-select:checked').length === 2,
  );
  click(`[data-select="${first}"]`);
  t('再次勾选可取消单句', currentSelection().length === 1 && currentSelection()[0] === second);
  click(`[data-select="${first}"]`);
  click('#btnMultiMode');
  t(
    '完成选择退出并清空勾选',
    !state.multiMode &&
      currentSelection().length === 0 &&
      !$$('.row-select:checked').length &&
      getComputedStyle($('.row-select')).display === 'none',
  );
  state.view = 'check';
  update('rows');
  click('#btnMultiMode');
  const selectSentence = id =>
    $(`.as[data-id="${id}"]`).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  selectSentence(first);
  selectSentence(second);
  t('原文多选逐句累加且不弹卡', currentSelection().length === 2 && $$('.as[aria-checked="true"]').length === 2);
  key(`.as[data-id="${first}"]`, ' ');
  t('原文空格键切换勾选', currentSelection().length === 1);
  key(`.as[data-id="${first}"]`, 'Enter');
  click('#btnGroup');
  click('#mOk');
  await pause(30);
  t('共用成功退出多选并保住结果', !state.multiMode && state.multi === null && state.sel === first);
  state.view = 'table';
  update('rows');
  t(
    '共用后收起勾选框',
    getComputedStyle($('.row-select')).display === 'none' && $('#selectionHeading').textContent === '#',
  );
  t(
    '共用画面有连续边框和句号范围',
    $$('.shared-scene-header').length === 1 &&
      $$('.shared-scene-row').length === 2 &&
      $$('.shared-scene-end').length === 1 &&
      $('.shared-scene-header').textContent.includes('第 1–2 句'),
  );
  t(
    '共用区只保留一套类型、状态与描述',
    $$('.shared-scene .typebox').length === 1 &&
      $$('.shared-scene .production-badge').length === 1 &&
      $$('.shared-scene .note').length === 1 &&
      !$('.shared-follow'),
  );
  t(
    '共用区保留类型竖线且与蓝框分开',
    $$('.shared-scene .spine').every(
      el =>
        getComputedStyle(el).display !== 'none' &&
        el.getBoundingClientRect().left - $('.shared-scene').getBoundingClientRect().left >= 16,
    ),
  );
  $('.shared-scene .note').focus();
  const fieldStyle = getComputedStyle($('.shared-scene .note'));
  t(
    '共用批注输入框有完整左边框和文字留白',
    parseFloat(fieldStyle.borderLeftWidth) >= 1 && parseFloat(fieldStyle.paddingLeft) >= 8,
  );
  $('.shared-scene .note').blur();
  click('.shared-scene .tchip');
  t('共享类型可以直接点击修改', !!$('.popover'));
  click('.popover .pop-item[data-t="stock"]');
  t(
    '共享类型点击后同步到所有句子',
    shotMembers(
      state.rows,
      state.rows.find(r => r.id === first),
    ).every(r => r.type === 'stock'),
  );
  t(
    '镜头分组保留两句原文',
    shotMembers(
      state.rows,
      state.rows.find(r => r.id === first),
    ).length === 2,
  );
  setType([second], 'ai');
  t(
    '组内类型同步',
    shotMembers(
      state.rows,
      state.rows.find(r => r.id === first),
    ).every(r => r.type === 'ai'),
  );
  setNote(second, '分组画面');
  t(
    '组内备注同步',
    shotMembers(
      state.rows,
      state.rows.find(r => r.id === first),
    ).every(r => r.note === '分组画面'),
  );
  state.sel = first;
  state.multi = null;
  update('selection');
  if ($('#inspector').hidden) click('#btnDetail');
  input('#detailNote', '镜头组新描述');
  t(
    '素材面板备注即时写入',
    shotMembers(
      state.rows,
      state.rows.find(r => r.id === first),
    ).every(r => r.note === '镜头组新描述'),
  );
  key('#detailNote', 'Backspace');
  t('表单退格不会删除句子', state.rows.filter(r => r.kind === 'line').length === 5);
  input('#detailAssets', '/tmp/参考.png\nhttps://example.com/video');
  $('#detailStatus').value = 'ready';
  $('#detailStatus').dispatchEvent(new Event('change', { bubbles: true }));
  t(
    '素材状态与引用同步到整组',
    shotMembers(
      state.rows,
      state.rows.find(r => r.id === first),
    ).every(r => r.status === 'ready' && r.assets.includes('参考.png') && r.assetUsages.length === 2),
  );
  click('#saveDetail');
  await pause(350);
  const center = el => {
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  };
  const aligned = () =>
    Math.abs(center($('.shared-scene-body')) - center($('.shared-scene-body>.typebox'))) < 2 &&
    Math.abs(center($('.shared-scene-body')) - center($('.shared-scene-body>.visual-cell'))) < 2;
  t('类型与素材在整组垂直居中', aligned());
  document.body.classList.add('multi-mode');
  t(
    '多选时共享布局仍居中且原文占三列',
    aligned() &&
      $('.shared-scene .dur').getBoundingClientRect().right <
        $('.shared-scene-body>.typebox').getBoundingClientRect().left &&
      $('.shared-scene .sent').getBoundingClientRect().right < $('.shared-scene .dur').getBoundingClientRect().left,
  );
  document.body.classList.remove('multi-mode');
  t(
    '表格直接显示对应素材名称',
    $('.shared-scene .row-assets').textContent.includes('参考.png') && $$('.shared-scene .row-assets').length === 1,
  );
  click('[data-remove-usage="0"]');
  t(
    '移除单个素材保留其他引用并同步整组',
    shotMembers(
      state.rows,
      state.rows.find(r => r.id === first),
    ).every(r => r.assetUsages.length === 1 && r.assets === 'https://example.com/video'),
  );
  t(
    '移除后面板与表格同步',
    !$('[data-remove-usage="0"][data-remove-ref]') && !$('.shared-scene .row-assets').textContent.includes('参考.png'),
  );
  undo();
  t(
    '撤销恢复整组素材关联',
    shotMembers(
      state.rows,
      state.rows.find(r => r.id === first),
    ).every(r => r.assets.includes('参考.png')),
  );
  input('#detailAssets', '/tmp/参考.png\n/tmp/样片.mp4');
  click('#saveDetail');
  t(
    '视频素材有预览和片段入口',
    !!$('.asset-open[data-preview-usage]') &&
      !!$('[data-clip-usage]') &&
      !!$('.asset-thumb[data-preview-path="/tmp/样片.mp4"]') &&
      [...$$('.inspector-asset')].some(el => el.textContent.includes('视频')),
  );
  click('[data-remove-usage="0"]');
  click('[data-remove-usage="0"]');
  t(
    '最后一份素材可移除并显示空状态',
    shotMembers(
      state.rows,
      state.rows.find(r => r.id === first),
    ).every(r => r.assets === '') && !!$('.asset-none'),
    'usages=' + state.rows.find(r => r.id === first).assetUsages.length + ' hidden=' + $('#inspector').hidden,
  );
  undo();
  undo();
  state.view = 'check';
  update('rows');
  setNote(first, '从原文更新的批注');
  t('原文共用画面将两句话围在同一区块', $$('.shared-passage').length === 1 && $$('.shared-passage .as').length === 2);
  const noteStyle = getComputedStyle($('.as-note'));
  t(
    '原文批注放大且为红色',
    parseFloat(noteStyle.fontSize) >= 20 && ['rgb(200, 45, 53)', 'rgb(255, 142, 148)'].includes(noteStyle.color),
  );
  t('原文批注与素材面板保持同步', $('#detailNote')?.value === '从原文更新的批注');
  t(
    '共用批注在原文整组末尾只出现一次',
    $$('.shared-passage .as-note').length === 1 &&
      $('.shared-passage').lastElementChild.classList.contains('shared-note'),
  );
  const down = el => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  down($('.shared-note'));
  click('.shared-note');
  t('共用批注可点击编辑', !!$('.shared-passage>.as-note-edit'));
  $('.as-note-edit').textContent = '只显示一次的新批注';
  key('.as-note-edit', 'Enter');
  t(
    '编辑共用批注同步整组且不重复',
    shotMembers(
      state.rows,
      state.rows.find(r => r.id === first),
    ).every(r => r.note === '只显示一次的新批注') && $$('.shared-passage .as-note').length === 1,
  );
  down($(`.as[data-id="${second}"]`));
  click(`[data-ck-note="${second}"]`);
  t(
    '从第二句编辑仍定位到组末同一批注',
    !!$('.shared-passage>.as-note-edit') &&
      $('.as-note-edit').dataset.edit === String(first) &&
      $('.shared-note').style.display === 'none',
  );
  key('.as-note-edit', 'Escape');
  setNote(second, '');
  t('清空共用批注移除唯一红字', $$('.shared-passage .as-note').length === 0);
  undo();
  t('撤销后批注仍只显示一次', $$('.shared-passage .as-note').length === 1);

  state.view = 'table';
  update('rows');
  click('#closeDetail');
  state.sel = third;
  state.multi = null;
  update('selection');
  t('非共用句不显示解除共用', $('#btnUngroup').hidden === true);
  state.sel = first;
  update('selection');
  t('共用句上出现解除共用', $('#btnUngroup').hidden === false);
  click('#btnUngroup');
  t('解除共用移除边框', $$('.shared-scene-header').length === 0 && $$('.shared-scene-row').length === 0);
  t(
    '解除分组保留描述及素材',
    !state.rows.find(r => r.id === first).groupId && state.rows.find(r => r.id === first).assets.includes('参考.png'),
  );
  undo();
  t('分组操作可撤销', !!state.rows.find(r => r.id === first).groupId);
  click('#btnMultiMode');
  click('#btnMultiMode');
  t('完成选择不影响已建共用', !!state.rows.find(r => r.id === first).groupId);
  state.view = 'check';
  update('rows');
  const beforeTypes = state.rows.map(r => r.type);
  click('#filters [data-f="none"]');
  t('筛选后选区指向可见句子', !!document.querySelector(`.as[data-id="${state.sel}"]`));
  t(
    '原文顶部是筛选，不会改类型',
    JSON.stringify(state.rows.map(r => r.type)) === JSON.stringify(beforeTypes) && $$('.as').length === 3,
  );
  state.sel = third;
  state.multi = null;
  update('selection');
  markSentences([third], 'real');
  t('原文筛选中标注后移出未标列表', $$('.as').length === 2);
  state.filter = 'all';
  state.view = 'table';
  update('rows');
  jumpTo(second);
  await pause(500);
  storage.switchProject(original);
  storage.switchProject(storage.allProjects().find(p => p.title === '新版工作流测试').id);
  update('rows');
  t('切回项目恢复处理位置', state.sel === second);
  openDurPopover($('#btnDur'));
  $('#speechRate').value = '3';
  click('#saveRate');
  t('自定义语速持久化', state.speechRate === 3 && storage.current().speechRate === 3);
  openReview();
  t('交稿检查显示缺项', $$('.review-item').length > 0);
  click('#closeReview');
  const count = storage.allProjects().length,
    previous = state.projectId;
  previewImport(parseAny('新导入。'), '导入测试');
  t('导入默认另存项目', $('#importMode').value === 'new');
  click('#acceptImport');
  t(
    '确认导入保留旧项目',
    storage.allProjects().length === count + 1 && storage.allProjects().some(p => p.id === previous),
  );
  storage.switchProject(previous);
  update('rows');
  const oldFirst = state.rows.find(r => r.id === first),
    oldNote = oldFirst.note;
  previewImport(parseAny('## 开场\n甲：“好。”乙。新句。\n## 后半段\n丁。戊。'), '新版稿');
  $('#importMode').value = 'update';
  $('#importMode').dispatchEvent(new Event('change', { bubbles: true }));
  click('#acceptImport');
  t('改稿保留未变句子标注', state.rows.find(r => r.id === first)?.note === oldNote);
  t(
    '改稿前自动保留项目副本',
    storage.allProjects().some(p => p.title === '新版工作流测试 · 改稿前'),
  );
  t(
    '改动句子被标为待核对',
    state.rows.some(r => r.text === '新句。' && r.needsReview),
  );
  t(
    '改稿后的镜头组仍可导出',
    shots(state.rows).length > 0 && checkDelivery(state.rows).some(x => x.issues.includes('稿件更新待核对')),
  );
  // Save references without invoking system dialogs; verify native disk round trip.
  storage.persist(true);
  await pause(100);
  const disk = window.native.loadData();
  const saved = disk.projects[state.projectId];
  t(
    '新增字段完整落盘',
    saved.rows.some(r => r.assets?.includes('参考.png') && r.assetUsages?.length) &&
      saved.speechRate === 3 &&
      !!saved.assets,
  );
  // 视图切换：不提交的编辑不丢，定位不跳走
  state.view = 'table';
  state.filter = 'all';
  update('rows');
  await pause(30);
  const editRow = state.rows.find(r => r.kind === 'line');
  const sentEl = $(`.row[data-id="${editRow.id}"] .sent`);
  sentEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await pause(20);
  sentEl.textContent = '切换视图前改的字。';
  click('#viewToggle button[data-v="check"]');
  await pause(80);
  t(
    '切换视图前自动保存正在编辑的内容',
    state.rows.find(r => r.id === editRow.id)?.text === '切换视图前改的字。',
    state.rows.find(r => r.id === editRow.id)?.text,
  );
  t('切换视图保持当前句子定位', state.sel === editRow.id && !!$(`.as[data-id="${editRow.id}"]`));
  t(
    '筛选与视图同步数据',
    JSON.stringify(state.rows.map(r => r.note)) === JSON.stringify(storage.current().rows.map(r => r.note)),
  );
  click('#viewToggle button[data-v="table"]');
  await pause(50);
  // A long draft must keep main content and controls inside a narrow desktop window.
  t(
    '新版工具栏存在且可见',
    !document.querySelector('.selection-tools') &&
      $('#btnMultiMode').getBoundingClientRect().width > 0 &&
      $('#btnGroup').getBoundingClientRect().width > 0 &&
      $('#btnNext').getBoundingClientRect().width > 0 &&
      $('.work-tools').scrollWidth <= $('.work-tools').clientWidth + 1,
  );
  const created = storage
    .allProjects()
    .filter(p => p.id !== original)
    .map(p => p.id);
  storage.switchProject(original);
  for (const id of created) storage.deleteProject(id);
  state.view = 'table';
  state.filter = 'all';
  state.autoAdvance = false;
  clearUndo();
  update('rows');
}
