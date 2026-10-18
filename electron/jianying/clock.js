/* 时间单位约定：调用方（IPC、导出任务、补登记）一律传毫秒（Date.now 的默认单位），
   剪映草稿索引里的 tm_draft_* 是整数微秒。毫秒→微秒只允许在 toUs 里转一次：
   二次乘 1000 会把「现在」写成 1970 年或几万年后的未来，草稿就会排到列表最末。
   本模块不依赖 Electron，纯函数，测试可直接注入时钟。 */
'use strict';

/* 读取毫秒时钟：函数就调用、数字直接用；拿不到有限数值时回退当前时间（不让坏值写进索引） */
function readMs(clock) {
  let value = typeof clock === 'function' ? clock() : clock;
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

/* 唯一的毫秒→微秒转换点：剪映 tm_draft_create / tm_draft_modified 都是整数微秒 */
const toUs = ms => Math.round(ms * 1000);

/* 备份文件名的本地日期：YYYYMMDD-HHMMSS（毫秒精度进不了文件名，只取到秒） */
function stampDate(ms) {
  const date = new Date(readMs(ms));
  const pad = n => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

module.exports = { readMs, toUs, stampDate };
