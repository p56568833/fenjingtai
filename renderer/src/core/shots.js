/* 镜头 / 共用画面的纯数据逻辑（无 DOM、无应用状态）：
   一个「镜头」= 一句独立的话，或同一共用画面里连续的几句。共享字段在组内每句各存一份副本。 */
import { fmtTime } from './text.js';
import { DEFAULT_TYPES, typeIndex } from './types.js';
import { GROUP_ID } from './parse.js';
export const STATUS = { todo: '待找素材', making: '待制作', ready: '已就绪' };
export const shotMembers = (rows, r) =>
  r?.groupId ? rows.filter(x => x.kind === 'line' && x.groupId === r.groupId) : r ? [r] : [];
/* 素材使用记录（结构同 assets.js；纯数据层，不 import assets.js 防循环依赖） */
const usagesOf = r => (Array.isArray(r?.assetUsages) ? r.assetUsages : []);
const cloneUsages = us =>
  us.map(u => ({ ...u, ...(u.clip ? { clip: { ...u.clip } } : {}), ...(u.at ? { at: { ...u.at } } : {}) }));
/* ── 素材角色与位置（1.4）──
   role：main 主画面（这段的底；1.8 起一段可以有多个，按时间先后放，见 shot-layout.js）/ overlay 叠加（盖在主画面上）/ alt 备选（先存着不用）。
         没有 role = 旧项目里的「未分配」，照旧参与导出，不强行改。
   位置：共用画面里每句各自持有一份使用记录副本，off: true 表示「这条素材不在这一句出现」。
         这样插句 / 拆句 / 并句 / 删句都不用重算范围；解除共用后每句只留下自己那几句的素材。 */
export const ROLES = { main: '主画面', overlay: '叠加', alt: '备选' };
export const ROLE_ORDER = ['main', 'overlay', null, 'alt'];
export const roleLabel = role => ROLES[role] || '未分配';
export const isRole = v => Object.prototype.hasOwnProperty.call(ROLES, v);
const usageAt = (m, assetId) => usagesOf(m).find(u => u.assetId === assetId);
const onRow = (m, assetId) => {
  const u = usageAt(m, assetId);
  return !!u && !u.off;
};
/* 某条素材在这组画面里出现的句子位置（members 下标），连续区间 {from, to, whole} */
export function usageSpan(members, assetId) {
  const idx = members.map((m, i) => (onRow(m, assetId) ? i : -1)).filter(i => i >= 0);
  if (!idx.length) return { from: -1, to: -1, whole: false, empty: true };
  return { from: idx[0], to: idx[idx.length - 1], whole: idx.length === members.length };
}
/* 人能读懂的位置：整段 / 第 85 句 / 第 84–85 句（单句画面不写位置） */
export function spanText(members, assetId) {
  if (members.length < 2) return '';
  const sp = usageSpan(members, assetId);
  if (sp.empty) return '不在任何一句';
  if (sp.whole) return '整段';
  const a = members[sp.from].no,
    b = members[sp.to].no;
  return a === b ? `第 ${a} 句` : `第 ${a}–${b} 句`;
}
/* 设位置：from / to 是 members 下标（含两端）；整段时清掉 off */
export function applySpan(members, assetId, from, to) {
  const lo = Math.max(0, Math.min(from, to)),
    hi = Math.min(members.length - 1, Math.max(from, to));
  members.forEach((m, i) => {
    const u = usageAt(m, assetId);
    if (!u) return;
    if (i >= lo && i <= hi) delete u.off;
    else u.off = true;
  });
}
/* 设角色：组内每句同步。1.8 起一段可以有多个主画面（按时间先后排，见 shot-layout.js），不再把别的主画面挤成备选；
   返回值保留成「被降级的 assetId」列表（现在总是空），调用方不用改 */
export function applyRole(members, assetId, role) {
  for (const m of members) {
    const u = usageAt(m, assetId);
    if (!u) continue;
    if (isRole(role)) u.role = role;
    else delete u.role;
    if (role !== 'main') delete u.at; // 不当主画面了，手动时间也不要了
  }
  return [];
}
/* 让 keepId 独占：和它在同一句上出现的其他主画面降为备选（只有视频审核「通过的视频替换占位照片」时用）。
   spare(id) 为真的主画面不动（视频审核里：别的已通过视频继续当主画面） */
export function resolveMainConflicts(members, keepId, spare = () => false) {
  const demoted = new Set();
  const others = [
    ...new Set(
      members.flatMap(m =>
        usagesOf(m)
          .filter(u => u.role === 'main')
          .map(u => u.assetId),
      ),
    ),
  ].filter(id => id !== keepId && !spare(id));
  for (const id of others) {
    const clash = members.some(m => onRow(m, keepId) && onRow(m, id));
    if (!clash) continue;
    demoted.add(id);
    for (const m of members) {
      const u = usageAt(m, id);
      if (u) u.role = 'alt';
    }
  }
  return [...demoted];
}
/* 这组画面里每句有没有主画面（交稿检查 / 卡片提示用） */
export function mainCoverage(members) {
  const anyRole = members.some(m => usagesOf(m).some(u => isRole(u.role)));
  const mains = members.map(m => usagesOf(m).some(u => u.role === 'main' && !u.off));
  return { anyRole, hasMain: mains.some(Boolean), full: mains.every(Boolean) };
}
/* 整理位置标记：单句画面去掉不在本句的素材；共用画面里谁都不在的素材移除；整段的去掉 off。
   成员结构变化（解除共用 / 移出 / 拆分 / 删句）之后调用，幂等 */
export function normalizeUsageSpans(rows) {
  for (const members of shots(rows)) {
    if (members.length < 2) {
      const r = members[0];
      if (!Array.isArray(r.assetUsages)) continue;
      if (r.assetUsages.some(u => u.off)) r.assetUsages = r.assetUsages.filter(u => !u.off);
      continue;
    }
    const ids = [...new Set(members.flatMap(m => usagesOf(m).map(u => u.assetId)))];
    for (const id of ids) {
      const sp = usageSpan(members, id);
      for (const m of members) {
        if (!Array.isArray(m.assetUsages)) continue;
        if (sp.empty) m.assetUsages = m.assetUsages.filter(u => u.assetId !== id);
        else if (sp.whole) {
          const u = usageAt(m, id);
          if (u) delete u.off;
        }
      }
    }
  }
}
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
/* 需要配画面、但还没挂上要用的素材（主画面 / 叠加 / 未分配；只有备选不算）的镜头 */
export const linkedUsages = r => usagesOf(r).filter(u => u.role !== 'alt' && !u.off);
export function unlinkedShots(rows, types = DEFAULT_TYPES) {
  const ti = typeIndex(types);
  return shots(rows).filter(g => g[0].type && ti.needsVisual(g[0].type) && !g.some(m => linkedUsages(m).length));
}
/* 交稿检查。默认是「分镜方案」检查：类型、画面描述、主画面、片段、改稿、字幕；
   opts.assets = true 时再加「素材交付」检查：需要画面却没关联素材、素材文件失联（opts.missing = 失联路径集合，opts.registry = 素材库） */
export function checkDelivery(rows, types = DEFAULT_TYPES, opts = {}) {
  const ti = typeIndex(types);
  return shots(rows).flatMap(group => {
    const r = group[0],
      issues = [];
    if (!r.type) issues.push('未标注类型');
    if (r.type && ti.needsVisual(r.type)) {
      if (!(r.note || '').trim()) issues.push('缺画面描述');
    }
    if (usagesOf(r).some(u => u.clip && u.clip.needsAdjust)) issues.push('片段范围待调整');
    if (r.type && ti.needsVisual(r.type)) {
      // 只在开始用角色之后提醒，旧项目不会一下子冒出一堆待处理
      const cov = mainCoverage(group);
      if (cov.anyRole && !cov.hasMain) issues.push('未指定主画面');
      else if (cov.anyRole && !cov.full) issues.push('部分句子没有主画面');
    }
    if (group.some(x => x.needsReview)) issues.push('稿件更新待核对');
    if (group.some(x => x.time && x.time.st === 'est')) issues.push('字幕里没找到这句');
    if (opts.assets && r.type && ti.needsVisual(r.type)) {
      if (!group.some(m => linkedUsages(m).length)) issues.push('还没关联素材');
      const reg = opts.registry || {};
      const lost = group.some(m => usagesOf(m).some(u => u.role !== 'alt' && opts.missing?.has(reg[u.assetId]?.path)));
      if (lost) issues.push('素材文件失联');
    }
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
  // 每句拿一份拷贝：解除共用 / 移出后各改各的，互不影响。
  // 原来只挂在某几句上的素材，合并后仍只在那几句出现（off 标记），不会突然铺满整段
  const had = members.map(
    r =>
      new Set(
        usagesOf(r)
          .filter(u => !u.off)
          .map(u => u.assetId),
      ),
  );
  const anyHad = shared.assetUsages.map(u => had.some(h => h.has(u.assetId)));
  members.forEach((r, i) =>
    Object.assign(r, {
      ...shared,
      assetUsages: cloneUsages(shared.assetUsages).map((u, k) => {
        delete u.off;
        if (anyHad[k] && !had[i].has(u.assetId)) u.off = true;
        return u;
      }),
    }),
  );
  normalizeUsageSpans(members);
  return members;
}
const validTime = t => t && Number.isFinite(+t.start) && Number.isFinite(+t.end) && +t.end >= +t.start;
/* 项目 JSON 导入：清洗句子。
   原文件里的 id 是一串不重复的正整数时原样保留（手动秒数 at.of、视频候选 rowId 都按 id 指向句子，保留最省事也最不容易错）；
   有重复 / 缺失 / 非法时才重新编号，并把 at.of 一起换成新 id。旧 id → 新 id 写进 info.idMap，调用方用它改写其他引用 */
export function normalizeProjectRows(rows, types = DEFAULT_TYPES, info = {}) {
  if (!Array.isArray(rows)) throw new Error('项目中没有有效的句子列表');
  const allowed = new Set(types.map(t => t.id));
  const ids = rows.map(r => r?.id);
  const keepIds = ids.every(x => Number.isInteger(x) && x > 0) && new Set(ids).size === ids.length;
  const idMap = new Map();
  let id = 0;
  const nextId = r => {
    const nid = keepIds ? r.id : ++id;
    if (r.id != null && !idMap.has(r.id)) idMap.set(r.id, nid);
    return nid;
  };
  info.idMap = idMap;
  const result = rows.map(r => {
    if (!r || !['line', 'section'].includes(r.kind) || typeof r.text !== 'string') throw new Error('项目格式不完整');
    if (r.kind === 'section') return { id: nextId(r), kind: 'section', text: r.text };
    return {
      id: nextId(r),
      kind: 'line',
      text: r.text,
      type: allowed.has(r.type) ? r.type : null,
      note: typeof r.note === 'string' ? r.note : '',
      assets: typeof r.assets === 'string' ? r.assets : '',
      status: STATUS[r.status] ? r.status : 'todo',
      ...(Array.isArray(r.assetUsages)
        ? { assetUsages: cloneUsages(r.assetUsages.filter(u => u && (u.assetId || u.path))) }
        : {}),
      ...(typeof r.groupId === 'string' && GROUP_ID.test(r.groupId) ? { groupId: r.groupId } : {}),
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
  // 重新编号时，手动秒数里记的「镜头第一句 id」跟着换
  if (!keepIds)
    for (const r of result)
      for (const u of r.assetUsages || []) if (u.at && idMap.has(u.at.of)) u.at = { ...u.at, of: idMap.get(u.at.of) };
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
  normalizeUsageSpans(rows);
}

/* ── 共用画面范围调整（纯数据层；actions.js 负责快照 / 落盘 / 提示） ──
   规则：范围永远是同一章节里的连续句子；加入只允许紧邻下一句；不吞并别的共用画面；
   有差异先出报告；移出 / 拆分后各部分保留现有画面信息，之后独立修改；
   只剩一句的部分自动成为独立画面。 */

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
