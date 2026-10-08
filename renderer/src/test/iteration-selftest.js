/* 1.3.2 回归：自定义标注类型 / 口播音频与时间轴 / 连播预览 / 界面整理 */
import { state, update, types, timeline } from '../app/state.js';
import * as storage from '../app/storage.js';
import { undo, clearUndo } from '../app/undo.js';
import { setProjectTypes } from '../app/types-actions.js';
import { setVoice, clearVoice } from '../app/voice.js';
import { deleteRows, groupSelectionAction } from '../app/actions.js';
import { addRefsToShot, setUsageRole } from '../app/asset-actions.js';
import { usageList } from '../core/asset-model.js';
import { parseAny } from '../core/parse.js';
import { defaultTypes } from '../core/types.js';
import { runCommand } from '../ui/commands.js';
import { playthroughState } from '../features/playthrough.js';
import { inspectorAssets } from '../ui/badges.js';

const $ = s => document.querySelector(s),
  $$ = s => [...document.querySelectorAll(s)];
const pause = ms => new Promise(r => setTimeout(r, ms));
const lines = () => state.rows.filter(r => r.kind === 'line');
const key = (el, k, opts = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
const select = id => {
  state.sel = id;
  state.multi = null;
  update('selection');
};

export async function runIterationTests(t) {
  const original = state.projectId;
  const fx = window.native.fixtureInfo();
  storage.createProject(
    '1.3.2 测试',
    parseAny('## 开场\n第一句话在这里。第二句稍微长一点点。\n第三句。第四句话。\n## 结尾\n第五句。'),
  );
  clearUndo();
  state.view = 'table';
  update('rows');
  await pause(30);

  /* ── 自定义标注类型 ── */
  const MAP = { id: 't1', label: '地图', full: '地图动画', color: '#0e9aa7', icon: 'chart', visual: true };
  setProjectTypes([...defaultTypes(), MAP]);
  t('新类型出现在筛选条', $$('.chip-filter[data-f="t1"]').length === 1);
  t('类型列快捷键提示跟着变', $('#typeKeys').textContent === '1-6');
  document.activeElement?.blur?.();
  select(lines()[0].id);
  key(document.body, '6');
  await pause(20);
  t('第 6 个类型按 6 标注', lines()[0].type === 't1', `type=${lines()[0].type}`);
  const chip = $(`.row[data-id="${lines()[0].id}"] .tchip`);
  t(
    '类型标签用自定义短名和颜色，全名在悬停提示里',
    chip.textContent.includes('地图') && chip.title === '地图动画' && chip.style.getPropertyValue('--tc') === '#0e9aa7',
  );
  select(lines()[1].id);
  key(document.body, '3');
  t('默认类型照常', lines()[1].type === 'stock');
  // 删除正在用的「通用素材」，改成「真实素材」
  setProjectTypes(
    types().list.filter(x => x.id !== 'stock'),
    { remap: { stock: 'real' } },
  );
  t('删除类型时句子按选择改类型', lines()[1].type === 'real' && !types().has('stock'));
  t('删除后快捷键顺延', types().keyToType('5') === 't1');
  undo();
  t('类型修改可撤销（类型表和句子一起回来）', types().has('stock') && lines()[1].type === 'stock');

  // 编辑器界面：加一个类型、改名、保存
  runCommand('types:edit');
  t('类型编辑器打开', $('#typeEditorMask').classList.contains('show') && $$('.te-row').length === 6);
  $('#teAdd').click();
  const labels = $$('.te-label');
  labels[labels.length - 1].value = '字卡';
  $('#teSave').click();
  t('编辑器里新增类型并保存', types().list.length === 7 && types().list[6].label === '字卡');
  runCommand('types:edit');
  $$('.te-row')[types().list.findIndex(x => x.id === 'stock')].querySelector('[data-te="del"]').click();
  t('删掉用过的类型要先选去向', !!$('#teRemoved [data-remap]'));
  key($('#typeEditorMask'), 'Escape');
  t('Esc 关闭类型编辑器且不保存', !$('#typeEditorMask').classList.contains('show') && types().has('a'));

  // 原文视图和专注标注也认自定义类型
  state.view = 'check';
  update('rows');
  select(lines()[2].id);
  key(document.body, '6');
  t(
    '原文视图按 6 标注自定义类型',
    lines()[2].type === 't1' && $(`.as[data-id="${lines()[2].id}"]`).classList.contains('typed'),
  );
  state.view = 'table';
  update('rows');
  select(lines()[3].id);
  runCommand('focus:open');
  key(document.body, '7');
  t('专注标注里按 7 标第 7 个类型', lines()[3].type === types().list[6].id);
  key(document.body, 'Escape');

  /* ── 口播音频与时间轴 ── */
  t('没有口播时按语速估算', timeline().source === 'rate' && $('#voiceBar').hidden);
  const voicePath = fx?.hasVoice ? fx.dir + '/口播.wav' : '/tmp/不存在的口播.wav';
  setVoice(voicePath, 20);
  t('导入口播后按音频长度推算每句时间', timeline().source === 'fit' && Math.abs(timeline().total - 20) < 0.01);
  t('时长列显示可点击的时间码', !!$('.dur .tc[data-play]') && $('#durHeading').textContent === '≈时间码');
  t('口播条出现', !$('#voiceBar').hidden && !!$('#vbPlay'));
  const total = lines().reduce((s, r) => s + timeline().times.get(r.id).end - timeline().times.get(r.id).start, 0);
  t('各句时长加起来等于音频时长', Math.abs(total - 20) < 0.01);
  runCommand('inspector:open', lines()[1].id);
  await pause(20);
  t('画面面板显示这句对应的口播时间', !!$('.voice-block') && $('.voice-block').textContent.includes('按口播音频推算'));
  if (fx?.hasVoice) {
    await pause(400); // 等元数据：真实时长 8 秒会替换掉传进去的 20
    t('读到音频真实时长后时间轴跟着改', Math.abs(timeline().total - 8) < 0.2, `total=${timeline().total}`);
    const tc = $(`.row[data-id="${lines()[2].id}"] .tc[data-play]`);
    tc.click();
    await pause(500);
    const r2 = timeline().times.get(lines()[2].id);
    const audioT = $('#vbTime').textContent;
    t(
      '点时间码从这句开始播',
      !!$('.row.playing') && $('#vbPlay').dataset.state === 'playing',
      `${audioT} start=${r2.start}`,
    );
    runCommand('voice:toggle');
    await pause(50);
    t('空格 / 按钮暂停', $('#vbPlay').dataset.state === 'paused');
  } else t('口播播放（缺 ffmpeg，跳过）', true);

  /* ── 连播预览 ── */
  runCommand('playthrough:shot', lines()[4].id);
  await pause(60);
  t('对着口播看画面：打开预览并定位到这个镜头', $('#ptMask').classList.contains('show') && playthroughState().range);
  t('没关联素材的镜头显示画面描述卡', !!$('#ptStage .pt-card'));
  key(document.body, 'Escape');
  await pause(20);
  t('Esc 关闭连播预览', !$('#ptMask').classList.contains('show'));
  runCommand('playthrough:from', lines()[0].id);
  await pause(60);
  t('连播预览按镜头切分', playthroughState().units >= 4 && !playthroughState().range);
  key(document.body, 'ArrowRight');
  t('→ 跳到下一个镜头', playthroughState().current === 1);
  key(document.body, 'Escape');

  /* ── 1.8：一个镜头多个主画面 + 镜头轨调秒数 ── */
  if (fx?.dir) {
    const [g0, g1] = [lines()[0].id, lines()[1].id];
    groupSelectionAction([g0, g1]);
    const row0 = () => state.rows.find(r => r.id === g0);
    addRefsToShot(row0(), [
      fx.dir + '/样图.png',
      fx.dir + '/a-very-long-file-name-that-should-not-break-the-layout-图片素材名字特别长用来验证布局不被撑坏.png',
    ]);
    setUsageRole(row0(), 1, 'main');
    t('同一段设两个主画面，两个都是主画面', usageList(row0()).filter(u => u.role === 'main').length === 2);
    runCommand('playthrough:shot', g0);
    await pause(80);
    const lay = () => playthroughState().layout;
    t(
      '镜头轨：两个主画面各一个色块，默认平分这段',
      !$('#ptTrack').hidden &&
        $$('#ptTrack .ptt-block').length === 2 &&
        Math.abs(lay().items[0].end - lay().dur / 2) < 0.05 &&
        !lay().timed,
      JSON.stringify(lay()?.items.map(i => [i.start, i.end])),
    );
    if (playthroughState().playing) key(document.body, ' ');
    const scrubTo = f => {
      const ruler = $('#pttRuler');
      const rr = ruler.getBoundingClientRect();
      ruler.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: rr.left + rr.width * f }),
      );
      ruler.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    };
    const want = Math.round(lay().dur * 0.1 * 10) / 10;
    scrubTo(0.1);
    key(document.body, 'i');
    await pause(60);
    t(
      '刻度尺跳到 10% 处按 I：① 从这里开始，存成手动时间，组内每句一致，另一个画面也固定下来',
      lay().timed &&
        Math.abs(lay().items[0].start - want) <= 0.1 &&
        Math.abs((usageList(row0())[0].at?.start ?? -1) - want) <= 0.1 &&
        usageList(state.rows.find(r => r.id === g1))[0].at?.start === usageList(row0())[0].at?.start &&
        !!usageList(row0())[1].at,
      JSON.stringify([want, usageList(row0()).map(u => u.at)]),
    );
    t('手动模式出现「恢复按句子」，没有开始 / 结束输入框', !!$('#pttReset') && !$('.ptt-num'));
    t('有镜头轨时不显示上面那条总进度条', $('.pt-progress').hidden);
    t(
      '面板里每个主画面写着编号和出现秒数',
      /① 出现 \d+\.\d–\d+\.\d 秒/.test(inspectorAssets(row0())),
      inspectorAssets(row0()).slice(0, 300),
    );
    undo();
    await pause(60);
    t('⌘Z 撤销手动时间', !usageList(row0())[0].at && !lay().timed);
    scrubTo(0.2);
    key(document.body, 'o');
    await pause(60);
    t('按 O 设结束', lay().timed);
    $('#pttReset').click();
    await pause(60);
    t('恢复按句子：去掉所有手动时间', !usageList(row0()).some(u => u.at) && !lay().timed);
    // 1.8.1：「对着口播看画面」播完这个镜头接着播下一个
    if (playthroughState().playing) key(document.body, ' ');
    scrubTo(0.97);
    const r0 = playthroughState().range;
    key(document.body, ' ');
    await pause(700);
    const r1 = playthroughState().range;
    t(
      '播完这个镜头自动接着播下一个镜头',
      !!r0 && !!r1 && r1.start >= r0.end - 0.05 && playthroughState().playing,
      JSON.stringify([r0, r1]),
    );
    key(document.body, 'ArrowLeft');
    await pause(30);
    t('← 回到上一个镜头（单镜头预览里也能切）', playthroughState().range.start === r0.start);
    key(document.body, 'Escape');
    await pause(20);
  } else t('镜头轨（缺测试素材，跳过）', true);

  clearVoice();
  t('移除口播后回到按语速估算', !state.voice && timeline().source === 'rate' && $('#voiceBar').hidden);
  undo();
  t('移除口播可撤销', !!state.voice);
  clearVoice();

  /* ── 界面整理 ── */
  // 表格备注：Shift+Enter 的换行不再被吞掉
  const note = $(`.note[data-id="${lines()[0].id}"]`);
  t('备注格是纯文本编辑', note.getAttribute('contenteditable') === 'plaintext-only');
  note.focus();
  note.innerText = '第一行\n第二行';
  note.dispatchEvent(new Event('input', { bubbles: true }));
  t('备注保留换行', lines()[0].note === '第一行\n第二行', JSON.stringify(lines()[0].note));
  note.blur();

  // toast 上的「撤销」按钮真的能撤销
  const n0 = lines().length;
  deleteRows([lines()[4].id]);
  t('删除句子后 toast 带撤销', $('#toastAct').style.display !== 'none');
  $('#toastAct').click();
  t('点 toast 上的撤销恢复句子', lines().length === n0);

  // 孤立标点：有才露出提示
  t('没有孤立标点时不显示修复提示', $('#repairHint').hidden);
  state.rows.push({ id: 999, kind: 'line', text: '”', note: '', type: null });
  update('rows');
  t('有孤立标点时出现修复提示', !$('#repairHint').hidden && $('#repairHint').textContent.includes('1'));
  state.rows.pop();
  update('rows');

  // 帮助面板
  key(document.body, '/', { metaKey: true });
  t(
    '⌘/ 打开快捷键面板（含本项目类型）',
    $('#helpMask').classList.contains('show') && $('#helpBody').textContent.includes('地图'),
  );
  key(document.body, 'Escape');
  t('Esc 关闭快捷键面板', !$('#helpMask').classList.contains('show'));

  /* ── 项目：最近删除 ── */
  const testId = state.projectId;
  const before = storage.trashList().length;
  storage.switchProject(original);
  storage.deleteProject(testId);
  t(
    '删除的项目进最近删除',
    storage.trashList().length === before + 1 && !storage.allProjects().some(p => p.id === testId),
  );
  storage.restoreFromTrash(testId);
  t('从最近删除找回项目（类型表一起回来）', storage.allProjects().find(p => p.id === testId)?.types?.length === 7);
  storage.deleteProject(testId);
  await pause(50);
  const disk = window.native.loadData();
  t('删除写进磁盘（增量保存）', !disk.projects[testId] && !!disk.trash?.[testId]);
  clearUndo();
  update('rows');
}
