/* 按稿件顺序搜索：正文定位到具体句子，共用画面描述只算一次。 */
import { lineAt } from './timeline.js';
export function searchLineIds(lines, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const contains = text => (text || '').toLowerCase().includes(q);
  const textIds = new Set();
  const textGroups = new Set();
  for (const r of lines) {
    if (!contains(r.text)) continue;
    textIds.add(r.id);
    if (r.groupId) textGroups.add(r.groupId);
  }
  const noteGroups = new Set();
  return lines.flatMap(r => {
    if (textIds.has(r.id)) return [r.id];
    if (!contains(r.note)) return [];
    if (r.groupId) {
      // 组内正文已经命中时，不让整组共用的备注抢在真正那句前面。
      if (textGroups.has(r.groupId) || noteGroups.has(r.groupId)) return [];
      noteGroups.add(r.groupId);
    }
    return [r.id];
  });
}

/* 编号与时间直达：「248」「#248」「第248句」「248-256」「26:37」「1:02:05」「26分37秒」「26:37-27:21」，
   时间也可用小数点代替冒号：「26.37」「1.02.05」（点后必须正好两位）。
   纯数字、小数点时间也可能只是正文里的数字，标 loose：直达不到时退回正文搜索。 */
const RANGE = /\s*(?:-|–|—|~|～|到|至)\s*/;
const DOT_TIME = /^\d{1,3}\.\d{2}(?:\.\d{2})?$/;
function parseNo(s) {
  const m = /^(?:#|第)?\s*(\d{1,6})\s*句?$/.exec(s);
  return m ? Number(m[1]) : null;
}
function parseTime(s) {
  if (DOT_TIME.test(s)) s = s.replaceAll('.', ':');
  let m = /^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?$/.exec(s);
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), m[3] == null ? null : Number(m[3])];
    if (c == null) return b < 60 ? a * 60 + b : null;
    return b < 60 && c < 60 ? a * 3600 + b * 60 + c : null;
  }
  m = /^(?:(\d{1,2})\s*(?:小时|时))?\s*(?:(\d{1,3})\s*分(?:钟)?)?\s*(?:(\d{1,3}(?:\.\d+)?)\s*秒)?$/.exec(s);
  if (!m || (m[1] == null && m[2] == null && m[3] == null)) return null;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}
export function parseJump(query) {
  const q = (query || '').trim();
  if (!q) return null;
  const parts = q.split(RANGE);
  if (parts.length > 2) return null;
  if (parts.length === 1) {
    const no = parseNo(q);
    if (no != null) return { kind: 'no', from: no, to: no, loose: /^\d+$/.test(q) };
    const t = parseTime(q);
    return t == null ? null : { kind: 'time', from: t, to: t, loose: DOT_TIME.test(q) };
  }
  const [a, b] = parts;
  const na = parseNo(a),
    nb = parseNo(b);
  if (na != null && nb != null) return { kind: 'no', from: Math.min(na, nb), to: Math.max(na, nb), range: true };
  const ta = parseTime(a),
    tb = parseTime(b);
  if (ta != null && tb != null) return { kind: 'time', from: Math.min(ta, tb), to: Math.max(ta, tb), range: true };
  return null;
}

/* lines：按稿件顺序的全部句子（第几句按位置算）；tl：buildTimeline 的结果。返回直达的句子和给搜索条看的说明。 */
export function jumpLineIds(jump, lines, tl, fmt) {
  if (!jump) return null;
  if (jump.kind === 'no') {
    const ids = lines.slice(Math.max(0, jump.from - 1), jump.to).map(r => r.id);
    const name = jump.range ? `第 ${jump.from}–${jump.to} 句` : `第 ${jump.from} 句`;
    return { ids, label: ids.length ? `→ ${name}` : `没有${name}` };
  }
  const total = tl.total;
  if (!lines.length || jump.from > total) return { ids: [], label: `超出全片时长 ${fmt(total)}` };
  if (!jump.range) {
    const order = lines.map(r => r.id);
    const id = lineAt(tl, order, jump.from);
    return {
      ids: id == null ? [] : [id],
      label: id == null ? '' : `${fmt(jump.from)} → 第 ${order.indexOf(id) + 1} 句`,
    };
  }
  const ids = lines
    .filter(r => {
      const tm = tl.times.get(r.id);
      return tm && tm.end > jump.from && tm.start < jump.to;
    })
    .map(r => r.id);
  return { ids, label: `${fmt(jump.from)}–${fmt(jump.to)} · ${ids.length} 句` };
}
