/* 审核名称和返工范围只认实际句子，不采用 AI 写的批名或历史批号。 */
import { shotMembers } from './shots.js';
import { CANDIDATE_VERSION } from './candidate-values.js';

export function sentenceScope(numbers) {
  const nos = [...new Set(numbers.filter(n => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b);
  const ranges = [];
  for (const n of nos) {
    const last = ranges.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  const text = ranges.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join('、');
  return {
    count: nos.length,
    text: text ? `第${text}句` : '句子已移除',
    compact: text.length <= 20 && ranges.length <= 3,
  };
}

export function candidateScope(cands, rows) {
  const byId = new Map(rows.filter(r => r.kind === 'line').map(r => [r.id, r]));
  const groups = new Map();
  for (const row of byId.values()) {
    if (!row.groupId) continue;
    if (!groups.has(row.groupId)) groups.set(row.groupId, []);
    groups.get(row.groupId).push(row);
  }
  const members = new Map();
  let missing = false;
  for (const c of cands) {
    const row = byId.get(c.rowId);
    if (!row) missing = true;
    else for (const m of row.groupId ? groups.get(row.groupId) : [row]) members.set(m.id, m);
  }
  return { ...sentenceScope([...members.values()].map(m => m.no)), missing };
}

export function normalizeReworkRequests(value, idMap = new Map()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [id, request] of Object.entries(value)) {
    if (!id.startsWith('rw-') || !Array.isArray(request?.targets)) continue;
    const targets = request.targets
      .filter(t => Array.isArray(t?.rowIds) && t.rowIds.length && t.rowIds.every(n => Number.isSafeInteger(n) && n > 0))
      .map(t => ({
        rowIds: t.rowIds.map(n => idMap.get(n) ?? n),
        ...(Array.isArray(t.forIds) && t.forIds.every(n => Number.isSafeInteger(n) && n > 0)
          ? { forIds: t.forIds.map(n => idMap.get(n) ?? n) }
          : {}),
        note: typeof t.note === 'string' ? t.note : '',
      }));
    if (targets.length) out[id] = { at: Number(request.at) || 0, targets };
  }
  return out;
}

export function reworkScopeErrors(doc, rows, requests) {
  if (!doc.reworkId) return [];
  const request = requests[doc.reworkId];
  if (!request) return ['reworkId 找不到对应的返工单，请使用本项目生成的返工单标记'];
  if (doc.version !== CANDIDATE_VERSION)
    return [`返工素材必须使用候选清单格式 v${CANDIDATE_VERSION}，逐个画面写 shots[].lines`];
  const byNo = new Map(rows.filter(r => r.kind === 'line').map(r => [r.no, r]));
  const errors = [];
  for (const s of doc.shots) {
    const row = byNo.get(Number(s.lines.split('-')[0]));
    const members = row ? shotMembers(rows, row) : [];
    const target = request.targets.find(
      t => t.rowIds.length === members.length && t.rowIds.every(id => members.some(m => m.id === id)),
    );
    if (!target) {
      errors.push(
        `lines "${s.lines}" 不在这张返工单里，或画面范围已改变。只能逐项回复返工单中的画面，不能用首尾句号扩成整段；改稿后请重新生成返工单`,
      );
      continue;
    }
    // 返工单写了要补哪几句：回复的视频只能给那几句
    if (!target.forIds) continue;
    const want = members.filter(m => target.forIds.includes(m.id));
    const wantText = sentenceScope(want.map(m => m.no)).text;
    for (const c of s.cands || []) {
      const f = String(c?.for || '').match(/^(\d+)(?:-(\d+))?$/);
      if (!f) continue; // 写法不对的在格式检查里报
      const from = +f[1],
        to = +(f[2] || f[1]);
      const hit = members.filter(m => m.no >= from && m.no <= to);
      if (!hit.length || hit.some(m => !target.forIds.includes(m.id)))
        errors.push(
          `lines "${s.lines}" 的 key "${c.key}"：for "${c.for}" 不在返工单要补的句子里。这个画面只要补${wantText}，同一画面的别的句子不用找`,
        );
    }
  }
  return errors;
}
