/* Optional production fields keep v2 projects readable; original sentences stay intact. */
export const STATUS = { todo: '待找素材', making: '待制作', ready: '已就绪' };
export const shotMembers = (rows, r) =>
  r?.groupId ? rows.filter(x => x.kind === 'line' && x.groupId === r.groupId) : r ? [r] : [];
/* 素材使用记录（结构同 assets.js；纯数据层，不 import assets.js 防循环依赖） */
const usagesOf = r => (Array.isArray(r?.assetUsages) ? r.assetUsages : []);
const cloneUsages = us => us.map(u => ({ ...u, ...(u.clip ? { clip: { ...u.clip } } : {}) }));
/* 使用记录按素材去重合并；同一素材以先出现的片段范围为准 */
const mergeUsages = memberLists => {
  const seen = new Map();
  for (const us of memberLists)
    for (const u of us) {
      if (!seen.has(u.assetId)) seen.set(u.assetId, { ...u, ...(u.clip ? { clip: { ...u.clip } } : {}) });
    }
  return [...seen.values()];
};
/* 共用画面的共享字段（描述 / 类型 / 状态 / 待核对）统一从这里写：组内每句一起改，保证一致。
   返回被改到的句子，调用方据此刷界面。素材使用记录要逐句拷贝，走 assets.js 的 eachMember。 */
export const SHARED_FIELDS = ['note', 'type', 'status', 'needsReview'];
export function setShotField(rows, row, key, value) {
  const members = shotMembers(rows, row);
  for (const m of members) m[key] = value;
  return members;
}
export function expandShotIds(rows, ids) {
  return [
    ...new Set(
      ids.flatMap(id =>
        shotMembers(
          rows,
          rows.find(r => r.id === id),
        ).map(r => r.id),
      ),
    ),
  ];
}
export function shots(rows) {
  const seen = new Set();
  return rows
    .filter(r => r.kind === 'line')
    .reduce((out, r) => {
      const key = r.groupId || `line-${r.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(shotMembers(rows, r));
      }
      return out;
    }, []);
}
export function checkDelivery(rows) {
  return shots(rows).flatMap(group => {
    const r = group[0],
      issues = [];
    if (!r.type) issues.push('未标注类型');
    if (r.type && r.type !== 'a') {
      if (!(r.note || '').trim()) issues.push('缺画面描述');
      if (r.status !== 'ready') issues.push('素材未就绪');
    }
    if (usagesOf(r).some(u => u.clip && u.clip.needsAdjust)) issues.push('片段范围待调整');
    if (group.some(x => x.needsReview)) issues.push('稿件更新待核对');
    if (group.some(x => x.time && x.time.st === 'est')) issues.push('字幕里没找到这句');
    return issues.length ? [{ id: r.id, no: r.no, text: group.map(x => x.text).join(''), issues }] : [];
  });
}
export function repairCandidates(rows) {
  return rows.filter(
    (r, i) =>
      r.kind === 'line' &&
      /^[”’」』）】\]"'。！？；!?…\s]+$/.test(r.text) &&
      i > 0 &&
      rows[i - 1].kind === 'line' &&
      !r.type &&
      !r.note &&
      !r.assets &&
      !r.groupId &&
      !r.status &&
      !usagesOf(r).length,
  );
}
export function repairPunctuation(rows) {
  const ids = new Set(repairCandidates(rows).map(r => r.id));
  const out = [];
  for (const r of rows) {
    if (ids.has(r.id)) out[out.length - 1].text += r.text;
    else out.push({ ...r });
  }
  return out;
}
export function validGroup(rows, ids) {
  const selected = expandShotIds(rows, ids);
  const indexes = selected.map(id => rows.findIndex(r => r.id === id)).sort((a, b) => a - b);
  return (
    indexes.length >= 2 &&
    indexes.every((i, n) => i >= 0 && rows[i].kind === 'line' && (!n || i === indexes[n - 1] + 1))
  );
}
/* 选区本来就同属一个共用画面：不允许重复建立（会白白重置制作状态），规则 8 */
export function sameGroupSelection(rows, ids) {
  const expanded = expandShotIds(rows, ids);
  const members = rows.filter(r => expanded.includes(r.id));
  if (members.length < 2 || members.length !== expanded.length) return false;
  const g = members[0].groupId;
  return !!g && members.every(r => r.groupId === g);
}
export function groupRows(rows, ids) {
  if (!validGroup(rows, ids)) return null;
  const expanded = new Set(expandShotIds(rows, ids));
  const members = rows.filter(r => expanded.has(r.id));
  const groupId = 'shot-' + crypto.randomUUID();
  const unique = key => [...new Set(members.map(r => r[key]).filter(Boolean))].join('\n');
  const shared = {
    groupId,
    note: unique('note'),
    assets: unique('assets'),
    type: members.find(r => r.type)?.type || null,
    status: members.every(r => r.status === 'ready') ? 'ready' : 'todo',
    assetUsages: mergeUsages(members.map(usagesOf)),
  };
  // 每句拿一份拷贝：解除共用 / 移出后各改各的，互不影响
  members.forEach(r => Object.assign(r, { ...shared, assetUsages: cloneUsages(shared.assetUsages) }));
  return members;
}
const validTime = t => t && Number.isFinite(+t.start) && Number.isFinite(+t.end) && +t.end >= +t.start;
export function normalizeProjectRows(rows) {
  if (!Array.isArray(rows)) throw new Error('项目中没有有效的句子列表');
  const allowed = new Set(['a', 'real', 'stock', 'ai', 'fx']);
  let id = 0;
  const result = rows.map(r => {
    if (!r || !['line', 'section'].includes(r.kind) || typeof r.text !== 'string') throw new Error('项目格式不完整');
    if (r.kind === 'section') return { id: ++id, kind: 'section', text: r.text };
    return {
      id: ++id,
      kind: 'line',
      text: r.text,
      type: allowed.has(r.type) ? r.type : null,
      note: typeof r.note === 'string' ? r.note : '',
      assets: typeof r.assets === 'string' ? r.assets : '',
      status: STATUS[r.status] ? r.status : 'todo',
      ...(Array.isArray(r.assetUsages)
        ? { assetUsages: cloneUsages(r.assetUsages.filter(u => u && (u.assetId || u.path))) }
        : {}),
      ...(typeof r.groupId === 'string' ? { groupId: r.groupId } : {}),
      para: !!r.para,
      needsReview: !!r.needsReview,
      ...(validTime(r.time)
        ? {
            time: {
              start: +r.time.start,
              end: +r.time.end,
              conf: +r.time.conf || 0,
              st: ['ok', 'low', 'est'].includes(r.time.st) ? r.time.st : 'est',
            },
          }
        : {}),
    };
  });
  // A group may not span sections or disconnected runs in an imported project.
  const visited = new Set();
  let last = null;
  for (const r of result) {
    if (r.kind === 'section') {
      last = null;
      continue;
    }
    if (r.groupId && r.groupId !== last) {
      if (visited.has(r.groupId)) throw new Error('共用画面的句子不连续，请检查项目文件');
      visited.add(r.groupId);
    }
    last = r.groupId || null;
  }
  return result;
}
/* Conservative draft update: repeated sentences stay unconfirmed instead of inheriting a wrong shot. */
export function reconcileDraft(oldRows, newRows) {
  const key = r => r.text.trim();
  const oldMap = new Map(),
    newCounts = new Map();
  oldRows.filter(r => r.kind === 'line').forEach(r => oldMap.set(key(r), [...(oldMap.get(key(r)) || []), r]));
  newRows.filter(r => r.kind === 'line').forEach(r => newCounts.set(key(r), (newCounts.get(key(r)) || 0) + 1));
  let next = Math.max(0, ...oldRows.map(r => r.id)) + 1,
    kept = 0;
  const result = newRows.map(r => {
    const matches = oldMap.get(key(r));
    if (r.kind === 'line' && matches?.length === 1 && newCounts.get(key(r)) === 1) {
      kept++;
      return { ...matches[0], para: r.para };
    }
    return { ...r, id: next++, ...(r.kind === 'line' ? { needsReview: true } : {}) };
  });
  for (const group of shots(oldRows).filter(g => g[0].groupId)) {
    const ids = group.map(r => r.id),
      matched = result.filter(r => ids.includes(r.id));
    if (
      matched.length !== ids.length ||
      !validGroup(
        result,
        matched.map(r => r.id),
      ) ||
      matched.some((r, i) => r.id !== ids[i])
    ) {
      matched.forEach(r => {
        delete r.groupId;
        r.needsReview = true;
      });
    }
  }
  return {
    rows: result,
    kept,
    review: result.filter(r => r.needsReview).length,
    removed: oldRows.filter(r => r.kind === 'line' && !result.some(x => x.id === r.id)).length,
  };
}

export function normalizeGroups(rows) {
  const seen = new Set();
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const old = run[0].groupId;
    if (run.length === 1) delete run[0].groupId;
    else if (seen.has(old)) {
      const id = 'shot-' + crypto.randomUUID();
      run.forEach(r => (r.groupId = id));
    }
    seen.add(old);
    run = [];
  };
  for (const r of rows) {
    if (r.kind !== 'line' || !r.groupId) {
      flush();
      continue;
    }
    if (run.length && run[0].groupId !== r.groupId) flush();
    run.push(r);
  }
  flush();
}

/* ── 共用画面范围调整（纯数据层；actions.js 负责快照 / 落盘 / 提示） ──
   规则：范围永远是同一章节里的连续句子；加入只允许紧邻下一句；不吞并别的共用画面；
   有差异先出报告；移出 / 拆分后各部分保留现有画面信息，之后独立修改；
   只剩一句的部分自动成为独立画面。 */
import { fmtTime } from './util.js';

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
  const curStatus = members.every(r => r.status === 'ready') ? 'ready' : 'todo';
  const newStatus = curStatus === 'ready' && next.status === 'ready' ? 'ready' : 'todo';
  if (newStatus !== curStatus)
    diffs.push({
      field: '制作状态',
      group: STATUS[curStatus],
      other: STATUS[next.status] || STATUS.todo,
      action: `合并后为「${STATUS[newStatus]}」`,
    });
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
  plan.next.groupId = groupId;
  for (const m of [...members, plan.next]) Object.assign(m, cloneShared(values));
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
  return { ok: true, front, back };
}
