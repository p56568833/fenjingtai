/* 比较一次提交前后的项目，描述实际改变的数据；保存和界面刷新使用同一份结果。 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clockRows = rows =>
  (rows || []).filter(r => r.kind === 'line').map(r => [r.id, r.text, r.time?.start, r.time?.end]);
export function projectDelta(before, after) {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    key => !same(before[key], after[key]),
  );
  const previous = new Map((before.rows || []).map(r => [r.id, r]));
  const changedRows = (after.rows || []).filter(r => !same(previous.get(r.id), r));
  const rowIds = changedRows.map(r => r.id);
  const rowFields = [
    ...new Set(
      changedRows.flatMap(row => {
        const old = previous.get(row.id) || {};
        return [...new Set([...Object.keys(old), ...Object.keys(row)])].filter(key => !same(old[key], row[key]));
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
    before.voice?.duration !== after.voice?.duration ||
    before.speechRate !== after.speechRate;
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
