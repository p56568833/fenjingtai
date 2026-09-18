import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

const b = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
const page = (await b.pages()).find(p => p.url().includes('renderer/index.html'));
const shot = async name => {
  const buf = await page.screenshot();
  writeFileSync(`/tmp/fjz-${name}.png`, buf);
  console.log('saved', name);
};

// 重新干净启动一遍（selftest 改过数据），保证截图是初始态
await page.reload({ waitUntil: 'load' });
await new Promise(r => setTimeout(r, 2500));
await shot('table');

// 勾选
await page.click('#viewToggle button[data-v="check"]');
await new Promise(r => setTimeout(r, 900));
await shot('check');
await page.click('#viewToggle button[data-v="table"]');
await new Promise(r => setTimeout(r, 400));

// 项目菜单
await page.click('#btnProjects');
await new Promise(r => setTimeout(r, 400));
await shot('projects');
await page.keyboard.press('Escape');
await new Promise(r => setTimeout(r, 200));

// 深色
await page.evaluate(() => document.querySelector('#btnTheme').click());
await new Promise(r => setTimeout(r, 500));
await shot('dark');

b.disconnect();
