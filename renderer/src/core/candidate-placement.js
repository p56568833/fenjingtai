/* 审核通过后的画面挂载、撤回、本地片段替换与文件命名。 */

import { shotMembers, setShotField, applyRole, applySpan, resolveMainConflicts } from './shots.js';
import { ensureAsset, usageList, syncMirror, assetName, referencedAssetIds } from './asset-model.js';

import { placeApproved } from './shot-tracks.js';
import { parseLines, cleanBest, noteLine, remotePath, planOf, usableSeconds } from './candidate-values.js';
export function orderPlanMains(members, registry, cands) {
  const byId = new Map(cands.map(c => [c.id, c]));
  const candOf = u => {
    const c = byId.get(registry[u.assetId]?.source?.candidate);
    return c && c.assetId === u.assetId ? c : null;
  };
  for (const m of members) {
    const list = usageList(m);
    const slots = list.map((u, i) => (u.role === 'main' && candOf(u) ? i : -1)).filter(i => i >= 0);
    const sorted = slots
      .map(i => list[i])
      .sort((a, b) => planOf(candOf(a)) - planOf(candOf(b)) || (candOf(a).seq ?? 0) - (candOf(b).seq ?? 0));
    slots.forEach((slot, k) => (list[slot] = sorted[k]));
  }
}
export function attachCandidate(c, rows, registry, cands = [], { tl = null } = {}) {
  const row = rows.find(r => r.id === c.rowId);
  if (!row) return { error: '找不到这个画面（句子可能被删了）' };
  const members = shotMembers(rows, row);
  const asset = ensureAsset(registry, remotePath(c), { kind: 'video', name: c.title });
  asset.source = { candidate: c.id, url: c.url, page: c.page, license: c.license };
  // 先判断放哪：只看别的候选视频占了多少（占位照片会让位，不算）
  const place = tl
    ? placeApproved(registry, members, tl, usableSeconds(c), id => id !== asset.id && !!registry[id]?.source?.candidate)
    : { role: 'main' };
  for (const m of members) {
    let u = usageList(m).find(x => x.assetId === asset.id);
    if (!u) {
      m.assetUsages = [...usageList(m), { assetId: asset.id }];
      u = m.assetUsages[m.assetUsages.length - 1];
    }
    // 可用片段：清单写了精选段就用精选段，否则整段（截取保存的始终是 in–out，精选段换算到文件里）
    const best = cleanBest(c.best, c.in, c.out);
    u.clip = best ? { ...best } : { in: c.in, out: c.out };
    delete u.off;
  }
  const main = place.role === 'main';
  applyRole(members, asset.id, place.role);
  applySpan(members, asset.id, 0, members.length - 1);
  if (place.at)
    for (const m of members)
      for (const u of usageList(m)) if (u.assetId === asset.id) u.at = { ...place.at, of: members[0].id };
  const demoted = main ? resolveMainConflicts(members, asset.id, id => !!registry[id]?.source?.candidate) : [];
  if (main) orderPlanMains(members, registry, [...cands.filter(x => x.id !== c.id), { ...c, assetId: asset.id }]);
  const line = noteLine(c);
  if (!(row.note || '').includes(line))
    setShotField(rows, row, 'note', (row.note ? row.note.replace(/\s+$/, '') + '\n' : '') + line);
  syncMirror(members, registry);
  return { assetId: asset.id, role: place.role, current: main, demoted };
}
export function detachCandidate(c, rows, registry) {
  const id = c.assetId;
  const own = rows.find(r => r.id === c.rowId && r.kind === 'line');
  // 原来那句还在：就处理它所在的画面；找不到（句子被删了 / 旧数据）：到用着这个视频的每个画面里摘掉
  const owners = own
    ? [own]
    : id
      ? rows.filter(r => r.kind === 'line' && usageList(r).some(u => u.assetId === id))
      : [];
  const line = noteLine(c);
  const touched = [];
  for (const row of owners) {
    const members = shotMembers(rows, row);
    if (touched.includes(members[0])) continue;
    touched.push(members[0]);
    for (const m of members) if (id) m.assetUsages = usageList(m).filter(u => u.assetId !== id);
    if ((row.note || '').includes(line))
      setShotField(
        rows,
        row,
        'note',
        row.note
          .split('\n')
          .filter(l => l !== line)
          .join('\n'),
      );
    syncMirror(members, registry);
  }
}
const r2 = x => Math.round(x * 100) / 100;
export function localClip(clip, c) {
  const span = Number.isFinite(c?.in) && Number.isFinite(c?.out) && c.out > c.in ? c.out - c.in : null;
  if (!clip || span == null || !Number.isFinite(clip.in) || !Number.isFinite(clip.out)) return null;
  const s = Math.max(0, clip.in - c.in),
    e = Math.min(span, clip.out - c.in);
  if (e - s < 0.1 || (s < 0.05 && e > span - 0.05)) return null;
  return { in: r2(s), out: r2(e) };
}
export function swapToLocal(c, localPath, rows, registry) {
  const a = registry[c.assetId];
  if (!a) return false;
  a.path = localPath;
  a.name = assetName(localPath);
  a.kind = 'video';
  delete a.durationSec;
  for (const r of rows)
    if (r.kind === 'line')
      for (const u of usageList(r)) {
        if (u.assetId !== a.id) continue;
        const clip = localClip(u.clip, c);
        if (clip) u.clip = clip;
        else delete u.clip;
      }
  syncMirror(rows, registry);
  return true;
}
export function staleOnlineClips(cands, rows, registry) {
  const saved = new Map(); // 在线地址（含入出点）→ 已保存的候选
  for (const c of cands) if (c.decision === 'ok' && c.savedPath && c.url) saved.set(remotePath(c), c);
  const byId = new Map(cands.map(c => [c.id, c]));
  const out = [];
  for (const id of referencedAssetIds(rows)) {
    const a = registry[id];
    if (!a || !saved.has(a.path)) continue;
    const own = a.source?.candidate ? byId.get(a.source.candidate) : null;
    const c = own && own.decision === 'ok' && own.savedPath && remotePath(own) === a.path ? own : saved.get(a.path);
    out.push({ asset: a, cand: c });
  }
  return out;
}
export function lineTag(c, rows) {
  const row = rows.find(r => r.id === c.rowId);
  const nos = row
    ? shotMembers(rows, row)
        .map(m => m.no)
        .filter(n => n > 0)
    : [];
  let from, to;
  if (nos.length) {
    from = Math.min(...nos);
    to = Math.max(...nos);
  } else {
    const r = parseLines(c.lines);
    if (!r || !(r.from > 0)) return '';
    ({ from, to } = r);
  }
  return from === to ? `第${from}句` : `第${from}-${to}句`;
}
export const fileTitle = (c, rows) => [lineTag(c, rows), c.title].filter(Boolean).join('_');
export const hasLineTag = p => /^第\d+(?:-\d+)?句_/.test(assetName(p));
