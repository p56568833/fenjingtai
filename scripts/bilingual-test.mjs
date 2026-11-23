/* 英配中字模式（YouTube 工作流）与底盘修复核心自动化测试（纯 Node） */
import assert from 'node:assert/strict';
import { fmtLen, fmtTc, joinSentences } from '../renderer/src/core/text.js';
import { parseScript, parseAny } from '../renderer/src/core/parse.js';
import { parseSubtitles, alignScript } from '../renderer/src/core/subtitle-align.js';
import { buildTimeline } from '../renderer/src/core/timeline.js';
import {
  hasCjk,
  detectScriptLang,
  isLatinDominant,
  isBilingualProject,
  parseBilingualLines,
  inspectSubtitleCues,
  rowsFromBilingualSrt,
  mapSubCuesToLines,
  parseBatchTranslations,
  cueAtTime,
  resolvePlaybackSub,
  buildSrtDocument,
} from '../renderer/src/core/bilingual.js';
import { projectData, normalizeProjectData } from '../renderer/src/core/project-data.js';
import { normalizeProjectRows, reconcileDraft } from '../renderer/src/core/project-import.js';
import { prepareProjectEdit } from '../renderer/src/core/project-edit.js';
import { projectRefresh } from '../renderer/src/core/project-refresh.js';
import { searchLineIds } from '../renderer/src/core/search.js';
import { buildPrintDoc } from '../renderer/src/core/print-doc.js';
import { buildReworkDoc } from '../renderer/src/core/rework.js';
import { buildEditExportPlan } from '../renderer/src/core/edit-export-plan.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}\n`, err);
    process.exitCode = 1;
  }
}

/* ── 1. Phase 1 核心底盘回归 ── */

test('时间格式化进位：不出现 0 分 60 秒或 60 秒', () => {
  assert.equal(fmtLen(59.96), '1 分 00 秒');
  assert.equal(fmtLen(119.98), '2 分 00 秒');
  assert.ok(!fmtTc(59.9999).includes(':60'));
  assert.equal(fmtTc(60), '01:00.0');
});

test('英文分句：保留缩写、小数、网址与省略号，正确切分英文长句', () => {
  const rows = parseScript(
    'Dr. Smith invested $3.5B in the U.S. market via https://example.com/a.b today. Wait... Really? Yes, it worked!',
  );
  const texts = rows.filter(r => r.kind === 'line').map(r => r.text);
  assert.equal(texts.length, 4, JSON.stringify(texts));
  assert.ok(
    texts[0].includes('Dr. Smith') && texts[0].includes('$3.5B') && texts[0].includes('https://example.com/a.b'),
  );
  assert.equal(texts[1], 'Wait...');
  assert.equal(texts[2], 'Really?');
  assert.equal(texts[3], 'Yes, it worked!');
});

test('中英文拼接：拉丁词之间补空格，中文之间不补空格', () => {
  assert.equal(joinSentences(['Hello', 'world']), 'Hello world');
  assert.equal(joinSentences(['今天讲', '一个故事']), '今天讲一个故事');
  assert.equal(joinSentences(['Open', 'AI']), 'Open AI');
});

test('英文口播 SRT 词级对齐与 VTT 滚动去重、实体解码、ASS 解析', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:03.000',
    'Welcome back &amp; let&apos;s explore how Apple',
    '',
    '00:00:03.000 --> 00:00:06.500',
    'Welcome back &amp; let&apos;s explore how Apple',
    'built the fastest supply chain in the world.',
    '',
    '00:00:07.000 --> 00:00:11.000',
    'Every single component arrives just in time.',
  ].join('\n');
  const cues = parseSubtitles(vtt);
  assert.equal(cues.length, 3);
  assert.ok(cues[0].text.includes("Welcome back & let's"));
  assert.equal(cues[1].text, 'built the fastest supply chain in the world.');

  const lines = [
    {
      id: 1,
      kind: 'line',
      text: "Welcome back & let's explore how Apple built the fastest supply chain in the world.",
    },
    { id: 2, kind: 'line', text: 'Every single component arrives just in time.' },
  ];
  const aligned = alignScript(lines, cues);
  assert.equal(aligned.stats.ok, 2);
  assert.ok(aligned.times.get(1).start <= 0.1 && aligned.times.get(1).end >= 6.4);
  assert.ok(aligned.times.get(2).start >= 6.9 && aligned.times.get(2).end >= 10.9);

  const ass = `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an2}Hello\\N你好世界`;
  const assCues = parseSubtitles(ass);
  assert.equal(assCues.length, 1);
  assert.deepEqual(assCues[0].rawLines, ['Hello', '你好世界']);
});

test('剪映导出计划自动剥离本地视频路径上的 #t= 片段参数', () => {
  const plan = buildEditExportPlan(
    {
      title: '片段路径测试',
      rows: [
        {
          id: 1,
          kind: 'line',
          text: '测试一句。',
          time: { start: 0, end: 3, conf: 1, st: 'ok' },
          assetUsages: [{ assetId: 'a1', role: 'main', clip: { in: 1, out: 4 } }],
        },
      ],
      assets: { a1: { id: 'a1', kind: 'video', name: 'clip.mp4', path: '/tmp/clip.mp4#t=1,4', durationSec: 10 } },
    },
    {},
    { probes: { '/tmp/clip.mp4': { exists: true, durationSec: 10, isImage: false } } },
  );
  assert.equal(plan.assets[0].path, '/tmp/clip.mp4');
});

/* ── 2. 英配中字模式（YouTube 工作流）核心测试 ── */

test('语种识别：含英文品牌/缩写词的中文句不会误判为英文', () => {
  assert.equal(hasCjk('你好'), true);
  assert.equal(hasCjk('Hello'), false);
  assert.equal(detectScriptLang('2024 年礼来靠 GLP-1 药物营收暴涨，Le Labo 也在涨价。'), 'zh');
  assert.equal(detectScriptLang('Today we uncover how Eli Lilly built a billion dollar empire.'), 'en');
  assert.equal(isLatinDominant('How Red Bull conquered extreme sports marketing worldwide.'), true);
  assert.equal(isLatinDominant('今天聊一聊 YouTube 频道怎么做。'), false);
});

test('双语稿件解析：支持 || / Tab 同行对照与英中交替双行，且不误伤纯中文/纯英文稿', () => {
  const inlineDoc = [
    '## Opening',
    'In 1984, a small drink changed energy forever. || 1984 年，一罐小饮料彻底改变了功能饮料行业。',
    '这背后其实是一场顶级营销课。 || Behind it was a masterclass in brand marketing.',
  ].join('\n');
  const rowsA = parseAny(inlineDoc);
  const linesA = rowsA.filter(r => r.kind === 'line');
  assert.equal(rowsA[0].kind, 'section');
  assert.equal(linesA.length, 2);
  assert.equal(linesA[0].text, 'In 1984, a small drink changed energy forever.');
  assert.equal(linesA[0].sub, '1984 年，一罐小饮料彻底改变了功能饮料行业。');
  assert.equal(linesA[1].text, 'Behind it was a masterclass in brand marketing.');
  assert.equal(linesA[1].sub, '这背后其实是一场顶级营销课。');

  const altDoc = [
    '# Chapter 1',
    'Everyone thought the formula was too strange to sell.',
    '所有人都觉得这个配方太怪了，根本卖不出去。',
    'Yet within ten years it dominated every gas station in Europe.',
    '然而短短十年，它就占领了欧洲每一家加油站。',
  ].join('\n');
  const rowsB = parseAny(altDoc);
  const linesB = rowsB.filter(r => r.kind === 'line');
  assert.equal(linesB.length, 2);
  assert.equal(linesB[0].sub, '所有人都觉得这个配方太怪了，根本卖不出去。');
  assert.equal(linesB[1].sub, '然而短短十年，它就占领了欧洲每一家加油站。');

  assert.equal(parseBilingualLines('第一句中文。\n第二句中文含 GLP-1 关键词。'), null);
  assert.equal(parseBilingualLines('First English sentence here.\nSecond English sentence here.'), null);
});

test('双语 SRT 自动拆轨、译文字幕识别与空项目直接生成英文稿+中文字幕', () => {
  const biSrt = [
    '1',
    '00:00:00,000 --> 00:00:03,200',
    'This is the hidden factory behind the hype.',
    '这就是爆火背后鲜为人知的工厂。',
    '',
    '2',
    '00:00:03,800 --> 00:00:07,500',
    'And nobody noticed until the price doubled.',
    '直到价格翻倍，大家才反应过来。',
  ].join('\n');
  const cues = parseSubtitles(biSrt);
  const info = inspectSubtitleCues(cues, []);
  assert.equal(info.kind, 'bilingual');
  assert.equal(info.enCues.length, 2);
  assert.equal(info.zhCues.length, 2);
  assert.equal(info.enCues[0].text, 'This is the hidden factory behind the hype.');
  assert.equal(info.zhCues[0].text, '这就是爆火背后鲜为人知的工厂。');

  const built = rowsFromBilingualSrt(cues);
  assert.equal(built.rows.length, 2);
  assert.equal(built.rows[0].sub, '这就是爆火背后鲜为人知的工厂。');
  assert.equal(built.rows[0].time.start, 0);
  assert.equal(built.rows[1].time.end, 7.5);

  const zhSrt = parseSubtitles(
    '1\n00:00:00,000 --> 00:00:03,000\n这是中文翻译字幕。\n\n2\n00:00:03,500 --> 00:00:06,000\n这是第二句中文。',
  );
  const trInfo = inspectSubtitleCues(zhSrt, built.rows);
  assert.equal(trInfo.kind, 'translation');
  const srcInfo = inspectSubtitleCues(zhSrt, [{ kind: 'line', text: '这是纯中文稿子第一句。' }]);
  assert.equal(srcInfo.kind, 'source');
});

test('中文字幕轨映射、静音消隐与手工修改所见即所得（WYSIWYG）', () => {
  const lines = [
    { id: 1, kind: 'line', text: 'First sentence in English.', time: { start: 0, end: 3, conf: 1, st: 'ok' } },
    { id: 2, kind: 'line', text: 'Second sentence in English.', time: { start: 4, end: 7, conf: 1, st: 'ok' } },
  ];
  const tl = buildTimeline(lines);
  const subCues = [
    { start: 0.1, end: 1.5, text: '第一句前半。' },
    { start: 1.6, end: 2.9, text: '第一句后半。' },
    { start: 4.1, end: 6.8, text: '第二句中文。' },
  ];
  const mapped = mapSubCuesToLines(lines, tl, subCues);
  assert.equal(mapped.matched, 2);
  lines[0].sub = mapped.mapped.get(1);
  lines[1].sub = mapped.mapped.get(2);
  assert.equal(lines[0].sub, '第一句前半。第一句后半。');
  assert.equal(cueAtTime(subCues, 0.5)?.text, '第一句前半。');
  assert.equal(cueAtTime(subCues, 3.5), null);

  const subTiming = { name: 'zh.srt', cues: subCues, raw: '' };
  // 未手改：精准随 subTiming 跳字 + 静音空隙消隐
  const r1 = resolvePlaybackSub({ row: lines[0], time: 0.8, subTiming, tl, displayMode: 'zh', bilingual: true });
  assert.equal(r1.showOverlay, true);
  assert.equal(r1.overlayZh, '第一句前半。');
  assert.equal(r1.barText, 'First sentence in English.');

  const rGap = resolvePlaybackSub({ row: lines[0], time: 3.5, subTiming, tl, displayMode: 'zh', bilingual: true });
  assert.equal(rGap.showOverlay, false);
  assert.equal(rGap.overlayZh, '');

  // 双语 / 仅英文 / 关闭模式
  const rBoth = resolvePlaybackSub({ row: lines[0], time: 2.0, subTiming, tl, displayMode: 'both', bilingual: true });
  assert.equal(rBoth.overlayZh, '第一句后半。');
  assert.equal(rBoth.overlayEn, 'First sentence in English.');
  const rOff = resolvePlaybackSub({ row: lines[0], time: 2.0, subTiming, tl, displayMode: 'off', bilingual: true });
  assert.equal(rOff.showOverlay, false);

  // 手工改过 row.sub：立刻所见即所得，不再被旧 subTiming 盖住
  lines[0].sub = '校对后的第一句中文。';
  const rEdited = resolvePlaybackSub({ row: lines[0], time: 0.8, subTiming, tl, displayMode: 'zh', bilingual: true });
  assert.equal(rEdited.overlayZh, '校对后的第一句中文。');

  // 非双语项目完全不变
  const rMono = resolvePlaybackSub({ row: lines[0], time: 0.8, subTiming, tl, displayMode: 'zh', bilingual: false });
  assert.equal(rMono.showOverlay, false);
  assert.equal(rMono.barText, 'First sentence in English.');
});

test('批量粘贴中文译文：跳过章节标题并按句映射', () => {
  const lines = [
    { id: 1, kind: 'line', text: 'One.' },
    { id: 2, kind: 'line', text: 'Two.' },
    { id: 3, kind: 'line', text: 'Three.' },
  ];
  const res = parseBatchTranslations('## 第一章\n第一句。\n第二句。\n第三句。\n多出一句。', lines);
  assert.equal(res.matched, 3);
  assert.equal(res.extra, 1);
  assert.equal(res.mapped.get(2), '第二句。');
});

test('SRT 导出：支持中字 / 英字 / 中英双语，遵循 WYSIWYG 与 --> 转义', () => {
  const project = {
    title: 'YT Demo',
    langMode: 'en-zh',
    rows: [
      {
        id: 1,
        kind: 'line',
        text: 'A --> B test.',
        sub: '手工校对中字 --> 展示',
        time: { start: 0, end: 3, conf: 1, st: 'ok' },
      },
      {
        id: 2,
        kind: 'line',
        text: 'Second line.',
        sub: '第二句中文',
        time: { start: 2.8, end: 5.5, conf: 1, st: 'ok' },
      },
    ],
    subTiming: {
      name: 'old.srt',
      cues: [{ start: 0, end: 3, text: '旧译文' }],
      raw: '1\n00:00:00,000 --> 00:00:03,000\n旧译文\n',
    },
  };
  const zhDoc = buildSrtDocument({ project, track: 'zh' });
  assert.equal(zhDoc.count, 2);
  assert.ok(zhDoc.srt.includes('手工校对中字 → 展示'));
  assert.ok(!zhDoc.srt.includes('旧译文'));
  // 微重叠裁切：第一条结束时间被裁到 00:00:02,800
  assert.ok(zhDoc.srt.includes('00:00:00,000 --> 00:00:02,800'));

  const biDoc = buildSrtDocument({ project, track: 'bilingual' });
  assert.equal(biDoc.count, 2);
  assert.ok(biDoc.srt.includes('第二句中文\nSecond line.'));
});

test('序列化、校验、局部刷新、搜索、PDF、返工单与剪映导出全面兼容英配中字', () => {
  // 纯中文项目不污染序列化
  const mono = projectData(
    { title: '中文稿', rows: [{ id: 1, kind: 'line', text: '你好。', note: '', type: null }] },
    'exchange',
  );
  assert.equal('langMode' in mono, false);
  assert.equal('subTiming' in mono, false);
  assert.equal(isBilingualProject(mono), false);

  // 双语项目完整持久化与往返
  const biState = {
    title: 'YouTube Ep1',
    langMode: 'en-zh',
    rows: [
      {
        id: 1,
        kind: 'line',
        text: 'Apple revolutionized retail.',
        sub: '苹果彻底改变了零售业。',
        note: '门店画面',
        type: 'B',
        time: { start: 0, end: 3, conf: 1, st: 'ok' },
      },
      {
        id: 2,
        kind: 'line',
        text: 'Nobody expected the glass cube.',
        sub: '没人料到那座玻璃立方体。',
        note: '',
        type: 'B',
        time: { start: 3, end: 6, conf: 1, st: 'ok' },
      },
    ],
    subTiming: { name: 'zh.srt', cues: [{ start: 0, end: 3, text: '苹果彻底改变了零售业。' }], raw: '' },
  };
  const dumped = projectData(biState, 'exchange');
  assert.equal(dumped.langMode, 'en-zh');
  assert.equal(dumped.subTiming.cues.length, 1);
  const norm = normalizeProjectData(dumped);
  assert.equal(norm.langMode, 'en-zh');
  assert.equal(norm.subTiming.cues.length, 1);
  const normRows = normalizeProjectRows(dumped.rows);
  assert.equal(normRows[0].sub, '苹果彻底改变了零售业。');
  assert.equal(isBilingualProject(norm), true);

  // 改稿继承旧译文
  const rec = reconcileDraft(biState.rows, [{ id: 10, kind: 'line', text: 'Apple revolutionized retail.' }]);
  assert.equal(rec.rows[0].sub, '苹果彻底改变了零售业。');

  // 编辑校验与刷新范围隔离
  const validEdit = prepareProjectEdit(biState, {
    project: { langMode: 'en-zh' },
    rows: [{ id: 1, values: { sub: '新译文' } }],
  });
  assert.equal(validEdit.changed, true);
  assert.throws(() => prepareProjectEdit(biState, { project: { langMode: 'fr-zh' } }));
  const subRefresh = projectRefresh({ fields: [], rowFields: ['sub'] });
  assert.equal(subRefresh.subs, true);
  assert.equal(subRefresh.table, false);
  assert.equal(subRefresh.notes, false);
  const modeRefresh = projectRefresh({ fields: ['langMode'], rowFields: [] });
  assert.equal(modeRefresh.table, true);
  assert.equal(modeRefresh.review, true);

  // 中文关键词直接搜中英文句
  assert.deepEqual(searchLineIds(biState.rows, '玻璃立方体'), [2]);
  assert.deepEqual(searchLineIds(biState.rows, 'Apple'), [1]);

  // PDF 附带与关闭中文字幕
  const pdfWith = buildPrintDoc(biState, { subtitles: true });
  assert.ok(pdfWith.html.includes('class="tx-sub"') && pdfWith.html.includes('苹果彻底改变了零售业。'));
  const pdfWithout = buildPrintDoc(biState, { subtitles: false });
  assert.ok(!pdfWithout.html.includes('class="tx-sub"') && !pdfWithout.html.includes('苹果彻底改变了零售业。'));

  // 返工单透传中文译文
  const rwLine = { ...biState.rows[0], no: 1 };
  const rwDoc = buildReworkDoc({
    title: biState.title,
    shots: [
      {
        lead: rwLine,
        members: [rwLine],
        target: [rwLine],
        forTexts: [rwLine.text],
        requests: ['换夜景'],
        replaces: [],
        rejected: [],
        cands: [],
      },
    ],
    registry: {},
  });
  assert.equal(rwDoc.shots[0].each[0].sub, '苹果彻底改变了零售业。');

  // 剪映导出多语言文字轨（中字 / 双语）
  const planZh = buildEditExportPlan(biState, { subtitles: true, subtitleLang: 'zh' });
  assert.equal(planZh.subtitles.length, 2);
  assert.equal(planZh.subtitles[0].text, '苹果彻底改变了零售业。');
  const planBi = buildEditExportPlan(biState, { subtitles: true, subtitleLang: 'bilingual' });
  assert.equal(planBi.subtitles[0].text, '苹果彻底改变了零售业。\nApple revolutionized retail.');
});

if (process.exitCode) process.exit(process.exitCode);
console.log(`\n英配中字模式与底盘回归测试全部通过：${passed} 项`);
