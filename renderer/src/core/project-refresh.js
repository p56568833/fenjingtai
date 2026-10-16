/* 从已提交的数据变化决定刷新范围；不依赖界面，也不依赖操作名称或事件顺序。 */
export function projectRefresh(change) {
  const fields = change.fields || [];
  const rows = change.rowFields;
  const has = (...names) => names.some(name => fields.includes(name));
  const all = change.full || change.rowIds === null || change.structural;
  const rowChange = fields.includes('rows') || !!rows?.length;
  const marks = !!rows?.includes('type');
  const notes = !!rows?.includes('note');
  // 未识别的句子字段走完整的块更新，避免新字段被静默漏掉。
  const table =
    all ||
    change.timing ||
    has('types', 'voice', 'timing', 'speechRate') ||
    (rowChange && (!rows || rows.some(key => !['type', 'note', 'assets', 'assetUsages', 'rework'].includes(key))));
  return {
    table: !!table,
    marks,
    notes,
    workspace: !!(table || rowChange || change.assets || change.source === 'history'),
    stats: !!(table || marks || change.assets),
    review: !!(
      all ||
      rowChange ||
      change.timing ||
      change.assets ||
      change.candidates ||
      has('types', 'voice', 'timing', 'speechRate', 'mediaDir', 'reworkRequests')
    ),
    focus: !!(all || rowChange || change.timing || has('types', 'voice', 'timing', 'speechRate')),
  };
}
