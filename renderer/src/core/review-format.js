/* 审核页的文字格式化：日期、批次说明、秒数。纯函数，只吃传进来的值，不读页面和共享状态。 */

export const fmtDay = t => {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const batchDetail = b =>
  [b.detail, b.scope.missing && b.scope.count ? '部分句子已移除' : ''].filter(Boolean).join(' · ');

/* 秒数显示：保留一位小数，整数不带 .0 */
export const secText = x => String(Math.round(Math.max(0, x) * 10) / 10);
