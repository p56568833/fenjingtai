/* 使用记录的基础工具：镜头与素材模型共用，不依赖任一业务模型。 */
export const usageList = row => (Array.isArray(row?.assetUsages) ? row.assetUsages : []);
export function cleanRework(value) {
  if (!value || typeof value !== 'object' || typeof value.note !== 'string') return null;
  return {
    note: value.note,
    at: Number.isFinite(+value.at) ? +value.at : 0,
    ...(typeof value.assetId === 'string' ? { assetId: value.assetId } : {}),
  };
}
export const cloneUsage = u => ({
  ...u,
  ...(u.clip ? { clip: { ...u.clip } } : {}),
  ...(u.at ? { at: { ...u.at } } : {}),
  ...(u.rework ? { rework: { ...u.rework } } : {}),
});
export const cloneUsages = usages => usages.map(cloneUsage);
