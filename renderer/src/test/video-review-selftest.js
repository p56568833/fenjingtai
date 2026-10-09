/* 1.5 视频审核自测：导入候选清单（不新建项目）、按句号对上画面、通过 → 主画面 + 片段 + 画面描述来源行、
   同一画面再通过的也当主画面、撤回、不要 / 清除、写回候选清单、只保存那几秒、完整原片要确认、撤销、切项目保留。
   原生能力全部用 window.fjtHooks 替身，不碰网络和磁盘。 */
import { state, update } from '../app/state.js';
import * as storage from '../app/storage.js';
import { undo, clearUndo } from '../app/undo.js';
import { parseAny } from '../core/parse.js';
import { usageList } from '../core/asset-model.js';
import { addRefsToShot } from '../app/asset-actions.js';
import { setType } from '../app/actions.js';
import { importLoadedFile } from '../ui/import-export.js';
import { flushWriteBack, tagOldSavedClips } from '../features/video-review.js';
import { parseLines, parseClock, planImport, lineTag } from '../core/candidates.js';
import { confirmModal } from '../ui/dom.js';
import { anyModalOpen, topModal, menuAllowed } from '../ui/modal.js';
import { setView } from '../ui/render.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const pause = ms => new Promise(r => setTimeout(r, ms));
const click = s => {
  const el = typeof s === 'string' ? $(s) : s;
  if (el) el.click();
  return !!el;
};
const lines = () => state.rows.filter(r => r.kind === 'line');
const us = (n = 0) => usageList(lines()[n]);
const cand = key => state.candidates.find(c => c.key === key);
const card = key => $(`[data-vr-id="${cand(key)?.id}"]`);
const btn = (key, d) => card(key)?.querySelector(`[data-vr-d="${d}"]`);

const DOC = {
  type: 'fenjingtai-candidates',
  version: 1,
  project: '视频审核测试',
  shots: [
    {
      lines: '1-3',
      label: '屠宰场',
      cands: [
        {
          key: 'A1',
          title: '福特肉类加工 1922',
          url: 'https://archive.org/download/fc-fc-485/fc-fc-485.mp4',
          page: 'https://archive.org/details/fc-fc-485',
          in: 101,
          out: 110,
          license: '公有领域',
          why: '流水线上的牛肉',
        },
        { key: 'A2', title: '赶牛', url: 'https://upload.wikimedia.org/x/cattle.webm', in: '0:15', out: '0:30' },
        { key: 'A3', title: '坏的', url: 'ftp://nope', in: 1, out: 2 },
      ],
    },
    {
      lines: '4',
      label: '实验室',
      cands: [{ key: 'B1', title: '白喉抗毒素', url: 'https://x.org/d.mp4', in: 960, out: 1050 }],
    },
    { lines: '99', cands: [{ key: 'Z1', title: '对不上', url: 'https://x.org/z.mp4', in: 1, out: 2 }] },
  ],
};

export async function runVideoReviewTests(t) {
  /* 纯函数 */
  t(
    '句号与时间的写法都认',
    parseLines('101–103').from === 101 &&
      parseLines('101-103').to === 103 &&
      parseLines(7).to === 7 &&
      parseClock('1:41') === 101 &&
      parseClock(12.5) === 12.5 &&
      Number.isNaN(parseClock('abc')),
  );
  t('不是候选清单的 JSON 不当候选导入', !!planImport({ v: 2 }, '', [], []).error);

  const original = state.projectId;
  const writes = [],
    saves = [],
    originals = [];
  let ffmpegMissing = false;
  window.fjtHooks = {
    ...(window.fjtHooks || {}),
    writeCandidateReview: async (file, results) => (writes.push({ file, results }), { ok: true }),
    pickFolder: async () => '/tmp/视频素材',
    saveVideoSegment: async o =>
      ffmpegMissing
        ? {
            ok: false,
            needFfmpeg: true,
            error: '这台电脑上没找到 ffmpeg。在「终端」里运行 brew install ffmpeg 装好后再试。',
          }
        : (saves.push(o), { ok: true, path: `/tmp/视频素材/${o.name}_1m41s-1m50s.mp4` }),
    downloadOriginalVideo: async o => (originals.push(o), { ok: true, path: '/tmp/视频素材/x_完整原片.mp4' }),
    revealAsset: async () => true,
  };
  storage.createProject('视频审核测试', parseAny('## 段\n甲。乙。丙。\n## 别的\n丁。'));
  const pid = state.projectId;
  clearUndo();
  state.view = 'table';
  update('rows');
  await pause(30);
  const ids = lines()
    .slice(0, 3)
    .map(r => r.id);
  state.multi = ids;
  state.sel = ids[0];
  state.multiMode = true;
  update('selection');
  click('#btnGroup');
  click('#mOk');
  state.multiMode = false;
  setType(ids, 'real');
  addRefsToShot(lines()[0], ['/tmp/原来的照片.jpg']);
  update('rows');
  await pause(30);
  t('先有一张照片当主画面', us(0)[0]?.role === 'main');
  t('没有候选时「视频审核」上不显示待审数', $('#vtBadge').hidden === true);

  /* 导入 */
  const file = { name: '视频候选.json', ext: 'json', content: JSON.stringify(DOC), path: '/tmp/视频候选.json' };
  importLoadedFile(file);
  await pause(60);
  t(
    '候选清单导入到当前项目，不新建项目',
    state.projectId === pid && state.candidates.length === 3,
    state.candidates.length,
  );
  t(
    '按句号对上画面，坏链接和对不上的句子跳过',
    cand('A1').rowId === ids[0] && cand('B1').rowId === lines()[3].id && !cand('A3') && !cand('Z1'),
  );
  t('「m:ss」写法的时间换算成秒', cand('A2').in === 15 && cand('A2').out === 30);
  t('导入后直接进入审核页面', !$('#reviewPage').hidden);
  t(
    '审核与表格共用视图状态，审核是主页面，表格整页收起',
    state.view === 'review' &&
      $('#reviewPage').matches('main') &&
      $('#tablePage').hidden &&
      !$('#reviewPage').matches('.modal-mask, .modal, [role="dialog"], [aria-modal]') &&
      !$('#reviewPage').querySelector('.modal'),
  );
  t(
    '审核不占弹窗栈，顶栏菜单按普通页面开放',
    !anyModalOpen() &&
      topModal() === null &&
      ['import', 'export:json', 'search', 'edit-types', 'import-srt'].every(menuAllowed),
  );
  const pageBox = $('#reviewPage').getBoundingClientRect();
  const headerBox = $('.topbar').getBoundingClientRect();
  t(
    '审核页面在顶栏下正常布局并占满剩余空间',
    Math.abs(pageBox.top - headerBox.bottom) <= 1 &&
      Math.abs(pageBox.bottom - innerHeight) <= 1 &&
      getComputedStyle($('#reviewPage')).position === 'static',
  );
  $('#vrImport').focus();
  const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  $('#vrImport').dispatchEvent(tabEvent);
  t('审核页不按弹窗方式拦截 Tab', !tabEvent.defaultPrevented);
  $('#vrImport').blur();
  setView('table');
  t('统一视图入口切到表格，审核页收起', state.view === 'table' && $('#reviewPage').hidden && !$('#tablePage').hidden);
  click('#viewToggle [data-v="review"]');
  t(
    '顶栏切回审核，原来的候选和批次仍在',
    state.view === 'review' && !$('#reviewPage').hidden && state.candidates.length === 3,
  );
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }));
  t(
    '审核页的全局搜索可用，并切到显示稿件结果的表格页',
    state.view === 'table' &&
      !$('#tablePage').hidden &&
      $('#searchbar').classList.contains('show') &&
      document.activeElement === $('#searchInput'),
  );
  click('#qClose');
  click('#viewToggle [data-v="review"]');
  t(
    '顶栏「视频审核」显示待审数，并处于选中状态',
    !$('#vtBadge').hidden &&
      $('#vtBadge').textContent === '3' &&
      $('#viewToggle [data-v="review"]').classList.contains('active'),
  );
  t(
    '左边按画面列出这一批（带待审数），右边只显示第一个画面的候选和口播原文',
    $$('#vrNav .vr-nav-shot').length === 2 &&
      $('#vrNav .vr-nav-shot.on')?.textContent.includes('2 待审') &&
      $$('#vrList .vr-shot').length === 1 &&
      $('#vrList .vr-vo')?.textContent.includes('甲。乙。丙。') &&
      !card('B1'),
  );
  t(
    '顶部写着这一批的进度',
    $('#vrSummary').textContent.includes('还剩 3 个待审') && $('#vrBatch').options.length === 1,
  );
  t(
    '每个候选有 6 格截图位、建议片段和版权',
    card('A1')?.querySelectorAll('.vr-cell').length >= 1 &&
      card('A1').textContent.includes('01:41–01:50') &&
      card('A1').textContent.includes('公有领域'),
  );
  t(
    '播放器默认不加载（不下载）',
    $$('#vrList video.vr-player').every(v => !v.getAttribute('src')),
  );

  importLoadedFile(file);
  await pause(30);
  t('同一份清单再导入只更新，不重复', state.candidates.length === 3);

  /* 审核页直接拖入候选 JSON，不能被误认成弹窗；真正的确认框仍拦截。 */
  const reads = [];
  const readBefore = window.fjtHooks.readScriptFile;
  const droppedDoc = {
    ...DOC,
    shots: [{ lines: '4', cands: [{ key: 'DROP', title: '拖入候选', url: 'https://x.org/drop.mp4', in: 1, out: 3 }] }],
  };
  window.fjtHooks.readScriptFile = async path => (
    reads.push(path),
    { name: '拖入候选.json', ext: 'json', content: JSON.stringify(droppedDoc), path }
  );
  const droppedFile = new File([JSON.stringify(droppedDoc)], '拖入候选.json', { type: 'application/json' });
  Object.defineProperty(droppedFile, 'path', { value: '/tmp/拖入候选.json' });
  const dropJson = () => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(droppedFile);
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer });
    $('#vrList').dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    const prevented = dropJson();
    await pause(60);
    t(
      '审核页直接拖入 JSON：读取文件、追加候选，仍在当前项目审核页',
      prevented &&
        reads.length === 1 &&
        reads[0] === droppedFile.path &&
        state.projectId === pid &&
        state.candidates.length === 4 &&
        cand('DROP')?.rowId === lines()[3].id &&
        !$('#reviewPage').hidden &&
        !$('#modalMask').classList.contains('show'),
    );
    undo();
    await pause(30);
    t('拖入的候选可以撤销，原候选保留', !cand('DROP') && state.candidates.length === 3);
    confirmModal('拖入测试', '确认框打开时不导入', '继续', () => {});
    dropJson();
    await pause(30);
    t(
      '审核页上叠着确认框时拦截拖入，不读文件也不修改候选',
      reads.length === 1 &&
        state.candidates.length === 3 &&
        $('#modalMask').classList.contains('show') &&
        topModal() === 'modalMask' &&
        !menuAllowed('import'),
    );
    click('#mCancel');
  } finally {
    if (readBefore) window.fjtHooks.readScriptFile = readBefore;
    else delete window.fjtHooks.readScriptFile;
  }
  // 回到原测试批次，继续检查原候选的审核行为。
  importLoadedFile(file);
  await pause(30);

  /* 通过 → 主画面 */
  click(btn('A1', 'ok'));
  await pause(30);
  const a1 = state.assets[cand('A1').assetId];
  t('通过：候选记成已通过并挂上素材', cand('A1').decision === 'ok' && !!a1 && a1.kind === 'video');
  t(
    '通过的视频成为整组主画面，带入出点',
    [0, 1, 2].every(n => {
      const u = us(n).find(x => x.assetId === a1.id);
      return u && u.role === 'main' && u.clip?.in === 101 && u.clip?.out === 110;
    }),
    JSON.stringify(us(0)),
  );
  t('原来的照片主画面让位成备选', us(0).find(x => x.assetId !== a1.id)?.role === 'alt');
  t(
    '画面描述追加一行：视频名、几分几秒、版权、原片页面',
    lines()[0].note.includes('视频：福特肉类加工 1922｜01:41–01:50｜公有领域｜https://archive.org/details/fc-fc-485') &&
      lines()[1].note === lines()[0].note,
    lines()[0].note,
  );
  t(
    '卡片不再显示单独保存按钮，顶部仍可批量保存',
    !card('A1')?.querySelector('[data-vr-save]') && !$('#vrSaveAll').hidden,
  );
  await pause(600);
  const last = writes.at(-1);
  t(
    '审核结果自动写回候选清单文件',
    last?.file === '/tmp/视频候选.json' &&
      last.results.some(r => r.key === 'A1' && r.lines === '1-3' && r.decision === 'ok'),
    JSON.stringify(last),
  );

  click(btn('A2', 'ok'));
  await pause(30);
  const a2 = cand('A2').assetId;
  t(
    '同一画面再通过一个视频：也当主画面，已通过的主画面不被顶掉',
    us(0).find(x => x.assetId === a2)?.role === 'main' && us(0).find(x => x.assetId === a1.id)?.role === 'main',
  );
  undo();
  await pause(30);
  t('撤销通过：候选回到待审，素材拿掉', !cand('A2').decision && !us(0).some(x => x.assetId === a2));

  /* 意见 */
  const note = card('A1').querySelector('[data-vr-note]');
  note.value = '再找个近景';
  note.dispatchEvent(new Event('input', { bubbles: true }));
  note.focus();
  note.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  t('审核意见框按回车结束输入，仍留在审核页', document.activeElement !== note && state.view === 'review');
  await pause(1000);
  t(
    '意见写进候选，也写回清单',
    cand('A1').note === '再找个近景' && writes.at(-1).results.some(r => r.note === '再找个近景'),
  );

  /* 换一个 → 这个画面审完，自动跳到下一个画面 */
  click(btn('A2', 're'));
  await pause(30);
  t('换一个记下来，刚审过的卡片先留在原处', cand('A2').decision === 're' && !!card('A2') && !!card('A1'));
  await pause(750);
  t(
    '这个画面审完，自动跳到下一个还有待审的画面',
    $('#vrNav .vr-nav-shot.on')?.textContent.includes('第 4 句') && !!card('B1') && !card('A1'),
  );
  t('截图只给右边正在看的画面截', !!card('B1')?.querySelector('.vr-strip'));

  /* 完整原片：必须确认 */
  click(card('B1').querySelector('[data-vr-orig]'));
  await pause(30);
  t('下载完整原片先弹确认，不直接下', originals.length === 0 && $('#modalMask').classList.contains('show'));
  click('#mCancel');
  await pause(20);
  t('取消就不下载', originals.length === 0);
  click(card('B1').querySelector('[data-vr-orig]'));
  click('#mOk');
  await pause(60);
  t('确认后才下载完整原片', originals.length === 1 && originals[0].url === 'https://x.org/d.mp4');

  /* 键盘 */
  const key = k =>
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  key('2');
  await pause(30);
  t('键盘 2 = 不要', cand('B1').decision === 'no');
  t(
    '审核快捷键没有改动表格句子的类型',
    lines()
      .slice(0, 3)
      .every(r => r.type === 'real') && lines()[3].type == null,
  );
  t('整批审完：顶部写「这一批审完了」', $('#vrSummary').textContent.includes('这一批审完了'));
  key('ArrowLeft');
  await pause(30);
  t(
    '← 回到上一个画面：审过的候选收成一行（结果 + 撤回），不再有「已通过」页',
    $('#vrNav .vr-nav-shot.on')?.textContent.includes('第 1–3 句') &&
      $$('#vrList .vr-done').length === 2 &&
      !$('#vrList .vr-cand') &&
      !$('#vrFilter'),
  );

  /* 顶部批量保存已通过的片段 */
  ffmpegMissing = true;
  click('#vrSaveAll');
  await pause(60);
  t(
    '没装 ffmpeg：弹窗说明怎么装，素材不变',
    $('#modalMask').classList.contains('show') &&
      $('#modalMask').textContent.includes('brew install ffmpeg') &&
      !cand('A1').savedPath,
  );
  click('#mCancel');
  ffmpegMissing = false;
  click('#vrSaveAll');
  await pause(80);
  t(
    '批量保存：只截建议片段，存到选好的文件夹',
    saves.length === 1 &&
      saves[0].start === 101 &&
      saves[0].end === 110 &&
      saves[0].dir === '/tmp/视频素材' &&
      state.mediaDir === '/tmp/视频素材',
    JSON.stringify(saves),
  );
  const a1now = state.assets[cand('A1').assetId];
  t(
    '保存后素材换成本地片段文件，不再需要入出点',
    a1now.path === '/tmp/视频素材/第1-3句_福特肉类加工 1922_1m41s-1m50s.mp4' &&
      us(0).find(x => x.assetId === a1.id) &&
      !us(0).find(x => x.assetId === a1.id).clip,
    a1now.path,
  );
  t('保存的文件名带上对应的句号：第1-3句_标题', saves[0].name === '第1-3句_福特肉类加工 1922', saves[0].name);
  t('画面描述里的原片来源还在', lines()[0].note.includes('archive.org/details/fc-fc-485'));
  t('收起的那一行显示已保存', card('A1').textContent.includes('已保存'));

  /* 撤回通过 */
  const noteBefore = lines()[0].note;
  click(btn('A1', 'ok'));
  await pause(30);
  t(
    '再点一次「通过」= 撤回：素材拿掉，画面描述那一行删掉',
    !cand('A1').decision && !us(0).some(x => x.assetId === a1.id) && !lines()[0].note.includes('福特肉类加工'),
    noteBefore + ' → ' + lines()[0].note,
  );
  undo();
  await pause(30);
  t('撤销撤回：通过和画面描述都回来', cand('A1').decision === 'ok' && lines()[0].note.includes('福特肉类加工'));

  /* 「不要」的：离开审核页时自动清掉；同一份清单再导入也不会回来 */
  $('#viewToggle [data-v="table"]').click();
  await pause(80);
  t('切回表格页面', $('#reviewPage').hidden && state.view === 'table');
  t('离开审核页时「不要」的候选自动清掉', !cand('B1') && state.candidates.length === 2);
  const again = planImport(
    { ...DOC, shots: [{ ...DOC.shots[1], cands: [{ ...DOC.shots[1].cands[0], review: { decision: 'no' } }] }] },
    '/tmp/视频候选.json',
    state.rows,
    state.candidates,
  );
  t('清单里已经标成「不要」的，再导入不会回来', again.added.length === 0);

  /* 右侧面板入口 */
  click(`[data-detail="${ids[0]}"]`);
  await pause(30);
  const entry = $('#inspector [data-vr-open]');
  t('画面面板里有「视频候选 · 去审核」入口', !!entry && entry.textContent.includes('视频候选 2 个'));
  click(entry);
  await pause(30);
  t(
    '从面板进入审核页面，直接选中这个画面',
    !$('#reviewPage').hidden && $('#vrNav .vr-nav-shot.on')?.textContent.includes('第 1–3 句'),
  );
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await pause(30);
  t('Esc 不关闭审核页面', !$('#reviewPage').hidden && state.view === 'review');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true }));
  await pause(30);
  t('⌘T 从审核切回表格', $('#reviewPage').hidden && state.view === 'table');
  click('#btnDetail');

  /* 旧版本保存的片段：载入时文件名补上句号，素材路径和候选记录一起改 */
  const oldPath = '/tmp/视频素材/福特肉类加工 1922_1m41s-1m50s.mp4';
  cand('A1').savedPath = oldPath;
  state.assets[cand('A1').assetId].path = oldPath;
  const tagCalls = [];
  window.fjtHooks.tagSavedClip = async (p, tag) => (
    tagCalls.push({ p, tag }),
    { ok: true, path: p.replace(/[^/]+$/, n => `${tag}_${n}`) }
  );
  t('句号按画面现在的句子范围算', lineTag(cand('A1'), state.rows) === '第1-3句');
  const tagged = await tagOldSavedClips();
  const newPath = '/tmp/视频素材/第1-3句_福特肉类加工 1922_1m41s-1m50s.mp4';
  t(
    '旧片段改名补上句号：候选记录和素材库路径一起换成新名字',
    tagged === 1 &&
      tagCalls.length === 1 &&
      tagCalls[0].tag === '第1-3句' &&
      cand('A1').savedPath === newPath &&
      state.assets[cand('A1').assetId].path === newPath,
    JSON.stringify(tagCalls),
  );
  t('已经带句号的不再改', (await tagOldSavedClips()) === 0 && tagCalls.length === 1);
  delete window.fjtHooks.tagSavedClip;

  /* 保存与切项目 */
  storage.switchProject(original);
  update('rows');
  await pause(20);
  t('切到别的项目：候选不串过去', state.candidates.length === 0 && $('#vtBadge').hidden);
  storage.switchProject(pid);
  update('rows');
  await pause(20);
  t('切回来候选还在', state.candidates.length === 2 && cand('A1').decision === 'ok');
  await flushWriteBack();

  /* 清场 */
  storage.switchProject(original);
  storage.deleteProject(pid);
  state.multi = null;
  state.multiMode = false;
  delete window.fjtHooks.writeCandidateReview;
  delete window.fjtHooks.pickFolder;
  delete window.fjtHooks.saveVideoSegment;
  delete window.fjtHooks.downloadOriginalVideo;
  delete window.fjtHooks.revealAsset;
  clearUndo();
  update('rows');
  await pause(30);
}
