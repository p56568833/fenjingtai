/* 1.5 视频审核自测：导入候选清单（不新建项目）、按句号对上画面、通过 → 主画面 + 片段 + 画面描述来源行、
   同一画面再通过的也当主画面、撤回、不要 / 清除、写回候选清单、只保存那几秒、完整原片要确认、撤销、切项目保留。
   原生能力全部用 window.fjtHooks 替身，不碰网络和磁盘。 */
import { state, update, emit } from '../app/state.js';
import * as storage from '../app/storage.js';
import { undo, redo, clearUndo } from '../app/undo.js';
import { parseAny } from '../core/parse.js';
import { usageList } from '../core/asset-model.js';
import { addRefsToShot } from '../app/asset-actions.js';
import { setType } from '../app/actions.js';
import { importLoadedFile } from '../ui/import-export.js';
import { flushWriteBack, tagOldSavedClips, setDecision, openRework } from '../features/video-review.js';
import { playthroughState } from '../features/playthrough.js';
import { importCandidateData, setReworkNote } from '../app/candidate-actions.js';
import { parseLines, parseClock, planImport, lineTag } from '../core/candidates.js';
import { confirmModal } from '../ui/base/dom.js';
import { anyModalOpen, topModal, menuAllowed } from '../ui/base/modal.js';
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
/* 左栏顶上的当前批次卡片：点它在菜单里换批次；删除在卡片的「⋯」菜单里 */
const chooseBatch = id => {
  click('#vrBatchPick');
  return click(`.popover [data-vrb="pick"][data-id="${id}"]`);
};
const curBatchHead = () => $('#vrBatchPick');
const deleteBatch = () => {
  click('#vrBatchMore');
  return click('.popover #vrDeleteBatch');
};

const DOC = {
  type: 'fenjingtai-candidates',
  version: 2,
  project: '视频审核测试',
  batch: '测试批次',
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
          limitations: '没有人物面部',
        },
        {
          key: 'A2',
          title: '赶牛',
          url: 'https://upload.wikimedia.org/x/cattle.webm',
          in: 15,
          out: 30,
          license: '版权未核实',
          why: '赶牛进场',
        },
      ],
    },
    {
      lines: '4',
      label: '实验室',
      cands: [
        {
          key: 'B1',
          title: '白喉抗毒素',
          url: 'https://x.org/d.mp4',
          in: 960,
          out: 1050,
          license: '公有领域',
          why: '实验室',
        },
      ],
    },
    {
      lines: '99',
      label: '对不上',
      cands: [
        { key: 'Z1', title: '对不上', url: 'https://x.org/z.mp4', in: 1, out: 2, license: '公有领域', why: '对不上' },
      ],
    },
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

  /* 不合格式（v2 规范）的清单整份拒收：弹窗逐条写错在哪，「复制给 AI」复制问题 + 规范 */
  const copied = [];
  window.fjtHooks.copyText = async text => copied.push(text);
  const badDoc = {
    ...DOC,
    version: 1,
    shots: [
      {
        lines: '1-3',
        label: '坏',
        plans: [{ cands: [{ key: 'X', title: '坏', url: 'ftp://nope', in: '1:41', out: 2, note: 1 }] }],
      },
    ],
  };
  importLoadedFile({ name: '坏清单.json', ext: 'json', content: JSON.stringify(badDoc), path: '/tmp/坏清单.json' });
  await pause(30);
  t(
    '不合格式的候选清单整份拒收，弹窗逐条写出错在哪',
    state.candidates.length === 0 &&
      $('#modalMask').classList.contains('show') &&
      ['version 必须是数字 3', 'url 必须是', 'in 必须是秒数', 'license 必须写', '不认识的字段「note」'].every(x =>
        $('#mBody').textContent.includes(x),
      ),
  );
  click('#mOk');
  await pause(30);
  t(
    '「复制给 AI」复制全部问题和格式规范',
    copied.length === 1 && copied[0].includes('不认识的字段「note」') && copied[0].includes('分镜台候选清单格式 v3'),
  );
  delete window.fjtHooks.copyText;

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
    '按句号对上画面，对不上句子的候选跳过',
    cand('A1').rowId === ids[0] && cand('B1').rowId === lines()[3].id && !cand('Z1'),
  );
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
  $('#vrBatchPick').focus();
  const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  $('#vrBatchPick').dispatchEvent(tabEvent);
  t('审核页不按弹窗方式拦截 Tab', !tabEvent.defaultPrevented);
  $('#vrBatchPick').blur();
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
    '左边按画面列出这一批（带待审数），右边只显示第一个画面的候选，播放器停在这个画面第一句',
    $$('#vrNav .vr-nav-shot').length === 2 &&
      $('#vrNav .vr-nav-shot.on')?.textContent.includes('2 待审') &&
      $$('#vrList .vr-shot').length === 1 &&
      !!$('#vrList #vrDockPlayer .pt-box.docked') &&
      $('#ptSub')?.textContent === '甲。' &&
      !card('B1'),
  );
  t(
    '进度写在左栏批次卡片上',
    $('#vrNav .vr-bprogress')?.textContent.includes('3 待审') && $$('#vrNav [data-vr-batch]').length === 1,
  );
  t(
    '左栏顶上固定当前批次卡片（实际句子、待审数、进度条、「⋯」），下面列出这一批的全部画面',
    !!curBatchHead() &&
      curBatchHead().textContent.includes('第1–4句') &&
      $('#vrNav .vr-picker .vr-bprogress').textContent.includes('3 待审') &&
      !!$('#vrNav .vr-picker .vr-bbar') &&
      $$('#vrNav .vr-shots .vr-nav-shot').length === 2 &&
      !!$('#vrBatchMore') &&
      !$('#vrDeleteBatch'),
  );
  click('#vrBatchPick');
  t(
    '点批次卡片弹出换批次菜单：当前批次打勾，最下面是导入新批次',
    $$('.popover [data-vrb="pick"]').length === 1 &&
      !!$('.popover .vr-bpick.cur .chk') &&
      !!$('.popover [data-vrb="import"]'),
  );
  click('#vrBatchPick');
  t('再点批次卡片收起菜单', !$('.popover'));
  t(
    '左边「对着口播看画面」，右边这个画面的全部视频，下面正片和备选两条轨',
    !!$(`#vrList .vr-plist [data-vr-id="${cand('A1').id}"]`) &&
      !!$(`#vrList .vr-plist [data-vr-id="${cand('A2').id}"]`) &&
      !!$('#vrList #vrDockTrack #pttLane') &&
      !!$('#vrList #vrDockTrack #pttAlt'),
  );
  t(
    '列表上面写正片轨排了几秒 / 口播几秒',
    /已排 [\d.]+ \/ 口播 [\d.]+ 秒/.test($('#vrList .vr-pfill-head')?.textContent || ''),
    $('#vrList .vr-pfill-head')?.textContent,
  );
  click('#vrBatchMore');
  t(
    '批次「⋯」菜单里有更换保存位置和删除此批次（候选数、保留说明）',
    !!$('.popover [data-vrb="dir"]') &&
      $('.popover #vrDeleteBatch')?.textContent.includes('3 个候选') &&
      $('.popover #vrDeleteBatch').classList.contains('danger'),
  );
  click('#vrBatchMore');
  t('再点「⋯」收起菜单', !$('.popover'));
  t(
    '每个候选有 9 格截图位（审核页排成 3×3）、建议片段和版权',
    card('A1')?.querySelectorAll('.vr-cell').length >= 1 &&
      getComputedStyle(card('A1').querySelector('.vr-strip')).gridTemplateColumns.split(' ').length === 3 &&
      card('A1').textContent.includes('01:41–01:50') &&
      card('A1').textContent.includes('公有领域'),
  );
  t(
    '清单写的「缺了什么」显示在候选卡片上，不挂在句子下面',
    card('A1')?.querySelector('.vr-cov-note')?.textContent === '缺：没有人物面部',
  );
  const shotEl = $('#vrList .vr-shot');
  update('rows');
  await pause(30);
  t('内容没变的刷新（别人改别处、后台保存）不重建审核页', $('#vrList .vr-shot') === shotEl);
  t(
    '播放器默认不加载（不下载）',
    $$('#vrList video.vr-player').every(v => !v.getAttribute('src')),
  );
  // 右边卡片不再带播放器：点「播放这段」时候选临时盖在左边播放器上播；候选盖着时空格管候选
  t(
    '审核页卡片里没有播放器，左边平时放排好的画面',
    !card('A1')?.querySelector('.vr-player') && $('#vrPreview')?.hidden,
  );
  click(card('A1').querySelector('[data-vr-play]'));
  await pause(30);
  t(
    '点「播放这段」：候选临时盖在左边播放器上，标着「候选」和是哪个视频',
    !$('#vrPreview').hidden &&
      !!$('#vrPreview video.vr-player') &&
      $('.vr-dock-wrap').classList.contains('previewing') &&
      $('#vrPreview .vr-pv-badge')?.textContent === '候选' &&
      $('#vrPreview .vr-pv-title')?.textContent.includes(cand('A1').title),
  );
  click('#vrPreview [data-vr-pv-close]');
  await pause(20);
  t('点「回到画面时间」：候选收起，回到排好的画面', $('#vrPreview').hidden && !$('#vrPreview video'));
  click(card('A1').querySelector('[data-vr-play]'));
  await pause(20);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  await pause(30);
  t(
    '候选盖着时按空格：暂停 / 继续候选，候选不收起，排好的画面不播',
    !$('#vrPreview').hidden && !playthroughState().playing,
  );
  click('#vrPreview [data-vr-pv-close]');
  await pause(20);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  await pause(30);
  t('收起候选后按空格：播排好的画面', $('#vrPreview').hidden && playthroughState().playing);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  await pause(20);
  t('再按空格：排好的画面停下，候选也没被打开', !playthroughState().playing && $('#vrPreview').hidden);
  t(
    '右边一栏和左边播放器一样高，内容多了在栏里滚，下面的画面时间条不被挤走',
    Math.abs($('.vr-plans').getBoundingClientRect().height - $('.vr-watch').getBoundingClientRect().height) < 2 &&
      getComputedStyle($('.vr-plans > .vr-pbody')).overflowY === 'auto',
  );
  importLoadedFile(file);
  await pause(30);
  t('同一份清单再导入只更新，不重复', state.candidates.length === 3);

  /* 审核页直接拖入候选 JSON，不能被误认成弹窗；真正的确认框仍拦截。 */
  const reads = [];
  const readBefore = window.fjtHooks.readScriptFile;
  const droppedDoc = {
    ...DOC,
    shots: [
      {
        lines: '4',
        label: '实验室',
        cands: [
          {
            key: 'DROP',
            title: '拖入候选',
            url: 'https://x.org/drop.mp4',
            in: 1,
            out: 3,
            license: '公有领域',
            why: '拖入',
          },
        ],
      },
    ],
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

  t('画面填满、没有待审了：自动跳到下一个画面', $('#vrList .vr-shot')?.dataset.vrShot === String(lines()[3].id));
  click(`#vrNav [data-vr-goto="${ids[0]}"]`);
  await pause(30);
  t('通过了写着「缺了什么」的视频：不再标「只覆盖一部分」', !$('#vrList').textContent.includes('只覆盖一部分'));
  t(
    '正片轨已经排满：没审的视频收成「未采用」，不算待审',
    !!$(`#vrList .vr-done.d-idle[data-vr-id="${cand('A2').id}"]`) && !btn('A2', 'ok'),
  );
  click($(`#vrList .vr-done.d-idle[data-vr-id="${cand('A2').id}"]`));
  await pause(30);
  t('点开「未采用」的视频还能审', !!btn('A2', 'ok'));
  click(btn('A2', 'ok'));
  await pause(30);
  const a2 = cand('A2').assetId;
  t(
    '正片轨排满后再通过一个视频：放在备选轨，已通过的主画面不被顶掉',
    us(0).find(x => x.assetId === a2)?.role === 'alt' &&
      us(0).find(x => x.assetId === a1.id)?.role === 'main' &&
      !!$(`#pttAlt .ptt-block[data-ptt="${a2}"]`),
    JSON.stringify(us(0).map(u => [u.assetId, u.role, u.at])) + ' alt:' + $$('#pttAlt .ptt-block').length,
  );
  undo();
  await pause(30);
  t('撤销通过：候选回到待审，素材拿掉', !cand('A2').decision && !us(0).some(x => x.assetId === a2));

  /* 意见（换画面回来后，审过的 A1 收成了一行：点开再写） */
  if (!card('A1')?.querySelector('[data-vr-note]')) click(`#vrList .vr-done[data-vr-id="${cand('A1').id}"]`);
  await pause(30);
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

  /* 换一个 → 这个画面审完，自动跳到下一个画面（A1 已经填满，撤销后的 A2 是「未采用」，点开再审） */
  if (!btn('A2', 're')) {
    click(`#vrNav [data-vr-goto="${ids[0]}"]`);
    await pause(30);
    click(`#vrList .vr-done[data-vr-id="${cand('A2').id}"]`);
    await pause(30);
  }
  click(btn('A2', 're'));
  await pause(30);
  t(
    '换一个记下来，刚审过的收成一行留在原处；只有选中的那个展开',
    cand('A2').decision === 're' && !!card('A2') && !!card('A1') && $$('#vrList .vr-cand').length <= 1,
  );
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
  t('整批审完：右边不再写「这一批审完了」', !$('#vrList').textContent.includes('这一批都审完了'));
  key('ArrowLeft');
  await pause(30);
  t(
    '← 回到上一个画面：审过的候选收成一行（结果 + 撤回），不再有「已通过」页',
    $('#vrNav .vr-nav-shot.on')?.textContent.includes('第 1–3 句') &&
      $$('#vrList .vr-done').length === 2 &&
      $$('#vrList .vr-done.d-ok .vr-done-thumbs').length >= 1 &&
      !$('#vrList .vr-done b') &&
      !$('#vrList .vr-cand'),
  );
  click($(`#vrList .vr-done[data-vr-id="${cand('A1').id}"] .vr-done-title`));
  await pause(30);
  t(
    '点审过的一行展开成完整卡片看画面，审核结果不变',
    !!$(`#vrList .vr-cand[data-vr-id="${cand('A1').id}"]`) &&
      cand('A1').decision === 'ok' &&
      !!$(`#vrList [data-vr-fold="${cand('A1').id}"]`),
  );
  click(`#vrList [data-vr-fold="${cand('A1').id}"]`);
  await pause(30);
  t(
    '「收起」收回成一行',
    !!$(`#vrList .vr-done[data-vr-id="${cand('A1').id}"]`) && !$(`#vrList .vr-cand[data-vr-id="${cand('A1').id}"]`),
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

  /* 保存过的片段：撤回后再通过，直接挂回本地文件，不再变回「在线」（以前会一直显示在线，批量保存也跳过它） */
  const fx = window.native?.fixtureInfo?.();
  if (fx?.dir) {
    const keepSaved = cand('A1').savedPath;
    const keepPath = state.assets[cand('A1').assetId].path;
    const realFile = fx.dir + '/样图.png';
    cand('A1').savedPath = realFile;
    state.assets[cand('A1').assetId].path = realFile;
    click(btn('A1', 'ok'));
    await pause(30);
    click(btn('A1', 'ok'));
    await pause(120);
    const relinked = state.assets[cand('A1').assetId];
    t(
      '保存过的片段撤回后再通过：素材直接是本地文件，不是在线地址，也不带入出点',
      cand('A1').decision === 'ok' &&
        relinked?.path === realFile &&
        !us(0).find(x => x.assetId === relinked.id)?.clip &&
        cand('A1').savedPath === realFile,
      relinked?.path,
    );
    undo();
    undo();
    await pause(30);
    cand('A1').savedPath = keepSaved;
    state.assets[cand('A1').assetId].path = keepPath;
    update('rows');
    await pause(30);
  }

  /* 「不要」的：这个画面一个都没通过时留在「待返工」里（不再离开审核页就清掉）；同一份清单再导入也不会重复 */
  $('#viewToggle [data-v="table"]').click();
  await pause(80);
  t('切回表格页面', $('#reviewPage').hidden && state.view === 'table');
  t(
    '离开审核页时，没有通过候选的画面里「不要」的候选留着（在待返工里）',
    cand('B1')?.decision === 'no' && state.candidates.length === 3,
  );
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
  t('切回来候选还在', state.candidates.length === 3 && cand('A1').decision === 'ok');
  await flushWriteBack();

  /* 删除重复的旧批次：只清审核记录，保留表格素材、其他批次和清单结果。 */
  storage.createProject('批次删除测试', parseAny('甲。乙。丙。丁。'));
  const deletePid = state.projectId;
  update('rows');
  importLoadedFile({ ...file, path: '/tmp/删除批次-7.json', content: JSON.stringify({ ...DOC, batch: '重复批次' }) });
  await pause(30);
  const oldBatch = state.candidates[0].batchId;
  state.candidates.forEach(c => (c.batchNo = 7));
  setDecision(cand('A1').id, 'ok');
  setDecision(cand('B1').id, 'no');
  const approved = cand('A1');
  approved.savedPath = '/tmp/视频素材/第1句_已保存.mp4';
  state.assets[approved.assetId].path = approved.savedPath;
  importLoadedFile({ ...file, path: '/tmp/删除批次-8.json', content: JSON.stringify({ ...DOC, batch: '新批次' }) });
  await pause(30);
  const newer = state.candidates.filter(c => c.batchId !== oldBatch);
  const newBatch = newer[0].batchId;
  const remainingIds = newer
    .map(c => c.id)
    .sort()
    .join();
  const beforeRows = JSON.stringify(state.rows);
  const beforeAssets = JSON.stringify(state.assets);
  const beforeCandidates = JSON.stringify(state.candidates);
  clearUndo();
  chooseBatch(oldBatch);
  deleteBatch();
  t(
    '批次删除先确认名称和候选数量，说明已挂素材及本地文件保留',
    $('#modalMask').classList.contains('show') &&
      $('#mBody').textContent.includes('第1、4句') &&
      $('#mBody').textContent.includes('3 个候选') &&
      $('#mBody').textContent.includes('已下载文件') &&
      $('#mOk').classList.contains('danger'),
  );
  click('#mCancel');
  t('取消删除后所有候选原样保留', JSON.stringify(state.candidates) === beforeCandidates);
  deleteBatch();
  click('#mOk');
  await pause(30);
  t(
    '删除旧名单只移除该名单候选，新名单原样保留',
    state.candidates.length === 3 &&
      state.candidates
        .map(c => c.id)
        .sort()
        .join() === remainingIds,
  );
  t(
    '已通过的素材关联、画面描述和本地路径都保留',
    JSON.stringify(state.rows) === beforeRows && JSON.stringify(state.assets) === beforeAssets,
  );
  t(
    '删旧名单后自动切到剩余名单，句子名称和待审数量更新',
    curBatchHead()?.dataset.vrBatch === newBatch &&
      curBatchHead().textContent.includes('第1、4句') &&
      !$('#vrNav .vr-bname') &&
      $('#vtBadge').textContent === '3',
  );
  await flushWriteBack();
  t(
    '删除批次不把原清单里的已通过改成不要，保留已保存路径',
    writes.some(
      w =>
        w.file === '/tmp/删除批次-7.json' &&
        w.results.some(r => r.key === 'A1' && r.decision === 'ok' && r.savedPath === approved.savedPath),
    ),
  );
  undo();
  await pause(30);
  t('批次删除可以撤销，完整恢复候选与审核结果', JSON.stringify(state.candidates) === beforeCandidates);
  redo();
  await pause(30);
  t('重做批次删除仍只移除原批次', state.candidates.length === 3 && state.candidates.every(c => c.batchId === newBatch));
  storage.switchProject(original);
  update('rows');
  storage.switchProject(deletePid);
  update('rows');
  await pause(30);
  t(
    '重新载入项目后删除已保存，剩余名单仍按实际句子命名',
    state.candidates.length === 3 && curBatchHead()?.textContent.includes('第1、4句'),
  );
  deleteBatch();
  click('#mOk');
  await pause(30);
  t(
    '删除最后一批后显示空页面并收起批次选择和删除入口',
    !state.candidates.length &&
      !$('#vrBatchPick') &&
      !$('#vrBatchMore') &&
      !!$('#vrNav #vrImport') &&
      $('#vrList').textContent.includes('还没有视频候选'),
  );
  undo();
  state.candidates.forEach(c => {
    delete c.batchId;
    delete c.batchNo;
  });
  update('rows');
  deleteBatch();
  t('旧版本无批次编号的候选也能删除，确认显示实际句子', $('#mBody').textContent.includes('第1、4句'));
  click('#mOk');
  t('旧版本批次删除后候选为空', state.candidates.length === 0);
  undo();
  deleteBatch();
  storage.switchProject(original);
  update('rows');
  const otherCandidates = JSON.stringify(state.candidates);
  click('#mOk');
  t('确认期间切了项目，不会删除新项目候选', JSON.stringify(state.candidates) === otherCandidates);
  storage.deleteProject(deletePid);

  /* 两条轨：通过的先上正片轨，排满了放备选轨；备选能拖上正片轨（互换 / 插进空隙），正片能拖下来（原位置留空），
     备选在备选轨上能自由挪；清单里的方案不再分 Tab，表格里也没有方案切换 */
  storage.createProject('两条轨测试', parseAny('甲乙丙丁戊己庚辛壬癸。子丑寅卯辰巳午未申酉。'));
  const trackPid = state.projectId;
  const two = lines().map(r => r.id);
  state.multi = two;
  state.sel = two[0];
  state.multiMode = true;
  update('selection');
  click('#btnGroup');
  click('#mOk');
  state.multiMode = false;
  setType(two, 'real');
  lines().forEach((r, i) => (r.time = { start: i * 3, end: i * 3 + 3, st: 'ok' }));
  update('rows');
  const v3c = (key, len) => ({
    key,
    title: '视频 ' + key,
    url: `https://x.org/${key}.mp4`,
    in: 0,
    out: len + 2,
    best: { in: 1, out: 1 + len },
    license: '版权未核实',
    why: '测试',
  });
  const trackDoc = {
    type: 'fenjingtai-candidates',
    version: 3,
    project: '两条轨测试',
    batch: '两条轨',
    shots: [
      { lines: '1-2', label: '两句', plans: [{ cands: [v3c('P1a', 3), v3c('P1b', 3)] }, { cands: [v3c('P2', 6)] }] },
    ],
  };
  importLoadedFile({ name: '两条轨.json', ext: 'json', content: JSON.stringify(trackDoc), path: '/tmp/两条轨.json' });
  await pause(60);
  t(
    '清单里有两个方案：审核页不分 Tab，三个视频列在一起',
    !!card('P1a') && !!$(`#vrList .vr-plist [data-vr-id="${cand('P2').id}"]`),
  );
  setDecision(cand('P1a').id, 'ok');
  setDecision(cand('P1b').id, 'ok');
  await pause(30);
  const aid = key => cand(key).assetId;
  const roleOf = key => us(0).find(u => u.assetId === aid(key))?.role;
  t('正片轨还有空：通过的视频都放上正片轨', roleOf('P1a') === 'main' && roleOf('P1b') === 'main');
  t('排满后列表上写已排 6 / 口播 6 秒', $('#vrList .vr-pfill-head')?.textContent.includes('已排 6 / 口播 6 秒'));
  click($(`#vrList .vr-done.d-idle[data-vr-id="${cand('P2').id}"]`));
  await pause(30);
  setDecision(cand('P2').id, 'ok');
  await pause(60);
  t(
    '正片轨排满再通过：放在备选轨，提示里说清楚',
    roleOf('P2') === 'alt' &&
      !!$(`#pttAlt .ptt-block[data-ptt="${aid('P2')}"]`) &&
      $('#toastTxt')?.textContent.includes('备选轨'),
  );
  // 合成指针事件拖色块：按下在色块上，移动 / 松手在两条轨的外框上（和真实鼠标一样被外框接住）
  const lanes = () => $('#pttLanes');
  const blockOf = key => $(`#pttLanes .ptt-block[data-ptt="${aid(key)}"]`);
  const fire = (el, type, x, y) =>
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 7, clientX: x, clientY: y }));
  const at = (el, fx = 0.5) => {
    const r = el.getBoundingClientRect();
    return [r.left + r.width * fx, r.top + r.height / 2];
  };
  const drag = async (key, [x, y]) => {
    const el = blockOf(key);
    const [x0, y0] = at(el);
    fire(el.querySelector('.ptt-label') || el, 'pointerdown', x0, y0);
    fire(lanes(), 'pointermove', x0 + (x - x0) / 2, y0 + (y - y0) / 2);
    fire(lanes(), 'pointermove', x, y);
    fire(lanes(), 'pointerup', x, y);
    await pause(60);
  };
  const timeOfX = sec => {
    const r = $('#pttLane').getBoundingClientRect();
    return r.left + (sec / 6) * r.width;
  };
  const laneY = id => at($(id))[1];
  const atOf = key => us(0).find(u => u.assetId === aid(key))?.at;
  await drag('P2', at(blockOf('P1a')));
  t(
    '备选拖到正片的画面上：两个互换，换下来的放到备选轨',
    roleOf('P2') === 'main' && roleOf('P1a') === 'alt' && atOf('P2')?.start === 0 && roleOf('P1b') === 'main',
    JSON.stringify(us(0).map(u => [u.role, u.at])),
  );
  undo();
  await pause(60);
  t('互换可以一步撤销', roleOf('P2') === 'alt' && roleOf('P1a') === 'main');
  await drag('P1b', [timeOfX(4.5), laneY('#pttAlt')]);
  t(
    '正片拖到备选轨：撤下来，原来的位置留空，前面的画面不动',
    roleOf('P1b') === 'alt' &&
      roleOf('P1a') === 'main' &&
      atOf('P1a')?.start === 0 &&
      atOf('P1a')?.end === 3 &&
      $('#vrList .vr-pfill-head')?.textContent.includes('已排 3 / 口播 6 秒'),
    JSON.stringify(us(0).map(u => [u.role, u.at])),
  );
  const p1bAt = atOf('P1b');
  await drag('P1b', [timeOfX(1), laneY('#pttAlt')]);
  t(
    '备选在备选轨上自由挪位置，还是备选',
    roleOf('P1b') === 'alt' && atOf('P1b')?.start < p1bAt.start,
    JSON.stringify([p1bAt, atOf('P1b')]),
  );
  // 拖到一半来了别处的刷新（协作对方改了别的句子、后台保存）：拖动不断，松手照样保存
  const slowDrag = async (key, sec, during) => {
    const el = blockOf(key);
    const [x0, y0] = at(el);
    const px = $('#pttLane').getBoundingClientRect().width / 6;
    fire(el.querySelector('.ptt-label') || el, 'pointerdown', x0, y0);
    fire(lanes(), 'pointermove', x0 + 10, y0);
    await during();
    fire(lanes(), 'pointermove', x0 + sec * px, y0);
    fire(lanes(), 'pointerup', x0 + sec * px, y0);
    await pause(250);
  };
  const before = atOf('P1b').start;
  await slowDrag('P1b', 1.5, async () => {
    emit('project-changed');
    update('rows');
    await pause(40);
  });
  t(
    '拖动中途有刷新：备选不弹回原位，松手停在拖到的地方',
    roleOf('P1b') === 'alt' && Math.abs(atOf('P1b').start - (before + 1.5)) < 0.15,
    JSON.stringify([before, atOf('P1b')]),
  );
  // 拖动期间改了备注、后台把片段存到本地（入出点换成本地的）：不动排布，松手照样保存，不弹回
  const noted = atOf('P1b').start;
  await slowDrag('P1b', -1, async () => {
    for (const r of lines()) for (const u of r.assetUsages) if (u.assetId === aid('P1a')) u.note = '对方改了';
    for (const r of lines())
      for (const u of r.assetUsages) if (u.assetId === aid('P1b')) u.clip = { ...(u.clip || { in: 0 }), local: true };
    emit('project-changed');
    await pause(40);
  });
  t(
    '拖动期间改了备注、后台保存了片段：松手照样保存，不弹回',
    Math.abs(atOf('P1b').start - (noted - 1)) < 0.15,
    JSON.stringify([noted, atOf('P1b')]),
  );
  // 拖动期间协作对方挪了正在拖的这个画面：草稿按旧排布算的，不提交，以对方的为准
  let kept = 0;
  await slowDrag('P1b', 1, async () => {
    for (const r of lines())
      for (const u of r.assetUsages)
        if (u.assetId === aid('P1b')) u.at = { ...u.at, start: u.at.start + 0.5, end: u.at.end + 0.5 };
    kept = atOf('P1b').start;
    emit('project-changed');
    await pause(40);
  });
  t('拖动期间同一个画面被别处挪过：这次拖动不保存，不盖掉对方的改动', atOf('P1b').start === kept);
  // 拖得快：按下以后一次移动都没报就松手（浏览器把移动合并掉了），按松手的位置存
  const flick = async (key, sec) => {
    const el = blockOf(key);
    const [x0, y0] = at(el);
    const px = $('#pttLane').getBoundingClientRect().width / 6;
    fire(el.querySelector('.ptt-label') || el, 'pointerdown', x0, y0);
    fire(lanes(), 'pointerup', x0 + sec * px, y0);
    await pause(60);
  };
  const flickFrom = atOf('P1b').start;
  await flick('P1b', 1);
  t(
    '快速拖动（中间没有移动事件）：备选停在松手的地方，不弹回',
    roleOf('P1b') === 'alt' && Math.abs(atOf('P1b').start - (flickFrom + 1)) < 0.15,
    JSON.stringify([flickFrom, atOf('P1b')]),
  );
  const mainFrom = atOf('P1a').start;
  await flick('P1a', 1);
  t(
    '快速拖动正片：同样停在松手的地方',
    roleOf('P1a') === 'main' && Math.abs(atOf('P1a').start - (mainFrom + 1)) < 0.15,
    JSON.stringify([mainFrom, atOf('P1a')]),
  );
  // 审核页滚到下面看时间轴时整块重画（拖完「已排几秒」变了就会重画）：滚动位置不变，不跳回最上面
  const host = $('#vrList');
  host.style.maxHeight = '320px';
  // 滚到时间轴附近（不贴底：贴底时重画前后页面高度差一点，滚动位置会被浏览器夹住）
  host.scrollTop = Math.max(0, host.scrollHeight - host.clientHeight - 80);
  await pause(30);
  const scrolled = host.scrollTop;
  const tall = host.scrollHeight;
  cand('P2').title = '视频 P2（改名触发重画）';
  update('rows');
  await pause(60);
  t(
    '审核页滚到下面时整块重画：滚动位置不变，时间轴还在原处',
    scrolled > 0 && Math.abs(host.scrollTop - scrolled) < 2 && !!$('#vrList #vrDockTrack #pttLane'),
    JSON.stringify([scrolled, host.scrollTop, tall, host.scrollHeight]),
  );
  host.style.maxHeight = '';
  // 和协作同步一样：先报「对方改动已写入」，再刷新界面（审核页会跟着重画）
  const remote = () => {
    emit('collab-applied');
    emit('collab-remote');
  };
  // 协作对方只改了备注：排布没变，不提示
  for (const r of lines()) for (const u of r.assetUsages) if (u.assetId === aid('P1a')) u.note = '对方又改了';
  remote();
  await pause(60);
  t('协作对方只改了备注：不提示画面被换', !$('#pttWarn')?.textContent.includes('协作对方'));
  // 协作对方挪了现在开着的这个画面：「画面时间」那一行说一声
  for (const r of lines())
    for (const u of r.assetUsages) if (u.assetId === aid('P1a')) u.at = { ...u.at, end: u.at.end - 0.5 };
  remote();
  await pause(60);
  t(
    '协作对方挪了开着的画面：画面时间一行提示已换成对方的版本',
    $('#pttWarn')?.textContent.includes('协作对方'),
    $('#pttWarn')?.textContent,
  );
  remote();
  await pause(60);
  t('对方没再改这个画面：不重复提示', !$('#pttWarn')?.textContent.includes('协作对方'));
  await drag('P2', [timeOfX(4), laneY('#pttLane')]);
  t(
    '备选拖进正片轨的空隙：插进去，从空隙开头放',
    roleOf('P2') === 'main' && atOf('P2')?.start >= 3 && atOf('P2')?.start < 6,
    JSON.stringify(us(0).map(u => [u.role, u.at])),
  );
  t(
    '句子分界只画在两条轨上，刻度尺上没有竖线；操作说明收进「?」',
    !$('#pttRuler .ptt-sep') && $$('#pttLane .ptt-sep').length === 1 && !!$('#vrDockTrack .ptt-help'),
  );
  // 双击画面：正片有「定格补满」和「删除」，备选只有「删除」；删除审核通过的视频 = 撤回通过，可以撤销
  const dbl = el => {
    const [x, y] = at(el);
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
  };
  dbl(blockOf('P1b'));
  await pause(30);
  t(
    '双击备选：菜单只有删除',
    !!$('.popover.ptt-menu [data-ptt-act="remove"]') && !$('.popover.ptt-menu [data-ptt-act="freeze"]'),
  );
  click($('.popover.ptt-menu [data-ptt-act="remove"]'));
  await pause(60);
  t(
    '删除备选：撤回通过，从备选轨上拿掉',
    !us(0).some(u => u.assetId === aid('P1b')) && cand('P1b').decision === '' && !blockOf('P1b'),
  );
  undo();
  await pause(60);
  t('删除可以一步撤销', roleOf('P1b') === 'alt' && cand('P1b').decision === 'ok');
  dbl(blockOf('P1a'));
  await pause(30);
  t(
    '双击正片：菜单有定格补满和删除',
    !!$('.popover.ptt-menu [data-ptt-act="freeze"], .popover.ptt-menu [data-ptt-act="unfreeze"]') &&
      !!$('.popover.ptt-menu [data-ptt-act="remove"]'),
  );
  click($('.popover.ptt-menu [data-ptt-act="remove"]'));
  await pause(60);
  t('删除正片：从正片轨上拿掉', !us(0).some(u => u.assetId === aid('P1a')) && !blockOf('P1a'));
  undo();
  await pause(60);
  setView('table');
  await pause(30);
  storage.switchProject(original);
  storage.deleteProject(trackPid);

  /* 分散句子的返工单：真实生成入口、导入约束、原批注展示、切项目持久化。 */
  storage.createProject('分散返工测试', parseAny('甲。乙。丙。丁。戊。'), {}, { mediaDir: '/tmp/返工测试' });
  const reworkPid = state.projectId;
  setReworkNote(lines()[0], '开头换成近景');
  setReworkNote(lines()[4], '结尾画面太暗');
  let replyDoc = null;
  let writeOk = false;
  window.fjtHooks.writeReworkDoc = async (_file, content) => {
    replyDoc = JSON.parse(content);
    return { ok: writeOk, error: '测试写入失败' };
  };
  openRework();
  await pause(30);
  click('#vrReworkDoc');
  await pause(50);
  t('返工单写入失败时不登记任务，也不显示已生成', !Object.keys(state.reworkRequests).length && !$('#vrNav .vr-bother'));
  writeOk = true;
  click('#vrReworkDoc');
  await pause(50);
  t(
    '首尾两句的返工单逐项列出，登记目标身份与批注',
    replyDoc?.sentences === '第1、5句' &&
      replyDoc.shots.map(s => s.lines).join() === '1,5' &&
      state.reworkRequests[replyDoc.id]?.targets.length === 2 &&
      state.reworkRequests[replyDoc.id].targets[0].note === '开头换成近景',
  );
  const replyShot = n => ({
    lines: String(n),
    label: '重找',
    plans: [
      {
        cands: [
          {
            key: `reply-${n}`,
            title: '新视频',
            url: `https://example.com/reply-${n}.mp4`,
            in: 0,
            out: 12,
            best: { in: 1, out: 11 },
            license: '版权未核实',
            why: '按批注重找',
          },
        ],
      },
    ],
  });
  const reply = {
    type: 'fenjingtai-candidates',
    version: 3,
    project: state.title,
    batch: 'AI乱写第1-999句',
    reworkId: replyDoc.id,
    shots: [replyShot(1), replyShot(5)],
  };
  const invalid = importCandidateData({ ...reply, shots: [replyShot(2)] }, '/tmp/错误回复.json');
  t('应用导入入口拒收返工单之外的画面，候选保持原样', !!invalid.error && !state.candidates.length);
  const missing = importCandidateData({ ...reply, reworkId: undefined }, '/tmp/无标记回复.json');
  t('应用导入入口不能靠删掉返工标记绕过范围检查', !!missing.error && !state.candidates.length);
  importLoadedFile({ name: '正确返工回复.json', path: '/tmp/正确返工回复.json', content: JSON.stringify(reply) });
  await pause(40);
  t(
    '返回素材按实际分散句子命名，忽略 AI 的整段批名，并显示原批注',
    curBatchHead()?.textContent.includes('第1、5句 · 重找') &&
      $('#vrList .vr-rework-note')?.textContent.includes('开头换成近景') &&
      !curBatchHead()?.textContent.includes('999') &&
      state.candidates.length === 2,
  );
  storage.switchProject(original);
  storage.switchProject(reworkPid);
  update('rows');
  await pause(30);
  t(
    '切回项目后返工关联与原批注仍在',
    state.reworkRequests[replyDoc.id]?.targets[1].note === '结尾画面太暗' &&
      state.candidates.every(c => c.reworkId === replyDoc.id),
  );
  delete window.fjtHooks.writeReworkDoc;
  storage.switchProject(original);
  storage.deleteProject(reworkPid);

  storage.createProject(
    '分散名单布局测试',
    parseAny(Array.from({ length: 30 }, (_, i) => `第${i + 1}句话。`).join('')),
  );
  const layoutPid = state.projectId;
  importLoadedFile({
    name: '分散名单.json',
    path: '/tmp/分散名单.json',
    content: JSON.stringify({
      ...reply,
      reworkId: undefined,
      shots: Array.from({ length: 12 }, (_, i) => replyShot(i * 2 + 1)),
    }),
  });
  await pause(30);
  click('#vrBatchPick');
  const menu = $('.popover');
  const item = menu?.querySelector('.vr-bpick');
  t(
    '很多分散句子的名单显示数量与完整句号，菜单宽度受限且文字不溢出',
    item?.textContent.includes('视频素材 · 共12句') &&
      item?.querySelector('.desc')?.textContent.includes('第1、3、5、7、9、11、13、15、17、19、21、23句') &&
      menu.getBoundingClientRect().width <= 442 &&
      item.scrollWidth <= item.clientWidth + 1,
  );
  click('#vrBatchPick');
  storage.switchProject(original);
  storage.deleteProject(layoutPid);

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
