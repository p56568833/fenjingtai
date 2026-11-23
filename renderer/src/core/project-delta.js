/* 比较一次提交前后的项目，描述实际改变的数据；保存和界面刷新使用同一份结果。 */
const same = (a, b) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
const stripNo = row => {
  if (!row || typeof row !== 'object' || !Object.hasOwn(row, 'no')) return row;
  const copy = { ...row };
  delete copy.no;
  return copy;
};
const clockRows = rows =>
  (rows || []).filter(r => r.kind === 'line').map(r => [r.id, r.text, r.time?.start, r.time?.end, r.time?.st]);
export function projectDelta(before, after) {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key =>
    key === 'rows'
      ? !same((before.rows || []).map(stripNo), (after.rows || []).map(stripNo))
      : !same(before[key], after[key]),
  );
  const previous = new Map((before.rows || []).map(r => [r.id, r]));
  const changedRows = (after.rows || []).filter(r => !same(stripNo(previous.get(r.id)), stripNo(r)));
  const rowIds = changedRows.map(r => r.id);
  const rowFields = [
    ...new Set(
      changedRows.flatMap(row => {
        const old = previous.get(row.id) || {};
        return [...new Set([...Object.keys(old), ...Object.keys(row)])].filter(
          key => key !== 'no' && !same(old[key], row[key]),
        );
      }),
    ),
  ];
  const alive = new Set((after.rows || []).map(r => r.id));
  rowIds.push(...(before.rows || []).filter(r => !alive.has(r.id)).map(r => r.id));
  const structural = !same(
    (before.rows || []).map(r => [r.id, r.kind, r.groupId]),
    (after.rows || []).map(r => [r.id, r.kind, r.groupId]),
  );
  const timing =
    !same(clockRows(before.rows), clockRows(after.rows)) ||
    !Object.is(before.voice?.duration, after.voice?.duration) ||
    !Object.is(before.speechRate, after.speechRate);
  const usages = rows => (rows || []).map(r => [r.id, r.assetUsages]);
  const assetIds = new Set(
    [...new Set([...Object.keys(before.assets || {}), ...Object.keys(after.assets || {})])].filter(
      id => !same(before.assets?.[id], after.assets?.[id]),
    ),
  );
  const assetRowIds = [
    ...new Set([
      ...rowIds,
      ...(after.rows || []).filter(row => row.assetUsages?.some(u => assetIds.has(u.assetId))).map(row => row.id),
    ]),
  ];
  return {
    fields,
    rowIds,
    rowFields,
    assetRowIds,
    structural,
    timing,
    assets: fields.includes('assets') || structural || !same(usages(before.rows), usages(after.rows)),
    candidates: fields.includes('candidates'),
  };
}
