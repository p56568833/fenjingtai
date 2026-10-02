/* 共用画面范围调整自测：加入下一句 / 移出最后一句 / 从这句拆分 / 解除，
   覆盖章节边界、相邻另一组、差异确认、单句退化、重复建立拒绝、撤销还原、插入取消不破坏。 */
import { state, update } from './state.js';
import * as storage from './storage.js';
import { undo, clearUndo } from './undo.js';
import { parseAny } from './parse.js';
import { shotMembers } from './production.js';
import { insertAfter, dropIfEmpty, setNote } from './actions.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const pause = ms => new Promise(r => setTimeout(r, ms));
const click = s => {
  const el = typeof s === 'string' ? $(s) : s;
  if (el) el.click();
  return !!el;
};
const rowOf = id => state.rows.find(r => r.id === id);
const lines = () => state.rows.filter(r => r.kind === 'line');
const closeMenu = () => {
  if ($('.popover')) document.body.click();
};

export async function runGroupRangeTests(t) {
  const original = state.projectId;
  storage.createProject('共用范围测试', parseAny('## 上\n甲。乙。丙。丁。\n## 下\n戊。己。'));
  clearUndo();
  update('rows');
  await pause(30);
  const R = n => lines()[n];
  const group = ids => {
    state.multi = ids;
    state.sel = ids[0];
    state.multiMode = true;
    update('selection');
    click('#btnGroup');
    click('#mOk');
  };

  /* 章节边界：整章四句共用 → 没有下一句可加 */
  group([R(0).id, R(1).id, R(2).id, R(3).id]);
  await pause(50);
  const gAll = () => rowOf(R(0).id).groupId;
  t('共用画面建立成功', !!gAll() && shotMembers(state.rows, rowOf(R(0).id)).length === 4);
  click(`[data-group-more="${gAll()}"]`);
  await pause(30);
  t(
    '共用区「···」提供三件套',
    !!$('[data-shot-act="extend-next"]') && !!$('[data-shot-act="drop-last"]') && !!$('[data-shot-act="ungroup"]'),
  );
  t(
    '章节末尾禁用加入下一句并说明原因',
    $('[data-shot-act="extend-next"]').classList.contains('disabled') &&
      $('[data-shot-act="extend-next"]').textContent.includes('章节'),
    $('[data-shot-act="extend-next"]').textContent,
  );
  closeMenu();
  click(`[data-group-more="${gAll()}"]`);
  click('[data-shot-act="ungroup"]');
  await pause(40);

  /* 甲乙丙共用；无差异时直接把丁加入 */
  group([R(0).id, R(1).id, R(2).id]);
  await pause(50);
  const g2 = () => rowOf(R(0).id).groupId;
  click(`[data-group-more="${g2()}"]`);
  await pause(30);
  t(
    '同章下一句可加入（无差异直接执行）',
    !$('[data-shot-act="extend-next"]').classList.contains('disabled') &&
      $('[data-shot-act="extend-next"]').textContent.includes('第 4 句'),
  );
  click('[data-shot-act="extend-next"]');
  await pause(50);
  t('下一句加入共用画面', shotMembers(state.rows, rowOf(R(0).id)).length === 4);
  undo();
  await pause(40);
  t('加入一次撤销完整还原', shotMembers(state.rows, rowOf(R(0).id)).length === 3 && !rowOf(R(3).id).groupId);

  /* 规则 4：有差异先展示差异和处理方式 */
  setNote(R(0).id, '共同描述');
  await pause(20);
  rowOf(R(3).id).note = '特写';
  rowOf(R(3).id).type = 'fx';
  storage.persist();
  click(`[data-group-more="${g2()}"]`);
  await pause(30);
  click('[data-shot-act="extend-next"]');
  await pause(40);
  t('有差异先弹差异说明', $('#diffMask').classList.contains('show') && $('#diffBody').textContent.includes('画面描述'));
  t('差异弹窗标明处理方式（合并保留）', $('#diffBody').textContent.includes('都保留'));
  click('#diffOk');
  await pause(50);
  t('确认后加入并合并差异', rowOf(R(3).id).groupId === g2() && rowOf(R(0).id).note === '共同描述\n特写');
  undo();
  await pause(40);
  t('差异加入也能一次撤销', !rowOf(R(3).id).groupId && rowOf(R(0).id).note === '共同描述');

  /* 规则 5：移出最后一句，副本保留、后续互不影响 */
  click(`[data-group-more="${g2()}"]`);
  await pause(30);
  click('[data-shot-act="drop-last"]');
  await pause(50);
  const out = rowOf(R(2).id);
  t('最后一句移出并保留副本', !out.groupId && out.note === '共同描述');
  out.note = '独立改';
  await pause(20);
  t('移出后编辑互不影响', rowOf(R(0).id).note === '共同描述');
  undo();
  await pause(40);
  t('移出可撤销', rowOf(R(2).id).groupId === g2());

  /* 规则 6/7：从这句开始使用另一个画面；单句退化 */
  click(`[data-row-more="${R(1).id}"]`);
  await pause(30);
  t(
    '组内句子「···」提供拆分入口',
    !!$('[data-shot-act="split-at"]') &&
      $('[data-shot-act="split-at"]').textContent.includes('从这句开始使用另一个画面'),
  );
  click('[data-shot-act="split-at"]');
  await pause(50);
  t(
    '拆分后前后两部分各自成立',
    !rowOf(R(0).id).groupId &&
      rowOf(R(1).id).groupId &&
      rowOf(R(1).id).groupId === rowOf(R(2).id).groupId &&
      rowOf(R(1).id).groupId !== g2(),
  );
  t('单句部分自动独立不带外框', $$('.shared-scene').length === 1);
  t('拆分保留画面信息', rowOf(R(0).id).note === '共同描述' && rowOf(R(1).id).note === '共同描述');
  undo();
  await pause(40);
  t('拆分一次撤销完整还原', rowOf(R(0).id).groupId === g2() && shotMembers(state.rows, rowOf(R(0).id)).length === 3);

  click(`[data-row-more="${R(0).id}"]`);
  await pause(30);
  t(
    '首句拆分禁用并说明原因',
    $('[data-shot-act="split-at"]').classList.contains('disabled') &&
      $('[data-shot-act="split-at"]').textContent.includes('第一句'),
  );
  closeMenu();
  click(`[data-row-more="${R(2).id}"]`);
  await pause(30);
  t(
    '末句拆分指向移出操作',
    $('[data-shot-act="split-at"]').classList.contains('disabled') &&
      $('[data-shot-act="split-at"]').textContent.includes('最后一句'),
  );
  closeMenu();

  /* 规则 3：相邻另一共用画面不能吞并 */
  click(`[data-group-more="${g2()}"]`);
  click('[data-shot-act="ungroup"]');
  await pause(40);
  group([R(0).id, R(1).id]);
  await pause(40);
  group([R(2).id, R(3).id]);
  await pause(40);
  const gA = rowOf(R(0).id).groupId,
    gB = rowOf(R(2).id).groupId;
  t('两个相邻共用画面并存', !!gA && !!gB && gA !== gB);
  click(`[data-group-more="${gA}"]`);
  await pause(30);
  t(
    '下一句属于另一组时禁用并解释',
    $('[data-shot-act="extend-next"]').classList.contains('disabled') &&
      $('[data-shot-act="extend-next"]').textContent.includes('另一个共用画面'),
  );
  closeMenu();

  /* 规则 8：同组选区不重复建立、状态不重置 */
  rowOf(R(0).id).status = 'ready';
  rowOf(R(1).id).status = 'ready';
  storage.persist();
  state.multi = [R(0).id, R(1).id];
  state.sel = R(0).id;
  update('selection');
  await pause(30);
  t('同组选区拒绝重复建立', $('#btnGroup').disabled && $('#btnGroup').title.includes('已经在同一个共用画面'));
  t('制作状态不被重置', rowOf(R(0).id).status === 'ready' && rowOf(R(1).id).status === 'ready');

  /* 规则 11：组内插入空句再取消，原共用关系完整恢复 */
  const beforeLen = shotMembers(state.rows, rowOf(R(0).id)).length;
  const nid = insertAfter(R(0).id);
  await pause(40);
  t(
    '组内插入的空句归入共用画面',
    !!rowOf(nid) && rowOf(nid).groupId === gA && shotMembers(state.rows, rowOf(nid)).length === beforeLen + 1,
  );
  dropIfEmpty(nid);
  await pause(40);
  t(
    '取消插入后原共用关系完整恢复',
    shotMembers(state.rows, rowOf(R(0).id)).length === beforeLen && rowOf(R(0).id).groupId === gA,
  );

  /* 解除共用：保留信息、可撤销 */
  click(`[data-group-more="${gA}"]`);
  await pause(20);
  click('[data-shot-act="ungroup"]');
  await pause(40);
  t('解除共用保留信息', !rowOf(R(0).id).groupId && rowOf(R(0).id).note === '共同描述');
  undo();
  await pause(40);
  t('解除共用可撤销', rowOf(R(0).id).groupId === gA);

  /* 原文视图同一套入口、同一套名称 */
  state.view = 'check';
  update('rows');
  await pause(40);
  t('原文视图共用区也有「···」', !!$('.shared-passage [data-group-more]'));
  click($('.shared-passage [data-group-more]'));
  await pause(30);
  t(
    '原文菜单与表格同一套名称',
    !!$('[data-shot-act="extend-next"]') &&
      !!$('[data-shot-act="drop-last"]') &&
      !!$('[data-shot-act="ungroup"]') &&
      $('[data-shot-act="extend-next"]').textContent.includes('将下一句加入这个画面'),
  );
  closeMenu();
  state.view = 'table';
  update('rows');
  await pause(30);

  /* 清场 */
  const created = storage
    .allProjects()
    .filter(p => p.id !== original)
    .map(p => p.id);
  storage.switchProject(original);
  for (const id of created) storage.deleteProject(id);
  state.multi = null;
  state.multiMode = false;
  clearUndo();
  update('rows');
  await pause(30);
}
