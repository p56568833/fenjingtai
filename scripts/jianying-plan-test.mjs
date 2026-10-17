/* 剪映导出计划回归（纯函数，不需要 Electron / 真实剪映）：
   固定 12 秒样例 A 逐段断言，B 组覆盖顺序、共用画面、裁剪、off/回退、at 失效、自然停顿、
   留白、估算/字幕时间、定格、越界与精度。运行：node scripts/jianying-plan-test.mjs */
import assert from 'node:assert/strict';
import {
  buildEditExportPlan,
  collectPlanFiles,
  PLAN_DEFAULTS,
  SCHEMA_VERSION,
} from '../renderer/src/core/edit-export-plan.js';

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const FPS = 30;
const ids = () => {
  let n = 0;
  return prefix => `${prefix}-${++n}`;
};
const makePlan = (project, options = {}, deps = {}) =>
  buildEditExportPlan(
    project,
    { width: 1920, height: 1080, fps: FPS, ...options },
    { idFor: ids(), probes: {}, ...deps },
  );

const asset = (id, path, kind, extra = {}) => ({ id, path, name: path.split('/').pop(), kind, ...extra });
const assetsOf = list => Object.fromEntries(list.map(item => [item.id, item]));
const line = (id, no, text, time) => ({ id, kind: 'line', no, text, ...(time ? { time } : {}) });
const project = ({
  rows,
  assets = [],
  voice = null,
  speechRate,
  title = '测试项目',
  projectId = 'p1',
  updatedAt = 123,
}) => ({
  projectId,
  title,
  rows,
  assets: assetsOf(assets),
  types: [],
  speechRate: speechRate ?? 4.5,
  voice,
  updatedAt,
});

const pathOf = (plan, assetId) => {
  const hit = plan.assets.find(item => item.planId === assetId);
  if (hit) return hit.path;
  const derived = plan.derived.find(item => item.planId === assetId);
  return derived ? `${derived.sourcePath}#freeze` : assetId;
};
const videoSummary = plan =>
  plan.tracks.video.map(segment => ({
    kind: segment.kind,
    path: pathOf(plan, segment.assetId),
    start: segment.targetStartUs,
    dur: segment.targetDurationUs,
    sourceStart: segment.sourceStartUs,
    sourceDur: segment.sourceDurationUs,
    derived: segment.derived === true,
  }));
const hasIssue = (plan, code, level = null) =>
  plan.issues.some(issue => issue.code === code && (level == null || issue.level === level));
const issue = (plan, code) => plan.issues.find(item => item.code === code);

/* ── 固定样例 A：12 秒，0–3 视频 A（源 5–8）/ 3–5 图片 B / 5–6 手动留白 /
   6–8 视频 C（源 10–12）/ 8–12 定格 / 0–12 口播 ── */
function sampleA() {
  const rows = [
    line('L1', 1, '第一句话。', { start: 0, end: 2, st: 'ok' }),
    line('L2', 2, '第二句话。', { start: 2, end: 4, st: 'ok' }),
    line('L3', 3, '第三句话。', { start: 4, end: 6, st: 'ok' }),
    line('L4', 4, '最后一句长一点的话。', { start: 6, end: 12, st: 'ok' }),
  ];
  const usages = [
    { assetId: 'vA', role: 'main', clip: { in: 5, out: 8 }, at: { start: 0, end: 3, of: 'L1' } },
    { assetId: 'imgB', role: 'main', at: { start: 3, end: 5, of: 'L1' } },
    { assetId: 'vC', role: 'main', clip: { in: 10, out: 12 }, at: { start: 6, end: 12, of: 'L1' }, fitDone: true },
  ];
  for (const row of rows) {
    row.groupId = 'gA';
    row.assetUsages = usages.map(usage => JSON.parse(JSON.stringify(usage)));
  }
  return project({
    rows,
    assets: [
      asset('vA', '/media/a.mp4', 'video', { durationSec: 30 }),
      asset('imgB', '/media/b.png', 'image'),
      asset('vC', '/media/c.mp4', 'video', { durationSec: 30 }),
    ],
    voice: { path: '/media/voice.wav', name: 'voice.wav', duration: 12 },
  });
}

test('样例 A：视频 / 图片 / 定格逐段边界与源区间', () => {
  const plan = makePlan(sampleA(), { subtitles: true });
  assert.deepEqual(videoSummary(plan), [
    {
      kind: 'video',
      path: '/media/a.mp4',
      start: 0,
      dur: 3000000,
      sourceStart: 5000000,
      sourceDur: 3000000,
      derived: false,
    },
    {
      kind: 'image',
      path: '/media/b.png',
      start: 3000000,
      dur: 2000000,
      sourceStart: 0,
      sourceDur: 2000000,
      derived: false,
    },
    {
      kind: 'video',
      path: '/media/c.mp4',
      start: 6000000,
      dur: 2000000,
      sourceStart: 10000000,
      sourceDur: 2000000,
      derived: false,
    },
    {
      kind: 'image',
      path: '/media/c.mp4#freeze',
      start: 8000000,
      dur: 4000000,
      sourceStart: 0,
      sourceDur: 4000000,
      derived: true,
    },
  ]);
  assert.equal(plan.durationUs, 12000000);
  assert.equal(plan.tracks.video[0].speed, 1);
  assert.equal(plan.tracks.video[0].volume, 0);
});

test('样例 A：口播音轨、字幕、SRT、素材表、时间来源与统计', () => {
  const plan = makePlan(sampleA(), { subtitles: true });
  assert.equal(plan.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(plan.canvas, { width: 1920, height: 1080 });
  assert.deepEqual(plan.fps, { num: 30, den: 1 });
  assert.deepEqual(plan.source, { projectId: 'p1', updatedAt: 123, title: '测试项目' });

  assert.equal(plan.tracks.audio.length, 1);
  assert.deepEqual(
    {
      start: plan.tracks.audio[0].targetStartUs,
      dur: plan.tracks.audio[0].targetDurationUs,
      sourceStart: plan.tracks.audio[0].sourceStartUs,
      volume: plan.tracks.audio[0].volume,
      kind: plan.tracks.audio[0].kind,
    },
    { start: 0, dur: 12000000, sourceStart: 0, volume: 1, kind: 'audio' },
  );
  assert.equal(pathOf(plan, plan.tracks.audio[0].assetId), '/media/voice.wav');

  assert.deepEqual(
    plan.subtitles.map(item => [item.no, item.text, item.startUs, item.endUs]),
    [
      [1, '第一句话。', 0, 2000000],
      [2, '第二句话。', 2000000, 4000000],
      [3, '第三句话。', 4000000, 6000000],
      [4, '最后一句长一点的话。', 6000000, 12000000],
    ],
  );
  assert.equal(plan.tracks.text.length, 4);
  assert.match(plan.srt, /^1\n00:00:00,000 --> 00:00:02,000\n第一句话。\n\n2\n/);
  assert.ok(plan.srt.endsWith('最后一句长一点的话。\n'));

  assert.deepEqual(
    plan.assets.map(item => [item.kind, item.path]),
    [
      ['video', '/media/a.mp4'],
      ['image', '/media/b.png'],
      ['video', '/media/c.mp4'],
      ['audio', '/media/voice.wav'],
    ],
  );
  assert.deepEqual(
    plan.derived.map(item => [item.type, item.sourcePath, item.atUs, item.width, item.height]),
    [['freeze', '/media/c.mp4', 11966667, 1920, 1080]],
  );
  assert.equal(plan.derived[0].sourceAssetId, plan.tracks.video[2].assetId, '派生图引用源素材的 planId');
  assert.equal(plan.assets.find(item => item.planId === plan.tracks.video[2].assetId).sourceAssetId, 'vC');
  assert.equal(plan.derived[0].outputName, 'c-freeze-1.png');

  assert.deepEqual(plan.timing, {
    source: 'srt',
    mixed: false,
    counts: { ok: 4, low: 0, est: 0, gap: 0 },
    note: '字幕实测 4 句',
  });
  assert.deepEqual(plan.stats, {
    shots: 1,
    segments: 9,
    videoSegments: 2,
    imageSegments: 1,
    freezeSegments: 1,
    freezeCount: 1,
    derivedCount: 1,
    textSegments: 4,
    gapUs: 1000000,
    totalUs: 12000000,
    visualUs: 11000000,
    voiceUs: 12000000,
    voiceIncluded: true,
    assetCount: 4,
    altCount: 0,
    timingSource: 'srt',
    mixed: false,
  });
});

test('样例 A：问题列表只有手动留白 info，没有阻塞或需确认', () => {
  const plan = makePlan(sampleA(), { subtitles: true });
  assert.deepEqual(
    plan.issues.map(item => [item.level, item.code]),
    [['info', 'manual-gap']],
  );
  assert.equal(issue(plan, 'manual-gap').rowId, 'L1');
  assert.equal(issue(plan, 'manual-gap').lineNo, 1);
});

test('样例 A：字幕可选关闭；画幅变化只影响派生输出规格', () => {
  const off = makePlan(sampleA());
  assert.deepEqual(off.tracks.text, []);
  assert.deepEqual(off.subtitles, []);
  assert.equal(off.srt, '');

  const portrait = makePlan(sampleA(), { width: 1080, height: 1920 });
  assert.deepEqual(portrait.canvas, { width: 1080, height: 1920 });
  assert.deepEqual([portrait.derived[0].width, portrait.derived[0].height], [1080, 1920]);
  assert.equal(portrait.durationUs, 12000000);
});

test('计划是纯函数：不修改项目快照，重复调用结果一致', () => {
  const input = sampleA();
  const before = JSON.stringify(input);
  const first = makePlan(input, { subtitles: true });
  const second = makePlan(input, { subtitles: true });
  assert.equal(JSON.stringify(input), before, '计划不能修改快照');
  assert.deepEqual(first, second, '同样输入 + 同样 idFor 必须得到同样计划');

  const files = collectPlanFiles(first);
  assert.equal(files.media.length, first.assets.length);
  assert.equal(files.derived.length, first.derived.length);
  assert.equal(files.alt.length, 0);
  assert.notEqual(files.media, first.assets, '文件清单是浅拷贝数组');
  assert.deepEqual(Object.values(PLAN_DEFAULTS), [1920, 1080, 30, false, false, true]);
});

/* ── 顺序 / 共用画面 / 裁剪 ── */

function threeVideos(order) {
  const times = [
    [0, 1],
    [1, 2],
    [2, 3],
  ];
  const rows = times.map(([start, end], index) =>
    line(`L${index + 1}`, index + 1, `第${index + 1}句`, { start, end, st: 'ok' }),
  );
  const clips = { A: [1, 2], B: [3, 4], C: [5, 6] };
  rows.forEach(row => {
    row.groupId = 'g3';
    row.assetUsages = order.map(key => ({
      assetId: key,
      role: 'main',
      clip: { in: clips[key][0], out: clips[key][1] },
    }));
  });
  return project({
    rows,
    assets: [
      asset('A', '/m/a.mp4', 'video', { durationSec: 10 }),
      asset('B', '/m/b.mp4', 'video', { durationSec: 10 }),
      asset('C', '/m/c.mp4', 'video', { durationSec: 10 }),
    ],
  });
}

test('同一画面 3 个主素材按列表顺序排，调整先后导出顺序跟着变', () => {
  const normal = videoSummary(makePlan(threeVideos(['A', 'B', 'C']))).map(item => [
    item.path,
    item.start,
    item.dur,
    item.sourceStart,
  ]);
  assert.deepEqual(normal, [
    ['/m/a.mp4', 0, 1000000, 1000000],
    ['/m/b.mp4', 1000000, 1000000, 3000000],
    ['/m/c.mp4', 2000000, 1000000, 5000000],
  ]);
  const reversed = videoSummary(makePlan(threeVideos(['C', 'B', 'A']))).map(item => [
    item.path,
    item.start,
    item.sourceStart,
  ]);
  assert.deepEqual(reversed, [
    ['/m/c.mp4', 0, 5000000],
    ['/m/b.mp4', 1000000, 3000000],
    ['/m/a.mp4', 2000000, 1000000],
  ]);
});

function twoSentenceRanges(order) {
  const rows = [
    line('L1', 1, '第一句', { start: 0, end: 1, st: 'ok' }),
    line('L2', 2, '第二句', { start: 1, end: 2, st: 'ok' }),
  ];
  const on = { A: 0, B: 1 };
  rows.forEach((row, index) => {
    row.groupId = 'gr';
    row.assetUsages = order.map(key => ({
      assetId: key,
      role: 'main',
      clip: key === 'A' ? { in: 2, out: 3 } : { in: 4, out: 5 },
      ...(on[key] !== index ? { off: true } : {}),
    }));
  });
  return project({
    rows,
    assets: [
      asset('A', '/m/a.mp4', 'video', { durationSec: 10 }),
      asset('B', '/m/b.mp4', 'video', { durationSec: 10 }),
    ],
  });
}

test('指定句子范围：每个画面占自己那句，顺序与列表顺序无关', () => {
  for (const order of [
    ['A', 'B'],
    ['B', 'A'],
  ]) {
    const summary = videoSummary(makePlan(twoSentenceRanges(order)));
    assert.deepEqual(
      summary.map(item => [item.path, item.start, item.dur, item.sourceStart]),
      [
        ['/m/a.mp4', 0, 1000000, 2000000],
        ['/m/b.mp4', 1000000, 1000000, 4000000],
      ],
    );
  }
});

test('3 句共用画面只生成一份片段，不按句重复', () => {
  const rows = [
    line('L1', 1, '一句', { start: 0, end: 1, st: 'ok' }),
    line('L2', 2, '二句', { start: 1, end: 2, st: 'ok' }),
    line('L3', 3, '三句', { start: 2, end: 3, st: 'ok' }),
  ];
  rows.forEach(row => {
    row.groupId = 'gx';
    row.assetUsages = [{ assetId: 'img', role: 'main' }];
  });
  const plan = makePlan(project({ rows, assets: [asset('img', '/m/pic.png', 'image')] }));
  assert.deepEqual(videoSummary(plan), [
    { kind: 'image', path: '/m/pic.png', start: 0, dur: 3000000, sourceStart: 0, sourceDur: 3000000, derived: false },
  ]);
  assert.equal(plan.stats.shots, 1);
  assert.equal(plan.stats.gapUs, 0);
});

test('同一素材在两个画面各取不同区间：素材去重、片段各自独立', () => {
  const rows = [
    line('L1', 1, '一', { start: 0, end: 1, st: 'ok' }),
    line('L2', 2, '二', { start: 1, end: 2, st: 'ok' }),
  ];
  rows[0].assetUsages = [{ assetId: 'V', role: 'main', clip: { in: 0, out: 1 } }];
  rows[1].assetUsages = [{ assetId: 'V', role: 'main', clip: { in: 5, out: 6 } }];
  const plan = makePlan(project({ rows, assets: [asset('V', '/m/v.mp4', 'video', { durationSec: 10 })] }));
  const segments = plan.tracks.video;
  assert.equal(segments.length, 2);
  assert.notEqual(segments[0].id, segments[1].id);
  assert.equal(segments[0].assetId, segments[1].assetId, '同一素材共用一个 plan 素材');
  assert.equal(plan.assets.length, 1);
  assert.deepEqual(
    segments.map(item => [item.targetStartUs, item.sourceStartUs, item.sourceDurationUs]),
    [
      [0, 0, 1000000],
      [1000000, 5000000, 1000000],
    ],
  );
});

test('off：共用画面里某句不出现的素材不会铺满整段', () => {
  const rows = [
    line('L1', 1, '一', { start: 0, end: 1, st: 'ok' }),
    line('L2', 2, '二', { start: 1, end: 2, st: 'ok' }),
  ];
  rows.forEach((row, index) => {
    row.groupId = 'go';
    row.assetUsages = [{ assetId: 'img', role: 'main', ...(index === 1 ? { off: true } : {}) }];
  });
  const plan = makePlan(project({ rows, assets: [asset('img', '/m/i.png', 'image')] }));
  assert.deepEqual(
    videoSummary(plan).map(item => [item.start, item.dur]),
    [[0, 1000000]],
  );
  assert.equal(plan.stats.gapUs, 1000000);
});

test('旧项目未分配角色照旧上屏；只有备选时不占主轨', () => {
  const legacy = [line('L1', 1, '旧句', { start: 0, end: 1, st: 'ok' })];
  legacy[0].assetUsages = [{ assetId: 'V' }];
  const legacyPlan = makePlan(project({ rows: legacy, assets: [asset('V', '/m/v.mp4', 'video', { durationSec: 5 })] }));
  assert.deepEqual(
    videoSummary(legacyPlan).map(item => [item.path, item.start, item.dur]),
    [['/m/v.mp4', 0, 1000000]],
  );

  const altOnly = [line('L1', 1, '只有备选', { start: 0, end: 1, st: 'ok' })];
  altOnly[0].assetUsages = [{ assetId: 'V', role: 'alt' }];
  const altPlan = makePlan(project({ rows: altOnly, assets: [asset('V', '/m/v.mp4', 'video', { durationSec: 5 })] }));
  assert.deepEqual(altPlan.tracks.video, []);
  assert.ok(hasIssue(altPlan, 'alt-not-selected', 'info'));
});

test('at.of 失效：手动时间退回按句子排布', () => {
  const rows = [line('L1', 1, '一句', { start: 0, end: 2, st: 'ok' })];
  rows[0].assetUsages = [{ assetId: 'img', role: 'main', at: { start: 0.5, end: 1.5, of: '别的句子' } }];
  const plan = makePlan(project({ rows, assets: [asset('img', '/m/i.png', 'image')] }));
  assert.deepEqual(
    videoSummary(plan).map(item => [item.start, item.dur]),
    [[0, 2000000]],
  );
});

test('部分手动位置 + 自动位置：自动的放进剩余时间', () => {
  const rows = [line('L1', 1, '三秒', { start: 0, end: 3, st: 'ok' })];
  rows[0].assetUsages = [
    { assetId: 'A', role: 'main', at: { start: 0, end: 1, of: 'L1' } },
    { assetId: 'B', role: 'main' },
  ];
  const plan = makePlan(project({ rows, assets: [asset('A', '/m/a.png', 'image'), asset('B', '/m/b.png', 'image')] }));
  assert.deepEqual(
    videoSummary(plan).map(item => [item.path, item.start, item.dur]),
    [
      ['/m/a.png', 0, 1000000],
      ['/m/b.png', 1000000, 2000000],
    ],
  );
});

/* ── 停顿 / 留白 / 开头与尾部 ── */

test('自动句间停顿：视频继续播到出点，再定格到下一画面出现', () => {
  const rows = [
    line('L1', 1, '一', { start: 0, end: 1, st: 'ok' }),
    line('L2', 2, '二', { start: 3, end: 4, st: 'ok' }),
  ];
  rows[0].assetUsages = [
    { assetId: 'V', role: 'main', clip: { in: 0, out: 2 } },
    { assetId: 'I', role: 'main', off: true },
  ];
  rows[1].assetUsages = [
    { assetId: 'V', role: 'main', clip: { in: 0, out: 2 }, off: true },
    { assetId: 'I', role: 'main' },
  ];
  rows.forEach(row => (row.groupId = 'gp'));
  const plan = makePlan(
    project({
      rows,
      assets: [asset('V', '/m/v.mp4', 'video', { durationSec: 30 }), asset('I', '/m/i.png', 'image')],
    }),
  );
  assert.deepEqual(
    videoSummary(plan).map(item => [
      item.kind,
      item.path,
      item.start,
      item.dur,
      item.sourceStart,
      item.sourceDur,
      item.derived,
    ]),
    [
      ['video', '/m/v.mp4', 0, 2000000, 0, 2000000, false],
      ['image', '/m/v.mp4#freeze', 2000000, 1000000, 0, 1000000, true],
      ['image', '/m/i.png', 3000000, 1000000, 0, 1000000, false],
    ],
  );
  assert.equal(plan.derived.length, 1);
  assert.equal(plan.derived[0].atUs, 1966667);
});

test('手动画布留白保持空白，不延续也不压缩', () => {
  const rows = [line('L1', 1, '三秒', { start: 0, end: 3, st: 'ok' })];
  rows[0].assetUsages = [
    { assetId: 'A', role: 'main', at: { start: 0, end: 1, of: 'L1' } },
    { assetId: 'B', role: 'main', at: { start: 2, end: 3, of: 'L1' } },
  ];
  const plan = makePlan(project({ rows, assets: [asset('A', '/m/a.png', 'image'), asset('B', '/m/b.png', 'image')] }));
  assert.deepEqual(
    videoSummary(plan).map(item => [item.start, item.dur]),
    [
      [0, 1000000],
      [2000000, 1000000],
    ],
  );
  assert.equal(plan.stats.gapUs, 1000000);
  assert.ok(hasIssue(plan, 'manual-gap', 'info'));
});

test('没有素材的句子不会被前一个画面错误填满', () => {
  const rows = [
    line('L1', 1, '有画面', { start: 0, end: 1, st: 'ok' }),
    line('L2', 2, '没画面', { start: 1, end: 2, st: 'ok' }),
  ];
  rows[0].assetUsages = [{ assetId: 'img', role: 'main' }];
  const plan = makePlan(project({ rows, assets: [asset('img', '/m/i.png', 'image')] }));
  assert.deepEqual(
    videoSummary(plan).map(item => [item.start, item.dur]),
    [[0, 1000000]],
  );
  assert.equal(plan.stats.gapUs, 1000000);
});

test('开头空档和录音尾部保留：画面不提前、音频不裁尾', () => {
  const rows = [
    line('L1', 1, '一', { start: 2, end: 3, st: 'ok' }),
    line('L2', 2, '二', { start: 3, end: 4, st: 'ok' }),
  ];
  rows[0].assetUsages = [{ assetId: 'img', role: 'main' }];
  rows[1].assetUsages = [{ assetId: 'img', role: 'main' }];
  const plan = makePlan(
    project({
      rows,
      assets: [asset('img', '/m/i.png', 'image')],
      voice: { path: '/m/voice.wav', name: 'voice.wav', duration: 5 },
    }),
  );
  assert.deepEqual(
    videoSummary(plan).map(item => [item.start, item.dur]),
    [
      [2000000, 1000000],
      [3000000, 1000000],
    ],
  );
  assert.equal(plan.tracks.audio[0].targetDurationUs, 5000000);
  assert.equal(plan.stats.gapUs, 3000000, '0–2 秒和 4–5 秒都算空白');
});

/* ── 时间来源 ── */

test('没有音频也没有字幕：按语速估算并标记', () => {
  const rows = [line('L1', 1, '一二三四', null), line('L2', 2, '五六七八', null)];
  const plan = makePlan(project({ rows, assets: [], speechRate: 4 }), { subtitles: true });
  assert.equal(plan.timing.source, 'rate');
  assert.equal(plan.timing.mixed, false);
  assert.deepEqual(plan.timing.counts, { ok: 0, low: 0, est: 0, gap: 0 });
  assert.match(plan.timing.note, /语速/);
  assert.ok(hasIssue(plan, 'timing-rate', 'info'));
  assert.ok(hasIssue(plan, 'no-voice', 'info'));
  assert.equal(plan.durationUs, 2000000, '两句各 4 字，4 字/秒 → 共 2 秒');
  assert.deepEqual(
    plan.subtitles.map(item => [item.startUs, item.endUs]),
    [
      [0, 1000000],
      [1000000, 2000000],
    ],
  );
});

test('有口播音频、没对齐字幕：按音频总长推算每句时间', () => {
  const rows = [line('L1', 1, '一二三四', null), line('L2', 2, '五六七八', null)];
  const plan = makePlan(project({ rows, assets: [], voice: { path: '/m/voice.wav', name: 'voice.wav', duration: 8 } }));
  assert.equal(plan.timing.source, 'fit');
  assert.match(plan.timing.note, /口播音频/);
  assert.ok(hasIssue(plan, 'timing-fit', 'info'));
  assert.equal(plan.durationUs, 8000000);
  assert.equal(plan.tracks.audio[0].targetDurationUs, 8000000);
});

test('完整字幕时间：标记为字幕实测，不出现估算提醒', () => {
  const rows = [
    line('L1', 1, '一', { start: 0, end: 1, st: 'ok' }),
    line('L2', 2, '二', { start: 1, end: 2, st: 'ok' }),
  ];
  const plan = makePlan(project({ rows, assets: [] }), { subtitles: true });
  assert.deepEqual(plan.timing.counts, { ok: 2, low: 0, est: 0, gap: 0 });
  assert.equal(plan.timing.mixed, false);
  assert.equal(hasIssue(plan, 'timing-mixed'), false);
  assert.equal(hasIssue(plan, 'timing-rate'), false);
});

test('部分字幕 / 低置信 / 对齐后新增句子：如实统计并提醒', () => {
  const rows = [
    line('L1', 1, '一二', { start: 0, end: 1, st: 'ok' }),
    line('L2', 2, '三', null),
    line('L3', 3, '四', { start: 2, end: 3, st: 'low' }),
  ];
  const plan = makePlan(project({ rows, assets: [] }), { subtitles: true });
  assert.deepEqual(plan.timing.counts, { ok: 1, low: 1, est: 0, gap: 1 });
  assert.equal(plan.timing.mixed, true);
  assert.match(plan.timing.note, /低置信 1 句/);
  assert.match(plan.timing.note, /新增 1 句/);
  assert.ok(hasIssue(plan, 'timing-mixed', 'info'));
  assert.equal(plan.subtitles.length, 3);
});

test('字幕里没找到某句（st=est）：计入 est 并说明不是逐句精确', () => {
  const rows = [
    line('L1', 1, '一', { start: 0, end: 1, st: 'ok' }),
    line('L2', 2, '二', { start: 1, end: 2, st: 'est' }),
  ];
  const plan = makePlan(project({ rows, assets: [] }));
  assert.deepEqual(plan.timing.counts, { ok: 1, low: 0, est: 1, gap: 0 });
  assert.equal(plan.timing.mixed, true);
  assert.match(plan.timing.note, /没找到 1 句/);
});

/* ── 源片段与定格 ── */

function oneVideoShot({ clip, at, fitDone = false, durationSec = 30, probe = null, shotEnd = 3 }) {
  const rows = [line('L1', 1, '一句', { start: 0, end: shotEnd, st: 'ok' })];
  rows[0].assetUsages = [
    {
      assetId: 'V',
      role: 'main',
      ...(clip ? { clip } : {}),
      ...(at ? { at } : {}),
      ...(fitDone ? { fitDone: true } : {}),
    },
  ];
  const probes = probe ? { '/m/v.mp4': probe } : {};
  return { project: project({ rows, assets: [asset('V', '/m/v.mp4', 'video', { durationSec })] }), probes };
}

test('源片段短于时间槽且未定格：只播可用部分，后面留白', () => {
  const { project: proj, probes } = oneVideoShot({ clip: { in: 0, out: 1 }, at: { start: 0, end: 3, of: 'L1' } });
  const plan = makePlan(proj, {}, { probes });
  assert.deepEqual(
    videoSummary(plan).map(item => [item.start, item.dur, item.sourceDur]),
    [[0, 1000000, 1000000]],
  );
  assert.equal(plan.derived.length, 0);
  assert.equal(plan.stats.gapUs, 2000000);
});

test('源片段短于时间槽且启用定格补满：视频 + 末帧定格补到槽末', () => {
  const { project: proj, probes } = oneVideoShot({
    clip: { in: 0, out: 1 },
    at: { start: 0, end: 3, of: 'L1' },
    fitDone: true,
  });
  const plan = makePlan(proj, {}, { probes });
  assert.deepEqual(
    videoSummary(plan).map(item => [item.kind, item.start, item.dur, item.derived]),
    [
      ['video', 0, 1000000, false],
      ['image', 1000000, 2000000, true],
    ],
  );
  assert.deepEqual(
    plan.derived.map(item => item.atUs),
    [966667],
  );
});

test('源片段长于时间槽：按可见区间截断，不改素材速度', () => {
  const { project: proj, probes } = oneVideoShot({ clip: { in: 0, out: 10 }, at: { start: 0, end: 2, of: 'L1' } });
  const plan = makePlan(proj, {}, { probes });
  assert.deepEqual(
    videoSummary(plan).map(item => [item.start, item.dur, item.sourceStart, item.sourceDur]),
    [[0, 2000000, 0, 2000000]],
  );
  assert.equal(plan.tracks.video[0].speed, 1);
  assert.equal(plan.derived.length, 0);
});

test('画面超出镜头末尾：截到可见区并提示需确认', () => {
  const rows = [line('L1', 1, '三秒', { start: 0, end: 3, st: 'ok' })];
  rows[0].assetUsages = [{ assetId: 'img', role: 'main', at: { start: 2, end: 4, of: 'L1' } }];
  const plan = makePlan(project({ rows, assets: [asset('img', '/m/i.png', 'image')] }));
  assert.deepEqual(
    videoSummary(plan).map(item => [item.start, item.dur]),
    [[2000000, 1000000]],
  );
  assert.ok(hasIssue(plan, 'over-shot', 'confirm'));
});

test('画面整段排在镜头之后：不上轨并提示需确认', () => {
  const rows = [line('L1', 1, '三秒', { start: 0, end: 3, st: 'ok' })];
  rows[0].assetUsages = [{ assetId: 'img', role: 'main', at: { start: 3.2, end: 4.2, of: 'L1' } }];
  const plan = makePlan(project({ rows, assets: [asset('img', '/m/i.png', 'image')] }));
  assert.deepEqual(plan.tracks.video, []);
  assert.ok(hasIssue(plan, 'over-shot', 'confirm'));
});

test('片段超出文件时长：阻塞诊断并按文件里有的部分导出', () => {
  const { project: proj } = oneVideoShot({
    clip: { in: 0, out: 10 },
    at: { start: 0, end: 2, of: 'L1' },
    durationSec: 20,
    probe: { durationSec: 5, exists: true },
  });
  const plan = makePlan(proj, {}, { probes: { '/m/v.mp4': { durationSec: 5, exists: true } } });
  assert.ok(hasIssue(plan, 'source-range', 'block'));
  assert.deepEqual(
    videoSummary(plan).map(item => [item.start, item.dur]),
    [[0, 2000000]],
  );
});

test('片段出点小于入点：阻塞诊断并按整段处理', () => {
  const { project: proj } = oneVideoShot({ clip: { in: 3, out: 2 }, at: { start: 0, end: 2, of: 'L1' } });
  const plan = makePlan(proj, {}, { probes: { '/m/v.mp4': { durationSec: 20, exists: true } } });
  assert.ok(hasIssue(plan, 'source-range', 'block'));
  assert.deepEqual(
    videoSummary(plan).map(item => [item.sourceStart, item.dur]),
    [[0, 2000000]],
  );
});

test('定格抽帧位置 = 出点前一帧，且不小于入点', () => {
  const { project: proj } = oneVideoShot({
    clip: { in: 5, out: 5.02 },
    at: { start: 0, end: 1, of: 'L1' },
    fitDone: true,
  });
  const plan = makePlan(proj, {}, { probes: { '/m/v.mp4': { durationSec: 30, exists: true } } });
  assert.equal(plan.derived.length, 1);
  assert.equal(plan.derived[0].atUs, 5000000, '源片段比一帧还短时定格在入点');
  assert.equal(plan.tracks.video[1].derived, true);
});

/* ── 异常与量化 ── */

test('量化后不足一帧的字幕：省略并给出诊断', () => {
  const rows = [
    line('L1', 1, '正常', { start: 0, end: 1, st: 'ok' }),
    line('L2', 2, '短', { start: 1, end: 1.01, st: 'ok' }),
  ];
  const plan = makePlan(project({ rows, assets: [] }), { subtitles: true });
  assert.equal(plan.subtitles.length, 1);
  assert.ok(hasIssue(plan, 'zero-length', 'confirm'));
});

test('负时间：定位到句子，导出时间不为负', () => {
  const rows = [
    line('L1', 1, '负时间', { start: -1, end: 1, st: 'ok' }),
    line('L2', 2, '正常', { start: 1, end: 2, st: 'ok' }),
  ];
  const plan = makePlan(project({ rows, assets: [] }), { subtitles: true });
  assert.ok(hasIssue(plan, 'invalid-time', 'block'));
  assert.ok(plan.tracks.text.every(item => item.targetStartUs >= 0));
  assert.ok(plan.subtitles.every(item => item.startUs >= 0));
});

test('非有限时间：定位到句子并继续按前后推算', () => {
  const rows = [
    line('L1', 1, '一', { start: 0, end: 1, st: 'ok' }),
    line('L2', 2, '坏时间', { start: 'x', end: 2, st: 'ok' }),
    line('L3', 3, '三', { start: 2, end: 3, st: 'ok' }),
  ];
  const plan = makePlan(project({ rows, assets: [] }), { subtitles: true });
  assert.ok(hasIssue(plan, 'invalid-time', 'block'));
  assert.equal(plan.subtitles.length, 3);
});

test('句子时间重叠：阻塞诊断，画面按后出现的句子截断且不重叠', () => {
  const rows = [
    line('L1', 1, '一', { start: 0, end: 2, st: 'ok' }),
    line('L2', 2, '二', { start: 1, end: 3, st: 'ok' }),
  ];
  rows[0].assetUsages = [{ assetId: 'A', role: 'main' }];
  rows[1].assetUsages = [{ assetId: 'B', role: 'main' }];
  const plan = makePlan(project({ rows, assets: [asset('A', '/m/a.png', 'image'), asset('B', '/m/b.png', 'image')] }));
  assert.ok(hasIssue(plan, 'line-overlap', 'block'));
  const segments = videoSummary(plan);
  assert.deepEqual(
    segments.map(item => [item.start, item.dur]),
    [
      [0, 1000000],
      [1000000, 2000000],
    ],
  );
  for (let i = 1; i < segments.length; i++)
    assert.ok(segments[i].start >= segments[i - 1].start + segments[i - 1].dur, '画面轨道不能重叠');
});

test('主画面时间重叠：阻塞诊断并按预览可见范围截断', () => {
  const rows = [line('L1', 1, '三秒', { start: 0, end: 3, st: 'ok' })];
  rows[0].assetUsages = [
    { assetId: 'A', role: 'main', at: { start: 0, end: 2, of: 'L1' } },
    { assetId: 'B', role: 'main', at: { start: 1, end: 3, of: 'L1' } },
  ];
  const plan = makePlan(project({ rows, assets: [asset('A', '/m/a.png', 'image'), asset('B', '/m/b.png', 'image')] }));
  assert.ok(hasIssue(plan, 'picture-overlap', 'block'));
  assert.deepEqual(
    videoSummary(plan).map(item => [item.path, item.start, item.dur]),
    [
      ['/m/a.png', 0, 2000000],
      ['/m/b.png', 2000000, 1000000],
    ],
  );
});

/* ── 长项目精度 ── */

test('30 分钟、数百片段：边界共用、总长误差不超过一帧（24/30/29.97/60fps）', () => {
  const count = 300;
  const segDur = 6;
  const totalSec = count * segDur; // 1800 秒 = 30 分钟
  for (const fps of [24, 30, 29.97, 60]) {
    const rows = [];
    for (let index = 0; index < count; index++) {
      const start = index * segDur,
        end = start + segDur;
      const row = line(`L${index}`, index + 1, '这句用来占时间', { start, end, st: 'ok' });
      row.assetUsages = [{ assetId: 'long', role: 'main', clip: { in: start, out: end } }];
      rows.push(row);
    }
    const plan = makePlan(
      project({ rows, assets: [asset('long', '/m/long.mp4', 'video', { durationSec: totalSec })] }),
      { fps },
    );
    const fpsRate = plan.fps.num / plan.fps.den;
    const frameUs = 1e6 / fpsRate;
    const videos = plan.tracks.video;
    assert.equal(videos.length, count, `${fps}fps 片段数`);
    assert.equal(plan.derived.length, 0, `${fps}fps 不应为了填满生成定格`);
    videos.forEach((segment, index) => {
      assert.ok(Math.abs(segment.targetStartUs - index * segDur * 1e6) <= frameUs, `${fps}fps 第 ${index} 段起点误差`);
      assert.ok(Math.abs(segment.targetDurationUs - segDur * 1e6) <= frameUs, `${fps}fps 第 ${index} 段长度误差`);
      assert.equal(
        segment.targetStartUs + segment.targetDurationUs,
        index + 1 < count ? videos[index + 1].targetStartUs : plan.durationUs,
        `${fps}fps 相邻片段共用边界`,
      );
    });
    assert.ok(Math.abs(plan.durationUs - totalSec * 1e6) <= frameUs, `${fps}fps 总长误差`);
    assert.equal(plan.stats.gapUs, 0, `${fps}fps 没有空白`);
  }
});

test('帧率用有理数：29.97 输出 30000/1001', () => {
  const rows = [line('L1', 1, '一', { start: 0, end: 1, st: 'ok' })];
  const plan = makePlan(project({ rows, assets: [] }), { fps: 29.97 });
  assert.deepEqual(plan.fps, { num: 30000, den: 1001 });
});

/* ── 素材问题与选项 ── */

test('链接素材：不导出为本地路径，主画面阻塞并跳过', () => {
  const rows = [line('L1', 1, '一', { start: 0, end: 1, st: 'ok' })];
  rows[0].assetUsages = [{ assetId: 'L', role: 'main' }];
  const plan = makePlan(
    project({ rows, assets: [asset('L', 'https://example.com/video.mp4', 'video', { durationSec: 10 })] }),
  );
  assert.ok(hasIssue(plan, 'linked-asset', 'block'));
  assert.deepEqual(plan.tracks.video, []);
  assert.equal(plan.assets.length, 0);
});

test('探针报告文件失联：阻塞并跳过，不伪造片段', () => {
  const rows = [line('L1', 1, '一', { start: 0, end: 1, st: 'ok' })];
  rows[0].assetUsages = [{ assetId: 'V', role: 'main' }];
  const plan = makePlan(
    project({ rows, assets: [asset('V', '/m/v.mp4', 'video', { durationSec: 10 })] }),
    {},
    { probes: { '/m/v.mp4': { exists: false } } },
  );
  assert.ok(hasIssue(plan, 'missing-file', 'block'));
  assert.deepEqual(plan.tracks.video, []);
});

test('素材记录不存在：阻塞定位到句子', () => {
  const rows = [line('L1', 1, '一', { start: 0, end: 1, st: 'ok' })];
  rows[0].assetUsages = [{ assetId: 'nope', role: 'main' }];
  const plan = makePlan(project({ rows, assets: [] }));
  const hit = issue(plan, 'unknown-asset');
  assert.equal(hit?.level, 'block');
  assert.equal(hit?.rowId, 'L1');
  assert.equal(hit?.lineNo, 1);
  assert.deepEqual(plan.tracks.video, []);
});

test('叠加素材：不上轨，提示需要在剪映里安排', () => {
  const rows = [line('L1', 1, '一', { start: 0, end: 1, st: 'ok' })];
  rows[0].assetUsages = [
    { assetId: 'main', role: 'main' },
    { assetId: 'over', role: 'overlay' },
  ];
  const plan = makePlan(
    project({ rows, assets: [asset('main', '/m/main.png', 'image'), asset('over', '/m/over.png', 'image')] }),
  );
  assert.deepEqual(
    videoSummary(plan).map(item => item.path),
    ['/m/main.png'],
  );
  assert.ok(hasIssue(plan, 'overlay', 'confirm'));
});

test('备选素材：勾选后只进 altAssets，不上轨；不勾选只提醒数量', () => {
  const rows = [line('L1', 1, '一', { start: 0, end: 1, st: 'ok' })];
  rows[0].assetUsages = [
    { assetId: 'main', role: 'main' },
    { assetId: 'alt', role: 'alt' },
  ];
  const proj = project({
    rows,
    assets: [asset('main', '/m/main.png', 'image'), asset('alt', '/m/alt.mp4', 'video', { durationSec: 9 })],
  });
  const withAlt = makePlan(proj, { altAssets: true });
  assert.deepEqual(
    withAlt.altAssets.map(item => [item.path, item.kind, item.name]),
    [['/m/alt.mp4', 'video', 'alt.mp4']],
  );
  assert.deepEqual(
    withAlt.tracks.video.map(item => pathOf(withAlt, item.assetId)),
    ['/m/main.png'],
  );
  assert.deepEqual(
    withAlt.assets.map(item => item.path),
    ['/m/main.png'],
  );

  const withoutAlt = makePlan(proj, { altAssets: false });
  assert.deepEqual(withoutAlt.altAssets, []);
  assert.ok(hasIssue(withoutAlt, 'alt-not-selected', 'info'));
  assert.equal(withoutAlt.stats.altCount, 1);
});

test('链接备选：不复制，给需确认问题', () => {
  const rows = [line('L1', 1, '一', { start: 0, end: 1, st: 'ok' })];
  rows[0].assetUsages = [{ assetId: 'alt', role: 'alt' }];
  const plan = makePlan(project({ rows, assets: [asset('alt', 'https://example.com/a.mp4', 'video')] }), {
    altAssets: true,
  });
  assert.deepEqual(plan.altAssets, []);
  assert.ok(hasIssue(plan, 'linked-asset', 'confirm'));
});

test('includeVoice=false 时不建音轨；没有口播时只给 info', () => {
  const plan = makePlan(sampleA(), { includeVoice: false });
  assert.deepEqual(plan.tracks.audio, []);
  assert.equal(plan.stats.voiceIncluded, false);
  assert.equal(hasIssue(plan, 'no-voice'), false);

  const rows = [line('L1', 1, '一', { start: 0, end: 1, st: 'ok' })];
  rows[0].assetUsages = [{ assetId: 'img', role: 'main' }];
  const noVoice = makePlan(project({ rows, assets: [asset('img', '/m/i.png', 'image')] }));
  assert.ok(hasIssue(noVoice, 'no-voice', 'info'));
  assert.deepEqual(noVoice.tracks.audio, []);
});

test('只有口播、没有句子：保留录音全长，不误判空项目', () => {
  const plan = makePlan(
    project({ rows: [], assets: [], voice: { path: '/m/voice.wav', name: 'voice.wav', duration: 7 } }),
  );
  assert.equal(plan.durationUs, 7000000);
  assert.deepEqual(plan.tracks.video, []);
  assert.equal(plan.tracks.audio.length, 1);
  assert.equal(plan.tracks.audio[0].targetDurationUs, 7000000);
  assert.equal(hasIssue(plan, 'empty-project'), false);
});

test('口播音频链接 / 失联 / 不足一帧：阻塞或省略，不建错误音轨', () => {
  const linked = makePlan(
    project({ rows: [], assets: [], voice: { path: 'https://example.com/v.mp4', name: 'v.mp4', duration: 7 } }),
  );
  assert.ok(hasIssue(linked, 'linked-asset', 'block'));
  assert.deepEqual(linked.tracks.audio, []);

  const missing = makePlan(
    project({ rows: [], assets: [], voice: { path: '/m/gone.wav', name: 'gone.wav', duration: 7 } }),
    {},
    { probes: { '/m/gone.wav': { exists: false } } },
  );
  assert.ok(hasIssue(missing, 'missing-file', 'block'));
  assert.deepEqual(missing.tracks.audio, []);

  const tiny = makePlan(
    project({ rows: [], assets: [], voice: { path: '/m/tiny.wav', name: 'tiny.wav', duration: 0.001 } }),
  );
  assert.ok(hasIssue(tiny, 'zero-length', 'confirm'));
  assert.deepEqual(tiny.tracks.audio, []);
});

test('未知时长的视频：降级铺满并提示需确认，不生成假定格', () => {
  const rows = [line('L1', 1, '两秒', { start: 0, end: 2, st: 'ok' })];
  rows[0].assetUsages = [{ assetId: 'V', role: 'main' }];
  const plan = makePlan(project({ rows, assets: [{ id: 'V', path: '/m/v.mp4', name: 'v.mp4', kind: 'video' }] }));
  assert.ok(hasIssue(plan, 'unknown-duration', 'confirm'));
  assert.deepEqual(
    videoSummary(plan).map(item => [item.start, item.dur, item.sourceDur]),
    [[0, 2000000, 2000000]],
  );
  assert.equal(plan.assets[0].durationUs, null);
});

test('探针时长和项目记录不一致：只提醒，不偷偷改排布', () => {
  const rows = [line('L1', 1, '两秒', { start: 0, end: 2, st: 'ok' })];
  rows[0].assetUsages = [{ assetId: 'V', role: 'main' }];
  const plan = makePlan(
    project({ rows, assets: [asset('V', '/m/v.mp4', 'video', { durationSec: 10 })] }),
    {},
    { probes: { '/m/v.mp4': { durationSec: 8, exists: true } } },
  );
  assert.ok(hasIssue(plan, 'duration-mismatch', 'info'));
  assert.deepEqual(
    videoSummary(plan).map(item => [item.start, item.dur]),
    [[0, 2000000]],
  );
});

test('动态图片：识别为动图并提示按静态图导出', () => {
  const rows = [line('L1', 1, '一', { start: 0, end: 1, st: 'ok' })];
  rows[0].assetUsages = [{ assetId: 'gif', role: 'main' }];
  const plan = makePlan(
    project({ rows, assets: [asset('gif', '/m/anim.gif', 'image')] }),
    {},
    { probes: { '/m/anim.gif': { durationSec: 2, isImage: true } } },
  );
  assert.ok(hasIssue(plan, 'animated-image', 'confirm'));
  assert.deepEqual(
    videoSummary(plan).map(item => [item.path, item.dur]),
    [['/m/anim.gif', 1000000]],
  );
});

/* ── 运行 ── */
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(error?.stack || error);
  }
}
console.log(`\n剪映导出计划测试：${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
