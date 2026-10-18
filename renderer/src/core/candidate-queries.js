import { shotMembers, usageSpan } from './shots.js';
import { usageList, assetName } from './asset-model.js';
import { lineTag, hasLineTag, tagOf } from './candidate-placement.js';
import { candidateScope } from './candidate-scope.js';

export function candidateBatches(candidates, rows = []) {
  const map = new Map();
  for (const c of candidates) {
    const id = c.batchId || 'legacy';
    if (!map.has(id))
      map.set(id, { id, name: c.batchId ? c.batchName || '视频候选' : '之前导入的', at: c.batchAt || 0, cands: [] });
    map.get(id).cands.push(c);
  }
  return [...map.values()]
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .map(b => {
      const scope = candidateScope(b.cands, rows);
      // 旧名单中明确写过返工 / 重找的，也沿用新显示方式；原名仅供溯源。
      const rework = b.cands.some(c => c.reworkId || c.batchKind === 'rework') || /返工|重找|批注/.test(b.name);
      const label = !scope.count
        ? '句子已移除'
        : scope.compact
          ? `${scope.text}${rework ? ' · 重找' : ''}`
          : `${rework ? '返工素材' : '视频素材'} · 共${scope.count}句`;
      return { ...b, label, scope, detail: scope.compact ? '' : scope.text };
    });
}

/* 文件名里的句号要改成什么：旧路径 → 「第N句」/「第N-M句」。
   按素材现在配的那几句（共用画面里只配其中一句的就是那一句；整段就是整个画面），素材没挂在表格里的按候选算 */
export function retagPlan(rows, assets, candidates) {
  let no = 0;
  rows = rows.map(r => (r.kind === 'line' ? { ...r, no: ++no } : r));
  const first = new Map(); // assetId → 句号
  const seen = new Set();
  for (const r of rows) {
    if (r.kind !== 'line') continue;
    const members = shotMembers(rows, r);
    const key = r.groupId || `line-${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const m of members)
      for (const u of usageList(m)) {
        if (first.has(u.assetId)) continue;
        const sp = usageSpan(members, u.assetId);
        const [a, b] = sp.empty ? [0, members.length - 1] : [sp.from, sp.to];
        first.set(u.assetId, tagOf(members[a].no, members[b].no));
      }
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
