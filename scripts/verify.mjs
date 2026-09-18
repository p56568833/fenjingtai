import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

const b = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
const page = (await b.pages()).find(p => p.url().includes('renderer/index.html'));
const shot = async name => { writeFileSync(`/tmp/v-${name}.png`, await page.screenshot()); console.log('saved', name); };

// 1. 表头对齐（浅色表格）
await new Promise(r => setTimeout(r, 1500));
await shot('align-light');

// 2. 切深色：过渡中段截一张（应整体半途，而不是一半已变一半没变），再截落定
await page.evaluate(() => document.querySelector('#btnTheme').click());
await new Promise(r => setTimeout(r, 140));
await shot('theme-mid');
await new Promise(r => setTimeout(r, 600));
await shot('theme-dark');

// 3. 切回浅色落定
await page.evaluate(() => document.querySelector('#btnTheme').click());
await new Promise(r => setTimeout(r, 700));
await shot('theme-light-again');

// 4. 切类型后 300ms 内截一张：行内容应原地变化、无整页重建白闪
const id = await page.evaluate(() => {
  const r = document.querySelector('.row .row-add')?.closest('.row');
  return r ? r.dataset.id : null;
});
await page.evaluate(id => {
  const row = document.querySelector(`.row[data-id="${id}"]`);
  row.querySelector('.tchip').click();
}, id);
await new Promise(r => setTimeout(r, 300));
await page.evaluate(() => {
  const item = [...document.querySelectorAll('.pop-item[data-t]')].find(i => i.dataset.t === 'fx');
  item && item.click();
});
await new Promise(r => setTimeout(r, 120));
await shot('type-changed-inplace');

// 校验：切类型后该行 DOM 节点未替换（原地更新），chip 类名已变
const check = await page.evaluate(id => {
  const el = document.querySelector(`.row[data-id="${id}"]`);
  return { cls: el?.className, hasFx: !!el?.querySelector('.t-fx') };
}, id);
console.log(JSON.stringify(check));
b.disconnect();
