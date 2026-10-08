/* 1.3 新功能回归（npm test 时由 selftest.js 调用）：
   重做 / 撤销回到原位 / ⌫ 与 ⌘⌫ / 弹窗栈 Esc / 搜索输入法 / 专注标注 / 剪映字幕对齐 / 拖入导入稿子 */
import { state, update } from '../app/state.js';
import * as storage from '../app/storage.js';
import { clearUndo, undo, redo, canRedo } from '../app/undo.js';
import * as actions from '../app/actions.js';
import { parseAny } from '../core/parse.js';
import { startSrtAlign } from '../features/srt.js';
import { clearTiming } from '../app/subtitle.js';
import { importDroppedFiles } from '../ui/asset-drop.js';
import { buildCsv } from '../core/export-doc.js';
import { anyModalOpen } from '../ui/modal.js';

const $ = s => document.querySelector(s);
const pause = ms => new Promise(r => setTimeout(r, ms));
const lines = () => state.rows.filter(r => r.kind === 'line');
const key = (k, opts = {}, el = document.activeElement || document.body) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

const SRT = `1
00:00:01,000 --> 00:00:03,000
第一句开场白

2
00:00:03,200 --> 00:00:06,000
第二句讲清楚问题所在

3
00:00:06,500 --> 00:00:09,000
第四句是结尾的总结`;

export async function runFeatureTests(t) {
  const original = state.projectId;
  storage.createProject(
    '1.3 功能测试',
    parseAny('## 开场\n第一句开场白。第二句讲清楚问题所在。\n## 结尾\n第三句这句没录。第四句是结尾的总结。'),
  );
  clearUndo();
  state.view = 'table';
  state.filter = 'all';
  update('rows');
  await pause(30);
  const L = n => lines()[n];

  /* ── 重做 ── */
  state.sel = L(0).id;
  actions.setType([L(0).id], 'real');
  undo();
  t('撤销后可以重做', canRedo() && !L(0).type);
  redo();
  t('重做恢复标注', L(0).type === 'real');
  undo();
  actions.setType([L(1).id], 'ai');
  t('有新改动后清空重做', !canRedo());
  clearUndo();

  /* ── 撤销回到改动的那一句 ── */
  state.sel = L(3).id;
  actions.setType([L(3).id], 'fx');
  state.sel = L(0).id;
  undo();
  t('撤销后光标回到改动的句子', state.sel === L(3).id, `sel=${state.sel}`);

  /* ── ⌫ 只清标注，⌘⌫ 才删句 ── */
  state.sel = L(1).id;
  state.multi = null;
  actions.setType([L(1).id], 'stock');
  document.activeElement?.blur();
  const n0 = lines().length;
  key('Backspace', {}, document.body);
  await pause(20);
  t('表格 ⌫ 清除标注、不删句子', lines().length === n0 && !L(1).type);
  key('Backspace', { metaKey: true }, document.body);
  await pause(20);
  t('⌘⌫ 删除句子', lines().length === n0 - 1);
  undo();
  await pause(20);
  t('删除可撤销', lines().length === n0);

  /* ── 弹窗栈：Esc 关最上层；以前没有 Esc 的素材库选择器也能关 ── */
  $('#assetPickerMask').classList.add('show');
  await pause(10);
  t('弹窗打开时登记为打开', anyModalOpen());
  key('Escape', {}, document.body);
  await pause(10);
  t('Esc 关闭素材库选择器', !$('#assetPickerMask').classList.contains('show'));
  $('#diffMask').classList.add('show');
  $('#modalMask').classList.add('show');
  await pause(10);
  key('Escape', {}, document.body);
  await pause(10);
  t('Esc 只关最上面一层', !$('#modalMask').classList.contains('show') && $('#diffMask').classList.contains('show'));
  key('Escape', {}, document.body);
  await pause(10);
  t('再按 Esc 关下一层', !$('#diffMask').classList.contains('show') && !anyModalOpen());

  /* ── 搜索：拼音组合中不触发搜索 ── */
  const inp = $('#searchInput');
  inp.value = 'di';
  inp.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
  await pause(220);
  t('输入法组合中不搜索', state.query === '');
  inp.value = '第四';
  inp.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  await pause(220);
  t('上屏后才搜索', state.query === '第四');
  inp.value = '';
  inp.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await pause(220);

  /* ── 专注标注 ── */
  for (const r of lines()) r.type = null;
  update('rows');
  state.sel = L(0).id;
  document.activeElement?.blur();
  key('e', { metaKey: true }, document.body);
  await pause(30);
  t('⌘E 打开专注标注', $('#focusMask').classList.contains('show') && $('.fc-text')?.textContent === L(0).text);
  key('2', {}, document.body);
  await pause(20);
  t('按 2 标注并跳到下一句', L(0).type === 'real' && $('.fc-text')?.textContent === L(1).text);
  key('r', {}, document.body);
  await pause(20);
  t('R 重复上一个类型', L(1).type === 'real' && $('.fc-text')?.textContent === L(2).text);
  key('z', { metaKey: true }, document.body);
  await pause(30);
  t('专注模式里 ⌘Z 撤销', !L(1).type);
  key('ArrowLeft', {}, document.body);
  await pause(10);
  key('Escape', {}, document.body);
  await pause(20);
  t(
    'Esc 退出并停在处理的句子',
    !$('#focusMask').classList.contains('show') && !state.focusMode && lines().some(r => r.id === state.sel),
  );

  /* ── 剪映字幕对齐 ── */
  startSrtAlign({ name: '测试.srt', content: SRT });
  await pause(20);
  t(
    '字幕对齐先出预览',
    $('#srtMask').classList.contains('show') && /对上 3/.test($('#srtSummary').textContent),
    $('#srtSummary').textContent,
  );
  $('#srtApply').click();
  await pause(30);
  t(
    '应用后每句有时间',
    lines().every(r => r.time) && Math.abs(L(0).time.start - 1) < 0.05 && Math.abs(L(3).time.end - 9) < 0.05,
    JSON.stringify(lines().map(r => r.time)),
  );
  t('没录的句子标为推算', L(2).time.st === 'est' && L(2).time.start >= L(1).time.end - 0.01);
  t(
    '表格显示时间码',
    $(`.row[data-id="${L(0).id}"] .dur .tc`)?.textContent === '00:01' && $('#durHeading').textContent === '时间码',
  );
  const csv = buildCsv({ title: 'x', rows: state.rows, registry: {}, missing: new Set() });
  t('CSV 带开始 / 结束时间', csv.includes('开始时间') && csv.includes('00:00:01.000'));
  t('项目记住字幕来源', state.timing?.name === '测试.srt' && state.timing.cues.length === 3);
  storage.persist(true);
  await pause(50);
  const saved = window.native.loadData().projects[state.projectId];
  t('字幕时间随项目保存', saved.timing?.cues?.length === 3 && saved.rows.some(r => r.time));
  actions.splitAt(L(1).id, 3);
  t('拆分对齐过的句子按字数分时间', L(1).time && L(2).time && Math.abs(L(1).time.end - L(2).time.start) < 0.001);
  undo();
  undo();
  t('对齐可撤销', !lines().some(r => r.time) && !state.timing);
  startSrtAlign({ name: '测试.srt', content: SRT }, { silent: true });
  clearTiming();
  t('清除字幕时间', !lines().some(r => r.time) && !state.timing);

  /* ── 拖入导入稿子（主进程读文件用替身） ── */
  window.fjtHooks = {
    ...(window.fjtHooks || {}),
    readScriptFile: async p => ({ name: '拖进来的稿子.docx', ext: 'docx', content: '## 第一章\n拖进来。第二句。' }),
  };
  const before = storage.allProjects().length;
  await importDroppedFiles([{ name: '拖进来的稿子.docx', path: '/tmp/拖进来的稿子.docx' }]);
  await pause(30);
  t(
    '拖入 docx 弹出导入预览',
    $('#importPreviewMask').classList.contains('show') && $('#importTitle').value === '拖进来的稿子',
  );
  $('#acceptImport').click();
  await pause(30);
  t(
    '确认后导入为新项目',
    storage.allProjects().length === before + 1 && state.title === '拖进来的稿子' && lines().length === 2,
  );
  window.fjtHooks.readScriptFile = async () => ({
    name: '剪映.srt',
    ext: 'srt',
    content: '1\n00:00:00,000 --> 00:00:02,000\n拖进来第二句',
  });
  await importDroppedFiles([{ name: '剪映.srt', path: '/tmp/剪映.srt' }]);
  await pause(20);
  t('拖入 SRT 走字幕对齐', $('#srtMask').classList.contains('show'));
  $('#srtCancel').click();
  window.fjtHooks.readScriptFile = async () => ({ error: '不支持导入 .exe 文件' });
  await importDroppedFiles([{ name: 'a.exe', path: '/tmp/a.exe' }]);
  await pause(10);
  t('读取失败给出原因', $('#toastTxt').textContent.includes('不支持'));
  delete window.fjtHooks.readScriptFile;

  // 收尾：回到原项目
  for (const p of storage.allProjects())
    if (p.title === '1.3 功能测试' || p.title === '拖进来的稿子') storage.deleteProject(p.id);
  if (original && storage.allProjects().some(p => p.id === original)) storage.switchProject(original);
  clearUndo();
  update('rows');
}
