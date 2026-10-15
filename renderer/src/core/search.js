/* 按稿件顺序搜索：正文定位到具体句子，共用画面描述只算一次。 */
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
