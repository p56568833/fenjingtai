import puppeteer from 'puppeteer-core';

/* 交互回归：npm test 起自测实例后，node scripts/ux-check.mjs
   覆盖本轮修过的体验问题：视图高亮跟随 / 搜索不跳视口 / 弹窗键盘 / 删除后选中 / 撤销刷新 */
const b = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
const page = (await b.pages()).find(p => p.url().includes('renderer/index.html'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = [];
const t = (name, ok, detail='') => { out.push(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
const cmdT = async () => { await page.keyboard.down('Meta'); await page.keyboard.press('KeyT'); await page.keyboard.up('Meta'); };
const cmdZ = async () => { await page.keyboard.down('Meta'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Meta'); };
const projCount = () => page.evaluate(async () => Object.keys((await window.native.loadData()).projects).length);

// reload 会带上 ?selftest=1 再触发一轮自测、和本脚本并发改数据，必须去掉查询串
await page.goto(page.url().replace(/[?].*$/, ''));
await sleep(1800);

/* 1. 视图切换高亮跟随（⌘T 两态循环：表格 ↔ 勾选） */
await page.click('#viewToggle button[data-v="check"]'); await sleep(500);
t('切勾选后高亮在勾选', await page.evaluate(() => document.querySelector('#viewToggle button.active')?.dataset.v) === 'check');
await cmdT(); await sleep(400);
t('⌘T 勾选→表格，高亮跟随', await page.evaluate(() => document.querySelector('#viewToggle button.active')?.dataset.v) === 'table');
await cmdT(); await sleep(400);
t('⌘T 表格→勾选，高亮跟随', await page.evaluate(() => document.querySelector('#viewToggle button.active')?.dataset.v) === 'check');
await cmdT(); await sleep(400);
t('⌘T 循环回表格', await page.evaluate(() => document.querySelector('#viewToggle button.active')?.dataset.v) === 'table');

/* 1.5 勾选视图：选中句子即弹标注卡 → 点 A roll → ⌘Z 恢复；章节标题吸顶 */
await page.click('#viewToggle button[data-v="check"]'); await sleep(500);
t('勾选视图章节吸顶', await page.evaluate(() => getComputedStyle(document.querySelector('.ck-sec')).position) === 'sticky');
const ckId = await page.evaluate(() => {
  const target = [...document.querySelectorAll('.as')].find(el => el.className.includes('st-fx'));
  if (!target) return null;
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return target.dataset.id;
});
await sleep(200);
const cardShown = await page.evaluate(() => !!document.querySelector('.popover.hovercard [data-ck-t="a"]'));
const marked = await page.evaluate(() => {
  const item = document.querySelector('.popover.hovercard [data-ck-t="a"]');
  if (!item) return false;
  item.click();
  return true;
});
await sleep(300);
t('选中弹卡并点 A roll 标注', cardShown && marked && await page.evaluate(id => {
  const el = document.querySelector(`.as[data-id="${id}"]`);
  return !!el && el.classList.contains('st-a');
}, ckId), `id=${ckId}`);
await cmdZ(); await sleep(400);
t('勾选 ⌘Z 撤销恢复', await page.evaluate(id => {
  const el = document.querySelector(`.as[data-id="${id}"]`);
  return !!el && el.className.includes('st-fx');
}, ckId));
await page.click('#viewToggle button[data-v="table"]'); await sleep(400);

/* 2. 搜索打字时视口稳定，命中高亮，关闭后输入框清空 */
await page.evaluate(() => { document.querySelector('#tableWrap').scrollTop = 1200; });
await sleep(200);
const st0 = await page.evaluate(() => document.querySelector('#tableWrap').scrollTop);
await page.click('#btnSearch');
await page.type('#searchInput', '任天堂', { delay: 40 }); await sleep(400);
const st1 = await page.evaluate(() => document.querySelector('#tableWrap').scrollTop);
t('搜索打字时视口稳定', Math.abs(st1 - st0) < 60, `before=${st0} after=${st1}`);
t('表格内命中高亮', await page.evaluate(() => document.querySelectorAll('mark').length) > 0);
await page.keyboard.press('Escape'); await sleep(300);
t('关闭搜索后输入框清空', await page.evaluate(() => document.querySelector('#searchInput').value) === '');

/* 3. 勾选视图搜索：命中句加高亮且回车可跳到视口内 */
await page.evaluate(() => document.querySelector('#viewToggle button[data-v="check"]').click()); await sleep(500);
await page.click('#btnSearch');
await page.type('#searchInput', '掌机', { delay: 30 }); await sleep(400);
await page.keyboard.press('Enter'); await sleep(500);
const ovHit = await page.evaluate(() => {
  const hit = [...document.querySelectorAll('.as')].find(el => el.querySelector('mark'));
  if (!hit) return 'no-marked-as';
  const r = hit.getBoundingClientRect();
  return r.top > 0 && r.bottom < innerHeight ? 'in-view' : `out(top=${Math.round(r.top)})`;
});
t('勾选视图下回车跳到命中句', ovHit === 'in-view', ovHit);
await page.keyboard.press('Escape'); await sleep(300);
await page.evaluate(() => document.querySelector('#viewToggle button[data-v="table"]').click()); await sleep(400);

/* 4. 删除一句后选中句留在原地；⌘Z 后界面恢复 */
const delInfo = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.row')];
  const target = rows[5];
  target.querySelector('.row-del').click();
  return { idx: target.querySelector('.idx').textContent };
});
await sleep(400);
const selAfter = await page.evaluate(() => document.querySelector('.row.selected .idx')?.textContent);
t('删除后选中句不跳第一句', selAfter !== '1', `删第 ${delInfo.idx} 句，现选中第 ${selAfter} 句`);
await cmdZ(); await sleep(400);
t('⌘Z 撤销后界面恢复', await page.evaluate(() => document.querySelectorAll('.row').length) > 5);

/* 5. 顶栏按钮点击后失焦：Enter 不会再次触发 */
await page.click('#btnTheme'); await sleep(600);
const dark0 = await page.evaluate(() => document.body.classList.contains('dark'));
await page.keyboard.press('Enter'); await sleep(300);
const dark1 = await page.evaluate(() => document.body.classList.contains('dark'));
t('顶栏按钮点击后 Enter 不再触发', dark0 && dark1);
await page.click('#btnTheme'); await sleep(500);

/* 6. 确认弹窗：Esc 取消 / Enter 确认 */
const n0 = await projCount();
await page.click('#btnProjects'); await sleep(300);
await page.evaluate(() => document.querySelector('.pop-item[data-projact="new"]')?.click()); await sleep(500);
await page.click('#btnProjects'); await sleep(300);
await page.evaluate(() => document.querySelector('.proj-del')?.click()); await sleep(300);
const modalShown = await page.evaluate(() => document.querySelector('#modalMask').classList.contains('show'));
await page.keyboard.press('Escape'); await sleep(200);
t('弹窗 Esc 取消，项目还在', modalShown && (await projCount()) === n0 + 1);
await page.click('#btnProjects'); await sleep(300);
await page.evaluate(() => document.querySelector('.proj-del')?.click()); await sleep(300);
await page.keyboard.press('Enter'); await sleep(500);
t('弹窗 Enter 确认，项目被删', (await projCount()) === n0);

console.log(out.join('\n'));
console.log('UXCHECK_DONE');
b.disconnect();
