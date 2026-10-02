import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://localhost:9223', defaultViewport: null });
const page = (await b.pages()).find(p => p.url().includes('index.html'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
page.on('pageerror', e =>
  console.log('[pageerror]', e.message, '|', (e.stack || '').split('\n').slice(1, 3).join(' ~ ')),
);
const dump = () =>
  page.evaluate(() => ({
    title: document.querySelector('#projTitle')?.textContent,
    rows: document.querySelectorAll('.row, .as').length,
    chips: document.querySelectorAll('.chip-filter').length,
    mask: document.querySelector('#envMask')?.style.display,
    native: !!window.native,
  }));
console.log('启动后:', JSON.stringify(await dump()));
await page.reload({ waitUntil: 'load' });
await sleep(3000);
console.log('刷新后:', JSON.stringify(await dump()));
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await sleep(1000);
console.log('刷新期间错误:', JSON.stringify(errs));
process.exit(0);
