import { state, update, currentSelection, types } from '../app/state.js';
import { shotMembers, shots, checkDelivery } from '../core/shots.js';
import { parseAny } from '../core/parse.js';
import { undo, clearUndo } from '../app/undo.js';
import { setType, setNote, markSentences } from '../app/actions.js';
import { addRefsToShot, setShotRefsFromText } from '../app/asset-actions.js';
import { renderInspector } from '../ui/inspector.js';
import { previewImport } from '../ui/import-export.js';
import { jumpTo, nextUnmarked, openReview } from '../ui/workspace.js';
import { openDurPopover } from '../ui/popover.js';
import { setMultiMode } from '../ui/toolbar.js';
import * as storage from '../app/storage.js';
const $ = s => document.querySelector(s),
  $$ = s => [...document.querySelectorAll(s)];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// 1.7.1 起界面上没有「多选句子」开关了，逐句点选模式只在自测里直接切
const toggleMultiMode = () => setMultiMode(!state.multiMode);
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
  // 长稿才能复现：已经吸顶的标题不再位于章节开头，目录仍须能向前跳和重新定位。
  storage.createProject(
    '章节跳转测试',
    parseAny(
      [1, 2, 3]
        .map(n => `## 第${n}章\n` + Array.from({ length: 40 }, (_, i) => `第${n}章第${i + 1}句测试正文。`).join('\n'))
        .join('\n'),
    ),
  );
  const navigationProject = state.projectId;
  const sections = state.rows.filter(r => r.kind === 'section');
  for (const view of ['table', 'check']) {
    state.view = view;
    update('rows');
    await pause(40);
    const wrap = $('#tableWrap');
    let navigationDetail;
    const firstLine = state.rows[state.rows.indexOf(sections[0]) + 1];
    const thirdLine = state.rows[state.rows.indexOf(sections[2]) + 1];
    state.sel = firstLine.id;
    update('selection');
    $(`.row[data-id="${thirdLine.id}"],.as[data-id="${thirdLine.id}"]`).scrollIntoView({ block: 'center' });
    await pause(80);
    t(
      `${view} 浏览到第3章时目录跟着高亮，选中句仍在第1章`,
      $('.outline-item.active')?.dataset.jump === String(sections[2].id) && state.sel === firstLine.id,
    );
    state.sel = thirdLine.id;
    update('selection');
    $(`.row[data-id="${firstLine.id}"],.as[data-id="${firstLine.id}"]`).scrollIntoView({ block: 'center' });
    await pause(80);
    t(
      `${view} 浏览回第1章时目录跟着高亮，选中句仍在第3章`,
      $('.outline-item.active')?.dataset.jump === String(sections[0].id) && state.sel === thirdLine.id,
    );
    const atChapterStart = section => {
      const si = state.rows.indexOf(section);
      const firstLine = state.rows[si + 1];
      const el = $(`.row[data-id="${firstLine.id}"],.as[data-id="${firstLine.id}"]`);
      const rect = el.getBoundingClientRect();
      const top = wrap.getBoundingClientRect().top + $('#thead').getBoundingClientRect().height;
      navigationDetail = JSON.stringify({
        selected: state.sel,
        first: firstLine.id,
        top: rect.top,
        bottom: rect.bottom,
        visibleTop: top,
        visibleBottom: wrap.getBoundingClientRect().bottom,
        scrollTop: wrap.scrollTop,
      });
      return state.sel === firstLine.id && rect.top >= top && rect.bottom <= wrap.getBoundingClientRect().bottom;
    };
    for (const index of [2, 0, 1, 1]) {
      const section = sections[index];
      if (index === 1 && state.sel === state.rows[state.rows.indexOf(section) + 1].id) {
        wrap.scrollTop += 500;
        await pause(40);
      }
      click(`#outline [data-jump="${section.id}"] span`);
      await pause(60);
      t(`${view} 目录跳到第${index + 1}章开头`, atChapterStart(section), navigationDetail);
    }
    state.filter = 'a';
    state.multi = [state.sel];
    update('rows');
    click(`#outline [data-jump="${sections[2].id}"]`);
    await pause(60);
    t(
      `${view} 目录跳转解除筛选并清空多选`,
      state.filter === 'all' && state.multi === null && atChapterStart(sections[2]),
      navigationDetail,
    );
  }
  storage.switchProject(original);
  storage.deleteProject(navigationProject);
  state.view = 'table';
  storage.createProject('新版工作流测试', parseAny('## 开场\n甲：“好。”乙。丙。\n## 后半段\n丁。戊。'));
  clearUndo();
  update('rows');
  const first = state.rows.find(r => r.kind === 'line').id;
  const second = first + 1,
    third = first + 2;
  t('章节目录显示所有有内容章节', $$('.outline-item').length === 2);
  setType([first], 'a');
  t('空画面右上角不再显示加号', !$('.asset-empty'));
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
  toggleMultiMode();
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
  toggleMultiMode();
  t(
    '完成选择退出并清空勾选',
    !state.multiMode &&
      currentSelection().length === 0 &&
      !$$('.row-select:checked').length &&
      getComputedStyle($('.row-select')).display === 'none',
  );
  // 1.7.1：勾选框只看勾选集合——光标停着的那句不会被顺带勾上，勾光标那句也不会反而取消
  state.sel = third;
  state.multi = null;
  update('selection');
  t('光标所在句的勾选框不显示为已勾', !$(`[data-select="${third}"]`).checked);
  click(`[data-select="${first}"]`);
  t(
    '勾第一句只勾这一句，勾立即显示',
    currentSelection().length === 1 &&
      currentSelection()[0] === first &&
      $(`[data-select="${first}"]`).checked &&
      getComputedStyle($(`[data-select="${first}"]`)).display !== 'none' &&
      !$('#selectTools').hidden,
  );
  click(`[data-select="${first}"]`);
  t('取消最后一句勾选后回到单选', state.multi === null && $('#selectTools').hidden);
  state.sel = first;
  update('selection');
  click(`[data-select="${first}"]`);
  t('勾光标所在的那句是勾上而不是取消', state.multi?.length === 1 && state.multi[0] === first);
  click('#btnClearSel');
  t('操作条「取消」清空勾选', state.multi === null && $('#selectTools').hidden);
  state.view = 'check';
  update('rows');
  toggleMultiMode();
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
  $('#detailNote').blur();
  const assetRow = () => state.rows.find(r => r.id === first);
  addRefsToShot(assetRow(), ['/tmp/参考.png', 'https://example.com/video']);
  renderInspector(true);
  t(
    '素材面板已精简指定入口',
    !$('#locateDetail') && !$('#closeDetail') && !$('#attachFromLib') && !$('#relinkFolder') && !$('#detailAssets'),
  );
  t(
    '移除素材紧邻添加素材，卡片不再放移除按钮',
    $('#attachAsset').nextElementSibling === $('#removeAsset') && !$('#inspector .asset-actions [data-remove-usage]'),
  );
  t('面板里不再有制作状态', !$('#detailStatus'));
  t(
    '素材引用同步到整组',
    shotMembers(
      state.rows,
      state.rows.find(r => r.id === first),
    ).every(r => r.assets.includes('参考.png') && r.assetUsages.length === 2),
  );
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
  click('#removeAsset');
  t(
    '多个素材先列出名称，打开菜单不会移除素材',
    !!$('.popover [data-remove-usage="0"]') &&
      $('.popover').textContent.includes('参考.png') &&
      assetRow().assetUsages.length === 2,
  );
  click('.popover [data-remove-usage="0"]');
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
  setShotRefsFromText(assetRow(), '/tmp/参考.png\n/tmp/样片.mp4');
  renderInspector(true);
  t(
    '视频素材有预览和片段入口',
    !!$('.asset-open[data-preview-usage]') &&
      !!$('[data-clip-usage]') &&
      !!$('.asset-thumb[data-preview-path="/tmp/样片.mp4"]') &&
      [...$$('.inspector-asset')].some(el => el.textContent.includes('视频')),
  );
  click('#removeAsset');
  click('.popover [data-remove-usage="0"]');
  click('#removeAsset');
  t(
    '最后一份素材可移除并显示空状态',
    shotMembers(
      state.rows,
      state.rows.find(r => r.id === first),
    ).every(r => r.assets === '') &&
      !!$('.asset-none') &&
      $('#removeAsset').disabled,
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
  click('#btnDetail');
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
  toggleMultiMode();
  toggleMultiMode();
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
  const hasTodo = state.rows.some(r => r.kind === 'line' && !r.type);
  t(
    '1.7 工具条一行：没有多余的多选开关，标注工具只在有未标注时出现，不横向溢出',
    !document.querySelector('.selection-tools') &&
      !$('#btnMultiMode') &&
      $('#btnNext').getBoundingClientRect().width > 0 === hasTodo &&
      $('.work-tools').scrollWidth <= $('.work-tools').clientWidth + 1,
  );
  const toolLines = state.rows.filter(r => r.kind === 'line' && !r.groupId);
  state.sel = toolLines[0].id;
  state.multi = null;
  update('selection');
  await pause(20);
  t('1.7 只选一句时不弹选区操作条', $('#selectTools').hidden);
  state.multi = [toolLines[0].id, toolLines[1].id];
  update('selection');
  await pause(20);
  // 1.10：能共用时显示「共用一个画面」；不能共用（不连续 / 跨章节）时直接写原因，不摆灰按钮
  t(
    '1.7 选中两句后浮出操作条（共用按钮或不能共用的原因）',
    !$('#selectTools').hidden &&
      ($('#btnGroup').getBoundingClientRect().width > 0 || $('#selHint').getBoundingClientRect().width > 0),
  );
  t('1.10 操作条上有类型按钮', $$('#selTypes [data-sel-type]').length === types().list.length + 1);
  state.multi = null;
  update('selection');
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
