/* 连接自测窗口，读取 __SELFTEST_RESULT__ 并输出 */
import puppeteer from 'puppeteer-core';

const b = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
const pages = await b.pages();
const page = pages.find(p => p.url().includes('renderer/index.html'));
if (!page) {
  console.error('NO_PAGE');
  process.exit(1);
}

// 等 selftest 跑完（main.js 里 boot 是 async，selftest 在其后）
let result = null;
for (let i = 0; i < 40; i++) {
  result = await page.evaluate(() => window.__SELFTEST_RESULT__ || null);
  if (result) break;
  await new Promise(r => setTimeout(r, 500));
}
if (!result) {
  console.error('SELFTEST_TIMEOUT');
  process.exit(1);
}

const line = (ok, name, detail) => `${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`;
console.log(`\n自测结果：${result.total - result.failed}/${result.total} 通过\n`);
for (const c of result.cases) console.log(line(c.ok, c.name, c.ok ? '' : c.detail));
process.exitCode = result.failed ? 1 : 0;
b.disconnect();
