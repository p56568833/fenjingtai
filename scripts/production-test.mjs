import { prepareProjectEdit } from '../renderer/src/core/project-edit.js';
import { buildReviewIndex } from '../renderer/src/core/review-index.js';
import { transitionSession } from '../renderer/src/core/collab-session-state.js';
import { registerCommand, runCommand } from '../renderer/src/ui/base/commands.js';
import { fmtTc } from '../renderer/src/core/text.js';
import { buildPrintDoc, planDocument, fmtLong } from '../renderer/src/core/print-doc.js';
import { buildPictureCoverage, coverageOf as coverOf } from '../renderer/src/core/coverage.js';
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
  validGroup,
  normalizeGroups,
} from '../renderer/src/core/shots.js';
import { candidateBatches } from '../renderer/src/core/candidate-queries.js';
import { sentenceScope, normalizeReworkRequests } from '../renderer/src/core/candidate-scope.js';
import { normalizeProjectRows, reconcileDraft } from '../renderer/src/core/project-import.js';
import { normalizeProjectData, projectData, applyProjectData } from '../renderer/src/core/project-data.js';
import { projectDelta } from '../renderer/src/core/project-delta.js';
import { projectRefresh } from '../renderer/src/core/project-refresh.js';
import { captureMutation, restoreMutation } from '../renderer/src/core/project-transaction.js';
import { searchLineIds, parseJump, jumpLineIds } from '../renderer/src/core/search.js';
let count = 0;
function test(name, fn) {
  fn();
  count++;
  console.log('✓', name);
}
const lines = s => parseAny(s).filter(r => r.kind === 'line');
test('搜索正文定位到具体句，共用描述不重复计算，纯备注搜索仍可用', () => {
  const rows = [
    { id: 1, text: '前一句', note: '批发商', groupId: 'body' },
    { id: 2, text: '批发商在这里', note: '批发商', groupId: 'body' },
    { id: 3, text: '后一句', note: '批发商', groupId: 'body' },
    { id: 4, text: '另一段', note: '批发商', groupId: 'note' },
    { id: 5, text: '同一段', note: '批发商', groupId: 'note' },
    { id: 6, text: '独立句', note: '批发商' },
    { id: 7, text: '第二个批发商', note: '另一个描述' },
  ];
  assert.deepEqual(searchLineIds(rows, '批发商'), [2, 4, 6, 7]);
  assert.deepEqual(searchLineIds(rows, '描述'), [7]);
  assert.deepEqual(searchLineIds(rows, '没有结果'), []);
  assert.deepEqual(searchLineIds(rows, '  '), []);
  assert.deepEqual(searchLineIds([{ id: 8, text: 'GLP-1', note: '' }], ' glp-1 '), [8]);
  assert.deepEqual(
    searchLineIds(
      rows.filter(row => row.id !== 1),
      '批发商',
    ),
    [2, 4, 6, 7],
  );
});
test('搜索识别句子编号与口播时间，其他文字照常搜索', () => {
  assert.deepEqual(parseJump('248'), { kind: 'no', from: 248, to: 248, loose: true });
  assert.deepEqual(parseJump('#248'), { kind: 'no', from: 248, to: 248, loose: false });
  assert.deepEqual(parseJump('第 248 句'), { kind: 'no', from: 248, to: 248, loose: false });
  assert.deepEqual(parseJump('256-248'), { kind: 'no', from: 248, to: 256, range: true });
  assert.deepEqual(parseJump('第248句到第256句'), { kind: 'no', from: 248, to: 256, range: true });
  assert.deepEqual(parseJump('26:37'), { kind: 'time', from: 1597, to: 1597, loose: false });
  assert.deepEqual(parseJump('1:02:05'), { kind: 'time', from: 3725, to: 3725, loose: false });
  assert.deepEqual(parseJump('26分37秒'), { kind: 'time', from: 1597, to: 1597, loose: false });
  assert.deepEqual(parseJump('26.37'), { kind: 'time', from: 1597, to: 1597, loose: true });
  assert.deepEqual(parseJump('1.02.05'), { kind: 'time', from: 3725, to: 3725, loose: true });
  assert.deepEqual(parseJump('26.37-27.21'), { kind: 'time', from: 1597, to: 1641, range: true });
  assert.deepEqual(parseJump('26:37 ~ 27:21'), { kind: 'time', from: 1597, to: 1641, range: true });
  for (const text of ['GLP-1', '26:70', '批发商', '5.5', '26.7', '26.75', '26.375', '', '1-2-3'])
    assert.equal(parseJump(text), null, text);
  const lines = [1, 2, 3, 4].map(id => ({ id }));
  const tl = {
    total: 40,
    times: new Map(lines.map(r => [r.id, { start: (r.id - 1) * 10, end: r.id * 10 }])),
  };
  const fmt = sec => `${sec}s`;
  assert.deepEqual(jumpLineIds(parseJump('3'), lines, tl, fmt), { ids: [3], label: '→ 第 3 句' });
  assert.deepEqual(jumpLineIds(parseJump('3-9'), lines, tl, fmt).ids, [3, 4]);
  assert.deepEqual(jumpLineIds(parseJump('9'), lines, tl, fmt), { ids: [], label: '没有第 9 句' });
  assert.deepEqual(jumpLineIds(parseJump('0:25'), lines, tl, fmt), { ids: [3], label: '25s → 第 3 句' });
  assert.deepEqual(jumpLineIds(parseJump('0:15-0:25'), lines, tl, fmt).ids, [2, 3]);
  assert.deepEqual(jumpLineIds(parseJump('1:00'), lines, tl, fmt), { ids: [], label: '超出全片时长 40s' });
});
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
import { sameGroupSelection } from '../renderer/src/core/shots.js';
import {
  groupExtendNextPlan,
  groupExtendNext,
  groupDropLast,
  groupSplitAt,
  groupSplitAtPlan,
} from '../renderer/src/core/shot-groups.js';

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
const { parseSubtitles, alignScript } = await import('../renderer/src/core/subtitle-align.js');
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
const { pruneTypingJunk } = await import('../renderer/src/core/asset-model.js');
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
  for (let i = 1; i <= 8; i++) ensureAsset(reg, '/a/b.mp4'.slice(0, i), { kind: 'doc' });
  const keep = Object.values(reg).find(a => a.path === '/a/b.mp4').id;
  const other = ensureAsset(reg, '/x/独立素材.png').id;
  const removed = pruneTypingJunk(reg, new Set([keep]));
  assert.equal(removed, 7);
  assert.deepEqual(Object.keys(reg).sort(), [keep, other].sort());
});

/* ── 1.6：合并后的交叉点 ── */
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
const { layoutShot, itemAt, linesOfTime, syncSpansFromTimes } = await import('../renderer/src/core/shot-layout.js');
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
// 排给每个画面的时间（视频画面本身还会截到可用长度，见 shown）
const spans = lay => lay.items.map(it => [it.assetId, +it.start.toFixed(2), +(it.slotEnd ?? it.end).toFixed(2)]);
const shown = lay => lay.items.map(it => [it.assetId, +it.start.toFixed(2), +it.end.toFixed(2)]);
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
test('镜头排布：几个画面配同一段时按顺序接起来，视频占可用长度，图片平分剩下的；不够长留空白，太长标排不下', () => {
  const rows = L8(); // 整段 6 秒
  const reg = {
    v1: { id: 'v1', kind: 'video', path: '/a/1.mp4', durationSec: 30 },
    v2: { id: 'v2', kind: 'video', path: '/a/2.mp4', durationSec: 30 },
    p: { id: 'p', kind: 'image', path: '/a/p.png' },
    u: { id: 'u', kind: 'video', path: '/a/u.mp4' }, // 还不知道时长
  };
  const clip = (id, len) => ({ assetId: id, role: 'main', clip: { in: 0, out: len } });
  setUs(rows, [clip('v1', 1.5), clip('v2', 2)]);
  let lay = layoutShot(reg, rows, tl8(rows));
  assert.deepEqual(shown(lay), [
    ['v1', 0, 1.5],
    ['v2', 1.5, 3.5],
  ]);
  assert.equal(lay.items[1].slotEnd, 6, '不够长：画面只放片段那么长，排给它的时间仍到末尾');
  assert.equal(lay.items[1].over, false);
  assert.equal(coverOf(lay.items[1], lay.dur).lack, 2.5, '后面 2.5 秒是空白，够不够照排给它的时间算');
  setUs(rows, [clip('v1', 1.5), { ...clip('v2', 2), fitDone: true }]);
  assert.deepEqual(
    shown(layoutShot(reg, rows, tl8(rows))),
    [
      ['v1', 0, 1.5],
      ['v2', 1.5, 6],
    ],
    '标了剪辑里补足（定格 / 放慢）：照排给它的时间放',
  );
  setUs(rows, [clip('v1', 1.5), { assetId: 'p', role: 'main' }, { assetId: 'u', role: 'main' }]);
  assert.deepEqual(spans(layoutShot(reg, rows, tl8(rows))), [
    ['v1', 0, 1.5],
    ['p', 1.5, 3.75],
    ['u', 3.75, 6],
  ]);
  setUs(rows, [clip('v1', 4), clip('v2', 4), { assetId: 'p', role: 'main' }]);
  lay = layoutShot(reg, rows, tl8(rows));
  assert.deepEqual(spans(lay), [
    ['v1', 0, 4],
    ['v2', 4, 6],
    ['p', 8, 8.2],
  ]);
  assert.deepEqual(
    lay.items.map(i => i.over),
    [false, false, true],
    '跨过末尾的截到末尾；整个排在末尾之后的标排不下',
  );
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
test('镜头排布：两个画面只在一句上重叠时，只平分那一句', () => {
  const rows = L8();
  setUs(rows, [
    { assetId: 'a', role: 'main' },
    { assetId: 'b', role: 'main' },
  ]);
  rows[2].assetUsages[0].off = true; // 甲配第 1–2 句
  rows[0].assetUsages[1].off = true; // 乙配第 2–3 句
  assert.deepEqual(spans(layoutShot(REG8, rows, tl8(rows))), [
    ['a', 0, 3],
    ['b', 3, 6],
  ]);
  // 乙整个套在甲里面（甲三句、乙只第 2 句）排不连续：退回整段平分
  setUs(rows, [
    { assetId: 'a', role: 'main' },
    { assetId: 'b', role: 'main' },
  ]);
  rows[0].assetUsages[1].off = true;
  rows[2].assetUsages[1].off = true;
  assert.deepEqual(spans(layoutShot(REG8, rows, tl8(rows))), [
    ['a', 0, 3],
    ['b', 3, 6],
  ]);
  // 甲第 1 句、乙第 1–3 句：第 1 句两人平分，乙接着放完
  setUs(rows, [
    { assetId: 'a', role: 'main' },
    { assetId: 'b', role: 'main' },
  ]);
  rows[1].assetUsages[0].off = true;
  rows[2].assetUsages[0].off = true;
  assert.deepEqual(spans(layoutShot(REG8, rows, tl8(rows))), [
    ['a', 0, 1],
    ['b', 1, 6],
  ]);
});
test('手动时间属于哪几句：占一半以上算，都不到一半算占得最多的那句；载入时补齐', () => {
  const rows = L8(); // 每句 2 秒：0–2 / 2–4 / 4–6
  const tl = tl8(rows);
  assert.deepEqual(linesOfTime(rows, tl, 0, 2.3), { from: 0, to: 0 }); // 只多拖了 0.3 秒，还是第 1 句
  assert.deepEqual(linesOfTime(rows, tl, 0.2, 3.2), { from: 0, to: 1 }); // 第 2 句占了 1.2 秒，过半
  assert.deepEqual(linesOfTime(rows, tl, 1.5, 2.4), { from: 0, to: 0 }); // 都不到一半：第 1 句 0.5 > 第 2 句 0.4
  assert.deepEqual(linesOfTime(rows, tl, 2, 6), { from: 1, to: 2 });
  setUs(rows, [
    { assetId: 'a', role: 'main', at: { start: 0, end: 2.3, of: 1 } },
    { assetId: 'b', role: 'main', at: { start: 2.3, end: 6, of: 1 } },
  ]);
  assert.equal(syncSpansFromTimes(rows, tl), 2);
  assert.deepEqual(
    rows.map(r => usageList(r).map(u => !u.off)),
    [
      [true, false],
      [false, true],
      [false, true],
    ],
  );
  assert.equal(syncSpansFromTimes(rows, tl), 0); // 已经对上了，再跑一遍不改
});
test('上屏画面按句子先后自动排：前面的画面改配后面的句子，顺序跟着换', async () => {
  const { sortMainsBySentence } = await import('../renderer/src/core/shots.js');
  const rows = L8();
  setUs(rows, [
    { assetId: 'a', role: 'main' },
    { assetId: 'c', role: 'alt' },
    { assetId: 'b', role: 'main' },
  ]);
  rows[0].assetUsages[0].off = true; // 甲配第 2–3 句
  rows[1].assetUsages[2].off = true;
  rows[2].assetUsages[2].off = true; // 乙配第 1 句
  assert.equal(sortMainsBySentence(rows), true);
  assert.deepEqual(
    rows.map(r => usageList(r).map(u => u.assetId)),
    [
      ['b', 'c', 'a'],
      ['b', 'c', 'a'],
      ['b', 'c', 'a'],
    ],
  ); // 备选丙原地不动
  assert.deepEqual(spans(layoutShot(REG8, rows, tl8(rows))), [
    ['b', 0, 2],
    ['a', 2, 6],
  ]);
  assert.equal(sortMainsBySentence(rows), false);
  // 同样起点的不动（「往前 / 往后」排的先后保留）
  setUs(rows, [
    { assetId: 'b', role: 'main' },
    { assetId: 'a', role: 'main' },
  ]);
  assert.equal(sortMainsBySentence(rows), false);
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
test('两条轨：通过的先排正片轨、排满放备选轨；互换、插入、拖下来和备选位置', async () => {
  const { buildTimeline } = await import('../renderer/src/core/timeline.js');
  const T = await import('../renderer/src/core/shot-tracks.js');
  const { layoutShot } = await import('../renderer/src/core/shot-layout.js');
  const { applyRole } = await import('../renderer/src/core/shots.js');
  const rows = [1, 2, 3].map(n => ({
    id: n,
    kind: 'line',
    no: 199 + n,
    text: '句' + n,
    groupId: 'g',
    time: { start: (n - 1) * 2, end: n * 2, st: 'ok' },
    assetUsages: [],
  }));
  const tl = buildTimeline(rows);
  const reg = {};
  const cands = [];
  const mk = (id, plan, seq, url, best) => ({
    id,
    rowId: 1,
    plan,
    seq,
    url,
    title: id,
    in: best.in - 1,
    out: best.out + 1,
    best,
    license: '',
    page: '',
  });
  const approve = c => {
    const r = attachCandidate(c, rows, reg, cands, { tl });
    c.assetId = r.assetId;
    c.decision = 'ok';
    cands.push(c);
    return r;
  };
  const b = mk('b', 1, 1, 'https://x/b.mp4', { in: 10, out: 13 });
  const a = mk('a', 1, 0, 'https://x/a.mp4', { in: 1, out: 4 });
  const c = mk('c', 2, 0, 'https://x/c.mp4', { in: 1, out: 7 });
  assert.equal(approve(b).role, 'main', '正片轨空着：通过的放上正片轨');
  assert.equal(approve(a).role, 'main', '还没排满：接着放上正片轨');
  const mains = () => rows[0].assetUsages.filter(u => u.role === 'main').map(u => reg[u.assetId].source.candidate);
  assert.deepEqual(mains(), ['a', 'b'], '自动排时按清单里的先后排，不按通过的先后');
  assert.ok(
    rows.every(m => m.assetUsages.every(u => !u.off)),
    '通过的视频都配整个画面',
  );
  assert.equal(T.mainFilled(reg, rows, tl), true, '3 + 3 秒排满 6 秒口播');
  const r = approve(c);
  assert.equal(r.role, 'alt', '正片轨排满：放到备选轨');
  assert.equal(r.current, false);
  const alts = T.altItems(reg, rows, tl);
  assert.deepEqual(
    alts.map(x => [x.assetId, x.start, x.end, x.row]),
    [[c.assetId, 0, 6, 0]],
    '没拖过的备选放在它配的那几句下面，按可用长度',
  );
  const items = layoutShot(reg, rows, tl).items;
  const swap = T.swapIntoMain(items, 0, alts[0], 6);
  assert.deepEqual(
    swap.mains.map(e => [e.assetId, e.start, e.end]),
    [
      [c.assetId, 0, 3],
      [b.assetId, 3, 6],
    ],
  );
  assert.deepEqual(
    swap.alts.map(e => [e.assetId, e.start, e.end]),
    [[a.assetId, 0, 3]],
    '互换：备选占那段的位置和长度，换下来的放到备选原来的位置',
  );
  const down = T.dropToAlt(items, 0, 2, 6);
  assert.deepEqual(
    down.mains.map(e => [e.assetId, e.start, e.end]),
    [[b.assetId, 3, 6]],
    '拖下来：别的画面原地不动',
  );
  assert.deepEqual(T.mainGaps({ dur: 6, items: down.mains }), [{ start: 0, end: 3 }], '原来的位置留空');
  const ins = T.insertIntoMain(down.mains, { ...alts[0], end: 2 }, 2, 6);
  assert.deepEqual(
    ins.mains.map(e => [e.assetId, e.start, e.end]),
    [
      [c.assetId, 2, 8],
      [b.assetId, 8, 11],
    ],
    '插进空隙：后面撞上的画面整体往后让',
  );
  assert.deepEqual(
    T.moveAlt({ assetId: 'x', start: 1, end: 3 }, 5.5, 6),
    { assetId: 'x', start: 4, end: 6 },
    '备选不出镜头',
  );
  // 主画面撤成备选：时间留着当备选轨位置；备选再当主画面：不沿用旧时间
  for (const m of rows) for (const u of m.assetUsages) if (u.assetId === b.assetId) u.at = { start: 3, end: 6, of: 1 };
  applyRole(rows, b.assetId, 'alt');
  assert.deepEqual(rows[0].assetUsages.find(u => u.assetId === b.assetId).at, { start: 3, end: 6, of: 1 });
  assert.deepEqual(
    T.altItems(reg, rows, tl).map(x => [x.assetId, x.row]),
    [
      [c.assetId, 0],
      [b.assetId, 1],
    ],
    '时间上重叠的备选往下叠一层',
  );
  applyRole(rows, b.assetId, 'main');
  assert.equal(rows[0].assetUsages.find(u => u.assetId === b.assetId).at, undefined);
  // 拖过时间的镜头：通过的视频放进第一个空当
  for (const m of rows) for (const u of m.assetUsages) if (u.assetId === a.assetId) u.at = { start: 0, end: 2, of: 1 };
  for (const m of rows) for (const u of m.assetUsages) if (u.assetId === b.assetId) u.at = { start: 4, end: 6, of: 1 };
  const place = T.placeApproved(reg, rows, tl, 5, id => id !== c.assetId);
  assert.deepEqual(place, { role: 'main', at: { start: 2, end: 4 } }, '手动排过：放进空当，最长到空当末尾');
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
  footageTakenBy,
} = await import('../renderer/src/core/candidates.js');
const { CANDIDATE_SPEC, CANDIDATE_EXAMPLE } = await import('../renderer/src/core/candidate-spec.js');
/* 合规范（v2）的最小候选清单 */
const v2 = shots => ({ type: CANDIDATE_TYPE, version: 2, project: '测试', batch: '测试批', shots });
const v2cand = c => ({ title: '标题', license: '版权未核实', why: '测试', ...c });
const v3 = shots => ({ type: CANDIDATE_TYPE, version: 3, project: '测试', batch: '测试批', shots });
const v3cand = c => ({
  title: '标题',
  license: '版权未核实',
  why: '测试',
  url: `https://x/${c.key}.mp4`,
  in: 0,
  out: 12,
  best: { in: 1, out: 11 },
  ...c,
});
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
test('候选清单的「要的画面」「缺了什么」和方案位置导入后保留，项目 JSON 往返不丢；v2 一律当方案一', () => {
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
  assert.equal(a.limits, '只拍到一家');
  assert.equal(b.limits, '');
  assert.equal(a.coverage, undefined, 'coverage 不再记');
  assert.deepEqual([a.plan, a.seq, b.plan, b.seq], [1, 0, 1, 1], 'v2 的候选都在方案一，按清单先后');
  const back = sanitizeProjectCandidates(JSON.parse(JSON.stringify([b])), { rowIds: new Set([1]) });
  assert.equal(back[0].need, '两家总部航拍');
  assert.deepEqual([back[0].plan, back[0].seq, back[0].short], [1, 1, '']);
  // 旧项目里的候选没有 plan / seq：算方案一
  const old = sanitizeProjectCandidates(
    [{ id: 'o', rowId: 1, url: 'https://x/o.mp4', in: 1, out: 2, coverage: 'partial', limits: '缺' }],
    {
      rowIds: new Set([1]),
    },
  );
  assert.deepEqual([old[0].plan, old[0].seq, old[0].limits, old[0].coverage], [1, 0, '缺', undefined]);
});
test('候选清单格式 v3 是硬性规定：规范里的示例本身合格，「候选清单格式.md」和软件里的规范一字不差', () => {
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
test('不合格式的候选清单整份拒收，并写出每一处错在哪', () => {
  const rows = [{ id: 1, kind: 'line', no: 1, text: '甲' }];
  const bad = {
    type: CANDIDATE_TYPE,
    version: 1,
    title: '旧写法',
    shots: [
      {
        lines: '1–2',
        plans: [
          {
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
      },
    ],
  };
  const plan = planImport(bad, '/bad.json', rows, []);
  assert.ok(plan.error && Array.isArray(plan.errors), '整份拒收');
  assert.equal(plan.added, undefined, '一个候选都不导入');
  const all = plan.errors.join('\n');
  for (const want of [
    'version 必须是数字 3（这是旧格式 version 1',
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
    'best 必须写',
    '不认识的字段「for」',
    '不认识的字段「coverage」',
  ])
    assert.ok(all.includes(want), '缺少提示：' + want);
  // v3 的方案层
  const v3errs = shots => validateCandidateDoc(v3(shots)).join('\n');
  assert.match(v3errs([{ lines: '1', label: '甲', cands: [v3cand({ key: 'A' })] }]), /要写在 plans 的方案里/);
  assert.match(v3errs([{ lines: '1', label: '甲', plans: [] }]), /plans 必须是数组，至少一个方案/);
  assert.match(v3errs([{ lines: '1', label: '甲', plans: [{ cands: [] }] }]), /方案1.*cands 必须是数组，至少一个视频/);
  assert.match(
    v3errs([{ lines: '1', label: '甲', plans: [{ cands: [v3cand({ key: 'A' })], name: 'x', short: 3 }] }]),
    /不认识的字段「name」[\s\S]*short 必须是文字/,
  );
  assert.match(
    v3errs([
      {
        lines: '1',
        label: '甲',
        plans: [{ cands: [v3cand({ key: 'A' })] }, { cands: [v3cand({ key: 'A', url: 'https://x/z.mp4' })] }],
      },
    ]),
    /key "A" 在这个画面里重复了（所有方案加起来不能重复）/,
  );
  // 下载范围比 best 每边最多宽 5 秒
  assert.match(
    v3errs([
      {
        lines: '1',
        label: '甲',
        plans: [{ cands: [v3cand({ key: 'A', in: 0, out: 30, best: { in: 10, out: 20 } })] }],
      },
    ]),
    /宽太多：每边最多宽 5 秒/,
  );
  assert.equal(
    v3errs([
      {
        lines: '1',
        label: '甲',
        plans: [{ cands: [v3cand({ key: 'A', in: 5, out: 25, best: { in: 10, out: 20 } })] }],
      },
    ]),
    '',
    '每边宽 5 秒刚好可以',
  );
  // 同一个方案里同一段画面用两次不行；同一个画面的不同方案之间可以
  const same = { url: 'https://x/same.mp4', in: 0, out: 12, best: { in: 1, out: 11 } };
  assert.match(
    v3errs([
      { lines: '1', label: '甲', plans: [{ cands: [v3cand({ key: 'A', ...same }), v3cand({ key: 'B', ...same })] }] },
    ]),
    /方案1 里 key "A".*同一个方案里不能用两次/,
  );
  assert.equal(
    v3errs([
      {
        lines: '1',
        label: '甲',
        plans: [{ cands: [v3cand({ key: 'A', ...same })] }, { cands: [v3cand({ key: 'B', ...same })] }],
      },
    ]),
    '',
  );
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
test('候选的 url 只能是视频：图片、网页、视频网站页面拒收，视频直链和无扩展名的 CDN 地址放行', () => {
  const doc = url => v2([{ lines: '1', label: '甲', cands: [v2cand({ key: 'A', url, in: 1, out: 5 })] }]);
  const errs = url => validateCandidateDoc(doc(url)).join('\n');
  assert.match(errs('https://x/pic.jpg'), /图片地址（\.jpg）.*不要找图片/);
  assert.match(errs('https://x/a/photo.WEBP?w=800'), /图片地址/);
  assert.match(errs('https://x/news/123.html'), /网页地址/);
  assert.match(errs('https://www.youtube.com/watch?v=abc'), /视频网站的页面/);
  assert.match(errs('https://www.bilibili.com/video/BV1xx'), /视频网站的页面/);
  assert.match(errs('http://127.0.0.1:18769/438-cpap.mp4'), /本机临时地址|这台电脑上的临时地址/);
  assert.match(errs('http://localhost:8000/a.mp4'), /临时地址/);
  assert.match(errs('http://192.168.1.5/a.mp4'), /临时地址/);
  for (const ok of [
    'https://x/a.mp4',
    'https://x/a.webm?token=1',
    'https://cdn.example.com/v/abc123',
    'https://player.vimeo.com/external/1.hd.mp4',
  ])
    assert.equal(errs(ok), '', ok);
});
test('1.11.2 同一段画面不能配给两处不同的句子：清单内、和项目已有候选、通过时都拦', () => {
  const cand = (key, url, a, b, extra = {}) => v2cand({ key, url, in: a, out: b, ...extra });
  const errs = shots => validateCandidateDoc(v2(shots)).filter(e => e.startsWith('重复画面'));
  // 不同句子、同一个视频、重叠的一段 → 拒收；地址只差 # 和临时令牌也算同一个文件
  assert.equal(
    errs([
      { lines: '1', label: '甲', cands: [cand('A', 'https://x/v.mp4?token=1', 10, 20)] },
      { lines: '2', label: '乙', cands: [cand('B', 'https://x/v.mp4?token=2#t=3', 15, 25)] },
    ]).length,
    1,
  );
  // 同一个视频里不重叠的两段、只重叠 1 秒的余量 → 可以
  assert.deepEqual(
    errs([
      { lines: '1', label: '甲', cands: [cand('A', 'https://x/v.mp4', 10, 20)] },
      { lines: '2', label: '乙', cands: [cand('B', 'https://x/v.mp4', 19, 40), cand('C', 'https://x/v.mp4', 60, 70)] },
    ]),
    [],
  );
  // 写了 best 看 best：in–out 余量重叠、精选段不重叠 → 可以
  assert.deepEqual(
    errs([
      { lines: '1', label: '甲', cands: [cand('A', 'https://x/v.mp4', 10, 22, { best: { in: 11, out: 17 } })] },
      { lines: '2', label: '乙', cands: [cand('B', 'https://x/v.mp4', 16, 30, { best: { in: 18, out: 28 } })] },
    ]),
    [],
  );
  // v2 同一画面里的几个候选当初是互为备选（v3 同一方案里的重复另有检查）；已否掉 / 要换的不算用上
  assert.deepEqual(
    errs([
      {
        lines: '1-2',
        label: '甲',
        cands: [cand('A', 'https://x/v.mp4', 10, 20), cand('B', 'https://x/v.mp4', 12, 22)],
      },
      {
        lines: '3',
        label: '乙',
        cands: [cand('C', 'https://x/w.mp4', 0, 9, { review: { decision: 'no', note: '' } })],
      },
      { lines: '4', label: '丙', cands: [cand('D', 'https://x/w.mp4', 0, 9)] },
    ]),
    [],
  );
  // 和项目里别的批次比：已通过 / 待审、配在别的句子上的 → 整份拒收；否掉的不算；重新导入同一份文件不和自己比
  const rows = [1, 2, 3].map(n => ({ id: n, kind: 'line', no: n, text: '句' + n }));
  const doc = v2([{ lines: '2', label: '乙', cands: [cand('B', 'https://x/v.mp4', 12, 18)] }]);
  const old = {
    id: 'o',
    rowId: 1,
    lines: '1',
    key: 'A',
    url: 'https://x/v.mp4',
    in: 10,
    out: 20,
    title: '旧',
    srcFile: '/a.json',
  };
  const blocked = planImport(doc, '/b.json', rows, [{ ...old, decision: 'ok' }]);
  assert.match(blocked.error, /重复画面/);
  assert.match(blocked.errors[0], /已经通过并用在第 1 句/);
  assert.match(planImport(doc, '/b.json', rows, [{ ...old, decision: '' }]).errors[0], /待审候选配在第 1 句/);
  assert.equal(planImport(doc, '/b.json', rows, [{ ...old, decision: 'no' }]).error, undefined);
  const self = { ...old, rowId: 2, lines: '2', key: 'B', in: 12, out: 18, srcFile: '/b.json', decision: 'ok' };
  assert.equal(planImport(doc, '/b.json', rows, [self]).error, undefined, '同一份文件重新导入不算重复');
  // 通过时：别的句子已经通过了这段画面 → 拦下；同一画面、否掉的不拦
  const c = { id: 'n', rowId: 2, url: 'https://x/v.mp4', in: 12, out: 18 };
  assert.equal(footageTakenBy(c, [{ ...old, decision: 'ok' }])?.id, 'o');
  assert.equal(footageTakenBy(c, [{ ...old, rowId: 2, decision: 'ok' }]), null);
  assert.equal(footageTakenBy(c, [{ ...old, decision: 'no' }]), null);
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
    plan: '方案一',
    note: '太暗',
    batch: '第 1 批',
  });
  const back = normalizeProjectRows([{ ...rows[0], reworkOff: 5 }]);
  assert.deepEqual(back[0].rework, { note: '再补一个近景', at: 2 });
  assert.deepEqual(back[0].assetUsages[0].rework, { note: '要彩色', at: 1 });
  assert.equal(back[0].reworkOff, 5);
  assert.equal(normalizeProjectRows([{ id: 1, kind: 'line', text: 'x', rework: 'bad' }])[0].rework, undefined);
});
const { coverageOf, shotCoverage } = await import('../renderer/src/core/coverage.js');
const { cleanBest, localClip } = await import('../renderer/src/core/candidates.js');
test('够不够：需要 = 分到的口播秒数，可用 = 可用片段（没标按整个文件），只拿这两个比', () => {
  const vid = (path, durationSec, clip, start = 0, end = 7.9) => ({
    kind: 'video',
    start,
    end,
    asset: { path, ...(durationSec != null ? { durationSec } : {}) },
    usage: { assetId: 'a', ...(clip ? { clip } : {}) },
  });
  // 文件 63 秒，标了 15–22 秒（7 秒），要配 7.9 秒：差 0.9 秒
  let c = coverageOf(vid('/m/x.mp4', 63, { in: 15, out: 22 }), 20.8);
  assert.equal(c.verdict, 'short');
  assert.equal(c.file, 63);
  assert.equal(c.usable, 7);
  assert.ok(Math.abs(c.lack - 0.9) < 1e-9);
  // 没标可用段：按整个文件算，够
  c = coverageOf(vid('/m/x.mp4', 63), 20.8);
  assert.equal(c.verdict, 'ok');
  assert.equal(c.whole, true);
  assert.ok(Math.abs(c.spare - 55.1) < 1e-9);
  // 文件时长还没读到：不知道
  assert.equal(coverageOf(vid('/m/x.mp4', null), 20.8).verdict, 'unknown');
  // 在线还没保存：地址里的 #t= 就是要截的那段；文件时长（原片）不算数
  c = coverageOf(vid('https://a/b.mp4#t=12,75', 300), 20.8);
  assert.equal(c.online, true);
  assert.equal(c.file, null);
  assert.equal(c.usable, 63);
  // 超出口播的部分不算需要；图片不限时长
  assert.equal(coverageOf(vid('/m/x.mp4', 5, null, 18, 25), 20.8).need.toFixed(1), '2.8');
  assert.equal(coverageOf({ kind: 'image', start: 0, end: 4, asset: {}, usage: {} }, 10).verdict, 'still');
  // 差不到 0.05 秒算够
  assert.equal(coverageOf(vid('/m/x.mp4', 7.86), 20.8).verdict, 'ok');
  const m = shotCoverage({ dur: 10, items: [{ ...vid('/m/y.mp4', 3, null, 0, 5), assetId: 'y', n: 1 }] });
  assert.equal(m.get('y').verdict, 'short');
  assert.equal(m.get('y').n, 1);
  assert.equal(shotCoverage(null).size, 0);
});
test('剪辑已补足：差几秒的视频标上后算够，每句的画面也按盖满算', async () => {
  const { lineCoverage } = await import('../renderer/src/core/coverage.js');
  const { extraOf } = await import('../renderer/src/core/asset-model.js');
  const item = fitDone => ({
    kind: 'video',
    start: 0,
    end: 6,
    asset: { path: '/m/z.mp4', durationSec: 4 },
    usage: { assetId: 'z', ...(fitDone ? { fitDone: true } : {}) },
  });
  assert.equal(coverageOf(item(false), 6).verdict, 'short');
  const c = coverageOf(item(true), 6);
  assert.equal(c.verdict, 'ok');
  assert.equal(c.fixed, true);
  assert.ok(Math.abs(c.lack - 2) < 1e-9);
  assert.deepEqual(extraOf({ fitDone: true }), { fitDone: true });
  const registry = { z: { id: 'z', kind: 'video', path: '/m/z.mp4', durationSec: 4 } };
  const rows = fitDone => [
    {
      id: 1,
      kind: 'line',
      text: '一',
      assetUsages: [{ assetId: 'z', role: 'main', ...(fitDone ? { fitDone: true } : {}) }],
    },
  ];
  const tl = { source: 'srt', times: new Map([[1, { start: 0, end: 6 }]]) };
  assert.equal(lineCoverage(registry, rows(false), tl)[0].state, 'part');
  assert.equal(lineCoverage(registry, rows(true), tl)[0].state, 'ok');
});
test('v3 画面范围照抄分镜表；每个方案都要填满口播，填不满只能单独交一个并写明理由', () => {
  const rows = [438, 439, 440, 441].map((n, i) => ({
    id: i + 1,
    kind: 'line',
    no: n,
    text: '句' + n,
    ...(n < 441 ? { groupId: 'g' } : {}),
  }));
  const shotSeconds = ms => (ms.length === 3 ? 21.8 : 5);
  const imp = (shots, existing = []) => planImport(v3(shots), '/a.json', rows, existing, { shotSeconds });
  const shot = (...plans) => ({ lines: '438-440', label: '甲', plans });
  const clip = (key, len, extra = {}) => v3cand({ key, in: 0, out: len + 2, best: { in: 1, out: 1 + len }, ...extra });
  // 范围和分镜表对不上：整份拒收，并说出表里的范围
  const off = imp([{ lines: '438-439', label: '甲', plans: [{ cands: [clip('a', 22)] }] }]);
  assert.match(off.error, /和分镜表对不上/);
  assert.match(off.errors[0], /第 438 句所在的画面是「第 438–440 句」/);
  assert.match(
    imp([{ lines: '440-441', label: '乙', plans: [{ cands: [clip('a', 22)] }] }]).errors[0],
    /第 440 句所在的画面是「第 438–440 句」/,
  );
  assert.match(
    imp([{ lines: '441-442', label: '乙', plans: [{ cands: [clip('a', 22)] }] }]).errors[0],
    /「第 441 句（单句）」/,
  );
  // 一个视频就够长 / 几个接起来够长：可以；差不到 0.5 秒也算满
  assert.equal(imp([shot({ cands: [clip('a', 22)] })]).error, undefined);
  assert.equal(imp([shot({ cands: [clip('a', 9.6), clip('b', 12)] })]).error, undefined);
  assert.equal(imp([shot({ cands: [clip('a', 21.4)] })]).error, undefined);
  const added = imp([shot({ cands: [clip('a', 9.6), clip('b', 12)] }, { cands: [clip('c', 22)] })]).added;
  assert.deepEqual(
    added.map(c => [c.key, c.plan, c.seq]),
    [
      ['a', 1, 0],
      ['b', 1, 1],
      ['c', 2, 0],
    ],
  );
  // 填不满、没写理由：拒收并说还差几秒
  const bad = imp([shot({ cands: [clip('a', 6.1)] })]);
  assert.match(bad.error, /填不满/);
  assert.match(bad.errors[0], /方案一：视频加起来 6\.1 秒，口播 21\.8 秒，还差 15\.7 秒.*short/);
  // 写了理由、而且只有这一个方案：可以
  const ok = imp([shot({ short: '只找到 6 秒的公开视频', cands: [clip('a', 6.1)] })]);
  assert.equal(ok.error, undefined);
  assert.equal(ok.added[0].short, '只找到 6 秒的公开视频');
  // 有能填满的方案时，不够长的方案不能交（写了理由也不行）
  assert.match(
    imp([shot({ cands: [clip('a', 22)] }, { short: '偷懒', cands: [clip('b', 5)] })]).errors[0],
    /方案二：.*已经有能填满的方案/,
  );
  // 都填不满：只能交一个
  assert.match(
    imp([shot({ short: '甲', cands: [clip('a', 5)] }, { short: '乙', cands: [clip('b', 6)] })]).errors[0],
    /只能交一个不够长的方案/,
  );
  // 要换的不算进长度：AI 在它后面补了新的就够；没补、这个画面又没改过的，重新导入不追究
  const existing = [
    { id: 'x', srcFile: '/a.json', lines: '438-440', key: 'a', url: 'https://x/a.mp4', in: 0, out: 14, decision: 're' },
    { id: 'y', srcFile: '/a.json', lines: '438-440', key: 'b', url: 'https://x/b.mp4', in: 0, out: 14, decision: '' },
  ];
  const a12 = clip('a', 12, { review: { decision: 're', note: '' } });
  assert.equal(imp([shot({ cands: [a12, clip('b', 12)] })], existing).error, undefined, '画面没改过：不追究');
  assert.match(
    imp([shot({ cands: [a12, clip('a2', 3), clip('b', 12)] })], existing).errors[0],
    /方案一：视频加起来 15 秒/,
    '补的新视频太短：要换的那个不算，还是填不满',
  );
  assert.equal(imp([shot({ cands: [a12, clip('a2', 10), clip('b', 12)] })], existing).error, undefined);
  // 不传口播时间不查长度；v2 清单不查范围、不查长度
  assert.equal(planImport(v3([shot({ cands: [clip('a', 3)] })]), '/a.json', rows, []).error, undefined);
  assert.equal(
    planImport(
      v2([
        { lines: '438-439', label: '甲', cands: [v2cand({ key: 'cpap', url: 'https://x/c.mp4', in: 195, out: 201 })] },
      ]),
      '/a.json',
      rows,
      [],
      { shotSeconds },
    ).error,
    undefined,
  );
});
test('没盖住的几秒对应句子里哪几个字：按朗读量摊开，标点跟前一个字，开头 / 中间 / 结尾都能标', async () => {
  const { charRangesForTimes } = await import('../renderer/src/core/text.js');
  const text = '一二三四五六七八九十。';
  // 10 个字 10 秒：后 3 秒 → 最后三个字和句号
  assert.deepEqual(charRangesForTimes(text, 10, [[7, 10]]), [{ from: 7, to: 11, sec: 3 }]);
  // 整句
  assert.deepEqual(charRangesForTimes(text, 10, [[0, 10]]), [{ from: 0, to: 11, sec: 10 }]);
  // 开头和中间各空一段
  assert.deepEqual(
    charRangesForTimes(text, 10, [
      [0, 2],
      [4, 6],
    ]),
    [
      { from: 0, to: 2, sec: 2 },
      { from: 4, to: 6, sec: 2 },
    ],
  );
  // 句首的标点跟后一个字；英文一个词算 1.8 份，字母整体一起走
  assert.deepEqual(charRangesForTimes('「所以PBM谈价', 5.8, [[0, 1]]), [{ from: 0, to: 2, sec: 1 }]);
  assert.deepEqual(charRangesForTimes('所以 PBM 谈价', 5.8, [[2.5, 5.8]]), [{ from: 3, to: 9, sec: 3.3 }]);
  // 没有空白 / 没有时长 / 全是标点：不标
  assert.deepEqual(charRangesForTimes(text, 10, []), []);
  assert.deepEqual(charRangesForTimes(text, 0, [[0, 1]]), []);
  assert.deepEqual(charRangesForTimes('。，', 1, [[0, 1]]), []);
});
test('1.11.2 每句有没有画面：按排布算，视频只盖住可用片段那么长；一个画面都没放的镜头不算空白', async () => {
  const { lineCoverage, blankShots, linesText } = await import('../renderer/src/core/coverage.js');
  const { checkDelivery } = await import('../renderer/src/core/shots.js');
  const secs = [1.4, 4.8, 5.5, 5.3];
  const times = new Map();
  let t0 = 0;
  const rows = secs.map((d, i) => {
    times.set(i + 1, { start: t0, end: t0 + d, src: 'srt', st: 'ok' });
    t0 += d;
    return {
      id: i + 1,
      kind: 'line',
      no: 434 + i,
      text: '句',
      type: 'real',
      note: '有描述',
      groupId: 'g',
      assetUsages: [],
    };
  });
  const tl = { times, total: t0, source: 'srt' };
  // 一个视频只挂在前两句：后两句没画面
  rows[0].assetUsages = [{ assetId: 'v', role: 'main' }];
  rows[1].assetUsages = [{ assetId: 'v', role: 'main' }];
  const reg = { v: { id: 'v', kind: 'video', path: '/m/v.mp4', durationSec: 8 } };
  let cov = lineCoverage(reg, rows, tl);
  assert.deepEqual(
    cov.map(x => x.state),
    ['ok', 'ok', 'empty', 'empty'],
  );
  // 视频只有 3 秒：第二句只盖住一部分
  reg.v.durationSec = 3;
  cov = lineCoverage(reg, rows, tl);
  assert.deepEqual(
    cov.map(x => x.state),
    ['ok', 'part', 'empty', 'empty'],
  );
  assert.ok(Math.abs(cov[1].got - 1.6) < 1e-9);
  // 没盖住的那几段（相对句子开头）：第二句 1.6 秒之后是空的；整句空的就是整句
  assert.deepEqual(cov[0].gaps, []);
  assert.equal(cov[1].gaps.length, 1);
  assert.ok(Math.abs(cov[1].gaps[0][0] - 1.6) < 1e-9 && Math.abs(cov[1].gaps[0][1] - 4.8) < 1e-9);
  assert.deepEqual(cov[2].gaps, [[0, 5.5]]);
  // 图片排多长盖多长
  reg.v = { id: 'v', kind: 'image', path: '/m/p.png' };
  assert.equal(lineCoverage(reg, rows, tl)[1].state, 'ok');
  const blanks = blankShots(rows, reg, tl);
  assert.equal(blanks.length, 1);
  assert.equal(linesText(blanks[0].lines.map(x => x.row.no)), '第 436–437 句');
  assert.equal(linesText([1, 3, 4, 5]), '第 1、3–5 句');
  const issues = checkDelivery(rows, undefined, { gaps: new Map([[1, '第 436–437 句没画面']]) });
  assert.ok(issues[0].issues.includes('画面有空白：第 436–437 句没画面'));
  // 一个画面都还没放：还在找素材，不算空白；不需要画面的类型也不算
  for (const r of rows) r.assetUsages = [];
  assert.equal(blankShots(rows, reg, tl).length, 0);
  rows[0].assetUsages = [{ assetId: 'v', role: 'main' }];
  for (const r of rows) r.type = 'a';
  assert.equal(blankShots(rows, reg, tl).length, 0);
});
test('候选清单 best（精选段）：v3 必填；必须在 in–out 内；通过时设成可用片段，保存后换算成文件里的秒数', () => {
  const doc = JSON.parse(JSON.stringify(CANDIDATE_EXAMPLE));
  doc.shots[0].lines = '1-2';
  assert.deepEqual(validateCandidateDoc(doc), []);
  const bad = JSON.parse(JSON.stringify(doc));
  const b0 = bad.shots[0].plans[0].cands[0];
  b0.best = { in: 5, out: 17 };
  assert.match(validateCandidateDoc(bad).join('\n'), /best（5–17）必须在 in–out（8–20）范围内/);
  b0.best = { in: '11', out: 17 };
  assert.match(validateCandidateDoc(bad).join('\n'), /best 必须写成/);
  b0.best = { in: 11, out: 17, note: 'x' };
  assert.match(validateCandidateDoc(bad).join('\n'), /best 必须写成/);
  b0.best = { in: 17, out: 11 };
  assert.match(validateCandidateDoc(bad).join('\n'), /best 的 out 必须大于 in/);
  delete b0.best;
  assert.match(validateCandidateDoc(bad).join('\n'), /best 必须写/);
  assert.equal(cleanBest({ in: 5, out: 9 }, 8, 20), null);
  assert.equal(cleanBest(null, 8, 20), null);

  const rows = [1, 2].map(n => ({ id: n, kind: 'line', no: n, text: '句' + n, groupId: 'g' }));
  const plan = planImport(doc, '/e.json', rows, []);
  const [c1] = plan.added;
  assert.deepEqual(c1.best, { in: 9.5, out: 18.5 });
  const legacy = planImport(
    v2([{ lines: '1', label: '甲', cands: [v2cand({ key: 'A', url: 'https://x/a.mp4', in: 1, out: 5 })] }]),
    '/l.json',
    rows,
    [],
  );
  assert.equal(legacy.added[0].best, null, 'v2 没写 best = 整段');
  // 只改 best：不回到待审
  const doc2 = JSON.parse(JSON.stringify(doc));
  doc2.shots[0].plans[0].cands[0].best = { in: 9, out: 15 };
  const old = { ...c1, decision: 'ok', assetId: 'x', savedPath: '/s.mp4' };
  const up = planImport(doc2, '/e.json', rows, [old]).updated[0];
  assert.equal(up.changed, false);
  assert.equal(up.next.decision, 'ok');
  assert.deepEqual(up.next.best, { in: 9, out: 15 });
  // 项目 JSON 往返保留
  const back = sanitizeProjectCandidates(JSON.parse(JSON.stringify([c1])), { rowIds: new Set([1, 2]) });
  assert.deepEqual(back[0].best, { in: 9.5, out: 18.5 });

  // 通过：可用片段 = 精选段（原片秒数）；保存后：文件 = 原片 8–20，可用片段换成文件里的 1.5–10.5
  const reg = {};
  const res = attachCandidate(c1, rows, reg);
  const u = rows[0].assetUsages.find(x => x.assetId === res.assetId);
  assert.deepEqual(u.clip, { in: 9.5, out: 18.5 });
  c1.assetId = res.assetId;
  swapToLocal(c1, '/m/第1-2句_x_0m08s-0m20s.mp4', rows, reg);
  assert.deepEqual(rows[0].assetUsages.find(x => x.assetId === res.assetId).clip, { in: 1.5, out: 10.5 });
  assert.equal(reg[res.assetId].path, '/m/第1-2句_x_0m08s-0m20s.mp4');
  assert.equal(reg[res.assetId].durationSec, undefined, '文件时长等界面读出来再记');
});
test('保存到本地时可用片段的换算：盖满整个文件 = 整段；超出文件的部分截掉；不知道 in/out 退回整段', () => {
  const c = { in: 12, out: 75 };
  assert.equal(localClip({ in: 12, out: 75 }, c), null);
  assert.equal(localClip({ in: 12.02, out: 74.98 }, c), null);
  assert.deepEqual(localClip({ in: 15, out: 22 }, c), { in: 3, out: 10 });
  assert.deepEqual(localClip({ in: 5, out: 22 }, c), { in: 0, out: 10 });
  assert.deepEqual(localClip({ in: 70, out: 90 }, c), { in: 58, out: 63 });
  assert.equal(localClip({ in: 80, out: 90 }, c), null);
  assert.equal(localClip({ in: 15, out: 22 }, {}), null);
  assert.equal(localClip(null, c), null);
});
test('项目交换完整保留业务数据，排除光标、界面状态和协作密钥', () => {
  const source = {
    title: '项目字段回归',
    rows: [{ id: 7, kind: 'line', text: '正文', note: '描述' }],
    assets: { a: { id: 'a', kind: 'image', path: '/m/a.png' } },
    speechRate: 3,
    mediaDir: '/m',
    timing: { name: '字幕', cues: [] },
    voice: { path: '/m/voice.wav', duration: 12 },
    candidates: [{ id: 'c1', rowId: 7, note: '审核意见' }],
    collab: { secret: '不能导出', role: 'host' },
    cursorId: 7,
    view: 'review',
    sel: 7,
  };
  const exported = JSON.parse(buildProjectJson(source));
  const restored = normalizeProjectData(exported);
  for (const key of ['title', 'rows', 'assets', 'speechRate', 'mediaDir', 'timing', 'voice', 'candidates'])
    assert.deepEqual(restored[key], source[key]);
  for (const key of ['collab', 'cursorId', 'view', 'sel']) assert.equal(Object.hasOwn(exported, key), false);
});

test('老项目加载补默认值，移除可选数据时保存不会留下旧字段', () => {
  const loaded = normalizeProjectData({
    title: '旧项目',
    rows: [],
    speechRate: 'bad',
    assets: [],
    candidates: {},
    mediaDir: 3,
    voice: {},
    timing: {},
  });
  assert.equal(loaded.speechRate, 4.5);
  assert.deepEqual(loaded.assets, {});
  assert.deepEqual(loaded.candidates, []);
  assert.equal(loaded.voice, null);
  assert.equal(loaded.timing, null);
  assert.equal(loaded.mediaDir, '');
  const stored = {
    id: 'p1',
    collab: { secret: '保留在本机' },
    voice: { path: '/old.wav' },
    timing: { cues: [] },
    candidates: [{ id: 'old' }],
    mediaDir: '/old',
  };
  applyProjectData(stored, loaded, 'storage');
  assert.equal(stored.id, 'p1');
  assert.equal(stored.collab.secret, '保留在本机');
  for (const key of ['voice', 'timing', 'candidates', 'mediaDir']) assert.equal(Object.hasOwn(stored, key), false);
  assert.equal(Object.hasOwn(projectData(loaded, 'history'), 'speechRate'), false, '语速沿用既有的独立设置规则');
});

test('失败恢复保留被删除或替换的原对象、数组顺序和素材引用', () => {
  const row = { id: 1, text: '原文' },
    candidate = { id: 'c1', note: '原意见' },
    asset = { path: '/original.png' };
  const project = { rows: [row, { id: 2, text: '第二句' }], candidates: [candidate], assets: { a: asset } };
  const rows = project.rows,
    checkpoint = captureMutation(project);
  row.id = 9;
  row.text = '修改';
  project.rows.reverse();
  project.candidates.splice(0, 1);
  candidate.note = '删除后还被改过';
  project.assets.a = { path: '/wrong.png' };
  project.extra = project; // 失败修改即便产生循环引用也要能恢复。
  assert.equal(restoreMutation(project, checkpoint), true);
  assert.equal(project.rows, rows);
  assert.equal(project.rows[0], row);
  assert.equal(row.id, 1);
  assert.equal(row.text, '原文');
  assert.equal(project.candidates[0], candidate);
  assert.equal(candidate.note, '原意见');
  assert.equal(project.assets.a, asset);
  assert.equal(asset.path, '/original.png');
  assert.equal(Object.hasOwn(project, 'extra'), false);
});

test('候选清单错误百分号编码返回格式提示，合法编码可正常导入', () => {
  const doc = url => v2([{ lines: '1', label: '画面', cands: [v2cand({ key: 'A', url, in: 0, out: 3 })] }]);
  for (const url of ['https://x/100%.mp4', 'https://x/a%ZZ.mp4', 'https://x/a%FF.mp4']) {
    assert.ok(validateCandidateDoc(doc(url)).some(error => error.includes('百分号编码')));
    assert.ok(planImport(doc(url), '/c.json', lines('正文。'), []).error);
  }
  assert.deepEqual(validateCandidateDoc(doc('https://x/100%25.mp4')), []);
});

test('带批注 MD 和项目 JSON 回读保留手动时间、素材返工和画面返工标记', () => {
  const original = {
    title: '往返回归',
    assets: { a: { id: 'a', kind: 'video', name: '视频', path: '/m/a.mp4' } },
    rows: [
      { id: 101, kind: 'section', text: '章节' },
      {
        id: 205,
        kind: 'line',
        text: '第一句。',
        rework: { note: '补一个镜头', at: 111, assetId: 'a' },
        assetUsages: [
          { assetId: 'a', role: 'main', at: { start: 0, end: 2, of: 205 }, rework: { note: '换掉这段', at: 112 } },
        ],
      },
      { id: 401, kind: 'line', text: '第二句。', reworkOff: 222 },
    ],
  };
  const md = buildAnnotatedMd({ ...original, registry: original.assets });
  const restored = { rows: parseAny(md) };
  hydrateProjectAssets(restored);
  const row = restored.rows.find(r => r.kind === 'line'),
    usage = row.assetUsages[0];
  assert.equal(row.rework.note, '补一个镜头');
  assert.equal(row.rework.assetId, usage.assetId);
  assert.equal(restored.rows.at(-1).reworkOff, 222);
  assert.deepEqual(usage.at, { start: 0, end: 2, of: row.id });
  assert.deepEqual(usage.rework, { note: '换掉这段', at: 112 });
  hydrateProjectAssets(restored);
  assert.deepEqual(restored.rows[1].assetUsages[0].rework, usage.rework);
  const json = JSON.parse(buildProjectJson(original));
  json.rows = normalizeProjectRows(json.rows);
  hydrateProjectAssets(json);
  assert.deepEqual(json.rows[1].assetUsages[0].rework, original.rows[1].assetUsages[0].rework);
  const revised = reconcileDraft([], parseAny(md));
  assert.equal(revised.rows[1].assetUsages[0].at.of, revised.rows[1].id);
});

// 复现名额释放后，排队续体执行前又到来一个任务的真实 Promise 时序。
{
  const { withDecodeSlot } = await import('../renderer/src/ui/base/media.js');
  const gates = Array.from({ length: 6 }, () => {
    let release;
    const promise = new Promise(resolve => {
      release = resolve;
    });
    return { promise, release };
  });
  let active = 0,
    maximum = 0;
  const returns = [];
  const launch = i =>
    withDecodeSlot(() => {
      active++;
      maximum = Math.max(maximum, active);
      returns[i] = gates[i].promise.finally(() => active--);
      return returns[i];
    });
  const jobs = [launch(0), launch(1), launch(2), launch(3), launch(4)];
  const arrival = returns[0].then(() => launch(5));
  gates[0].release();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  for (const gate of gates) gate.release();
  await Promise.all([...jobs, arrival]);
  test('解码名额交接遇到新任务时仍不超过四个', () => assert.equal(maximum, 4));
  await assert.rejects(
    withDecodeSlot(() => Promise.reject(new Error('解码失败'))),
    /解码失败/,
  );
  test('失败解码释放名额，后续任务仍可执行', () => assert.equal(active, 0));
}

test('审核名单：旧批号和 AI 批名不影响实际句子名称，重号不会改号或丢名单', () => {
  const c = (id, batchId, batchAt, batchNo) => ({ id, batchId, batchAt, batchNo, rowId: 1, batchName: '第1-625句' });
  const cands = [c('a', 'b1', 100, 1), c('b', 'b2', 200, 2), c('x', 'mine', 300, 3), c('y', 'theirs', 310, 3)];
  const rows = [{ id: 1, kind: 'line', no: 28 }];
  const before = JSON.stringify(cands);
  const labels = list => candidateBatches(list, rows).map(b => [b.id, b.label]);
  assert.deepEqual(labels(cands), [
    ['theirs', '第28句'],
    ['mine', '第28句'],
    ['b2', '第28句'],
    ['b1', '第28句'],
  ]);
  assert.deepEqual(labels([...cands].reverse()), labels(cands));
  assert.equal(JSON.stringify(cands), before, '旧数据只改变显示，不修改候选和批注');
  cands[0].batchAt = 310;
  assert.deepEqual(labels([...cands].reverse()), labels(cands), '同一导入时间也有确定顺序');
});

test('句子名称：连续才合并，分散逐项列出，较多时显示数量；重复视频不重复计句数', () => {
  assert.equal(sentenceScope([625, 1, 1]).text, '第1、625句');
  assert.equal(sentenceScope([28, 35, 36, 37]).text, '第28、35–37句');
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, kind: 'line', no: i * 10 + 1 }));
  const cands = rows.map(r => ({ rowId: r.id, batchId: 'a', batchKind: 'rework' }));
  cands.push({ ...cands[0] });
  const b = candidateBatches(cands, rows)[0];
  assert.equal(b.label, '返工素材 · 共12句');
  assert.ok(b.detail.startsWith('第1、11、21句'.replace('句', '')));
  assert.equal(b.scope.count, 12);
  const shared = [
    { id: 1, no: 35, kind: 'line', groupId: 'g' },
    { id: 2, no: 36, kind: 'line', groupId: 'g' },
  ];
  assert.equal(
    candidateBatches([{ rowId: 2, batchId: 'b', batchName: '按批注重找' }], shared)[0].label,
    '第35–36句 · 重找',
  );
  shared[0].no = 40;
  shared[1].no = 41;
  assert.equal(candidateBatches([{ rowId: 2 }], shared)[0].label, '第40–41句', '改稿后跟随当前句号，不读旧 lines');
  assert.equal(candidateBatches([{ rowId: 999 }], shared)[0].label, '句子已移除');
});

test('返工单：首尾分散画面逐项列出，带可校验的对应标记和原意见', () => {
  const rows = [
    { id: 1, no: 1, kind: 'line', text: '开头' },
    { id: 625, no: 625, kind: 'line', text: '结尾' },
  ];
  rows.forEach(r => setRework(rows, r, { note: '要近景', at: 1 }));
  const doc = buildReworkDoc({ title: '测试', shots: reworkShots(rows, []) });
  assert.ok(doc.id.startsWith('rw-'));
  assert.equal(doc.sentences, '第1、625句');
  assert.deepEqual(
    doc.shots.map(s => s.lines),
    ['1', '625'],
  );
  assert.ok(doc.reply.includes('禁止用首尾句号扩成整段'));
});

test('返工素材导入：拒收未知标记、范围外画面、整段扩写；支持分散画面和部分交付', () => {
  const rows = [
    { id: 11, no: 1, kind: 'line' },
    { id: 22, no: 2, kind: 'line' },
    { id: 33, no: 625, kind: 'line' },
  ];
  const reworkRequests = {
    'rw-test': {
      at: 1,
      targets: [
        { rowIds: [11], note: '开头要近景' },
        { rowIds: [33], note: '结尾太暗' },
      ],
    },
  };
  const shot = n => ({ lines: String(n), label: '返工', plans: [{ cands: [v3cand({ key: `n-${n}` })] }] });
  const doc = { ...v3([shot(1), shot(625)]), reworkId: 'rw-test' };
  const load = d => planImport(d, '/reply.json', rows, [], { reworkRequests, reworkRowIds: [11, 33] });
  const plan = load(doc);
  assert.equal(plan.error, undefined);
  assert.equal(plan.added[0].reworkNote, '开头要近景');
  assert.equal(plan.added[1].reworkId, 'rw-test');
  assert.equal(load({ ...doc, shots: [shot(625)] }).added.length, 1);
  assert.match(load({ ...doc, reworkId: 'rw-unknown' }).error, /返工单/);
  assert.match(load({ ...doc, shots: [shot(2)] }).errors[0], /不在这张返工单/);
  assert.ok(load({ ...doc, shots: [shot('1-625')] }).error);
  assert.match(load({ ...doc, reworkId: undefined }).error, /缺少返工单标记/);
  assert.ok(validateCandidateDoc({ ...doc, shots: [shot(1), shot(1)] }).some(e => e.includes('只能写一次')));
  assert.equal(load(v3([shot(2)])).error, undefined, '不属于待返工任务的普通素材照常导入');
  const existing = plan.added.map(c => ({ ...c, srcFile: '/reply.json', decision: 'ok' }));
  assert.equal(
    planImport(doc, '/reply.json', rows, existing, { reworkRequests }).updated.length,
    2,
    '审核完成后重新导入同一回复仍保留关联',
  );
});

test('返工范围跟随句子身份：改稿后的句号可变，目标画面拆并或删除则拒收', () => {
  const rows = [
    { id: 11, no: 3, kind: 'line' },
    { id: 22, no: 1, kind: 'line' },
  ];
  const reworkRequests = { 'rw-test': { targets: [{ rowIds: [11], note: '近景' }] } };
  const doc = n => ({
    ...v3([{ lines: String(n), label: '返工', plans: [{ cands: [v3cand({ key: 'n' })] }] }]),
    reworkId: 'rw-test',
  });
  assert.ok(planImport(doc(1), '', rows, [], { reworkRequests }).error);
  assert.equal(planImport(doc(3), '', rows, [], { reworkRequests }).added[0].rowId, 11);
  rows.forEach(r => (r.groupId = 'changed'));
  assert.ok(planImport(doc(3), '', rows, [], { reworkRequests }).error);
  assert.ok(planImport(doc(3), '', [], [], { reworkRequests }).error);
  assert.ok(
    planImport(
      { ...doc(3), version: 2, shots: [{ lines: '3', label: '旧', cands: [v3cand({ key: 'n' })] }] },
      '',
      rows,
      [],
      { reworkRequests },
    ).error,
  );
});

test('返工对应关系随项目保存、导出和句子身份重映射保留', () => {
  const reworkRequests = { 'rw-test': { at: 1, targets: [{ rowIds: [10, 20], note: '要近景' }] } };
  for (const scope of ['state', 'history', 'storage', 'exchange'])
    assert.deepEqual(projectData({ reworkRequests }, scope).reworkRequests, reworkRequests);
  const doc = JSON.parse(buildProjectJson({ rows: [], reworkRequests }));
  assert.deepEqual(normalizeProjectData(doc).reworkRequests, reworkRequests);
  assert.deepEqual(
    normalizeReworkRequests(
      reworkRequests,
      new Map([
        [10, 1],
        [20, 2],
      ]),
    )['rw-test'].targets[0].rowIds,
    [1, 2],
  );
  assert.deepEqual(normalizeReworkRequests({ bad: {}, 'rw-invalid': { targets: [{ rowIds: ['x'] }] } }), {});
});

test('统一画面状态：失联不改变排布；缺口、停顿与覆盖各有独立结果', () => {
  const rows = [
    {
      id: 1,
      kind: 'line',
      type: 'real',
      groupId: 'g',
      text: '第一句',
      assetUsages: [
        { assetId: 'lost', role: 'main', at: { start: 0, end: 4, of: 1 } },
        { assetId: 'ok', role: 'main', at: { start: 4, end: 8, of: 1 } },
      ],
    },
    { id: 2, kind: 'line', type: 'real', text: '第二句', assetUsages: [{ assetId: 'ok', role: 'main' }] },
  ];
  const tl = buildTimeline(
    [
      { ...rows[0], time: { start: 0, end: 8, st: 'ok' } },
      { ...rows[1], time: { start: 9.14, end: 13.14, st: 'ok' } },
    ],
    { voiceDuration: 20 },
  );
  const registry = {
    lost: { id: 'lost', kind: 'video', path: '/lost.mp4', durationSec: 4 },
    ok: { id: 'ok', kind: 'image', path: '/ok.png' },
  };
  const result = buildPictureCoverage(rows, registry, tl, { missing: new Set(['/lost.mp4']) });
  assert.deepEqual(result.byLine.get(1).missingGaps, [[0, 4]]);
  assert.equal(result.byLine.get(1).got, 4);
  assert.deepEqual(
    result.byLine.get(1).segments.map(s => [s.start, s.end, s.status]),
    [
      [0, 4, 'missing'],
      [4, 8, 'covered'],
    ],
  );
  assert.deepEqual(
    result.pauses.map(s => [s.start, s.end, s.status, s.kind]),
    [[8, 9.14, 'covered', 'pause']],
  );
  assert.equal(result.byLine.get(2).state, 'ok');
  rows[0].assetUsages[1].off = true;
  const gap = buildPictureCoverage(rows, registry, tl, { missing: new Set(['/lost.mp4']) });
  assert.deepEqual(
    gap.byLine.get(1).segments.map(s => s.status),
    ['missing', 'gap'],
  );
  assert.equal(gap.pauses[0].status, 'gap');
  rows[0].assetUsages[1].off = false;
  const restored = buildPictureCoverage(rows, registry, tl);
  assert.equal(restored.byLine.get(1).state, 'ok');
  assert.deepEqual(restored.byLine.get(1).missingGaps, []);
  const lostBoth = buildPictureCoverage(rows, registry, tl, { missing: new Set(['/lost.mp4', '/ok.png']) });
  assert.equal(lostBoth.pauses[0].status, 'missing');
});

const { movePicture, trimPicture, rollPictures } = await import('../renderer/src/core/shot-edit.js');
const editVideo = (assetId, start, end, cin = 10, cout = cin + end - start, durationSec = 60) => ({
  assetId,
  start,
  end,
  kind: 'video',
  asset: { durationSec },
  usage: { clip: { in: cin, out: cout } },
});
test('不同长度素材插入换序，时长和区间总长保持，原数据不变', () => {
  const items = [editVideo('a', 0, 7), editVideo('b', 7, 19.7)];
  const before = JSON.stringify(items);
  const draft = movePicture(items, 0, 11, 19.7);
  assert.deepEqual(draft.entries, [
    { assetId: 'b', start: 0, end: 12.7 },
    { assetId: 'a', start: 12.7, end: 19.7 },
  ]);
  assert.equal(JSON.stringify(items), before);
  assert.equal(movePicture(items, 0, 1, 19.7).changed, false);
});
test('跨过多段换序：放到最后越过那段的另一边，那边不够放时被越过的才往空出的位置让，不影响区间外素材', () => {
  const items = [editVideo('a', 1, 3), editVideo('b', 4, 7), editVideo('c', 9, 13), editVideo('d', 14, 16)];
  assert.deepEqual(movePicture(items, 0, 11, 20).entries, [
    { assetId: 'b', start: 3, end: 6 },
    { assetId: 'c', start: 8, end: 12 },
    { assetId: 'a', start: 12, end: 14 },
    { assetId: 'd', start: 14, end: 16 },
  ]);
  assert.deepEqual(
    movePicture(items, 2, -1, 20)
      .entries.slice(0, 3)
      .map(e => e.assetId),
    ['c', 'a', 'b'],
  );
});
test('前沿越过相邻画面一半就紧挨着放到它另一边，相邻画面原地不动、颜色顺序无关', () => {
  const two = [editVideo('a', 0, 3), editVideo('b', 6, 9)];
  // 前沿 7.6 > b 的一半 7.5：换到 b 右边，紧挨着 b，b 不动
  assert.deepEqual(movePicture(two, 0, 4.6, 12).entries, [
    { assetId: 'b', start: 6, end: 9 },
    { assetId: 'a', start: 9, end: 12 },
  ]);
  // 没过一半：被 b 挡住，停在紧挨 b 的左边
  assert.deepEqual(movePicture(two, 0, 4.4, 12).entries, [
    { assetId: 'a', start: 3, end: 6 },
    { assetId: 'b', start: 6, end: 9 },
  ]);
  // 往左越过：紧挨着放到 a 左边；左边空不够时 a 往右让出刚好的位置
  assert.deepEqual(movePicture([editVideo('a', 1, 3), editVideo('b', 3, 9)], 1, -1, 9).entries, [
    { assetId: 'b', start: 0, end: 6 },
    { assetId: 'a', start: 6, end: 8 },
  ]);
});
test('移动到空隙时不裁剪视频，也不吸附任意播放位置', () => {
  const items = [editVideo('a', 0, 2), editVideo('b', 5, 7)];
  const draft = movePicture(items, 0, 2.3, 10);
  assert.equal(draft.start, 2.3);
  assert.equal(draft.end, 4.3);
  assert.ok(draft.entries.every(e => !e.clip));
});
test('左裁保留后半段，右裁保留前半段，拉回可恢复被裁掉的内容', () => {
  const items = [editVideo('a', 0, 10)];
  const left = trimPicture(items, 0, 'start', 3, 10);
  assert.deepEqual(left.clip, { in: 13, out: 20 });
  const trimmed = { ...items[0], start: left.start, end: left.end, usage: { clip: left.clip } };
  assert.deepEqual(trimPicture([trimmed], 0, 'start', 0, 10).clip, { in: 10, out: 20 });
  assert.deepEqual(trimPicture(items, 0, 'end', 6, 10).clip, { in: 10, out: 16 });
});
test('时间条比已选视频片段短时，左裁不意外露出后面的内容', () => {
  const item = editVideo('a', 0, 5, 10, 20);
  assert.deepEqual(trimPicture([item], 0, 'start', 2, 5).clip, { in: 12, out: 15 });
});
test('裁剪不能越过原片首尾、相邻画面或最短长度', () => {
  const item = editVideo('a', 2, 7, 1, 6, 8);
  assert.equal(trimPicture([item], 0, 'start', 0, 20).start, 1);
  assert.equal(trimPicture([item], 0, 'start', 20, 20).start, 6.8);
  assert.equal(trimPicture([item], 0, 'end', 20, 20).end, 9);
  assert.equal(trimPicture([item, editVideo('b', 8, 10)], 0, 'end', 20, 20).end, 8);
});
test('末帧停留区裁剪保持真实出点，不生成超出源视频的入点', () => {
  const item = editVideo('a', 0, 10, 0, 4, 4);
  assert.deepEqual(trimPicture([item], 0, 'end', 7, 10).clip, { in: 0, out: 4 });
  assert.equal(trimPicture([item], 0, 'start', 9, 10).clip.in, 3.8);
});
test('右拖结尾最多到原片末尾；标了剪辑里补足才能拉过去，片段本身不变', () => {
  const item = editVideo('a', 0, 4, 0, 4, 4);
  assert.equal(trimPicture([item], 0, 'end', 9, 10).end, 4);
  const fit = { ...item, usage: { ...item.usage, fitDone: true } };
  const draft = trimPicture([fit], 0, 'end', 9, 10);
  assert.equal(draft.end, 9);
  assert.deepEqual(draft.clip, { in: 0, out: 4 });
});
test('右裁短后还能拉回原长：上限按原片，不按上次裁剩的出点', () => {
  const item = editVideo('a', 0, 5, 10, 15, 60);
  const short = trimPicture([item], 0, 'end', 3, 10);
  assert.deepEqual(short.clip, { in: 10, out: 13 });
  const trimmed = { ...item, end: short.end, usage: { clip: short.clip } };
  assert.deepEqual(trimPicture([trimmed], 0, 'end', 5, 10).clip, { in: 10, out: 15 });
  assert.equal(trimPicture([trimmed], 0, 'end', 9, 10).end, 9);
});
test('未知时长的本地视频结尾不设上限，图片裁剪不产生视频入出点', () => {
  const item = editVideo('a', 0, 5, 10, 15, null);
  const short = trimPicture([item], 0, 'end', 3, 10);
  const trimmed = { ...item, end: short.end, usage: { clip: short.clip } };
  assert.equal(trimPicture([trimmed], 0, 'end', 9, 10).end, 9);
  const image = { ...item, kind: 'image', usage: {} };
  assert.ok(!trimPicture([image], 0, 'start', 2, 10).clip);
});
test('在线视频只在地址里那一段内收放，左裁拉不到那段之前', () => {
  const item = {
    ...editVideo('a', 6, 11.7, 11.4, 17.1, null),
    asset: { path: 'https://x.test/v.mp4#t=10.9,17.4' },
  };
  const left = trimPicture([item], 0, 'start', 0, 20);
  assert.equal(left.start, 5.5);
  assert.deepEqual(left.clip, { in: 10.9, out: 17.1 });
  const right = trimPicture([item], 0, 'end', 20, 20);
  assert.equal(right.end, 12);
  assert.deepEqual(right.clip, { in: 11.4, out: 17.4 });
  const short = trimPicture([item], 0, 'end', 8, 20);
  const trimmed = { ...item, end: short.end, usage: { clip: short.clip } };
  assert.equal(trimPicture([trimmed], 0, 'end', 20, 20).end, 12);
});
test('相接边同时裁左右两段，切换点两侧没有缝隙且视频内容连续对应', () => {
  const items = [editVideo('a', 0, 7), editVideo('b', 7, 19.7, 20, 32.7)];
  const draft = rollPictures(items, 0, 9, 19.7);
  assert.equal(draft.entries[0].end, draft.entries[1].start);
  assert.deepEqual(draft.entries[0].clip, { in: 10, out: 19 });
  assert.deepEqual(draft.entries[1].clip, { in: 22, out: 32.7 });
  const bound = rollPictures([items[0], editVideo('b', 7, 19.7, 0, 12.7)], 0, 3, 19.7);
  assert.equal(bound.cut, 7);
});

test('变化清单区分备注和标注，局部刷新不重建时间关系', () => {
  const before = { rows: [{ id: 1, kind: 'line', text: '口播', note: '原描述' }], assets: {} };
  const after = structuredClone(before);
  after.rows[0].note = '新描述';
  let change = projectDelta(before, after);
  assert.deepEqual(change.rowFields, ['note']);
  assert.deepEqual(change.rowIds, [1]);
  assert.equal(change.timing, false);
  assert.equal(projectRefresh(change).table, false);
  assert.equal(projectRefresh(change).notes, true);
  assert.equal(projectRefresh(change).stats, false);
  after.rows[0].type = 'real';
  change = projectDelta(before, after);
  assert.equal(projectRefresh(change).marks, true);
  assert.equal(projectRefresh(change).stats, true);
});
test('素材内容变化定位到使用它的句子，不要求业务操作手写刷新范围', () => {
  const before = {
    rows: [
      { id: 1, kind: 'line', assetUsages: [{ assetId: 'a' }] },
      { id: 2, kind: 'line', assetUsages: [{ assetId: 'b' }] },
      { id: 3, kind: 'line', assetUsages: [{ assetId: 'a' }] },
    ],
    assets: { a: { path: 'a.mp4' }, b: { path: 'b.mp4' } },
  };
  const after = structuredClone(before);
  after.assets.a.path = 'new-a.mp4';
  const change = projectDelta(before, after);
  assert.deepEqual(change.assetRowIds, [1, 3]);
  assert.equal(projectRefresh(change).table, false);
  assert.equal(projectRefresh(change).review, true);
});
test('候选审核和保存目录变化不刷新表格，审核页仍收到更新', () => {
  for (const field of ['candidates', 'mediaDir', 'reworkRequests']) {
    const plan = projectRefresh(projectDelta({ rows: [], [field]: null }, { rows: [], [field]: 'changed' }));
    assert.equal(plan.table, false);
    assert.equal(plan.workspace, false);
    assert.equal(plan.review, true);
  }
});
test('句子增删、重排、分组和未知字段保留完整块更新', () => {
  const before = {
    rows: [
      { id: 1, kind: 'line' },
      { id: 2, kind: 'line' },
    ],
  };
  for (const rows of [
    before.rows.slice(1),
    [...before.rows].reverse(),
    [{ ...before.rows[0], groupId: 'g' }, before.rows[1]],
    [{ ...before.rows[0], futureField: true }, before.rows[1]],
  ])
    assert.equal(projectRefresh(projectDelta(before, { rows })).table, true);
  assert.equal(projectRefresh({ fields: [], rowIds: null }).table, true);
  assert.equal(projectRefresh({ fields: [], rowIds: [], full: true }).review, true);
});

test('局部编辑只涉及目标字段，保留素材对象并准确报告时间变化', () => {
  const row = { id: 1, kind: 'line', text: '原文', note: '旧备注', assetUsages: [{ assetId: 'a' }] };
  const project = {
    rows: [row],
    candidates: [],
    assets: {
      toJSON() {
        throw new Error('不应遍历素材库');
      },
    },
  };
  const usages = row.assetUsages;
  const edit = prepareProjectEdit(project, { rows: [{ id: 1, values: { note: '新备注' } }] });
  assert.equal(row.note, '旧备注');
  edit.apply();
  assert.equal(row.note, '新备注');
  assert.equal(row.assetUsages, usages);
  assert.deepEqual(edit.changes.rowIds, [1]);
  assert.deepEqual(edit.changes.rowFields, ['note']);
  assert.equal(edit.changes.timing, false);
  assert.equal(edit.changes.assets, false);
  edit.rollback();
  assert.equal(row.note, '旧备注');
  assert.equal(prepareProjectEdit(project, { rows: [{ id: 1, values: { text: '新原文' } }] }).changes.timing, true);
});
test('局部编辑整体校验；对象失效、非法字段或应用失败不会留下半次修改', () => {
  const row = { id: 1, kind: 'line', note: '保留' };
  const candidate = { id: 'c', note: '旧意见' };
  const project = { rows: [row], candidates: [candidate] };
  assert.throws(
    () =>
      prepareProjectEdit(project, {
        rows: [
          { id: 1, values: { note: '不应写入' } },
          { id: 2, values: { note: '失效' } },
        ],
      }),
    /失效/,
  );
  assert.throws(() => prepareProjectEdit(project, { rows: [{ id: 1, values: { groupId: '越界' } }] }), /不支持/);
  assert.equal(row.note, '保留');
  Object.defineProperty(candidate, 'note', { writable: false });
  const edit = prepareProjectEdit(project, {
    rows: [{ id: 1, values: { note: '临时' } }],
    candidates: [{ id: 'c', values: { note: '失败' } }],
  });
  assert.throws(() => edit.apply());
  assert.equal(row.note, '保留');
  assert.equal(candidate.note, '旧意见');
  assert.equal(prepareProjectEdit(project, { rows: [{ id: 1, values: { note: '保留' } }] }).changed, false);
});
test('审核索引按共用画面归集候选，保留章节和稿件顺序，忽略失效引用', () => {
  const rows = [
    { id: 0, kind: 'section', text: '第一章' },
    { id: 1, kind: 'line', groupId: 'g' },
    { id: 2, kind: 'line', groupId: 'g' },
    { id: 3, kind: 'line' },
  ];
  const cands = [
    { id: 'a', rowId: 2 },
    { id: 'b', rowId: 1 },
    { id: 'c', rowId: 3 },
    { id: 'missing', rowId: 99 },
  ];
  const index = buildReviewIndex(rows, cands);
  assert.equal(index.byRow.get(1), index.byRow.get(2));
  assert.deepEqual(
    index.byRow.get(1).cands.map(c => c.id),
    ['a', 'b'],
  );
  assert.equal(index.byRow.get(2).lead.id, 1);
  assert.equal(index.groups.size, 2);
  assert.equal(index.sections.get(3), '第一章');
  assert.equal(index.order.get(3), 3);
});
test('协作连接遵守角色状态；掉线和重新配对后可恢复在线', () => {
  const guest = { rep: { role: 'guest' }, status: 'offline' };
  for (const next of ['connecting', 'online', 'offline', 'connecting', 'needs-code', 'online'])
    transitionSession(guest, next);
  assert.equal(guest.status, 'online');
  assert.throws(() => transitionSession(guest, 'waiting'), /无效/);
  assert.equal(guest.status, 'online');
  const host = { rep: { role: 'host' }, status: 'waiting' };
  transitionSession(host, 'online');
  transitionSession(host, 'waiting');
  assert.throws(() => transitionSession(host, 'needs-code'), /无效/);
});
test('命令遗漏和重复登记明确失败，合法命令只执行一次', () => {
  assert.throws(() => runCommand('audit:missing'), /未登记/);
  let n = 0;
  registerCommand('audit:once', value => {
    n += value;
  });
  assert.throws(() => registerCommand('audit:once', () => {}), /重复/);
  assert.equal(runCommand('audit:once', 2), true);
  assert.equal(n, 2);
});

console.log(`${count} 项数据回归通过`);
