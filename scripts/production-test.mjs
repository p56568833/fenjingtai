import { buildPrintDoc, planDocument, fmtLong } from '../renderer/src/print-doc.js';
import assert from 'node:assert/strict';
import { parseAny, splitSentences } from '../renderer/src/parse.js';
import {
  groupRows,
  shots,
  checkDelivery,
  repairPunctuation,
  repairCandidates,
  normalizeProjectRows,
  reconcileDraft,
  validGroup,
  normalizeGroups,
} from '../renderer/src/production.js';
let count = 0;
function test(name, fn) {
  fn();
  count++;
  console.log('✓', name);
}
const lines = s => parseAny(s).filter(r => r.kind === 'line');
test('中文右引号留在句尾', () =>
  assert.deepEqual(splitSentences('他说：“行。”她回答：“好！”'), ['他说：“行。”', '她回答：“好！”']));
test('省略号、连续问号不产生碎片', () =>
  assert.deepEqual(splitSentences('等一下……真的吗？！“好。”'), ['等一下……', '真的吗？！', '“好。”']));
test('英文小数与缩写保持原样', () => assert.equal(lines('GPT 5.5 和 Dr. Smith。')[0].text, 'GPT 5.5 和 Dr. Smith。'));
test('一条批注稿也能回读', () => assert.equal(lines('- [B roll · 真实素材] 舞台。（画面：开场）')[0].note, '开场'));
test('修复只合并未标注、无备注的孤立标点', () => {
  const rows = [
    { id: 1, kind: 'line', text: '你好。', type: 'a', note: '保留' },
    { id: 2, kind: 'line', text: '”' },
    { id: 3, kind: 'line', text: '”', note: '特殊处理' },
  ];
  assert.equal(repairCandidates(rows).length, 1);
  const fixed = repairPunctuation(rows);
  assert.equal(fixed.length, 2);
  assert.equal(fixed[0].text, '你好。”');
  assert.equal(fixed[0].note, '保留');
  assert.equal(rows[0].text, '你好。');
});
test('分组保留原文并合并素材、描述', () => {
  const rows = lines('甲。乙。');
  rows[0].note = '全景';
  rows[1].note = '推进';
  rows[1].assets = '/tmp/a.png';
  rows[0].type = 'real';
  const texts = rows.map(r => r.text);
  groupRows(
    rows,
    rows.map(r => r.id),
  );
  assert.deepEqual(
    rows.map(r => r.text),
    texts,
  );
  assert.equal(shots(rows).length, 1);
  assert.equal(rows[1].note, '全景\n推进');
  assert.equal(rows[0].assets, '/tmp/a.png');
  assert.equal(rows[1].type, 'real');
});
test('分组不可跨章节或不连续', () => {
  const rows = parseAny('甲。\n## 中段\n乙。丙。');
  assert.equal(validGroup(rows, [rows[0].id, rows[2].id]), false);
  assert.equal(validGroup(rows, [rows[2].id, rows[3].id]), true);
});
test('交稿检查区分类型完成与素材完成', () => {
  const rows = lines('甲。乙。');
  rows[0].type = 'a';
  rows[1].type = 'real';
  assert.deepEqual(checkDelivery(rows)[0].issues, ['缺画面描述', '素材未就绪']);
  rows[1].note = '全景';
  rows[1].status = 'ready';
  assert.equal(checkDelivery(rows).length, 0);
});
test('JSON导入修复重复ID并兼容旧类型', () => {
  const rows = normalizeProjectRows([
    { id: 1, kind: 'line', text: '甲', type: 'bogus' },
    { id: 1, kind: 'line', text: '乙', type: 'a' },
  ]);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(rows[0].type, null);
});
test('改稿只继承唯一原文匹配，重复与修改需核对', () => {
  const old = lines('甲。乙。乙。丙。');
  old[0].note = '保留';
  old[3].type = 'a';
  const result = reconcileDraft(old, lines('甲。乙。丁。丙。'));
  assert.equal(result.kept, 2);
  assert.equal(result.review, 2);
  assert.equal(result.rows[0].note, '保留');
  assert.equal(result.rows[3].type, 'a');
  assert.equal(new Set(result.rows.map(r => r.id)).size, 4);
});
test('改稿改变镜头成员后解除分组并要求核对', () => {
  const old = lines('甲。乙。丙。');
  groupRows(old, [old[0].id, old[1].id]);
  const result = reconcileDraft(old, lines('甲。新句。丙。'));
  assert.equal(result.rows[0].groupId, undefined);
  assert.equal(result.rows[0].needsReview, true);
});
test('完整镜头组在改稿中保留', () => {
  const old = lines('甲。乙。丙。');
  groupRows(old, [old[0].id, old[1].id]);
  const result = reconcileDraft(old, lines('甲。乙。新句。'));
  assert.equal(result.rows[0].groupId, old[0].groupId);
  assert.equal(result.rows[1].groupId, old[1].groupId);
});
test('批注MD回读保留分组、引用、状态和多行备注', () => {
  const meta = {
    groupId: 'shot-test',
    assets: '/tmp/参考.png',
    status: 'ready',
    note: '第一行\n第二行',
    displayNote: '第一行 / 第二行',
  };
  const md =
    '- [B roll · AI 动画] 画面。（画面：第一行 / 第二行）\n<!-- fj-meta ' +
    encodeURIComponent(JSON.stringify(meta)) +
    ' -->\n<!-- fj-review -->\n## 交稿待处理\n> 这里不是口播。';
  const rows = lines(md);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, meta.note);
  assert.equal(rows[0].assets, meta.assets);
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].groupId, 'shot-test');
});
test('新增章节拆开分组时保留各句制作信息', () => {
  const rows = lines('甲。乙。丙。丁。');
  groupRows(
    rows,
    rows.map(r => r.id),
  );
  rows.forEach(r => (r.note = '共同描述'));
  rows.splice(2, 0, { id: 99, kind: 'section', text: '新章节' });
  normalizeGroups(rows);
  assert.notEqual(rows[0].groupId, rows[3].groupId);
  assert.equal(rows[0].groupId, rows[1].groupId);
  assert.equal(rows[3].groupId, rows[4].groupId);
  assert.equal(rows[3].note, '共同描述');
});

/* ── 素材库 / 使用记录 / 片段范围（v1.2 数据层） ── */
import {
  hydrateProjectAssets,
  ensureAsset,
  kindOf,
  planAddRefs,
  clipAdjustPlan,
  checkClip,
  countAssetShots,
  usageList,
  clipText,
} from '../renderer/src/assets.js';
import { fmtTime, parseTime } from '../renderer/src/util.js';
import {
  sameGroupSelection,
  groupExtendNextPlan,
  groupExtendNext,
  groupDropLast,
  groupSplitAt,
  groupSplitAtPlan,
} from '../renderer/src/production.js';

test('素材类型识别：图片/视频/链接/不支持', () => {
  assert.equal(kindOf('/a/b/图.PNG'), 'image');
  assert.equal(kindOf('/a/b/片.mp4'), 'video');
  assert.equal(kindOf('https://x.com/v'), 'link');
  assert.equal(kindOf('/a/b/c.xyz'), null);
  assert.equal(kindOf(''), null);
});
test('时间解析与显示往返', () => {
  assert.equal(parseTime('00:12'), 12);
  assert.equal(parseTime('12'), 12);
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime('乱写'), null);
  assert.equal(fmtTime(12), '00:12');
  assert.equal(fmtTime(3723), '1:02:03');
  assert.equal(fmtTime(59.9), '00:59');
});
test('片段校验：入出点顺序、时长上限、整段放行', () => {
  assert.equal(checkClip(null, 10), null);
  assert.ok(checkClip({ in: 5, out: 3 }, null));
  assert.ok(checkClip({ in: -1, out: 3 }, null));
  assert.ok(checkClip({ in: 5, out: 20 }, 10));
  assert.equal(checkClip({ in: 5, out: 20 }, 30), null);
});
test('旧项目的素材文本迁移成素材库和使用记录', () => {
  const p = {
    rows: [
      { id: 1, kind: 'line', text: '甲。', assets: '/tmp/a.png\n/tmp/b.mp4' },
      { id: 2, kind: 'line', text: '乙。', assets: '/tmp/a.png' },
      { id: 3, kind: 'section', text: '章' },
    ],
  };
  const reg = hydrateProjectAssets(p);
  assert.deepEqual(
    Object.values(reg)
      .map(a => a.path)
      .sort(),
    ['/tmp/a.png', '/tmp/b.mp4'],
  );
  assert.equal(p.rows[0].assetUsages.length, 2);
  assert.equal(p.rows[1].assetUsages.length, 1);
  assert.equal(p.rows[1].assetUsages[0].assetId, p.rows[0].assetUsages[0].assetId);
  assert.equal(p.rows[0].assets, '/tmp/a.png\n/tmp/b.mp4');
  assert.equal(reg[p.rows[0].assetUsages[1].assetId].kind, 'video');
});
test('重复载入不丢片段范围，MD 内联素材信息并入素材库', () => {
  const p = {
    rows: [
      { id: 1, kind: 'line', text: '甲。', assets: '/tmp/a.png\n/tmp/b.mp4' },
      {
        id: 2,
        kind: 'line',
        text: '乙。',
        assetUsages: [{ path: '/tmp/内联.mp4', name: '内联.mp4', kind: 'video', clip: { in: 1, out: 2 } }],
      },
    ],
  };
  const reg = hydrateProjectAssets(p);
  p.rows[0].assetUsages[1].clip = { in: 12, out: 18 };
  hydrateProjectAssets(p);
  hydrateProjectAssets(p);
  assert.deepEqual(p.rows[0].assetUsages[1].clip, { in: 12, out: 18 });
  assert.ok(p.rows[1].assetUsages[0].clip.in === 1);
  assert.ok(Object.values(reg).some(a => a.path === '/tmp/内联.mp4'));
  assert.equal(p.rows[1].assetUsages[0].path, undefined); // 迁移后统一走 assetId 引用
});
test('同一目标重复添加去重、无效文件被拒绝', () => {
  const reg = {},
    usages = [];
  const r1 = planAddRefs(reg, usages, ['/tmp/a.png', '/tmp/a.png', '/tmp/b.mp4', '坏文件.xyz', '']);
  assert.equal(r1.added.length, 2);
  assert.equal(r1.dupes.length, 1);
  assert.equal(r1.invalid.length, 1);
  const r2 = planAddRefs(reg, r1.added, ['/tmp/a.png']);
  assert.equal(r2.added.length, 0);
  assert.equal(r2.dupes.length, 1);
});
test('替换文件后不兼容片段只标记待调整、不改时间', () => {
  const rows = [{ id: 1, kind: 'line', text: '甲。', assetUsages: [{ assetId: 'as-1', clip: { in: 5, out: 20 } }] }];
  let r = clipAdjustPlan(rows, 'as-1', 10);
  assert.equal(r.adjusted, 1);
  assert.deepEqual(rows[0].assetUsages[0].clip, { in: 5, out: 20, needsAdjust: true });
  clipAdjustPlan(rows, 'as-1', 30);
  assert.deepEqual(rows[0].assetUsages[0].clip, { in: 5, out: 20 });
  assert.equal(clipText(rows[0].assetUsages[0].clip), '00:05–00:20');
  assert.equal(clipText(null), '整段');
});
test('使用次数按独立画面统计', () => {
  const rows = lines('甲。乙。丙。丁。');
  groupRows(rows, [rows[0].id, rows[1].id, rows[2].id]);
  const reg = {};
  const a = ensureAsset(reg, '/tmp/a.png');
  rows.slice(0, 3).forEach(r => {
    r.assetUsages = [{ assetId: a.id }];
  });
  assert.equal(countAssetShots(rows, a.id), 1); // 共用三句算一处
  rows[3].assetUsages = [{ assetId: a.id }];
  assert.equal(countAssetShots(rows, a.id), 2); // 独立句再用一次算第二处
});

/* ── 共用画面范围调整 ── */
const mkRows = () => [
  { id: 1, kind: 'line', text: '甲。' },
  { id: 2, kind: 'line', text: '乙。' },
  { id: 3, kind: 'line', text: '丙。' },
  { id: 4, kind: 'section', text: '下一章' },
  { id: 5, kind: 'line', text: '丁。' },
  { id: 6, kind: 'line', text: '戊。' },
];
test('加入下一句：紧邻才可加；章节末尾与另一组都拒绝', () => {
  const rows = mkRows();
  groupRows(rows, [rows[0].id, rows[1].id]);
  let plan = groupExtendNextPlan(rows, rows[0].groupId);
  assert.equal(plan.ok, true);
  assert.equal(plan.next.id, 3);
  groupExtendNext(rows, rows[0].groupId);
  plan = groupExtendNextPlan(rows, rows[0].groupId);
  assert.equal(plan.ok, false);
  assert.ok(plan.reason.includes('章节'));
  const rows2 = lines('甲。乙。丙。丁。');
  groupRows(rows2, [rows2[0].id, rows2[1].id]);
  groupRows(rows2, [rows2[2].id, rows2[3].id]);
  plan = groupExtendNextPlan(rows2, rows2[0].groupId);
  assert.equal(plan.ok, false);
  assert.ok(plan.reason.includes('另一个共用画面'));
});
test('加入有差异的句子先出差异报告，无差异直接可执行', () => {
  const rows = mkRows();
  groupRows(rows, [rows[0].id, rows[1].id]);
  rows[0].note = '全景';
  rows[0].status = 'ready';
  rows[0].assetUsages = [{ assetId: 'as-x', clip: { in: 1, out: 5 } }];
  rows[1].note = '全景';
  rows[1].status = 'ready';
  rows[1].assetUsages = [{ assetId: 'as-x', clip: { in: 1, out: 5 } }];
  rows[2].note = '特写';
  rows[2].status = 'todo';
  rows[2].assetUsages = [{ assetId: 'as-x', clip: { in: 9, out: 12 } }, { assetId: 'as-y' }];
  const plan = groupExtendNextPlan(rows, rows[0].groupId);
  const fields = plan.diffs.map(d => d.field);
  assert.ok(fields.includes('画面描述'));
  assert.ok(fields.includes('素材片段'));
  assert.ok(fields.includes('制作状态'));
  assert.ok(fields.includes('素材'));
  // 合并执行：描述两行都留、片段取组内、素材并入、状态按规则落
  groupExtendNext(rows, rows[0].groupId);
  for (const r of rows.slice(0, 3)) {
    assert.equal(r.note, '全景\n特写');
    assert.equal(r.status, 'todo');
    assert.deepEqual(
      usageList(r).map(u => u.assetId),
      ['as-x', 'as-y'],
    );
    assert.equal(usageList(r)[0].clip.in, 1);
  }
  const clean = mkRows();
  groupRows(clean, [clean[0].id, clean[1].id]);
  assert.equal(groupExtendNextPlan(clean, clean[0].groupId).diffs.length, 0);
});
test('移出最后一句恢复独立并保留副本，单句自动退化', () => {
  const rows = mkRows();
  groupRows(rows, [rows[0].id, rows[1].id, rows[2].id]);
  rows.forEach(r => {
    r.note = '共同描述';
    r.assetUsages = [{ assetId: 'as-x', clip: { in: 1, out: 5 } }];
  });
  const gid = rows[0].groupId;
  const last = groupDropLast(rows, gid);
  assert.equal(last.id, 3);
  assert.equal(last.groupId, undefined);
  assert.equal(last.note, '共同描述');
  assert.deepEqual(usageList(last)[0].clip, { in: 1, out: 5 });
  last.note = '独立改';
  assert.equal(rows[0].note, '共同描述'); // 之后编辑互不影响
  assert.equal(groupDropLast(rows, gid).id, 2);
  assert.equal(rows[0].groupId, undefined); // 剩一句自动独立
});
test('从组内拆分前后两部分保留信息，首末句给出原因', () => {
  const rows = mkRows();
  groupRows(rows, [rows[0].id, rows[1].id, rows[2].id]);
  rows.forEach(r => {
    r.note = '共同描述';
  });
  const gid = rows[0].groupId;
  assert.equal(groupSplitAtPlan(rows, gid, 1).ok, false);
  assert.ok(groupSplitAtPlan(rows, gid, 1).reason.includes('第一句'));
  assert.equal(groupSplitAtPlan(rows, gid, 3).ok, false);
  assert.ok(groupSplitAtPlan(rows, gid, 3).reason.includes('最后一句'));
  const res = groupSplitAt(rows, gid, 2);
  assert.equal(res.front.length, 1);
  assert.equal(rows[0].groupId, undefined); // 前半只有一句自动独立
  assert.equal(res.back.length, 2);
  assert.ok(rows[1].groupId && rows[1].groupId !== gid);
  assert.equal(rows[1].groupId, rows[2].groupId);
  assert.equal(rows[2].note, '共同描述');
  // 前后独立修改互不影响
  rows[1].note = '后半改';
  assert.equal(rows[0].note, '共同描述');
});
test('拆分前后各两句时保留原组号与新组号', () => {
  const rows = [1, 2, 3, 4].map(i => ({ id: i, kind: 'line', text: '句' + i }));
  groupRows(
    rows,
    rows.map(r => r.id),
  );
  const gid = rows[0].groupId;
  const res = groupSplitAt(rows, gid, 3);
  assert.equal(rows[0].groupId, gid);
  assert.equal(rows[1].groupId, gid);
  assert.ok(rows[2].groupId && rows[2].groupId !== gid);
  assert.equal(rows[2].groupId, rows[3].groupId);
  assert.equal(res.ok, true);
});
test('同一共用画面的选区不允许重复建立（规则 8）', () => {
  const rows = mkRows();
  groupRows(rows, [rows[0].id, rows[1].id]);
  assert.equal(sameGroupSelection(rows, [rows[0].id, rows[1].id]), true);
  assert.equal(sameGroupSelection(rows, [rows[1].id, rows[2].id]), false);
});
test('项目 JSON 交换完整回读素材库与片段范围', () => {
  // 模拟导出 JSON 再导入：normalizeProjectRows 保留使用记录，素材库按 assetId 对上
  const registry = { 'as-1': { id: 'as-1', kind: 'video', path: '/tmp/片.mp4', name: '片.mp4', durationSec: 30 } };
  const rows = normalizeProjectRows([
    {
      id: 7,
      kind: 'line',
      text: '甲。',
      type: 'real',
      assets: '/tmp/片.mp4',
      assetUsages: [{ assetId: 'as-1', clip: { in: 12, out: 18 } }],
      groupId: 'shot-x',
      status: 'ready',
    },
    {
      id: 8,
      kind: 'line',
      text: '乙。',
      type: 'real',
      assets: '/tmp/片.mp4',
      assetUsages: [{ assetId: 'as-1', clip: { in: 12, out: 18 } }],
      groupId: 'shot-x',
      status: 'ready',
    },
  ]);
  assert.equal(rows[0].assetUsages[0].clip.in, 12);
  const reg = hydrateProjectAssets({ rows, assets: registry });
  assert.equal(rows[0].assetUsages[0].assetId, 'as-1');
  assert.deepEqual(rows[1].assetUsages[0].clip, { in: 12, out: 18 });
  assert.equal(reg['as-1'].durationSec, 30);
  assert.equal(rows[0].assets, '/tmp/片.mp4'); // 旧版文本镜像也在，老导出格式仍读得懂
});

/* ── 1.3：剪映字幕对齐 / 时长估算 ── */
const { parseSubtitles, alignScript, fmtTc } = await import('../renderer/src/subtitle-align.js');
const { speechUnits } = await import('../renderer/src/util.js');
test('SRT / VTT 解析：带小时、逗号或点毫秒、样式标签、BOM', () => {
  const cues = parseSubtitles(
    '﻿1\r\n01:00:01,5 --> 01:00:03,250\r\n<i>第一句</i>\r\n\r\n2\r\n01:00:04,000 --> 01:00:05,000\r\n{\\an8}第二句\r\n',
  );
  assert.deepEqual(
    cues.map(c => [c.start, c.end, c.text]),
    [
      [3601.5, 3603.25, '第一句'],
      [3604, 3605, '第二句'],
    ],
  );
  const vtt = parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.500\n你好世界');
  assert.deepEqual(
    vtt.map(c => [c.start, c.end]),
    [[1, 2.5]],
  );
});
test('字幕对齐：错字、断句不同、多说的话都不影响，没录的句子按前后推算', () => {
  const ls = [
    { id: 1, text: '今天我们聊聊短视频的剪辑节奏。' },
    { id: 2, text: '很多人一上来就堆特效，' },
    { id: 3, text: '这一句录的时候删掉了。' },
    { id: 4, text: '其实观众最在意的是信息密度！' },
  ];
  const cues = parseSubtitles(
    `1
00:00:00,500 --> 00:00:02,000
今天我们聊聊
2
00:00:02,000 --> 00:00:03,800
短视频的剪接节奏

3
00:00:04,000 --> 00:00:05,000
呃那个

4
00:00:05,000 --> 00:00:07,000
很多人一上来就堆特效

5
00:00:07,500 --> 00:00:10,000
其实观众最在意的是信息密度`.replace(/\n2\n/, '\n\n2\n'),
  );
  const { times, stats } = alignScript(ls, cues);
  assert.equal(stats.ok, 3);
  assert.equal(stats.est, 1);
  assert.ok(Math.abs(times.get(1).start - 0.5) < 0.01 && Math.abs(times.get(1).end - 3.8) < 0.01);
  assert.ok(Math.abs(times.get(2).start - 5) < 0.01 && Math.abs(times.get(4).end - 10) < 0.01);
  const t3 = times.get(3);
  assert.equal(t3.st, 'est');
  assert.ok(t3.start >= times.get(2).end - 0.001 && t3.end <= times.get(4).start + 0.001);
});
test('时间码格式', () => {
  assert.equal(fmtTc(62.345), '01:02.3');
  assert.equal(fmtTc(3723.5, { precise: true }), '01:02:03.500');
  assert.equal(fmtTc(59.9999, { precise: true }), '00:00:59.999');
});
test('朗读量：英文按词算，不再按字母算', () => {
  assert.equal(speechUnits('你好 world'), 2 + 1.8);
  assert.equal(speechUnits('2026 年'), 5);
  assert.equal(speechUnits("it's"), 1.8);
});
test('项目 JSON 导入保留字幕时间，改稿保留对上句子的时间', () => {
  const rows = normalizeProjectRows([
    { kind: 'line', text: '甲', time: { start: 1, end: 2, conf: 1, st: 'ok' } },
    { kind: 'line', text: '乙', time: { start: 'x' } },
  ]);
  assert.deepEqual(rows[0].time, { start: 1, end: 2, conf: 1, st: 'ok' });
  assert.equal(rows[1].time, undefined);
  const old = lines('甲。乙。');
  old[0].time = { start: 0, end: 1, conf: 1, st: 'ok' };
  const res = reconcileDraft(old, lines('甲。丙。'));
  assert.deepEqual(res.rows[0].time, old[0].time);
  assert.equal(res.rows[1].time, undefined);
});
test('交稿检查：字幕里没找到的句子提示核对', () => {
  const rows = lines('甲。乙。');
  rows.forEach(r => {
    r.type = 'a';
  });
  rows[1].time = { start: 1, end: 2, conf: 0, st: 'est' };
  assert.deepEqual(
    checkDelivery(rows).map(x => x.issues),
    [['字幕里没找到这句']],
  );
});
test('PDF：共用画面的几句合为一个镜头，原文逐句保留', () => {
  const rows = parseAny('## 开场\n甲句。乙句。丙句。\n## 正文\n丁句。');
  const ls = rows.filter(r => r.kind === 'line');
  ls.forEach((r, i) => (r.no = i + 1));
  ls[0].type = 'real';
  ls[0].note = '航拍';
  groupRows(rows, [ls[0].id, ls[1].id]);
  const plan = planDocument(rows, 4.5);
  assert.equal(plan.chapters.length, 2);
  assert.equal(plan.shots.length, 3);
  assert.equal(plan.shots[0].lines.length, 2);
  assert.deepEqual(
    plan.shots[0].lines.map(l => l.text),
    ['甲句。', '乙句。'],
  );
  assert.equal(plan.shots[0].note, '航拍');
  assert.deepEqual(
    plan.chapters.map(c => [c.first, c.last]),
    [
      [1, 2],
      [3, 3],
    ],
  );
});
test('PDF：内容转义、A roll 不显示制作状态、空章节跳过', () => {
  const rows = [
    { id: 1, kind: 'section', text: '空章' },
    { id: 2, kind: 'section', text: '<b>章</b>' },
    { id: 3, kind: 'line', no: 1, text: '<script>x</script>。', type: 'a', status: 'todo', note: '' },
    {
      id: 4,
      kind: 'line',
      no: 2,
      text: '乙。',
      type: 'fx',
      status: 'ready',
      note: '字卡',
      assets: '/Users/me/私密/图.png\nhttps://example.com/v/clip.mp4',
    },
  ];
  const doc = buildPrintDoc({ title: '标题 & <测试>', rows }, { date: '2026年1月1日' });
  assert.ok(!doc.html.includes('<script>x'));
  assert.ok(doc.html.includes('&lt;b&gt;章&lt;/b&gt;'));
  assert.ok(!doc.html.includes('空章'));
  assert.equal((doc.html.match(/class="status /g) || []).length, 1);
  assert.ok(doc.html.includes('已就绪'));
  assert.ok(!doc.html.includes('/Users/me'), '本机路径不进 PDF');
  assert.ok(doc.html.includes('href="https://example.com/v/clip.mp4"'));
  assert.ok(doc.footer.includes('标题 &amp; &lt;测试&gt;'));
  assert.equal(doc.landscape, false);
});
test('PDF：选项关闭封面、状态与素材', () => {
  const rows = parseAny('甲。乙。');
  rows.forEach((r, i) => {
    r.no = i + 1;
    r.type = 'real';
    r.assets = '/a/b.png';
  });
  const doc = buildPrintDoc({ title: 't', rows }, { cover: false, status: false, assets: false, landscape: true });
  assert.ok(!doc.html.includes('class="cover"'));
  assert.ok(!doc.html.includes('class="status '));
  assert.ok(!doc.html.includes('class="assets"'));
  assert.equal(doc.landscape, true);
  assert.ok(!doc.html.includes('class="ch"'), '无章节的稿子不出章节标题');
});
test('PDF：时长格式', () => {
  assert.equal(fmtLong(42), '42 秒');
  assert.equal(fmtLong(120), '2 分钟');
  assert.equal(fmtLong(372), '6 分 12 秒');
});
test('PDF：当前素材库、视频片段和字幕时长完整保留', () => {
  const registry = { v: { path: '/Users/me/private/clip.mp4', kind: 'video' } };
  const rows = [
    {
      id: 1,
      kind: 'line',
      text: 'GPT explains this.',
      type: 'real',
      assetUsages: [{ assetId: 'v', clip: { in: 12, out: 18, needsAdjust: true } }],
      time: { start: 31, end: 36, st: 'ok' },
    },
  ];
  const plan = planDocument(rows, 4.5, registry);
  assert.equal(plan.seconds, 5);
  assert.equal(plan.timed, true);
  const doc = buildPrintDoc({ title: '新结构', rows, assets: registry });
  assert.ok(doc.html.includes('clip.mp4 · 片段 00:12–00:18 · 片段待调整'));
  assert.ok(doc.html.includes('00:31 · 5.0s'));
  assert.ok(!doc.html.includes('/Users/me/private'));
  assert.ok(doc.html.includes('已对齐的句子采用字幕时长'));
});
test('PDF：未对齐英文时长沿用软件的按词估算', () => {
  const plan = planDocument([{ kind: 'line', text: 'This is a test.' }], 4.5);
  assert.equal(plan.seconds, (4 * 1.8) / 4.5);
  assert.equal(plan.timed, false);
});
console.log(`${count} 项数据回归通过`);
