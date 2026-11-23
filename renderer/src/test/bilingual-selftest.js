/* 英配中字模式（YouTube 工作流）端到端 UI 自测：
   覆盖纯中文零回归、英文/双语稿自动开启、表格内联编辑与撤销不重建、中文搜索高亮、
   中文字幕 SRT / 双语 SRT 导入、连播画面 YouTube 字幕叠层与 C 键切换、导出菜单与弹窗。 */
import { state } from '../app/state.js';
import { viewState } from '../app/view-state.js';
import { update } from '../app/project-events.js';
import * as storage from '../app/storage.js';
import { undo, clearUndo } from '../app/undo.js';
import { parseAny } from '../core/parse.js';
import { runCommand } from '../ui/base/commands.js';
import { closePop } from '../ui/base/popover.js';
import { openSearch, closeSearch } from '../ui/search.js';
import { previewImport } from '../ui/import-export.js';
import { closePlaythrough, playthroughKey, playthroughState } from '../features/playthrough.js';
import { setCcMode } from '../features/cc-pref.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const click = el => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

export async function runBilingualTests(t) {
  const original = state.projectId;
  const created = [];
  const prevSubShow = localStorage.getItem('fjz:subShow');
  const prevCcMode = localStorage.getItem('fjz:ccMode');
  try {
    localStorage.setItem('fjz:subShow', '1');
    setCcMode('zh');
    viewState.view = 'table';
    viewState.filter = 'all';
    viewState.query = '';

    /* 1. 纯中文项目零回归 */
    const monoId = storage.createProject('纯中文零回归', parseAny('第一句中文口播。\n第二句中文口播。'));
    created.push(monoId);
    update('rows');
    await sleep(40);
    t(
      '纯中文项目不显示英配中字表格外壳与中字按钮',
      !$('#tablePage').classList.contains('mode-en-zh') &&
        $('#btnSubToggle').hidden &&
        $$('#rows .sent-sub').length === 0,
    );
    click($('#btnExport'));
    t(
      '纯中文项目导出菜单保持 4 项（不含 SRT）',
      $$('.popover [data-x]')
        .map(el => el.dataset.x)
        .join(',') === 'review,jianying,pdf,json',
    );
    closePop();

    /* 2. 导入英文稿自动识别并开启英配中字模式 */
    const enRows = parseAny(
      '## Opening\nIn 1984 a tiny aluminum can changed the beverage industry forever. Everyone laughed at the taste at first.',
    );
    previewImport(enRows, 'YouTube 英文稿测试');
    await sleep(30);
    t(
      '英文稿导入预览提示将自动开启英配中字模式',
      $('#importSummary').textContent.includes('英配中字模式'),
      $('#importSummary').textContent,
    );
    $('#importMode').value = 'new';
    click($('#acceptImport'));
    await sleep(50);
    created.push(state.projectId);
    t(
      '导入英文稿后自动启用英配中字模式并显示中字开关与译文槽',
      state.langMode === 'en-zh' &&
        $('#tablePage').classList.contains('mode-en-zh') &&
        !$('#btnSubToggle').hidden &&
        $$('#rows .sent-sub').length === 2,
    );

    /* 3. 工具栏「中字」开关切换隐藏/显示，不重建表格节点 */
    const firstRowNode = $('#rows .row[data-id]');
    click($('#btnSubToggle'));
    await sleep(30);
    t(
      '点击「中字」按钮可隐藏表格中文字幕且保留原行节点',
      $('#tablePage').classList.contains('hide-subs') && $('#rows .row[data-id]') === firstRowNode,
    );
    click($('#btnSubToggle'));
    await sleep(30);
    t('再次点击「中字」按钮恢复显示', !$('#tablePage').classList.contains('hide-subs'));

    /* 4. 表格中文字幕原地编辑 + ⌘Z 撤销（不重建整张表） */
    clearUndo();
    const firstLine = state.rows.find(r => r.kind === 'line');
    const subEl = $(`#rows .sent-sub[data-id="${firstLine.id}"]`);
    subEl.focus();
    subEl.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    subEl.textContent = '1984 年，一只小小的铝罐彻底改变了饮料行业。';
    subEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
    subEl.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    subEl.blur();
    await sleep(40);
    t(
      '原地编辑中文字幕写回 row.sub 且不重建 DOM 节点',
      firstLine.sub === '1984 年，一只小小的铝罐彻底改变了饮料行业。' &&
        $(`#rows .sent-sub[data-id="${firstLine.id}"]`) === subEl,
    );
    undo();
    await sleep(40);
    const restoredLine = state.rows.find(r => r.id === firstLine.id);
    t(
      '撤销中文字幕编辑恢复为空且保持原地更新',
      !restoredLine?.sub &&
        $(`#rows .sent-sub[data-id="${firstLine.id}"]`)?.textContent === '' &&
        $(`#rows .sent-sub[data-id="${firstLine.id}"]`) === subEl,
    );

    /* 5. 对齐英文 SRT + 挂载中文 SRT（绝不覆盖英文时间轴） */
    const enSrt = [
      '1',
      '00:00:00,000 --> 00:00:04,000',
      'In 1984 a tiny aluminum can changed the beverage industry forever.',
      '',
      '2',
      '00:00:04,500 --> 00:00:08,000',
      'Everyone laughed at the taste at first.',
    ].join('\n');
    runCommand('srt:start', { name: 'en.srt', content: enSrt });
    await sleep(30);
    t('对齐英文字幕弹窗打开且默认选中对齐模式', $('#srtMask').classList.contains('show'));
    click($('#srtApply'));
    await sleep(40);
    const linesNow = state.rows.filter(r => r.kind === 'line');
    const enEndBefore = linesNow[0].time?.end;
    t('英文 SRT 对齐后写入真实时间轴', linesNow[0].time?.st === 'ok' && enEndBefore === 4);

    const zhSrt = [
      '1',
      '00:00:00,200 --> 00:00:03,800',
      '1984 年一只铝罐改变了整个饮料行业。',
      '',
      '2',
      '00:00:04,600 --> 00:00:07,900',
      '一开始所有人都嘲笑它的味道。',
    ].join('\n');
    runCommand('srt:start', { name: 'zh.srt', content: zhSrt });
    await sleep(30);
    t(
      '中文字幕自动识别为挂载中文字幕模式',
      $('#srtMask').classList.contains('show') && $('#srtApply').textContent.includes('挂载中文字幕'),
      $('#srtApply').textContent,
    );
    click($('#srtApply'));
    await sleep(40);
    t(
      '挂载中文字幕填入 row.sub 与 subTiming 且不改动英文时间轴',
      linesNow[0].sub === '1984 年一只铝罐改变了整个饮料行业。' &&
        linesNow[1].sub === '一开始所有人都嘲笑它的味道。' &&
        state.subTiming?.cues?.length === 2 &&
        linesNow[0].time?.end === enEndBefore,
    );

    /* 6. 搜索中文关键词直接命中英文句并在 .sent-sub 高亮 */
    openSearch();
    const sInput = $('#searchInput');
    sInput.value = '嘲笑';
    sInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(220);
    const row2 = $(`#rows .row[data-id="${linesNow[1].id}"]`);
    const row1 = $(`#rows .row[data-id="${linesNow[0].id}"]`);
    t(
      '中文搜索词命中对应英文句并在 .sent-sub 内高亮 <mark>',
      row2 &&
        !row2.classList.contains('qdim') &&
        row1?.classList.contains('qdim') &&
        row2.querySelector('.sent-sub mark')?.textContent === '嘲笑',
    );
    closeSearch();
    await sleep(30);
    t('关闭搜索后清除 .sent-sub 内的 <mark>', !row2.querySelector('.sent-sub mark'));

    /* 7. 连播预览 YouTube 中文字幕叠层、C 键切换与静音消隐 */
    runCommand('playthrough:from', linesNow[0].id);
    await sleep(60);
    // 暂停播放后点击镜头刻度尺跳到第 1 句内部（unit 0 为 0s–4.5s，30% 约 1.35s，落在第一条中文字幕 0.2s–3.8s 内）
    playthroughKey({ key: ' ', preventDefault() {} });
    const scrubPt = frac => {
      const target = $('#ptMask #pttRuler') || $('#ptMask .pt-progress');
      const rect = target.getBoundingClientRect();
      const x = rect.left + rect.width * frac;
      target.dispatchEvent(
        new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: x, clientY: rect.top + 2, bubbles: true }),
      );
      target.dispatchEvent(
        new PointerEvent('pointerup', { button: 0, pointerId: 1, clientX: x, clientY: rect.top + 2, bubbles: true }),
      );
    };
    scrubPt(0.3);
    await sleep(40);
    t(
      '连播窗口：画面叠加中文字幕 #ptCc，底栏显示英文原稿，且 #ptStage 不混入字幕节点',
      $('#ptMask').classList.contains('show') &&
        !$('#ptCc').hidden &&
        $('#ptCc .pt-cc-zh')?.textContent.includes('铝罐') &&
        $('#ptSub').textContent === linesNow[0].text &&
        !$('#ptStage .pt-cc') &&
        !$('#ptCcBtn').hidden &&
        $('#ptCcBtn').textContent === '中字',
      `t=${playthroughState().time} cc=${$('#ptCc')?.innerHTML} sub=${$('#ptSub')?.textContent}`,
    );
    // 按 C 键循环：zh -> both -> en -> off -> zh
    playthroughKey({ key: 'c', preventDefault() {} });
    await sleep(30);
    t(
      '按 C 切到双语叠字（上中下英）',
      playthroughState().ccMode === 'both' &&
        $('#ptCcBtn').textContent === '双语' &&
        !!$('#ptCc .pt-cc-zh') &&
        !!$('#ptCc .pt-cc-en'),
    );
    playthroughKey({ key: 'c', preventDefault() {} });
    await sleep(30);
    t('再按 C 切到仅英字叠层', playthroughState().ccMode === 'en' && !$('#ptCc .pt-cc-zh') && !!$('#ptCc .pt-cc-en'));
    playthroughKey({ key: 'c', preventDefault() {} });
    await sleep(30);
    t('再按 C 关闭画面叠字', playthroughState().ccMode === 'off' && $('#ptCc').hidden);
    playthroughKey({ key: 'c', preventDefault() {} });
    await sleep(30);
    t('再按 C 回到中字叠层', playthroughState().ccMode === 'zh' && !$('#ptCc').hidden);
    // 跳到 3.8s–4.5s 句间停顿（unit 0 的 93% 约 4.18s），中文字幕自动消隐
    scrubPt(0.93);
    await sleep(40);
    t('句间静音空隙自动隐藏中文字幕叠层', $('#ptCc').hidden, `t=${playthroughState().time}`);
    closePlaythrough();
    await sleep(30);

    /* 8. 导出菜单、导出 SRT 弹窗、PDF 与剪映多语言字幕选项 */
    click($('#btnExport'));
    t(
      '英配中字项目导出菜单出现字幕文件（SRT）入口',
      $$('.popover [data-x]')
        .map(el => el.dataset.x)
        .join(',') === 'review,jianying,pdf,srt,json',
    );
    const srtItem = $('.popover [data-x="srt"]');
    click(srtItem);
    await sleep(30);
    t(
      '导出 SRT 弹窗默认选中中文字幕且导出按钮可用',
      $('#srtExportMask').classList.contains('show') &&
        $('input[name="srtExportTrack"]:checked')?.value === 'zh' &&
        !$('#srtExportGo').disabled,
    );
    click($('#srtExportCancel'));
    await sleep(20);

    runCommand('pdf:open');
    await sleep(30);
    t('PDF 弹窗在双语项目显示「附带中文字幕对照」选项', !$('#pdfSubsRow').hidden && $('#pdfSubs').checked);
    click($('#pdfCancel'));
    await sleep(20);

    /* 9. 空项目直接导入双语 SRT 一步生成英文稿 + 中文字幕 + 双轨时间 */
    const emptyId = storage.createProject('未命名项目', []);
    created.push(emptyId);
    update('rows');
    await sleep(30);
    const biSrt = [
      '1',
      '00:00:00,000 --> 00:00:03,000',
      'This is a bilingual subtitle demo.',
      '这是一份双语字幕演示。',
      '',
      '2',
      '00:00:03,500 --> 00:00:06,500',
      'One drag creates the whole project.',
      '一次拖入就能建好整套项目。',
    ].join('\n');
    runCommand('srt:start', { name: 'youtube-ep1.srt', content: biSrt });
    await sleep(30);
    t('空项目读入双语 SRT 打开一步导入预览', $('#srtMask').classList.contains('show'));
    click($('#srtApply'));
    await sleep(40);
    const builtLines = state.rows.filter(r => r.kind === 'line');
    t(
      '空项目双语 SRT 导入一步生成英文句、中文字幕与双轨时间',
      state.langMode === 'en-zh' &&
        state.title === 'youtube-ep1' &&
        builtLines.length === 2 &&
        builtLines[0].sub === '这是一份双语字幕演示。' &&
        state.timing?.cues?.length === 2 &&
        state.subTiming?.cues?.length === 2,
    );
    undo();
    await sleep(30);
    t('空项目双语 SRT 导入支持 ⌘Z 一步撤销', state.rows.length === 0);
  } finally {
    closePlaythrough();
    closePop();
    closeSearch();
    $('#srtMask')?.classList.remove('show');
    $('#subPasteMask')?.classList.remove('show');
    $('#srtExportMask')?.classList.remove('show');
    $('#pdfMask')?.classList.remove('show');
    $('#importPreviewMask')?.classList.remove('show');
    if (prevSubShow == null) localStorage.removeItem('fjz:subShow');
    else localStorage.setItem('fjz:subShow', prevSubShow);
    if (prevCcMode == null) localStorage.removeItem('fjz:ccMode');
    else localStorage.setItem('fjz:ccMode', prevCcMode);
    if (original) storage.switchProject(original);
    for (const id of created) {
      if (id && id !== original) storage.deleteProject(id, { permanent: true });
    }
    update('rows');
    await sleep(40);
  }
}
