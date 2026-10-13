import { shotMembers } from './shots.js';
import { usageList, assetName } from './asset-model.js';
import { lineTag, hasLineTag } from './candidates.js';

export function candidateBatches(candidates) {
  const map = new Map();
  for (const c of candidates) {
    const id = c.batchId || 'legacy';
    if (!map.has(id))
      map.set(id, { id, name: c.batchId ? c.batchName || '视频候选' : '之前导入的', at: c.batchAt || 0, cands: [] });
    map.get(id).cands.push(c);
  }
  const all = [...map.values()].sort((a, b) => b.at - a.at);
  const nos = all.map(
    (b, i) => b.cands.find(c => Number.isSafeInteger(c.batchNo) && c.batchNo > 0)?.batchNo || all.length - i,
  );
  // 协作时两人同时导入，各自算出的批号会撞上：先导入的保留，后导入的往后顺延。
  // 只看合并后的数据，两台电脑算出来一样
  const taken = new Set(),
    dups = [];
  const oldest = all.map((_, i) => i).sort((i, j) => all[i].at - all[j].at || (all[i].id < all[j].id ? -1 : 1));
  for (const i of oldest) {
    if (taken.has(nos[i])) dups.push(i);
    else taken.add(nos[i]);
  }
  let next = Math.max(0, ...taken);
  for (const i of dups) nos[i] = ++next;
  return all.map((b, i) => ({ ...b, number: nos[i] }));
}

export function retagPlan(rows, assets, candidates) {
  let no = 0;
  rows = rows.map(r => (r.kind === 'line' ? { ...r, no: ++no } : r));
  const tagOf = members => {
    const nos = members.map(m => m.no).filter(n => n > 0);
    if (!nos.length) return '';
    const from = Math.min(...nos),
      to = Math.max(...nos);
    return from === to ? `第${from}句` : `第${from}-${to}句`;
  };
  const first = new Map(); // assetId → 句号
  const seen = new Set();
  for (const r of rows) {
    if (r.kind !== 'line') continue;
    const members = shotMembers(rows, r);
    const key = r.groupId || `line-${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const m of members)
      for (const u of usageList(m)) if (!first.has(u.assetId)) first.set(u.assetId, tagOf(members));
  }
  const plan = new Map(); // 旧路径 → 句号
  const local = p => typeof p === 'string' && p.startsWith('/') && hasLineTag(p);
  for (const a of Object.values(assets || {})) {
    if (!local(a.path) || plan.has(a.path)) continue;
    let tag = first.get(a.id);
    if (!tag) {
      const c = candidates.find(x => x.savedPath === a.path);
      tag = c ? lineTag(c, rows) : '';
    }
    if (tag && !assetName(a.path).startsWith(`${tag}_`)) plan.set(a.path, tag);
  }
  for (const c of candidates) {
    if (!local(c.savedPath) || plan.has(c.savedPath)) continue;
    if (Object.values(assets || {}).some(a => a.path === c.savedPath)) continue;
    const tag = lineTag(c, rows);
    if (tag && !assetName(c.savedPath).startsWith(`${tag}_`)) plan.set(c.savedPath, tag);
  }
  return plan;
}
