/* ── 共用画面范围调整：加入下一句 / 移出最后一句 / 从某句拆开（纯数据层；actions.js 负责快照 / 落盘 / 提示） ──
   规则：范围永远是同一章节里的连续句子；加入只允许紧邻下一句；不吞并别的共用画面；
   有差异先出报告；移出 / 拆分后各部分保留现有画面信息，之后独立修改；
   只剩一句的部分自动成为独立画面。 */
import { fmtTime } from './text.js';
import { usageList as usagesOf, cloneUsages } from './asset-usage.js';
import { shotMembers, normalizeUsageSpans } from './shots.js';

const clipLabel = c => (c ? `${fmtTime(c.in)}–${fmtTime(c.out)}` : '整段');
const groupIdNew = () => 'shot-' + crypto.randomUUID();

/* 把 next 并入共用信息会产生的差异（数组为空 = 没有冲突，可直接执行） */
export function mergeDiffs(members, next) {
  const g = members[0],
    diffs = [];
  if (next.type && g.type && next.type !== g.type)
    diffs.push({ field: '类型', group: g.type, other: next.type, action: '采用组内类型' });
  else if (next.type && !g.type) diffs.push({ field: '类型', group: '', other: next.type, action: '采用该句类型' });
  const gn = (g.note || '').trim(),
    sn = (next.note || '').trim();
  if (gn && sn && gn !== sn) diffs.push({ field: '画面描述', group: gn, other: sn, action: '两行合并，都保留' });
  const gMap = new Map(usagesOf(g).map(u => [u.assetId, u]));
  for (const u of usagesOf(next)) {
    const gu = gMap.get(u.assetId);
    if (!gu) diffs.push({ field: '素材', group: '', other: '该句另有素材关联', action: '一并保留' });
    else if (clipLabel(gu.clip) !== clipLabel(u.clip))
      diffs.push({
        field: '素材片段',
        group: clipLabel(gu.clip),
        other: clipLabel(u.clip),
        action: '采用组内片段范围',
      });
  }
  return diffs;
}

function mergeValues(members, next) {
  const g = members[0];
  const gn = (g.note || '').trim(),
    sn = (next.note || '').trim();
  const note = !sn ? g.note || '' : !gn ? next.note || '' : gn === sn ? g.note : `${gn}\n${sn}`;
  const map = new Map(usagesOf(g).map(u => [u.assetId, cloneUsages([u])[0]]));
  for (const u of usagesOf(next)) if (!map.has(u.assetId)) map.set(u.assetId, cloneUsages([u])[0]);
  return {
    note,
    type: g.type || next.type || null,
    status: members.every(r => r.status === 'ready') && next.status === 'ready' ? 'ready' : 'todo',
    assetUsages: [...map.values()],
  };
}

export function groupExtendNextPlan(rows, groupId) {
  const members = shotMembers(
    rows,
    rows.find(r => r.groupId === groupId),
  );
  if (members.length < 2) return { ok: false, reason: '这个画面不足两句' };
  const last = members[members.length - 1];
  const i = rows.indexOf(last);
  const next = rows[i + 1];
  if (!next) return { ok: false, reason: '已经是最后一句，没有下一句可加入' };
  if (next.kind === 'section') return { ok: false, reason: '已经是本章节最后一句，不能跨章节加入' };
  if (next.groupId) return { ok: false, reason: '下一句已经属于另一个共用画面，不能吞并它' };
  return { ok: true, next, diffs: mergeDiffs(members, next) };
}

export function groupExtendNext(rows, groupId) {
  const plan = groupExtendNextPlan(rows, groupId);
  if (!plan.ok) return null;
  const members = shotMembers(
    rows,
    rows.find(r => r.groupId === groupId),
  );
  const values = mergeValues(members, plan.next);
  const nextHad = new Set(
    usagesOf(plan.next)
      .filter(u => !u.off)
      .map(u => u.assetId),
  );
  const groupIds = new Set(usagesOf(members[0]).map(u => u.assetId));
  // 组内原有素材：每句保留自己的出现位置；下一句带来的新素材只在下一句出现
  const offBefore = members.map(
    m =>
      new Set(
        usagesOf(m)
          .filter(u => u.off)
          .map(u => u.assetId),
      ),
  );
  plan.next.groupId = groupId;
  members.forEach((m, i) => {
    Object.assign(m, cloneShared(values));
    m.assetUsages.forEach(u => {
      delete u.off;
      if (!groupIds.has(u.assetId) || offBefore[i].has(u.assetId)) u.off = true;
    });
  });
  Object.assign(plan.next, cloneShared(values));
  plan.next.assetUsages.forEach(u => {
    delete u.off;
    if (groupIds.has(u.assetId) && !nextHad.has(u.assetId)) {
      // 组内整段出现的素材顺延到新句；只在部分句子出现的不扩散
      const wasWhole = members.every((m, i) => !offBefore[i].has(u.assetId));
      if (!wasWhole) u.off = true;
    }
  });
  normalizeUsageSpans([...members, plan.next]);
  return { members: [...members, plan.next], diffs: plan.diffs };
}

/* 共享字段下发到每句时用拷贝：解除 / 移出后各改各的，互不影响 */
function cloneShared(v) {
  return { ...v, assetUsages: cloneUsages(v.assetUsages || []) };
}

export function groupDropLast(rows, groupId) {
  const members = shotMembers(
    rows,
    rows.find(r => r.groupId === groupId),
  );
  if (members.length < 2) return null;
  const last = members[members.length - 1];
  delete last.groupId; // 各字段本来就是共享值的副本，独立后原样保留
  if (members.length === 2) delete members[0].groupId; // 只剩一句自动独立，不保留单句「共用」外框
  normalizeUsageSpans(rows);
  return last;
}

export function groupSplitAtPlan(rows, groupId, rowId) {
  const members = shotMembers(
    rows,
    rows.find(r => r.groupId === groupId),
  );
  const at = members.findIndex(r => r.id === rowId);
  if (at < 0) return { ok: false, reason: '这句不在这个共用画面里' };
  if (at === 0) return { ok: false, reason: '从第一句开始就是当前画面本身' };
  if (at === members.length - 1) return { ok: false, reason: '这就是最后一句，请用「将最后一句移出这个画面」' };
  return { ok: true, members, at };
}

export function groupSplitAt(rows, groupId, rowId) {
  const plan = groupSplitAtPlan(rows, groupId, rowId);
  if (!plan.ok) return plan;
  const front = plan.members.slice(0, plan.at),
    back = plan.members.slice(plan.at);
  const fresh = groupIdNew();
  if (front.length >= 2)
    front.forEach(r => {
      r.groupId = groupId;
    });
  else
    front.forEach(r => {
      delete r.groupId;
    });
  if (back.length >= 2)
    back.forEach(r => {
      r.groupId = fresh;
    });
  else
    back.forEach(r => {
      delete r.groupId;
    });
  normalizeUsageSpans(rows);
  return { ok: true, front, back };
}
