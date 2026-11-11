/* 批次身份独立于候选和句号；删掉一批后仍保留编号，后续导入不重用。 */
export function normalizeReviewBatches(value, candidates = []) {
  const entries = new Map();
  const used = new Set();
  if (value && typeof value === 'object' && !Array.isArray(value))
    for (const [id, item] of Object.entries(value)) {
      if (!Number.isSafeInteger(item?.number) || item.number < 1 || used.has(item.number)) continue;
      entries.set(id, {
        number: item.number,
        title: typeof item.title === 'string' ? item.title.trim().slice(0, 40) : '',
      });
      used.add(item.number);
    }
  const groups = new Map();
  for (const c of candidates) {
    const id = c.batchId || 'legacy';
    if (!groups.has(id)) groups.set(id, c);
  }
  let next = Math.max(0, ...used);
  for (const [id, c] of [...groups].sort(
    (a, b) => (a[1].batchAt || 0) - (b[1].batchAt || 0) || a[0].localeCompare(b[0]),
  )) {
    if (entries.has(id)) continue;
    const number = Number.isSafeInteger(c.batchNo) && c.batchNo > 0 && !used.has(c.batchNo) ? c.batchNo : ++next;
    next = Math.max(next, number);
    used.add(number);
    entries.set(id, { number, title: '' });
  }
  return Object.fromEntries(entries);
}
