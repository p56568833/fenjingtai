/* 镜头 / 共用画面的纯数据逻辑（无 DOM、无应用状态）：
   一个「镜头」= 一句独立的话，或同一共用画面里连续的几句。共享字段在组内每句各存一份副本。
   导入清洗 / 改稿对账在 project-import.js，共用画面范围调整在 shot-groups.js。 */
import { DEFAULT_TYPES, typeIndex } from './types.js';
import { usageList as usagesOf, cloneUsages } from './asset-usage.js';
export const STATUS = { todo: '待找素材', making: '待制作', ready: '已就绪' };
export const shotMembers = (rows, r) =>
  r?.groupId ? rows.filter(x => x.kind === 'line' && x.groupId === r.groupId) : r ? [r] : [];
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
/* 上屏画面按句子先后排：配前面句子的排在前面（①②… 跟着变），同样起点的保持原来的先后（「往前 / 往后」调的就是它）。
   只在主画面之间挪位置，备选 / 未分配的原地不动；组内每句的列表一起排，顺序一致 */
export function sortMainsBySentence(members) {
  if (members.length < 2) return false;
  const list0 = usagesOf(members[0]);
  const mains = list0.filter(u => u.role === 'main').map(u => u.assetId);
  if (mains.length < 2) return false;
  const key = id => {
    const sp = usageSpan(members, id);
    return sp.empty ? Infinity : sp.from;
  };
  const at = id => list0.find(u => u.assetId === id)?.at?.start ?? Infinity;
  const order = mains
    .map((id, i) => ({ id, i, k: key(id), t: at(id) }))
    .sort(
      (a, b) => a.k - b.k || (a.t !== b.t && Number.isFinite(a.t) && Number.isFinite(b.t) ? a.t - b.t : 0) || a.i - b.i,
    )
    .map(x => x.id);
  if (order.every((id, i) => id === mains[i])) return false;
  for (const m of members) {
    const list = usagesOf(m);
    const slots = list.map((u, i) => (u.role === 'main' ? i : -1)).filter(i => i >= 0);
    const byId = new Map(list.map(u => [u.assetId, u]));
    const sorted = order.map(id => byId.get(id)).filter(Boolean);
    if (sorted.length !== slots.length) continue; // 这句的列表和第一句对不上（不该发生）：不动
    slots.forEach((slot, k) => (list[slot] = sorted[k]));
  }
  return true;
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
/* 共用画面的共享字段（描述 / 类型 / 状态）统一从这里写：组内每句一起改，保证一致。
   返回被改到的句子，调用方据此刷界面。素材使用记录要逐句拷贝，走 assets.js 的 eachMember。 */
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
/* 交稿检查。默认是「分镜方案」检查：类型、画面描述、主画面、片段、字幕；
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
