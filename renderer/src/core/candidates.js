/* 视频候选清单（纯数据，无 DOM、无应用状态）：解析 Claude 给的候选清单、挂到画面 / 撤回、换成本地文件、写回内容。
   界面与流程在 features/video-review.js。 */
import { fmtTime, parseTime } from './text.js';
import { shotMembers, setShotField, applyRole, resolveMainConflicts } from './shots.js';
import { ensureAsset, usageList, syncMirror, assetName } from './asset-model.js';

export const CANDIDATE_TYPE = 'fenjingtai-candidates';
export const DECISION = { ok: '通过', no: '不要', re: '换一个' };

export function parseClock(v) {
  if (typeof v === 'number' && isFinite(v)) return Math.max(0, v);
  const s = String(v ?? '').trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return parseTime(s) ?? NaN;
}
/* "101-103" / "101–103" / [101, 103] / 101 → {from, to} 句号 */
export function parseLines(v) {
  if (Array.isArray(v)) return { from: +v[0], to: +(v[1] ?? v[0]) };
  const m = String(v ?? '').match(/(\d+)\s*(?:[-–—~至到]\s*(\d+))?/);
  return m ? { from: +m[1], to: +(m[2] || m[1]) } : null;
}
export const noteLine = c =>
  `视频：${c.title || assetName(c.url)}｜${fmtTime(c.in)}–${fmtTime(c.out)}｜${c.license || '版权未注明'}｜${c.page || c.url}`;
export const remotePath = c => `${c.url.split('#')[0]}#t=${c.in},${c.out}`;

/* 候选清单 → 候选记录（按当前句号找到画面；找不到的列进 skipped） */
export function planImport(doc, srcFile, rows, existing = []) {
  if (!doc || doc.type !== CANDIDATE_TYPE || !Array.isArray(doc.shots)) return { error: '这不是视频候选清单' };
  const byNo = new Map(rows.filter(r => r.kind === 'line').map(r => [r.no, r]));
  const added = [],
    updated = [],
    skipped = [];
  for (const s of doc.shots) {
    const range = parseLines(s.lines);
    const row = range && byNo.get(range.from);
    for (const raw of Array.isArray(s.cands) ? s.cands : []) {
      const url = String(raw.url || '').trim();
      const tin = parseClock(raw.in),
        tout = parseClock(raw.out);
      if (!row || !/^https?:\/\//i.test(url) || !(tout > tin)) {
        skipped.push(`${s.lines || '?'} ${raw.key || ''}`.trim());
        continue;
      }
      const base = {
        key: String(raw.key || ''),
        lines: String(s.lines),
        label: String(s.label || ''),
        rowId: row.id,
        title: String(raw.title || assetName(url)),
        url,
        page: String(raw.page || ''),
        in: tin,
        out: tout,
        license: String(raw.license || ''),
        why: String(raw.why || ''),
        srcFile: srcFile || '',
      };
      const old = existing.find(c => c.srcFile === base.srcFile && c.lines === base.lines && c.key === base.key);
      if (old) {
        const same = old.url === url && old.in === tin && old.out === tout;
        updated.push({ old, next: { ...old, ...base, ...(same ? {} : { decision: '', note: old.note || '' }) } });
      } else if (raw.review?.decision === 'no') {
        // 以前已经标成「不要」、被清掉的：同一份清单再导入时不让它回来
        continue;
      } else added.push({ id: 'vc-' + crypto.randomUUID(), ...base, decision: '', note: raw.review?.note || '' });
    }
  }
  return { added, updated, skipped };
}

/* 通过：挂到画面上。规则：这个画面还没有「来自视频审核的主画面」→ 设成主画面（原来的主画面照片自动让位成备选）；
   已经有一个通过的视频当主画面 → 新通过的先放备选，避免互相顶掉，可在面板里调整 */
export function attachCandidate(c, rows, registry) {
  const row = rows.find(r => r.id === c.rowId);
  if (!row) return { error: '找不到这个画面（句子可能被删了）' };
  const members = shotMembers(rows, row);
  const asset = ensureAsset(registry, remotePath(c), { kind: 'video', name: c.title });
  asset.source = { candidate: c.id, url: c.url, page: c.page, license: c.license };
  const videoMain = usageList(row).some(
    u => u.role === 'main' && !u.off && u.assetId !== asset.id && registry[u.assetId]?.source?.candidate,
  );
  for (const m of members) {
    let u = usageList(m).find(x => x.assetId === asset.id);
    if (!u) {
      m.assetUsages = [...usageList(m), { assetId: asset.id }];
      u = m.assetUsages[m.assetUsages.length - 1];
    }
    u.clip = { in: c.in, out: c.out };
    delete u.off;
  }
  const role = videoMain ? 'alt' : 'main';
  applyRole(members, asset.id, role);
  // 通过的视频顶替原来的占位主画面（照片等）：同一句上的旧主画面让位成备选
  const demoted = role === 'main' ? resolveMainConflicts(members, asset.id) : [];
  const line = noteLine(c);
  if (!(row.note || '').includes(line))
    setShotField(rows, row, 'note', (row.note ? row.note.replace(/\s+$/, '') + '\n' : '') + line);
  syncMirror(members, registry);
  return { assetId: asset.id, role, demoted };
}
/* 撤回通过：把这个视频从画面上拿掉，画面描述里那一行也删掉 */
export function detachCandidate(c, rows, registry) {
  const row = rows.find(r => r.id === c.rowId);
  if (!row) return;
  const members = shotMembers(rows, row);
  const id = c.assetId;
  for (const m of members) if (id) m.assetUsages = usageList(m).filter(u => u.assetId !== id);
  const line = noteLine(c);
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
/* 保存了那几秒：素材换成本地文件（已经是剪好的片段，不再需要入出点），原链接留在画面描述里 */
export function swapToLocal(c, localPath, rows, registry) {
  const a = registry[c.assetId];
  if (!a) return false;
  a.path = localPath;
  a.name = assetName(localPath);
  a.kind = 'video';
  delete a.durationSec;
  for (const r of rows) if (r.kind === 'line') for (const u of usageList(r)) if (u.assetId === a.id) delete u.clip;
  syncMirror(rows, registry);
  return true;
}
/* 文件名里的句号：按这个画面现在的句子范围（第125-127句 / 第125句）；画面找不到时退回清单里写的 lines */
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

/* 写回候选清单的内容：每个来源文件一份 */
export function reviewPayload(cands) {
  const byFile = new Map();
  for (const c of cands) {
    if (!c.srcFile) continue;
    if (!byFile.has(c.srcFile)) byFile.set(c.srcFile, []);
    byFile.get(c.srcFile).push({
      key: c.key,
      lines: c.lines,
      decision: c.decision || '',
      note: c.note || '',
      savedPath: c.savedPath || '',
    });
  }
  return byFile;
}
