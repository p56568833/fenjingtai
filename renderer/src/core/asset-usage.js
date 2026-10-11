/* 使用记录的基础工具：镜头与素材模型共用，不依赖任一业务模型。 */
export const usageList = row => (Array.isArray(row?.assetUsages) ? row.assetUsages : []);
export const cloneUsage = u => ({
  ...u,
  ...(u.clip ? { clip: { ...u.clip } } : {}),
  ...(u.at ? { at: { ...u.at } } : {}),
});
export const cloneUsages = usages => usages.map(cloneUsage);
