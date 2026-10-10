import { buildPrintDoc, planDocument, fmtLong } from '../renderer/src/core/print-doc.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { lineTag, fileTitle, hasLineTag, attachCandidate } from '../renderer/src/core/candidates.js';
import { parseAny, splitSentences } from '../renderer/src/core/parse.js';
import { packPlan, toPacked, fromPacked, isPackRel } from '../renderer/src/core/pack.js';
import {
  reworkShots,
  resolveOnApprove,
  setRework,
  setAssetRework,
  dismissRework,
  buildReworkDoc,
} from '../renderer/src/core/rework.js';
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
} from '../renderer/src/core/shots.js';
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
test('交稿检查：B roll 缺画面描述才提醒，不再看制作状态', () => {
  const rows = lines('甲。乙。');
  rows[0].type = 'a';
  rows[1].type = 'real';
  assert.deepEqual(checkDelivery(rows)[0].issues, ['缺画面描述']);
  rows[1].note = '全景';
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
test('改稿只继承唯一原文匹配，重复与修改句不继承标注', () => {
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
test('改稿改变镜头成员后解除分组', () => {
  const old = lines('甲。乙。丙。');
  groupRows(old, [old[0].id, old[1].id]);
  const result = reconcileDraft(old, lines('甲。新句。丙。'));
  assert.equal(result.rows[0].groupId, undefined);
  assert.equal(result.rows[0].needsReview, undefined);
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
} from '../renderer/src/core/asset-model.js';
import { fmtTime, parseTime } from '../renderer/src/core/text.js';
import {
  sameGroupSelection,
  groupExtendNextPlan,
  groupExtendNext,
  groupDropLast,
  groupSplitAt,
  groupSplitAtPlan,
} from '../renderer/src/core/shots.js';

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
  assert.ok(!fields.includes('制作状态'), '1.5 起不再比较制作状态');
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
const { parseSubtitles, alignScript, fmtTc } = await import('../renderer/src/core/subtitle-align.js');
const { speechUnits } = await import('../renderer/src/core/text.js');
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

/* ── 合入的 1.3.1 PDF 分镜脚本 / 1.4 素材角色与位置 ── */
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
test('PDF：内容转义、不再显示制作状态、空章节跳过', () => {
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
  assert.equal((doc.html.match(/class="status /g) || []).length, 0);
  assert.ok(!doc.html.includes('已就绪'));
  assert.ok(!doc.html.includes('/Users/me'), '本机路径不进 PDF');
  assert.ok(doc.html.includes('href="https://example.com/v/clip.mp4"'));
  assert.ok(doc.footer.includes('标题 &amp; &lt;测试&gt;'));
  assert.equal(doc.landscape, false);
});
test('PDF：选项关闭封面与素材', () => {
  const rows = parseAny('甲。乙。');
  rows.forEach((r, i) => {
    r.no = i + 1;
    r.type = 'real';
    r.assets = '/a/b.png';
  });
  const doc = buildPrintDoc({ title: 't', rows }, { cover: false, assets: false, landscape: true });
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
  assert.ok(doc.html.includes('时长采用剪映字幕的真实时间'));
});
test('PDF：未对齐英文时长沿用软件的按词估算', () => {
  const plan = planDocument([{ kind: 'line', text: 'This is a test.' }], 4.5);
  assert.equal(plan.seconds, (4 * 1.8) / 4.5);
  assert.equal(plan.timed, false);
});

/* ── 1.4 素材角色与位置 ── */
import {
  applyRole,
  applySpan,
  spanText,
  usageSpan,
  normalizeUsageSpans,
  mainCoverage,
} from '../renderer/src/core/shots.js';
import * as ED from '../renderer/src/core/export-doc.js';
const roleRows = () => {
  const rows = lines('甲。乙。丙。');
  rows.forEach((r, i) => {
    r.no = i + 1;
    r.type = 'real';
  });
  return rows;
};
test('合并画面时素材保留原来所在的句子，解除后各回各句', () => {
  const rows = roleRows();
  rows[0].assetUsages = [{ assetId: 'as-a', role: 'main' }];
  rows[2].assetUsages = [{ assetId: 'as-c', role: 'main' }];
  groupRows(
    rows,
    rows.map(r => r.id),
  );
  assert.deepEqual(
    rows.map(r => usageList(r).map(u => u.assetId)),
    [
      ['as-a', 'as-c'],
      ['as-a', 'as-c'],
      ['as-a', 'as-c'],
    ],
  );
  assert.equal(spanText(rows, 'as-a'), '第 1 句');
  assert.equal(spanText(rows, 'as-c'), '第 3 句');
  // 两个主画面不在同一句，可以共存
  assert.equal(usageList(rows[0])[1].role, 'main');
  rows.forEach(r => delete r.groupId);
  normalizeUsageSpans(rows);
  assert.deepEqual(
    rows.map(r => usageList(r).map(u => u.assetId)),
    [['as-a'], [], ['as-c']],
  );
});
test('设主画面：1.8 起一段可以有多个主画面，不再互相挤成备选', () => {
  const rows = roleRows();
  groupRows(
    rows,
    rows.map(r => r.id),
  );
  rows.forEach(
    r =>
      (r.assetUsages = [
        { assetId: 'x', role: 'main' },
        { assetId: 'y', role: 'alt' },
      ]),
  );
  assert.deepEqual(applyRole(rows, 'y', 'main'), []);
  assert.ok(rows.every(r => usageList(r)[0].role === 'main' && usageList(r)[1].role === 'main'));
  applySpan(rows, 'y', 1, 2);
  assert.deepEqual(usageSpan(rows, 'y'), { from: 1, to: 2, whole: false });
  applySpan(rows, 'x', 0, 0);
  assert.deepEqual(mainCoverage(rows), { anyRole: true, hasMain: true, full: true });
  assert.ok(!checkDelivery(rows)[0]?.issues.some(x => x.includes('主画面')));
  applyRole(rows, 'y', 'overlay');
  assert.ok(checkDelivery(rows)[0].issues.includes('部分句子没有主画面'));
  applyRole(rows, 'x', 'alt');
  assert.ok(checkDelivery(rows)[0].issues.includes('未指定主画面'));
});
test('旧项目没有角色时交稿检查不新增提醒', () => {
  const rows = roleRows();
  rows[0].note = '画面';
  rows[0].status = 'ready';
  rows[0].assetUsages = [{ assetId: 'x' }];
  assert.ok(!(checkDelivery(rows).find(x => x.id === rows[0].id)?.issues || []).some(x => x.includes('主画面')));
});
test('加入下一句：组内整段素材顺延，下一句自带的只在下一句', () => {
  const rows = roleRows();
  groupRows(rows, [rows[0].id, rows[1].id]);
  rows[0].assetUsages = [{ assetId: 'g', role: 'main' }];
  rows[1].assetUsages = [{ assetId: 'g', role: 'main' }];
  rows[2].assetUsages = [{ assetId: 'n', role: 'main' }];
  groupExtendNext(rows, rows[0].groupId);
  assert.equal(spanText(rows, 'g'), '整段');
  assert.equal(spanText(rows, 'n'), '第 3 句');
  // 第 3 句上有两个主画面：1.8 起都保留，预览里平分这句的时间
  assert.equal(usageList(rows[2]).find(u => u.assetId === 'n').role, 'main');
});
test('素材清单只列要用的，CSV 逐句只列这句出现的，MD 回读保留角色与位置', () => {
  const rows = roleRows();
  const registry = {};
  const a = ensureAsset(registry, '/tmp/主.png'),
    b = ensureAsset(registry, '/tmp/叠.png'),
    c = ensureAsset(registry, '/tmp/备.mp4');
  groupRows(
    rows,
    rows.map(r => r.id),
  );
  rows.forEach(
    r =>
      (r.assetUsages = [
        { assetId: a.id, role: 'main' },
        { assetId: b.id, role: 'overlay' },
        { assetId: c.id, role: 'alt' },
      ]),
  );
  applySpan(rows, b.id, 1, 1);
  rows.forEach(r => (r.note = '画面'));
  const md = ED.buildAssetListMd({ title: 't', rows, issues: [], registry, speechRate: 4.5 });
  assert.ok(md.includes('【主画面】主.png（整段）'));
  assert.ok(md.includes('【叠加】叠.png（第 2 句 · 整段）'));
  assert.ok(!md.includes('备.mp4') && md.includes('另有备选 1 个'));
  const csv = ED.buildCsv({ title: 't', rows, registry });
  const csvRows = csv.split('\n');
  assert.ok(!csvRows[1].includes('叠.png') && csvRows[2].includes('【叠加】叠.png'));
  const annotated = ED.buildAnnotatedMd({ title: 't', rows, issues: [], registry });
  const back = parseAny(annotated);
  const p = { rows: back };
  hydrateProjectAssets(p);
  const bl = back.filter(r => r.kind === 'line');
  bl.forEach((r, i) => (r.no = i + 1));
  const reg = p.assets;
  const idOf = path => Object.values(reg).find(x => x.path === path).id;
  assert.equal(usageList(bl[0]).find(u => u.assetId === idOf('/tmp/叠.png')).off, true);
  assert.equal(spanText(bl, idOf('/tmp/叠.png')), '第 2 句');
  assert.equal(usageList(bl[1]).find(u => u.assetId === idOf('/tmp/备.mp4')).role, 'alt');
});
test('PDF 不排备选，共用画面写明出现在哪几句', () => {
  const rows = roleRows();
  const registry = {};
  const a = ensureAsset(registry, '/tmp/主.png'),
    c = ensureAsset(registry, '/tmp/备.mp4');
  groupRows(
    rows,
    rows.map(r => r.id),
  );
  rows.forEach(
    r =>
      (r.assetUsages = [
        { assetId: a.id, role: 'main' },
        { assetId: c.id, role: 'alt' },
      ]),
  );
  applySpan(rows, a.id, 0, 1);
  const plan = planDocument(rows, 4.5, registry);
  const shot = plan.shots[0];
  assert.deepEqual(shot.assets, ['/tmp/主.png']);
  assert.equal(shot.clipLabels.get('/tmp/主.png'), '第 1–2 句 · 主画面');
});

/* ── 1.3.2：自定义类型 / 时间轴 / 导出细节 ── */
const { normalizeTypes, typeIndex, newTypeId } = await import('../renderer/src/core/types.js');
const { buildTimeline, lineAt, spanOf } = await import('../renderer/src/core/timeline.js');
const { buildCsv, buildAnnotatedMd, buildAssetListMd } = await import('../renderer/src/core/export-doc.js');
const { safeFileName } = await import('../renderer/src/core/text.js');
const { pruneTypingJunk, usagesFromText } = await import('../renderer/src/core/asset-model.js');
const { mdTypes } = await import('../renderer/src/core/parse.js');

test('类型表清洗：去重、补默认值、封顶 9 个，空表退回默认五类', () => {
  assert.equal(normalizeTypes(null).length, 5);
  assert.equal(normalizeTypes([]).length, 5);
  const t = normalizeTypes([
    { id: 'a', label: '口播' },
    { id: 'a', label: '重复' },
    { id: 'bad id', label: 'x' },
    { id: 'none', label: '保留字' },
    ...Array.from({ length: 12 }, (_, i) => ({ id: 'k' + i, label: 'K' + i })),
  ]);
  assert.equal(t.length, 9);
  assert.equal(t[0].label, '口播');
  assert.ok(/^#[0-9a-f]{6}$/.test(t[1].color));
  assert.equal(newTypeId([{ id: 't1' }, { id: 't2' }]), 't3');
});
test('类型索引：快捷键、是否需要画面、未知类型按需要画面处理', () => {
  const ti = typeIndex([
    { id: 'talk', label: '口播', visual: false },
    { id: 'map', label: '地图', visual: true },
  ]);
  assert.equal(ti.keyToType('1'), 'talk');
  assert.equal(ti.keyToType('2'), 'map');
  assert.equal(ti.keyToType('0'), null);
  assert.equal(ti.isTypeKey('3'), false);
  assert.equal(ti.needsVisual('talk'), false);
  assert.equal(ti.needsVisual('ghost'), true);
  assert.equal(ti.label(null), '未标注');
});
test('自定义类型：交稿检查按「是否需要画面」判断，不再写死 A roll', () => {
  const types = [
    { id: 'talk', label: '口播', visual: false },
    { id: 'map', label: '地图', visual: true },
  ];
  const rows = [
    { id: 1, kind: 'line', no: 1, text: '甲。', type: 'talk' },
    { id: 2, kind: 'line', no: 2, text: '乙。', type: 'map' },
  ];
  const issues = checkDelivery(rows, types);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, 2);
  assert.deepEqual(issues[0].issues, ['缺画面描述']);
  assert.equal(normalizeProjectRows([{ kind: 'line', text: '甲', type: 'talk' }], types)[0].type, 'talk');
  assert.equal(normalizeProjectRows([{ kind: 'line', text: '甲', type: 'talk' }])[0].type, null);
});
test('带批注 MD 带着自定义类型表来回不丢', () => {
  const types = normalizeTypes([
    { id: 'talk', label: '口播', full: '口播 · 出镜', color: '#123456', visual: false },
    { id: 'map', label: '地图', full: '地图动画', visual: true },
  ]);
  const rows = [
    { id: 1, kind: 'section', text: '开场' },
    { id: 2, kind: 'line', text: '第一句。', type: 'talk', note: '' },
    { id: 3, kind: 'line', text: '第二句。', type: 'map', note: '路线图\n第二行' },
  ];
  const md = buildAnnotatedMd({ title: '测试', rows, types });
  const back = mdTypes(md);
  assert.equal(back[0].color, '#123456');
  const parsed = parseAny(md).filter(r => r.kind === 'line');
  assert.deepEqual(
    parsed.map(r => [r.type, r.note]),
    [
      ['talk', ''],
      ['map', '路线图\n第二行'],
    ],
  );
});
test('时间轴：有口播音频没字幕时按字数比例铺满音频时长', () => {
  const lines = [
    { id: 1, text: '一二三四五六七八九十' },
    { id: 2, text: '一二三四五' },
  ];
  const rate = buildTimeline(lines, { speechRate: 5 });
  assert.equal(rate.source, 'rate');
  assert.equal(rate.times.get(1).end, 2);
  const fit = buildTimeline(lines, { voiceDuration: 30, speechRate: 5 });
  assert.equal(fit.source, 'fit');
  assert.equal(fit.times.get(1).end, 20);
  assert.equal(fit.times.get(2).start, 20);
  assert.equal(fit.times.get(2).end, 30);
  assert.equal(fit.rate, 0.5);
  assert.equal(lineAt(fit, [1, 2], 25), 2);
  assert.equal(lineAt(fit, [1, 2], 3), 1);
  assert.deepEqual(spanOf(fit, [1, 2]), { start: 0, end: 30 });
});
test('时间轴：字幕时间优先；对齐后新加的句子夹在前后之间按字数分', () => {
  const lines = [
    { id: 1, text: '甲乙', time: { start: 1, end: 2, st: 'ok' } },
    { id: 2, text: '新加的句子' },
    { id: 3, text: '丙丁', time: { start: 5, end: 6, st: 'low' } },
  ];
  const tl = buildTimeline(lines, { voiceDuration: 60 });
  assert.equal(tl.source, 'srt');
  assert.deepEqual(tl.times.get(2), { start: 2, end: 5, src: 'gap' });
  assert.equal(tl.times.get(3).st, 'low');
  assert.equal(tl.total, 60);
});
test('CSV：共用画面写成人话、防公式注入；有口播音频时带开始结束时间', () => {
  const rows = [
    { id: 1, kind: 'line', no: 1, text: '=SUM(1)', type: 'real', groupId: 'shot-x' },
    { id: 2, kind: 'line', no: 2, text: '第二句', type: 'real', groupId: 'shot-x' },
  ];
  const csv = buildCsv({ title: 't', rows, voiceDuration: 10 });
  assert.ok(csv.includes('"第 1–2 句"'));
  assert.ok(!csv.includes('shot-x'));
  assert.ok(csv.includes(`"'=SUM(1)"`));
  assert.ok(csv.includes('开始时间') && csv.includes('按音频推算'));
  const list = buildAssetListMd({ title: 't', rows, voiceDuration: 10 });
  assert.ok(list.includes('按口播音频时长推算'));
});
test('导出文件名：去掉 / : 等会被当成路径的字符', () => {
  assert.equal(safeFileName('A/B:测试?'), 'A-B-测试-');
  assert.equal(safeFileName('  '), '未命名项目');
});
test('素材路径打字残留：只清没被引用、且是别的路径前缀的条目', () => {
  const reg = {};
  for (let i = 1; i <= 8; i++) usagesFromText(reg, [], '/a/b.mp4'.slice(0, i));
  const keep = Object.values(reg).find(a => a.path === '/a/b.mp4').id;
  const other = usagesFromText(reg, [], '/x/独立素材.png')[0].assetId;
  const removed = pruneTypingJunk(reg, new Set([keep]));
  assert.equal(removed, 7);
  assert.deepEqual(Object.keys(reg).sort(), [keep, other].sort());
});

/* ── 1.6：合并后的交叉点 ── */
const { firstVisualUsage } = await import('../renderer/src/core/asset-model.js');
test('连播预览取这句出现的主画面：备选、叠加、不在这句的都不上屏', () => {
  const reg = {
    m: { id: 'm', kind: 'image', path: '/a/主.png' },
    o: { id: 'o', kind: 'image', path: '/a/叠.png' },
    x: { id: 'x', kind: 'video', path: '/a/备.mp4' },
    n: { id: 'n', kind: 'video', path: '/a/后.mp4' },
  };
  const row = {
    assetUsages: [
      { assetId: 'x', role: 'alt' },
      { assetId: 'o', role: 'overlay' },
      { assetId: 'n', role: 'main', off: true },
      { assetId: 'm', role: 'main' },
    ],
  };
  assert.equal(firstVisualUsage(reg, row).asset.id, 'm');
  row.assetUsages[3].off = true;
  assert.equal(firstVisualUsage(reg, row), null);
  assert.equal(firstVisualUsage(reg, { assetUsages: [{ assetId: 'n' }] }).asset.id, 'n', '未分配的也算');
});
test('PDF 按自定义类型排版：类型名、颜色，不需要配画面的不写「画面待定」', () => {
  const types = [
    { id: 'talk', label: '口播', full: '口播出镜', color: '#112233', visual: false },
    { id: 'map', label: '地图', full: '地图动画', color: '#445566', visual: true },
  ];
  const rows = [
    { id: 1, kind: 'line', no: 1, text: '甲。', type: 'talk' },
    { id: 2, kind: 'line', no: 2, text: '乙。', type: 'map' },
  ];
  const doc = buildPrintDoc({ title: 't', rows, types }, { date: 'd' });
  assert.ok(doc.html.includes('口播出镜') && doc.html.includes('地图动画'));
  assert.ok(doc.html.includes('--tc:#445566'));
  assert.equal((doc.html.match(/画面待定/g) || []).length, 1);
  const fit = planDocument(rows, 4.5, {}, { types, voiceDuration: 10 });
  assert.equal(fit.source, 'fit');
  assert.equal(Math.round(fit.seconds), 10);
});

/* ── 1.8：一个镜头多个主画面 + 手动出现时间 ── */
const { layoutShot, itemAt, clampSpan } = await import('../renderer/src/core/shot-layout.js');
const L8 = () => {
  // 三句，每句 9 个字 → 语速 4.5 字/秒 时每句 2 秒，整段 6 秒
  const rows = [1, 2, 3].map(i => ({ id: i, kind: 'line', no: i, text: '一二三四五六七八九', type: 'real' }));
  rows.forEach(r => (r.groupId = 'g8'));
  return rows;
};
const REG8 = {
  a: { id: 'a', kind: 'image', path: '/a/甲.png', name: '甲' },
  b: { id: 'b', kind: 'video', path: '/a/乙.mp4', name: '乙', durationSec: 3 },
  c: { id: 'c', kind: 'image', path: '/a/丙.png', name: '丙' },
};
const tl8 = rows => buildTimeline(rows, { speechRate: 4.5 });
const spans = lay => lay.items.map(it => [it.assetId, +it.start.toFixed(2), +it.end.toFixed(2)]);
const setUs = (rows, us) =>
  rows.forEach(r => (r.assetUsages = us.map(u => ({ ...u, ...(u.at ? { at: { ...u.at } } : {}) }))));
test('镜头排布：一个主画面铺满整段；两个都是整段时平分', () => {
  const rows = L8();
  setUs(rows, [{ assetId: 'a', role: 'main' }]);
  assert.deepEqual(spans(layoutShot(REG8, rows, tl8(rows))), [['a', 0, 6]]);
  setUs(rows, [
    { assetId: 'a', role: 'main' },
    { assetId: 'b', role: 'main' },
  ]);
  const lay = layoutShot(REG8, rows, tl8(rows));
  assert.deepEqual(spans(lay), [
    ['a', 0, 3],
    ['b', 3, 6],
  ]);
  assert.deepEqual(
    lay.items.map(i => i.n),
    [1, 2],
  );
  assert.equal(lay.timed, false);
});
test('镜头排布：按句子范围各占各的，叠加和备选不上屏', () => {
  const rows = L8();
  setUs(rows, [
    { assetId: 'a', role: 'main' },
    { assetId: 'b', role: 'main' },
    { assetId: 'c', role: 'alt' },
  ]);
  rows[1].assetUsages[0].off = true;
  rows[2].assetUsages[0].off = true; // 甲只在第 1 句
  rows[0].assetUsages[1].off = true; // 乙在第 2–3 句
  assert.deepEqual(spans(layoutShot(REG8, rows, tl8(rows))), [
    ['a', 0, 2],
    ['b', 2, 6],
  ]);
});
test('镜头排布：手动秒数照放，空着的地方是空白，超出口播的标出来', () => {
  const rows = L8();
  setUs(rows, [
    { assetId: 'a', role: 'main', at: { start: 1, end: 3.5, of: 1 } },
    { assetId: 'b', role: 'main', at: { start: 4, end: 7, of: 1 } },
  ]);
  const lay = layoutShot(REG8, rows, tl8(rows));
  assert.equal(lay.timed, true);
  assert.deepEqual(spans(lay), [
    ['a', 1, 3.5],
    ['b', 4, 7],
  ]);
  assert.equal(itemAt(lay, 0.5), null, '0–1 秒空白');
  assert.equal(itemAt(lay, 2).assetId, 'a');
  assert.equal(itemAt(lay, 3.7), null, '3.5–4 秒空白');
  assert.equal(itemAt(lay, 5.9).assetId, 'b');
  assert.equal(lay.items[1].over, true, '乙到 7 秒，口播只有 6 秒');
});
test('镜头排布：镜头第一句变了（拆分 / 往前并句）手动秒数作废，退回按句子', () => {
  const rows = L8();
  setUs(rows, [{ assetId: 'a', role: 'main', at: { start: 1, end: 2, of: 99 } }]);
  const lay = layoutShot(REG8, rows, tl8(rows));
  assert.equal(lay.timed, false);
  assert.deepEqual(spans(lay), [['a', 0, 6]]);
});
test('镜头排布：调过秒数后新加的主画面放进末尾空着的时间；没空就分最后一个的后一半', () => {
  const rows = L8();
  setUs(rows, [
    { assetId: 'a', role: 'main', at: { start: 0, end: 4, of: 1 } },
    { assetId: 'b', role: 'main' },
  ]);
  assert.deepEqual(spans(layoutShot(REG8, rows, tl8(rows))), [
    ['a', 0, 4],
    ['b', 4, 6],
  ]);
  setUs(rows, [
    { assetId: 'a', role: 'main', at: { start: 0, end: 6, of: 1 } },
    { assetId: 'b', role: 'main' },
  ]);
  assert.deepEqual(spans(layoutShot(REG8, rows, tl8(rows))), [
    ['a', 0, 3],
    ['b', 3, 6],
  ]);
});
test('镜头排布：没有主画面时退回第一个未分配的画面（旧项目）', () => {
  const rows = L8();
  setUs(rows, [{ assetId: 'c' }, { assetId: 'a' }]);
  assert.deepEqual(spans(layoutShot(REG8, rows, tl8(rows))), [['c', 0, 6]]);
});
test('拖动约束：不出口播、不压前后画面、最短 0.2 秒、平移保持长度', () => {
  const items = [
    { start: 0, end: 2 },
    { start: 3, end: 5 },
  ];
  assert.deepEqual(clampSpan(items, 1, 1, 5, 6, 'start'), { start: 2, end: 5 });
  assert.deepEqual(clampSpan(items, 0, 0, 4, 6, 'end'), { start: 0, end: 3 });
  assert.deepEqual(clampSpan(items, 1, 5, 7, 6, 'move'), { start: 4, end: 6 });
  assert.deepEqual(clampSpan(items, 1, 4.95, 5, 6, 'start'), { start: 4.8, end: 5 });
});
test('手动出现时间随项目保存、载入不丢', () => {
  const p = {
    assets: { a: { id: 'a', kind: 'image', path: '/a/甲.png' } },
    rows: [
      {
        id: 1,
        kind: 'line',
        text: '甲',
        assetUsages: [{ assetId: 'a', role: 'main', at: { start: 1, end: 2.5, of: 1 } }],
      },
    ],
  };
  hydrateProjectAssets(p);
  assert.deepEqual(p.rows[0].assetUsages[0].at, { start: 1, end: 2.5, of: 1 });
  p.rows[0].assetUsages[0].at = { start: 2, end: 1, of: 1 };
  hydrateProjectAssets(p);
  assert.equal(p.rows[0].assetUsages[0].at, undefined, '不合法的时间丢掉');
});
test('视频片段文件名带句号：按画面现在的句子范围，找不到画面退回清单 lines', () => {
  const rows = [
    { id: 1, kind: 'section', text: '段' },
    { id: 2, kind: 'line', no: 125, text: '甲', groupId: 'g' },
    { id: 3, kind: 'line', no: 126, text: '乙', groupId: 'g' },
    { id: 4, kind: 'line', no: 127, text: '丙', groupId: 'g' },
    { id: 5, kind: 'line', no: 128, text: '丁' },
  ];
  assert.equal(lineTag({ rowId: 2, lines: '1-3' }, rows), '第125-127句');
  assert.equal(lineTag({ rowId: 5 }, rows), '第128句');
  assert.equal(lineTag({ rowId: 99, lines: '40-42' }, rows), '第40-42句');
  assert.equal(lineTag({ rowId: 99 }, rows), '');
  assert.equal(fileTitle({ rowId: 2, title: '牛津邓恩病理学院' }, rows), '第125-127句_牛津邓恩病理学院');
  assert.equal(hasLineTag('/a/第125-127句_x_0m01s-0m05s.mp4'), true);
  assert.equal(hasLineTag('/a/x_0m01s-0m05s.mp4'), false);
});
test('视频审核通过一律当主画面：占位照片让位，已通过的视频不被顶掉', () => {
  const rows = [
    { id: 1, kind: 'line', no: 1, text: '甲', groupId: 'g', assetUsages: [{ assetId: 'p', role: 'main' }] },
    { id: 2, kind: 'line', no: 2, text: '乙', groupId: 'g', assetUsages: [{ assetId: 'p', role: 'main' }] },
  ];
  const reg = { p: { id: 'p', kind: 'image', path: '/x/照片.jpg', name: '照片.jpg' } };
  const mk = (id, url) => ({ id, rowId: 1, url, title: id, in: 1, out: 5, license: '', page: '' });
  const a = attachCandidate(mk('c1', 'https://x/a.mp4'), rows, reg);
  const b = attachCandidate(mk('c2', 'https://x/b.mp4'), rows, reg);
  const role = id => rows[0].assetUsages.find(u => u.assetId === id)?.role;
  assert.equal(a.role, 'main');
  assert.equal(b.role, 'main');
  assert.equal(role(a.assetId), 'main', '先通过的仍是主画面');
  assert.equal(role(b.assetId), 'main', '后通过的也是主画面');
  assert.equal(role('p'), 'alt', '占位照片让位成备选');
  assert.deepEqual(b.demoted, [], '第二次通过不再降级任何素材');
});
test('候选写了 for（配哪几句）：通过后只在那几句出现', () => {
  const rows = [1, 2, 3].map(n => ({
    id: n,
    kind: 'line',
    no: 199 + n,
    text: '句' + n,
    groupId: 'g',
    assetUsages: [],
  }));
  const reg = {};
  const r = attachCandidate(
    { id: 'c', rowId: 1, url: 'https://x/a.mp4', title: 'a', in: 1, out: 5, for: '202', license: '', page: '' },
    rows,
    reg,
  );
  const offs = rows.map(m => !!m.assetUsages.find(u => u.assetId === r.assetId)?.off);
  assert.deepEqual(offs, [true, true, false], '只在第 202 句出现');
  const all = attachCandidate(
    { id: 'd', rowId: 1, url: 'https://x/b.mp4', title: 'b', in: 1, out: 5, for: '', license: '', page: '' },
    rows,
    reg,
  );
  assert.ok(
    rows.every(m => !m.assetUsages.find(u => u.assetId === all.assetId)?.off),
    '没写 for：整段出现',
  );
});
/* ── 1.10：项目 JSON 往返 / 候选更新失效 / 交稿检查两种目标 ── */
const { buildProjectJson } = await import('../renderer/src/core/export-doc.js');
const {
  sanitizeProjectCandidates,
  planImport,
  CANDIDATE_TYPE,
  validateCandidateDoc,
  staleOnlineClips,
  remotePath,
  swapToLocal,
  detachCandidate,
} = await import('../renderer/src/core/candidates.js');
const { CANDIDATE_SPEC, CANDIDATE_EXAMPLE } = await import('../renderer/src/core/candidate-spec.js');
/* 合规范（v2）的最小候选清单 */
const v2 = shots => ({ type: CANDIDATE_TYPE, version: 2, project: '测试', batch: '测试批', shots });
const v2cand = c => ({ title: '标题', license: '版权未核实', why: '测试', ...c });
const { unlinkedShots } = await import('../renderer/src/core/shots.js');
test('1.10 项目 JSON 导入：id 合法就原样保留，手动秒数和候选都不失效', () => {
  const src = [
    { id: 10, kind: 'section', text: '章' },
    {
      id: 12,
      kind: 'line',
      text: '甲',
      type: 'real',
      groupId: 'shot-k',
      assetUsages: [{ assetId: 'v', role: 'main', at: { start: 1, end: 2, of: 12 } }],
    },
    {
      id: 15,
      kind: 'line',
      text: '乙',
      type: 'real',
      groupId: 'shot-k',
      assetUsages: [{ assetId: 'v', role: 'main', at: { start: 1, end: 2, of: 12 } }],
    },
  ];
  const info = {};
  const rows = normalizeProjectRows(src, undefined, info);
  assert.deepEqual(
    rows.map(r => r.id),
    [10, 12, 15],
  );
  assert.equal(rows[1].assetUsages[0].at.of, 12);
  assert.equal(info.idMap.get(15), 15);
});
test('1.10 项目 JSON 导入：id 重复要重新编号时，手动秒数的 at.of 跟着换', () => {
  const info = {};
  const rows = normalizeProjectRows(
    [
      {
        id: 7,
        kind: 'line',
        text: '甲',
        assetUsages: [{ assetId: 'v', role: 'main', at: { start: 0, end: 1, of: 7 } }],
      },
      { id: 7, kind: 'line', text: '乙' },
    ],
    undefined,
    info,
  );
  assert.deepEqual(
    rows.map(r => r.id),
    [1, 2],
  );
  assert.equal(rows[0].assetUsages[0].at.of, 1, '旧 id 7 → 新 id 1');
});
test('1.10 项目 JSON 带上视频候选和保存位置，导回来审核结果、批次都在；对不上句子的丢掉', () => {
  const cands = [
    {
      id: 'vc-1',
      key: 'A',
      lines: '1',
      rowId: 12,
      url: 'https://x/a.mp4',
      in: 1,
      out: 5,
      decision: 'ok',
      note: '好',
      assetId: 'v',
      savedPath: '/m/a.mp4',
      batchId: 'vb-1',
      batchName: '第一章',
      batchAt: 5,
      batchNo: 7,
    },
    {
      id: 'vc-2',
      key: 'B',
      lines: '1',
      rowId: 12,
      url: 'https://x/b.mp4',
      in: 1,
      out: 5,
      decision: 'no',
      note: '太远',
    },
    { id: 'vc-3', key: 'C', lines: '9', rowId: 99, url: 'https://x/c.mp4', in: 1, out: 5 },
    { id: 'vc-4', key: 'D', lines: '1', rowId: 12, url: 'ftp://x/d.mp4', in: 1, out: 5 },
  ];
  const json = JSON.parse(
    buildProjectJson({ title: 't', rows: [], assets: {}, speechRate: 4.5, candidates: cands, mediaDir: '/m' }),
  );
  assert.equal(json.v, 4);
  assert.equal(json.mediaDir, '/m');
  const back = sanitizeProjectCandidates(json.candidates, {
    idMap: new Map([[12, 2]]),
    rowIds: new Set([2]),
    assets: { v: { id: 'v' } },
  });
  assert.equal(back.length, 2, '对不上句子、链接不合法的丢掉');
  assert.equal(back[0].rowId, 2, 'rowId 按导入时的 id 映射改写');
  assert.equal(back[0].decision, 'ok');
  assert.equal(back[0].savedPath, '/m/a.mp4');
  assert.equal(back[0].batchName, '第一章');
  assert.equal(back[0].batchNo, 7, '项目 JSON 回读保留批次编号，删除旧批次后不重排');
  assert.equal(back[1].decision, 'no');
  assert.equal(back[1].note, '太远');
  const noAsset = sanitizeProjectCandidates(json.candidates, { rowIds: new Set([12]), assets: {} });
  assert.equal(noAsset[0].decision, '', '素材已不在库里：不再算「已通过」，回到待审');
});
test('1.10 同一份清单里的候选换了链接或片段：回到待审，旧素材关联和已保存状态作废', () => {
  const rows = [{ id: 1, kind: 'line', no: 1, text: '甲' }];
  const old = {
    id: 'vc-1',
    key: 'A',
    lines: '1',
    srcFile: '/c.json',
    rowId: 1,
    url: 'https://x/a.mp4',
    in: 1,
    out: 5,
    decision: 'ok',
    assetId: 'v',
    savedPath: '/m/a.mp4',
  };
  const doc = v2([{ lines: '1', label: '甲', cands: [v2cand({ key: 'A', url: 'https://x/a.mp4', in: 2, out: 6 })] }]);
  const plan = planImport(doc, '/c.json', rows, [old]);
  assert.equal(plan.updated.length, 1);
  const { next, changed } = plan.updated[0];
  assert.equal(changed, true);
  assert.equal(next.decision, '');
  assert.equal(next.assetId, undefined);
  assert.equal(next.savedPath, undefined);
  const same = planImport(
    v2([
      { lines: '1', label: '甲', cands: [v2cand({ key: 'A', url: 'https://x/a.mp4', in: 1, out: 5, why: '新理由' })] },
    ]),
    '/c.json',
    rows,
    [old],
  );
  assert.equal(same.updated[0].changed, false);
  assert.equal(same.updated[0].next.decision, 'ok', '只改了说明文字：审核结果保留');
  assert.equal(same.updated[0].next.savedPath, '/m/a.mp4');
});
test('1.10 交稿检查：方案检查不管素材；勾上素材交付后列出没关联素材、文件失联的镜头', () => {
  const rows = lines('甲。乙。丙。');
  rows.forEach(r => {
    r.type = 'real';
    r.note = '画面';
  });
  rows[1].assetUsages = [{ assetId: 'x', role: 'main' }];
  assert.equal(checkDelivery(rows).length, 0, '方案检查：素材没到位也通过');
  assert.equal(unlinkedShots(rows).length, 2);
  const altOnly = lines('丁。');
  altOnly[0].type = 'real';
  altOnly[0].assetUsages = [{ assetId: 'y', role: 'alt' }];
  assert.equal(unlinkedShots(altOnly).length, 1, '只有备选不算已关联');
  const full = checkDelivery(rows, undefined, {
    assets: true,
    missing: new Set(['/lost.mp4']),
    registry: { x: { path: '/lost.mp4' }, y: { path: '/y.mp4' } },
  });
  assert.deepEqual(
    full.map(x => x.issues),
    [['还没关联素材'], ['素材文件失联'], ['还没关联素材']],
  );
});
test('1.10.4 候选清单的「要的画面」和「只覆盖一部分」导入后保留，项目 JSON 往返不丢', () => {
  const rows = [{ id: 1, kind: 'line', no: 1, text: '甲' }];
  const plan = planImport(
    v2([
      {
        lines: '1',
        label: '总部',
        need: '两家总部航拍',
        cands: [
          v2cand({
            key: 'A',
            url: 'https://x/a.mp4',
            in: 1,
            out: 5,
            coverage: 'partial',
            limitations: '只拍到一家',
          }),
          v2cand({ key: 'B', url: 'https://x/b.mp4', in: 1, out: 5 }),
        ],
      },
    ]),
    '/c.json',
    rows,
    [],
  );
  const [a, b] = plan.added;
  assert.equal(a.need, '两家总部航拍');
  assert.equal(a.coverage, 'partial');
  assert.equal(a.limits, '只拍到一家');
  assert.equal(b.coverage, '', '没写 coverage 不算部分覆盖');
  const back = sanitizeProjectCandidates(JSON.parse(JSON.stringify([a])), { rowIds: new Set([1]) });
  assert.equal(back[0].need, '两家总部航拍');
  assert.equal(back[0].coverage, 'partial');
  assert.equal(back[0].limits, '只拍到一家');
});
test('1.10.4 候选清单格式 v2 是硬性规定：规范里的示例本身合格，「候选清单格式.md」和软件里的规范一字不差', () => {
  assert.deepEqual(validateCandidateDoc(CANDIDATE_EXAMPLE), []);
  const md = fs.readFileSync(path.join(ROOT, '候选清单格式.md'), 'utf8');
  assert.equal(md, CANDIDATE_SPEC, '改了 core/candidate-spec.js 后要重新生成 候选清单格式.md');
  const rows = [1, 2, 3].map(n => ({ id: n, kind: 'line', no: n, text: '句' + n }));
  assert.equal(
    planImport(CANDIDATE_EXAMPLE, '/e.json', rows, []).error,
    undefined,
    '示例能正常导入（对不上的句子只是跳过）',
  );
});
test('1.10.4 不合格式的候选清单整份拒收，并写出每一处错在哪', () => {
  const rows = [{ id: 1, kind: 'line', no: 1, text: '甲' }];
  const bad = {
    type: CANDIDATE_TYPE,
    version: 1,
    title: '旧写法',
    shots: [
      {
        lines: '1–2',
        cands: [
          { key: 'A', title: 'a', url: 'https://x/page', in: '1:41', out: 2, coverageStatus: 'partial' },
          { key: 'A', title: 'b', url: 'ftp://x/b.mp4', in: 5, out: 3, license: '', why: '理由', for: '9' },
          {
            key: 'C',
            title: 'c',
            url: 'https://x/c.mp4',
            in: 1,
            out: 4,
            license: '公有',
            why: '理由',
            coverage: 'partial',
          },
        ],
      },
    ],
  };
  const plan = planImport(bad, '/bad.json', rows, []);
  assert.ok(plan.error && Array.isArray(plan.errors), '整份拒收');
  assert.equal(plan.added, undefined, '一个候选都不导入');
  const all = plan.errors.join('\n');
  for (const want of [
    'version 必须是数字 2（这是旧格式 version 1',
    'project 必须写',
    'batch 必须写',
    '不认识的字段「title」',
    'lines 必须是文字句号',
    'label 必须写',
    'in 必须是秒数',
    '不认识的字段「coverageStatus」',
    'key "A" 在这个画面里重复了',
    'url 必须是能直接播放的视频文件地址',
    'out 必须大于 in',
    'license 必须写',
    'coverage 是 "partial" 时必须写 limitations',
  ])
    assert.ok(all.includes(want), '缺少提示：' + want);
  const ok = v2([
    {
      lines: '1',
      label: '甲',
      extra: { 备注: '随便写' },
      cands: [
        v2cand({ key: 'A', url: 'https://x/a.mp4', in: 1, out: 5, for: '1', extra: { checked: true } }),
        v2cand({ key: 'B', url: 'https://x/b.mp4', in: 1, out: 5, review: { decision: 'ok', note: '' } }),
      ],
    },
  ]);
  ok.extra = { anything: [1, 2] };
  ok.reviewedAt = '2026-10-09T03:22:44.412Z';
  assert.deepEqual(validateCandidateDoc(ok), [], 'extra 随便写；分镜台写回的 review / reviewedAt 不算错');
  const outOfRange = v2([
    { lines: '1-2', label: '甲', cands: [v2cand({ key: 'A', url: 'https://x/a.mp4', in: 1, out: 5, for: '3' })] },
  ]);
  assert.ok(validateCandidateDoc(outOfRange).some(e => e.includes('必须在这个画面的 lines "1-2" 范围内')));
  assert.ok(
    validateCandidateDoc(
      v2([{ lines: '1', label: '甲', cands: [v2cand({ key: 'A', url: 'https://x/a.mp4', in: '1', out: 5 })] }]),
    ).length,
    '秒数带引号也不行',
  );
});
test('1.10.4 保存过的片段又挂成了在线地址（撤回后再通过）：能找出来换回本地文件', () => {
  const rows = [1, 2].map(n => ({ id: n, kind: 'line', no: n, text: '句' + n, groupId: 'g', assetUsages: [] }));
  const reg = {};
  const c = {
    id: 'c1',
    rowId: 1,
    url: 'https://x/a.mp4',
    title: 'a',
    in: 13.5,
    out: 22,
    for: '',
    license: '',
    page: '',
  };
  const r1 = attachCandidate(c, rows, reg);
  c.assetId = r1.assetId;
  c.decision = 'ok';
  c.savedPath = '/m/第1-2句_a_0m14s-0m22s.mp4';
  assert.deepEqual(
    staleOnlineClips([c], rows, reg).map(x => x.asset.id),
    [r1.assetId],
    '挂着在线地址、却已保存 → 找出来',
  );
  swapToLocal(c, c.savedPath, rows, reg);
  assert.equal(staleOnlineClips([c], rows, reg).length, 0, '换成本地文件后不再算');
  // 撤回再通过：按在线地址新建了素材，候选上的「已保存」还在
  detachCandidate(c, rows, reg);
  const r2 = attachCandidate(c, rows, reg);
  c.assetId = r2.assetId;
  assert.equal(reg[r2.assetId].path, remotePath(c));
  const stale = staleOnlineClips([c], rows, reg);
  assert.equal(stale.length, 1);
  swapToLocal(c, c.savedPath, rows, reg);
  assert.equal(reg[r2.assetId].path, c.savedPath);
  assert.ok(
    rows.every(m => !m.assetUsages.find(u => u.assetId === r2.assetId)?.clip),
    '换成本地后不再带入出点',
  );
  c.decision = '';
  assert.equal(staleOnlineClips([c], rows, reg).length, 0, '没通过的不管');
});
test('项目打包：只带用到的本地文件，重名加 (2)，路径换成包内相对路径，导入后换回新位置', () => {
  const project = {
    title: '打包测试',
    rows: [
      {
        id: 1,
        kind: 'line',
        text: '甲。',
        assets: '/A/片段.mp4\n/B/片段.mp4',
        assetUsages: [
          { assetId: 'a1', role: 'main' },
          { assetId: 'a2', role: 'alt' },
        ],
      },
      { id: 2, kind: 'line', text: '乙。', assetUsages: [{ assetId: 'a3' }] },
    ],
    assets: {
      a1: { id: 'a1', kind: 'video', path: '/A/片段.mp4', name: '片段.mp4' },
      a2: { id: 'a2', kind: 'video', path: '/B/片段.mp4', name: '片段.mp4' },
      a3: { id: 'a3', kind: 'image', path: 'https://x.org/a.jpg', name: 'a.jpg' },
      a4: { id: 'a4', kind: 'video', path: '/C/没用到.mp4', name: '没用到.mp4' },
    },
    candidates: [
      { id: 'c1', rowId: 1, assetId: 'a1', savedPath: '/A/片段.mp4', srcFile: '/L/清单.json', decision: 'ok' },
    ],
    voice: { path: '/V/口播.m4a', name: '口播.m4a' },
    mediaDir: '/A',
  };
  const files = packPlan(project);
  assert.deepEqual(
    [...files],
    [
      ['/A/片段.mp4', '素材/片段.mp4'],
      ['/B/片段.mp4', '素材/片段 (2).mp4'],
      ['/L/清单.json', '候选清单/清单.json'],
      ['/V/口播.m4a', '口播/口播.m4a'],
    ],
  );
  assert.equal(packPlan(project, { includeAlt: false }).has('/B/片段.mp4'), false);
  const packed = toPacked(project, files);
  assert.equal(packed.assets.a1.path, '素材/片段.mp4');
  assert.equal(packed.assets.a2.path, '素材/片段 (2).mp4');
  assert.equal(packed.assets.a3.path, 'https://x.org/a.jpg', '在线素材不动');
  assert.equal(packed.assets.a4.path, '/C/没用到.mp4', '没打包的保持原路径');
  assert.equal(packed.candidates[0].savedPath, '素材/片段.mp4');
  assert.equal(packed.candidates[0].srcFile, '候选清单/清单.json');
  assert.equal(packed.voice.path, '口播/口播.m4a');
  assert.equal(packed.rows[0].assets, '素材/片段.mp4\n素材/片段 (2).mp4');
  assert.equal(packed.mediaDir, undefined);
  assert.equal(project.assets.a1.path, '/A/片段.mp4', '原项目不被改动');
  const back = fromPacked(packed, '/Users/b/影片/分镜台素材/打包测试/');
  assert.equal(back.assets.a2.path, '/Users/b/影片/分镜台素材/打包测试/素材/片段 (2).mp4');
  assert.equal(back.assets.a3.path, 'https://x.org/a.jpg');
  assert.equal(back.assets.a4.path, '/C/没用到.mp4');
  assert.equal(back.candidates[0].srcFile, '/Users/b/影片/分镜台素材/打包测试/候选清单/清单.json');
  assert.equal(back.voice.path, '/Users/b/影片/分镜台素材/打包测试/口播/口播.m4a');
  assert.equal(back.mediaDir, '/Users/b/影片/分镜台素材/打包测试/素材');
  assert.equal(back.pack, undefined);
  for (const bad of ['../x.mp4', '素材/../../x', '/abs', 'https://a/b', '', 'a\\b'])
    assert.equal(isPackRel(bad), false, bad);
});
test('撤回通过：候选记着的那句已经不在（被删 / 并掉），到用着这个视频的画面里摘掉', () => {
  const rows = [
    { id: 1, kind: 'line', no: 1, text: '甲', groupId: 'g', note: '', assetUsages: [] },
    { id: 2, kind: 'line', no: 2, text: '乙', groupId: 'g', note: '', assetUsages: [] },
    { id: 3, kind: 'line', no: 3, text: '丙', note: '', assetUsages: [] },
  ];
  const reg = {};
  const c = { id: 'c', rowId: 2, url: 'https://x/a.mp4', title: 'a', in: 1, out: 5, license: '', page: '' };
  c.assetId = attachCandidate(c, rows, reg).assetId;
  rows.splice(1, 1); // 第 2 句被删掉了，候选还记着它
  c.rowId = 99;
  detachCandidate(c, rows, reg);
  assert.ok(
    rows.every(r => !r.assetUsages.some(u => u.assetId === c.assetId)),
    '视频从画面上摘掉了',
  );
});
test('待返工：否掉了又没通过的画面、对素材点了不满意、要再找一个的画面才列出；有候选通过就消失', () => {
  const rows = [
    { id: 1, kind: 'line', no: 1, text: '甲', groupId: 'g', assetUsages: [{ assetId: 'old', role: 'main' }] },
    { id: 2, kind: 'line', no: 2, text: '乙', groupId: 'g', assetUsages: [{ assetId: 'old', role: 'main' }] },
    { id: 3, kind: 'line', no: 3, text: '丙', assetUsages: [] },
    { id: 4, kind: 'line', no: 4, text: '丁', assetUsages: [] },
  ];
  const c = (id, rowId, decision, decidedAt = 10) => ({
    id,
    rowId,
    decision,
    decidedAt,
    url: 'https://x/' + id,
    in: 0,
    out: 1,
  });
  const cands = [c('a', 2, 'no'), c('b', 3, 're'), c('d', 3, 'ok'), c('e', 4, '')];
  let list = reworkShots(rows, cands);
  assert.deepEqual(
    list.map(s => s.lead.id),
    [1],
    '第 3 句有通过的候选、第 4 句待审：都不算',
  );
  assert.deepEqual(
    list[0].rejected.map(x => x.id),
    ['a'],
  );
  dismissRework(rows, rows[1], 20);
  assert.equal(reworkShots(rows, cands).length, 0, '不用返工了之前否掉的不再算');
  cands.push(c('f', 1, 'no', 30));
  assert.equal(reworkShots(rows, cands).length, 1, '之后又否掉新的：重新出现');
  setRework(rows, rows[3], { note: '要外景', at: 40 });
  list = reworkShots(rows, cands);
  assert.deepEqual(
    list.map(s => s.lead.id),
    [1, 4],
    '要再找一个的画面也列出，按稿子顺序',
  );
  assert.equal(list[1].request.note, '要外景');
  // 已通过但对这个素材不满意：素材上记着；新的通过后旧的挪到备选，要求解决
  setAssetRework(rows, rows[0], 'old', { note: '太暗', at: 50 });
  assert.ok(
    rows.slice(0, 2).every(r => r.assetUsages[0].rework.note === '太暗'),
    '共用画面每句的使用记录都记着',
  );
  assert.deepEqual(reworkShots(rows, cands)[0].replaces, [{ assetId: 'old', note: '太暗', at: 50 }]);
  rows.slice(0, 2).forEach(r => r.assetUsages.push({ assetId: 'new', role: 'main' }));
  assert.deepEqual(resolveOnApprove(rows, rows[1], 'new'), ['old']);
  assert.ok(rows.slice(0, 2).every(r => r.assetUsages[0].role === 'alt' && !r.assetUsages[0].rework && !r.rework));
  cands.find(x => x.id === 'f').decision = 'ok';
  assert.deepEqual(
    reworkShots(rows, cands).map(s => s.lead.id),
    [4],
  );
  // 只对素材点了不满意、没有任何候选的画面也算
  setAssetRework(rows, rows[0], 'new', { note: '', at: 60 });
  assert.deepEqual(
    reworkShots(rows, cands).map(s => s.lead.id),
    [1, 4],
  );
  setAssetRework(rows, rows[0], 'new', null);
  assert.deepEqual(
    reworkShots(rows, cands).map(s => s.lead.id),
    [4],
    '不用换了：离开',
  );
});
test('待返工：返工单写句号、要换掉的素材和理由、补充要求、否掉的候选；项目 JSON 往返保留标记', () => {
  const rows = [
    { id: 1, kind: 'line', no: 7, text: '甲', note: '外景', assetUsages: [{ assetId: 'x', role: 'main' }] },
  ];
  setAssetRework(rows, rows[0], 'x', { note: '要彩色', at: 1 });
  setRework(rows, rows[0], { note: '再补一个近景', at: 2 });
  const cands = [{ id: 'a', rowId: 1, decision: 're', note: '太暗', title: 'A', url: 'https://a', in: 1, out: 2 }];
  const doc = buildReworkDoc({
    title: 'T',
    shots: reworkShots(rows, cands),
    registry: { x: { name: '旧.mp4', path: '/m/旧.mp4' } },
    batchName: () => '第 1 批',
  });
  assert.equal(doc.type, 'fenjingtai-rework');
  const s = doc.shots[0];
  assert.equal(s.lines, '7');
  assert.equal(s.request, '再补一个近景');
  assert.deepEqual(s.replace, [{ name: '旧.mp4', note: '要彩色' }]);
  assert.deepEqual(s.current, [{ name: '旧.mp4', role: '主画面', path: '/m/旧.mp4' }]);
  assert.deepEqual(s.rejected[0], {
    title: 'A',
    url: 'https://a',
    in: 1,
    out: 2,
    decision: '换一个',
    note: '太暗',
    batch: '第 1 批',
  });
  const back = normalizeProjectRows([{ ...rows[0], reworkOff: 5 }]);
  assert.deepEqual(back[0].rework, { note: '再补一个近景', at: 2 });
  assert.deepEqual(back[0].assetUsages[0].rework, { note: '要彩色', at: 1 });
  assert.equal(back[0].reworkOff, 5);
  assert.equal(normalizeProjectRows([{ id: 1, kind: 'line', text: 'x', rework: 'bad' }])[0].rework, undefined);
});
console.log(`${count} 项数据回归通过`);
