/* 一次扫描建立审核查询索引。画面、章节和候选关系由同一份结果提供。 */
export function buildReviewIndex(rows, candidates) {
  const byRow = new Map();
  const groups = new Map();
  const sections = new Map();
  const order = new Map();
  let section = '';
  rows.forEach((row, i) => {
    order.set(row.id, i);
    if (row.kind === 'section') section = row.text;
    sections.set(row.id, section);
    if (row.kind !== 'line') return;
    const key = row.groupId ? `group:${row.groupId}` : `row:${row.id}`;
    if (!groups.has(key)) groups.set(key, { lead: row, members: [], cands: [] });
    const group = groups.get(key);
    group.members.push(row);
    byRow.set(row.id, group);
  });
  for (const candidate of candidates) byRow.get(candidate.rowId)?.cands.push(candidate);
  return { byRow, groups, sections, order };
}
