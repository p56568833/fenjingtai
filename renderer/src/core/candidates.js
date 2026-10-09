/* 视频候选清单（纯数据，无 DOM、无应用状态）：解析 Claude 给的候选清单、挂到画面 / 撤回、换成本地文件、写回内容。
   界面与流程在 features/video-review.js。 */
import { fmtTime, parseTime } from './text.js';
import { shotMembers, setShotField, applyRole, applySpan, resolveMainConflicts } from './shots.js';
import { ensureAsset, usageList, syncMirror, assetName, referencedAssetIds } from './asset-model.js';

export const CANDIDATE_TYPE = 'fenjingtai-candidates';
export const DECISION = { ok: '通过', no: '不要', re: '换一个' };
export const CANDIDATE_VERSION = 2;

/* ── 候选清单格式检查（v2，硬性规定）：不合格的整份拒收，返回每一处错在哪（空数组 = 合格）。
   规范说明在 core/candidate-spec.js；字段增减时两边一起改 ── */
const LINES_RE = /^\d+(-\d+)?$/;
const URL_RE = /^https?:\/\/\S+$/i;
const TOP_KEYS = ['type', 'version', 'project', 'batch', 'createdAt', 'shots', 'extra', 'reviewedAt'];
const SHOT_KEYS = ['lines', 'label', 'need', 'cands', 'extra'];
const CAND_KEYS = [
  'key',
  'title',
  'url',
  'page',
  'in',
  'out',
  'for',
  'license',
  'why',
  'coverage',
  'limitations',
  'extra',
  'review', // 分镜台写回的审核结果
];
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const filled = v => typeof v === 'string' && v.trim() !== '';
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const spanOf = s => {
  const [a, b = a] = s.split('-').map(Number);
  return { from: a, to: b };
};
export function validateCandidateDoc(doc) {
  const errs = [];
  const add = (where, msg) => errs.push(where ? `${where}：${msg}` : msg);
  const unknown = (obj, keys, where) => {
    for (const k of Object.keys(obj))
      if (!keys.includes(k)) add(where, `不认识的字段「${k}」（规范外的内容请放进 extra）`);
  };
  if (!isObj(doc)) return ['文件内容不是一个 JSON 对象'];
  if (doc.type !== CANDIDATE_TYPE) add('顶层', `type 必须是 "${CANDIDATE_TYPE}"`);
  if (doc.version !== CANDIDATE_VERSION)
    add(
      '顶层',
      `version 必须是数字 ${CANDIDATE_VERSION}${doc.version === 1 || doc.version === '1' ? '（这是旧格式 version 1，请按 v2 规范重写）' : ''}`,
    );
  if (!filled(doc.project)) add('顶层', 'project 必须写项目名');
  if (!filled(doc.batch)) add('顶层', 'batch 必须写这一批的名字');
  if (doc.createdAt != null && !(filled(doc.createdAt) && !Number.isNaN(Date.parse(doc.createdAt))))
    add('顶层', 'createdAt 必须是 ISO 时间，如 "2026-10-09T11:02:05+08:00"');
  unknown(doc, TOP_KEYS, '顶层');
  if (!Array.isArray(doc.shots) || !doc.shots.length) {
    add('顶层', 'shots 必须是数组，至少一个画面');
    return errs;
  }
  doc.shots.forEach((s, i) => {
    const sw = `shots[${i}]${isObj(s) && filled(s.lines) ? `（lines "${s.lines}"）` : ''}`;
    if (!isObj(s)) return add(sw, '必须是对象');
    let span = null;
    if (typeof s.lines !== 'string' || !LINES_RE.test(s.lines))
      add(sw, 'lines 必须是文字句号，如 "251" 或 "251-252"（半角减号，不加空格）');
    else {
      span = spanOf(s.lines);
      if (span.to < span.from) add(sw, 'lines 的结束句号不能小于开始句号');
    }
    if (!filled(s.label)) add(sw, 'label 必须写这个画面的简短名字');
    if (s.need != null && typeof s.need !== 'string') add(sw, 'need 必须是文字');
    unknown(s, SHOT_KEYS, sw);
    if (!Array.isArray(s.cands) || !s.cands.length) return add(sw, 'cands 必须是数组，至少一个候选');
    const keys = new Set();
    s.cands.forEach((c, j) => {
      const cw = `${sw} cands[${j}]${isObj(c) && filled(c.key) ? `（key "${c.key}"）` : ''}`;
      if (!isObj(c)) return add(cw, '必须是对象');
      if (!filled(c.key)) add(cw, 'key 必须写');
      else if (keys.has(c.key)) add(cw, `key "${c.key}" 在这个画面里重复了`);
      else keys.add(c.key);
      if (!filled(c.title)) add(cw, 'title 必须写中文标题');
      if (typeof c.url !== 'string' || !URL_RE.test(c.url))
        add(cw, 'url 必须是能直接播放的视频文件地址（http / https）');
      if (c.page != null && (typeof c.page !== 'string' || !URL_RE.test(c.page)))
        add(cw, 'page 必须是网页地址（http / https）');
      if (!isNum(c.in) || c.in < 0) add(cw, 'in 必须是秒数（数字，≥ 0），不要写 "1:41" 或带引号');
      if (!isNum(c.out)) add(cw, 'out 必须是秒数（数字），不要写 "1:41" 或带引号');
      else if (isNum(c.in) && c.out <= c.in) add(cw, 'out 必须大于 in');
      if (c.for != null) {
        if (typeof c.for !== 'string' || !LINES_RE.test(c.for)) add(cw, 'for 必须是文字句号，如 "252" 或 "252-253"');
        else if (span) {
          const f = spanOf(c.for);
          if (f.to < f.from || f.from < span.from || f.to > span.to)
            add(cw, `for "${c.for}" 必须在这个画面的 lines "${s.lines}" 范围内`);
        }
      }
      if (!filled(c.license)) add(cw, 'license 必须写版权情况（不清楚就写「版权未核实」）');
      if (!filled(c.why)) add(cw, 'why 必须写为什么选它、画面里看到了什么');
      if (c.coverage != null && c.coverage !== 'full' && c.coverage !== 'partial')
        add(cw, 'coverage 只能是 "full" 或 "partial"');
      if (c.limitations != null && typeof c.limitations !== 'string') add(cw, 'limitations 必须是文字');
      else if (c.coverage === 'partial' && !filled(c.limitations))
        add(cw, 'coverage 是 "partial" 时必须写 limitations（缺了哪部分）');
      unknown(c, CAND_KEYS, cw);
    });
  });
  return errs;
}

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
  if (!doc || doc.type !== CANDIDATE_TYPE) return { error: '这不是视频候选清单' };
  const errors = validateCandidateDoc(doc);
  if (errors.length) return { error: `候选清单格式不对（${errors.length} 处）`, errors };
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
        for: raw.for != null ? String(raw.for) : '', // 这段配画面里的哪几句（句号，如 "200" 或 "200-201"）；空 = 整个画面
        need: String(s.need || ''), // 这个画面要什么画面（审核页标题下显示）
        coverage: raw.coverage === 'partial' ? 'partial' : '', // 只覆盖一部分（比如两家公司只拍到一家）
        limits: String(raw.limitations || ''),
        srcFile: srcFile || '',
      };
      const old = existing.find(c => c.srcFile === base.srcFile && c.lines === base.lines && c.key === base.key);
      if (old) {
        const changed = candidateChanged(old, { url, in: tin, out: tout });
        // 链接或片段变了：回到待审，旧的素材关联 / 已保存状态都作废（旧文件留在磁盘上，不删）
        const next = { ...old, ...base, ...(changed ? { decision: '', note: old.note || '' } : {}) };
        if (changed) {
          delete next.assetId;
          delete next.savedPath;
          delete next.decidedAt;
        }
        updated.push({ old, next, changed });
      } else if (raw.review?.decision === 'no') {
        // 以前已经标成「不要」、被清掉的：同一份清单再导入时不让它回来
        continue;
      } else added.push({ id: 'vc-' + crypto.randomUUID(), ...base, decision: '', note: raw.review?.note || '' });
    }
  }
  return { added, updated, skipped };
}

/* 通过：挂到画面上，一律当主画面（不是主画面的由用户在面板里点成备选，比反过来少点很多次）。
   原来的占位主画面（照片等，非视频审核来的）让位成备选；别的已通过视频继续当主画面，同一句上几个主画面平分时间 */
export function attachCandidate(c, rows, registry) {
  const row = rows.find(r => r.id === c.rowId);
  if (!row) return { error: '找不到这个画面（句子可能被删了）' };
  const members = shotMembers(rows, row);
  const asset = ensureAsset(registry, remotePath(c), { kind: 'video', name: c.title });
  asset.source = { candidate: c.id, url: c.url, page: c.page, license: c.license };
  for (const m of members) {
    let u = usageList(m).find(x => x.assetId === asset.id);
    if (!u) {
      m.assetUsages = [...usageList(m), { assetId: asset.id }];
      u = m.assetUsages[m.assetUsages.length - 1];
    }
    u.clip = { in: c.in, out: c.out };
    delete u.off;
  }
  applyRole(members, asset.id, 'main');
  applyFor(c, members, asset.id);
  const demoted = resolveMainConflicts(members, asset.id, id => !!registry[id]?.source?.candidate);
  const line = noteLine(c);
  if (!(row.note || '').includes(line))
    setShotField(rows, row, 'note', (row.note ? row.note.replace(/\s+$/, '') + '\n' : '') + line);
  syncMirror(members, registry);
  return { assetId: asset.id, role: 'main', demoted };
}
/* 写了「配哪几句」（for）：素材只在那几句出现，和面板里「出现在 第 x 句 到 第 y 句」一样；没写 / 对不上 = 整段 */
export function applyFor(c, members, assetId) {
  const r = c.for ? parseLines(c.for) : null;
  const idx = r
    ? members
        .map((m, i) => (m.no >= Math.min(r.from, r.to) && m.no <= Math.max(r.from, r.to) ? i : -1))
        .filter(i => i >= 0)
    : [];
  if (idx.length) applySpan(members, assetId, idx[0], idx[idx.length - 1]);
  else applySpan(members, assetId, 0, members.length - 1);
}
/* 撤回通过：把这个视频从画面上拿掉，画面描述里那一行也删掉 */
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
/* 已经保存到本地、表格里却还挂着在线地址的视频：找出来（返回 [{ asset, cand }]）。
   典型来源：通过 → 保存 → 撤回 → 再通过，再通过时按在线地址新建了素材，候选上的「已保存」还在，
   「保存已通过的片段」又会跳过它，于是一直显示「在线」；或者重复导入的批次里同一段又通过了一次。
   按「链接 + 入出点」对上已通过、已保存的候选（素材记着的候选优先），链接或片段变了的不算 */
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

/* 项目 JSON 里带的候选记录：清洗字段，rowId 按导入时的 id 映射改写；对不上句子的丢掉，素材已不在库里的不再算「已挂」 */
export function sanitizeProjectCandidates(list, { idMap = new Map(), rowIds = new Set(), assets = {} } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const url = String(raw.url || '').trim();
    const tin = parseClock(raw.in),
      tout = parseClock(raw.out);
    if (!/^https?:\/\//i.test(url) || !(tout > tin)) continue;
    const rowId = idMap.has(raw.rowId) ? idMap.get(raw.rowId) : raw.rowId;
    if (!rowIds.has(rowId)) continue;
    let id = typeof raw.id === 'string' && raw.id ? raw.id : 'vc-' + crypto.randomUUID();
    if (seen.has(id)) id = 'vc-' + crypto.randomUUID();
    seen.add(id);
    const decision = ['ok', 'no', 're'].includes(raw.decision) ? raw.decision : '';
    const assetId = typeof raw.assetId === 'string' && assets[raw.assetId] ? raw.assetId : undefined;
    out.push({
      id,
      key: String(raw.key || ''),
      lines: String(raw.lines ?? ''),
      label: String(raw.label || ''),
      rowId,
      title: String(raw.title || assetName(url)),
      url,
      page: String(raw.page || ''),
      in: tin,
      out: tout,
      license: String(raw.license || ''),
      why: String(raw.why || ''),
      for: raw.for != null ? String(raw.for) : '',
      need: String(raw.need || ''),
      coverage: raw.coverage === 'partial' ? 'partial' : '',
      limits: String(raw.limits || ''),
      srcFile: typeof raw.srcFile === 'string' ? raw.srcFile : '',
      decision: decision === 'ok' && !assetId ? '' : decision,
      note: String(raw.note || ''),
      ...(assetId ? { assetId } : {}),
      ...(assetId && typeof raw.savedPath === 'string' && raw.savedPath ? { savedPath: raw.savedPath } : {}),
      ...(Number.isFinite(raw.decidedAt) ? { decidedAt: raw.decidedAt } : {}),
      ...(typeof raw.batchId === 'string' ? { batchId: raw.batchId } : {}),
      ...(Number.isFinite(raw.batchAt) ? { batchAt: raw.batchAt } : {}),
      ...(typeof raw.batchName === 'string' ? { batchName: raw.batchName } : {}),
      ...(Number.isSafeInteger(raw.batchNo) && raw.batchNo > 0 ? { batchNo: raw.batchNo } : {}),
    });
  }
  return out;
}

/* 同一候选的链接或片段改了：原来通过时挂上的素材、保存好的本地片段都不再代表这个候选 */
export const candidateChanged = (old, next) => old.url !== next.url || old.in !== next.in || old.out !== next.out;

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
