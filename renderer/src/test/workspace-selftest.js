import { viewState } from '../app/view-state.js';
import { usageList } from '../core/asset-model.js';
import { state } from '../app/state.js';
import { update } from '../app/project-events.js';
import { currentSelection } from '../app/selection.js';
import { types } from '../app/project-queries.js';
import { shotMembers, shots, checkDelivery } from '../core/shots.js';
import { parseAny } from '../core/parse.js';
import { undo, clearUndo } from '../app/undo.js';
import { setType, setNote, mergeToPrev } from '../app/actions.js';
import { addRefsToShot, removeUsage } from '../app/asset-actions.js';
import { renderInspector } from '../ui/inspector.js';
import { previewImport } from '../ui/import-export.js';
import { jumpTo, openReview } from '../ui/workspace.js';
import * as storage from '../app/storage.js';
import { runCommand } from '../ui/base/commands.js';
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
  {
    const view = 'table';
    viewState.view = view;
    update('rows');
    await pause(40);
    const wrap = $('#tableWrap');
    let navigationDetail;
    const firstLine = state.rows[state.rows.indexOf(sections[0]) + 1];
    const thirdLine = state.rows[state.rows.indexOf(sections[2]) + 1];
    viewState.sel = firstLine.id;
    update('selection');
    $(`.row[data-id="${thirdLine.id}"]`).scrollIntoView({ block: 'center' });
    await pause(80);
    t(
      `${view} 浏览到第3章时目录跟着高亮，选中句仍在第1章`,
      $('.outline-item.active')?.dataset.jump === String(sections[2].id) && viewState.sel === firstLine.id,
    );
    viewState.sel = thirdLine.id;
    update('selection');
    $(`.row[data-id="${firstLine.id}"]`).scrollIntoView({ block: 'center' });
    await pause(80);
    t(
      `${view} 浏览回第1章时目录跟着高亮，选中句仍在第3章`,
      $('.outline-item.active')?.dataset.jump === String(sections[0].id) && viewState.sel === thirdLine.id,
    );
    const atChapterStart = section => {
      const si = state.rows.indexOf(section);
      const firstLine = state.rows[si + 1];
      const el = $(`.row[data-id="${firstLine.id}"]`);
      const rect = el.getBoundingClientRect();
      const top = wrap.getBoundingClientRect().top + $('#thead').getBoundingClientRect().height;
      navigationDetail = JSON.stringify({
        selected: viewState.sel,
        first: firstLine.id,
        top: rect.top,
        bottom: rect.bottom,
        visibleTop: top,
        visibleBottom: wrap.getBoundingClientRect().bottom,
        scrollTop: wrap.scrollTop,
      });
      return viewState.sel === firstLine.id && rect.top >= top && rect.bottom <= wrap.getBoundingClientRect().bottom;
    };
    for (const index of [2, 0, 1, 1]) {
      const section = sections[index];
      if (index === 1 && viewState.sel === state.rows[state.rows.indexOf(section) + 1].id) {
        wrap.scrollTop += 500;
        await pause(40);
      }
      click(`#outline [data-jump="${section.id}"] span`);
      t(`${view} 点击第${index + 1}章立即切换目录高亮`, $('.outline-item.active')?.dataset.jump === String(section.id));
      await pause(100);
      t(`${view} 目录跳到第${index + 1}章开头`, atChapterStart(section), navigationDetail);
    }
    for (const index of [2, 0, 1, 2]) click(`#outline [data-jump="${sections[index].id}"] span`);
    await pause(120);
    t(
      `${view} 连续快速切章只停在最后点击的章节`,
      atChapterStart(sections[2]) && $('.outline-item.active')?.dataset.jump === String(sections[2].id),
      navigationDetail,
    );
    // 用户滚轮操作必须覆盖尚未完成的跳转校准，不能下一帧又被拉回首句。
    jumpTo(sections[1].id);
    await pause(120);
    jumpTo(sections[1].id);
    wrap.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    wrap.scrollTop += 240;
    const position = wrap.scrollTop;
    await pause(120);
    t(`${view} 跳转后开始滚动会取消迟后校准`, Math.abs(wrap.scrollTop - position) <= 2);
    viewState.filter = 'a';
    viewState.multi = [viewState.sel];
    update('rows');
    click(`#outline [data-jump="${sections[2].id}"]`);
    await pause(100);
    t(
      `${view} 目录跳转解除筛选并清空多选`,
      viewState.filter === 'all' && viewState.multi === null && atChapterStart(sections[2]),
      navigationDetail,
    );
  }
  storage.switchProject(original);
  storage.deleteProject(navigationProject);
  viewState.view = 'table';
  storage.createProject('新版工作流测试', parseAny('## 开场\n甲：“好。”乙。丙。\n## 后半段\n丁。戊。'));
  clearUndo();
  update('rows');
  const first = state.rows.find(r => r.kind === 'line').id;
  const second = first + 1,
    third = first + 2;
  t('章节目录显示所有有内容章节', $$('.outline-item').length === 2);
  setType([first], 'a');
  setType([second], 'real');
  viewState.sel = third;
  viewState.view = 'table';
  update('rows');
  t(
    '默认隐藏多选框',
    getComputedStyle($('.row-select')).display === 'none' && $('#selectionHeading').textContent === '#',
  );
  // 1.7.1：勾选框只看勾选集合——光标停着的那句不会被顺带勾上，勾光标那句也不会反而取消
  viewState.sel = third;
  viewState.multi = null;
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
  t('取消最后一句勾选后回到单选', viewState.multi === null && $('#selectTools').hidden);
  viewState.sel = first;
  update('selection');
  click(`[data-select="${first}"]`);
  t('勾光标所在的那句是勾上而不是取消', viewState.multi?.length === 1 && viewState.multi[0] === first);
  click('#btnClearSel');
  t('操作条「取消」清空勾选', viewState.multi === null && $('#selectTools').hidden);
  click(`[data-select="${first}"]`);
  click(`[data-select="${second}"]`);
  click('#btnGroup');
  click('#mOk');
  await pause(30);
  t('共用成功清空勾选并保住结果', viewState.multi === null && viewState.sel === first);
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
      $$('.shared-scene .note').length === 1,
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
  viewState.sel = first;
  viewState.multi = null;
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
    '移除素材紧邻添加素材，卡片不再放移除按钮',
    $('#attachAsset').nextElementSibling === $('#removeAsset') && !$('#inspector .asset-actions [data-remove-usage]'),
  );
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
  while (usageList(assetRow()).length) removeUsage(assetRow(), 0);
  addRefsToShot(assetRow(), ['/tmp/参考.png', '/tmp/样片.mp4']);
  renderInspector(true);
  t(
    '视频素材点缩略图预览（片段在预览里设），卡片上只有「不满意」',
    !!$('.asset-open[data-preview-usage]') &&
      !$('[data-clip-usage]') &&
      !$('[data-sys-open]') &&
      !!$('[data-rework-usage]') &&
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
  setNote(first, '从表格更新的画面描述');
  t('共用描述与素材面板保持同步', $('#detailNote')?.value === '从表格更新的画面描述');
  click('#btnDetail');
  viewState.sel = third;
  viewState.multi = null;
  update('selection');
  t('非共用句不显示解除共用', $('#btnUngroup').hidden === true);
  viewState.sel = first;
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
  const beforeTypes = state.rows.map(r => r.type);
  click('#filters [data-f="none"]');
  t('筛选后选区指向可见句子', !!document.querySelector(`.row[data-id="${viewState.sel}"]`));
  t('类型筛选不修改标注', JSON.stringify(state.rows.map(r => r.type)) === JSON.stringify(beforeTypes));
  setType([third], 'real');
  t('筛选中标注后移出未标列表', !document.querySelector(`.row[data-id="${third}"]`));
  viewState.filter = 'all';
  viewState.view = 'table';
  update('rows');
  jumpTo(second);
  await pause(500);
  storage.switchProject(original);
  storage.switchProject(storage.allProjects().find(p => p.title === '新版工作流测试').id);
  update('rows');
  t('切回项目恢复处理位置', viewState.sel === second);
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
    '改动句子不再标待核对',
    state.rows.some(r => r.text === '新句。' && !r.needsReview && !r.type),
  );
  t(
    '改稿后的镜头组仍可导出',
    shots(state.rows).length > 0 && !checkDelivery(state.rows).some(x => x.issues.includes('稿件更新待核对')),
  );
  // Save references without invoking system dialogs; verify native disk round trip.
  storage.persist(true);
  await pause(100);
  const disk = window.native.loadData();
  const saved = disk.projects[state.projectId];
  t(
    '新增字段完整落盘',
    saved.rows.some(r => r.assets?.includes('参考.png') && r.assetUsages?.length) && !!saved.assets,
  );
  // 视图切换：不提交的编辑不丢，定位不跳走
  viewState.view = 'table';
  viewState.filter = 'all';
  update('rows');
  await pause(30);
  const editRow = state.rows.find(r => r.kind === 'line');
  const sentEl = $(`.row[data-id="${editRow.id}"] .sent`);
  sentEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await pause(20);
  sentEl.textContent = '切换视图前改的字。';
  click('#viewToggle button[data-v="review"]');
  await pause(80);
  t(
    '切换视图前自动保存正在编辑的内容',
    state.rows.find(r => r.id === editRow.id)?.text === '切换视图前改的字。',
    state.rows.find(r => r.id === editRow.id)?.text,
  );
  t('切到审核保持当前句子定位', viewState.sel === editRow.id && viewState.view === 'review');
  t(
    '筛选与视图同步数据',
    JSON.stringify(state.rows.map(r => r.note)) === JSON.stringify(storage.current().rows.map(r => r.note)),
  );
  click('#viewToggle button[data-v="table"]');
  await pause(50);
  // A long draft must keep main content and controls inside a narrow desktop window.
  t(
    '工具条一行，不横向溢出',
    !document.querySelector('.selection-tools') && $('.work-tools').scrollWidth <= $('.work-tools').clientWidth + 1,
  );
  const toolLines = state.rows.filter(r => r.kind === 'line' && !r.groupId);
  viewState.sel = toolLines[0].id;
  viewState.multi = null;
  update('selection');
  await pause(20);
  t('1.7 只选一句时不弹选区操作条', $('#selectTools').hidden);
  viewState.multi = [toolLines[0].id, toolLines[1].id];
  update('selection');
  await pause(20);
  // 1.10：能共用时显示「共用一个画面」；不能共用（不连续 / 跨章节）时直接写原因，不摆灰按钮
  t(
    '1.7 选中两句后浮出操作条（共用按钮或不能共用的原因）',
    !$('#selectTools').hidden &&
      ($('#btnGroup').getBoundingClientRect().width > 0 || $('#selHint').getBoundingClientRect().width > 0),
  );
  t('1.10 操作条上有类型按钮', $$('#selTypes [data-sel-type]').length === types().list.length + 1);
  viewState.multi = null;
  update('selection');

  // 共用画面里移除一个素材：其余素材的逐句位置（off）不能被选中那一句的记录覆盖
  storage.createProject('移除与合并测试', parseAny('甲。乙。丙。丁。'));
  const [s1, s2, s3, s4] = state.rows.filter(r => r.kind === 'line');
  s1.groupId = s2.groupId = 'shot-selftest-remove';
  addRefsToShot(s1, ['/tmp/甲图.png', '/tmp/乙图.png']);
  const idA = s1.assetUsages[0].assetId;
  s2.assetUsages.find(u => u.assetId === idA).off = true; // 甲图只在第 1 句出现
  removeUsage(s1, 1); // 从第 1 句移除乙图
  t(
    '共用画面移除素材不改其余素材的逐句位置',
    s1.assetUsages.length === 1 &&
      s2.assetUsages.length === 1 &&
      !s1.assetUsages[0].off &&
      s2.assetUsages[0].off === true,
    JSON.stringify([s1.assetUsages, s2.assetUsages]),
  );
  // 合并句子：挂在被并掉那句上的视频候选改挂到合并后的句子
  state.candidates = [{ id: 'vc-selftest-merge', rowId: s4.id, decision: 'ok', url: 'https://x/a.mp4', in: 1, out: 2 }];
  mergeToPrev(s4.id);
  t('合并句子后视频候选跟到合并后的句子', state.candidates[0].rowId === s3.id);
  // 待返工：否掉了、一个都没通过的画面列在审核页「待返工」里
  state.candidates = [
    {
      id: 'vc-selftest-rw',
      rowId: s1.id,
      decision: 'no',
      decidedAt: Date.now(),
      url: 'https://x/b.mp4',
      in: 1,
      out: 2,
      title: '否掉的',
    },
  ];
  update('rows');
  runCommand('video:rework', s1.id);
  await pause(60);
  t(
    '待返工页列出否掉的画面',
    $('.vr-tab.on')?.dataset.vrTab === 'rework' && !!$('#vrNav [data-vr-rw]') && !!$('#vrList [data-vr-rw-note]'),
  );
  runCommand('video:close');
  await pause(30);
  state.candidates = [];
  update('rows');

  const created = storage
    .allProjects()
    .filter(p => p.id !== original)
    .map(p => p.id);
  storage.switchProject(original);
  for (const id of created) storage.deleteProject(id);
  viewState.view = 'table';
  viewState.filter = 'all';
  clearUndo();
  update('rows');
}
