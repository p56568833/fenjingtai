/* v1.2 功能与布局回归（CDP 交互，npm test 起实例后运行）：
   拖拽高亮与空白防打开 / 窄窗口+右面板不溢出 / 长文件名 / 项目导出片段 */
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

const fixDir = process.env.FJT_FIXTURE_DIR || '';
const b = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
const page = (await b.pages()).find(p => p.url().includes('renderer/index.html'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = [];
const t = (name, ok, detail = '') => out.push(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
const shot = async name => {
  writeFileSync(`/tmp/fjt-check-${name}.png`, await page.screenshot());
};

// 去掉 ?selftest=1，避免又跑一轮自测和本脚本抢数据
await page.goto(page.url().replace(/[?].*$/, ''));
await sleep(1800);
// 前序脚本（ux-check 删项目）可能留下空项目：没句子就补一份示例稿再验
await page.evaluate(async () => {
  const { state } = await import('./src/app/state.js');
  if (state.rows.some(r => r.kind === 'line')) return;
  const { demoProject } = await import('./src/core/demo.js');
  const storage = await import('./src/app/storage.js');
  const d = demoProject();
  storage.createProject(d.title, d.rows);
});
await sleep(600);

/* 1. 表格入口打开右侧面板 */
await page.click('#viewToggle button[data-v="table"]');
await page.click('#btnDetail');
await sleep(300);
t('入口打开右侧面板', await page.evaluate(() => !document.querySelector('#inspector').hidden));

/* 2. 拖拽：高亮接收区 + 空白处拦截默认打开 */
await page.click('#viewToggle button[data-v="table"]');
await sleep(500);
const dragRes = await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([1])], '拖入.png', { type: 'image/png' }));
  const row = document.querySelector('.row');
  const ev = new DragEvent('dragover', {
    bubbles: true,
    cancelable: true,
    dataTransfer: dt,
    clientX: 240,
    clientY: 320,
  });
  row.dispatchEvent(ev);
  const highlighted = !!document.querySelector('.drop-target');
  document.querySelectorAll('.drop-target').forEach(z => z.classList.remove('drop-target'));
  const dropEv = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
  document.body.dispatchEvent(dropEv); // 空白处：必须拦下默认行为（浏览器不得直接打开文件）
  return { highlighted, prevented: dropEv.defaultPrevented };
});
t('拖到句子上高亮接收区域', dragRes.highlighted);
t('空白处拖放被拦截、不触发浏览器打开', dragRes.prevented);

/* 3. 窄窗口 + 右侧面板：不遮挡、不横向溢出 */
await page.setViewport({ width: 980, height: 620 });
await sleep(500);
const layout = await page.evaluate(() => ({
  bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  tableOverflow: (() => {
    const w = document.querySelector('#tableWrap');
    return w.scrollWidth - w.clientWidth;
  })(),
  inspectorVisible: !document.querySelector('#inspector').hidden,
  rowReadable: (() => {
    const s = document.querySelector('.sent');
    return s ? s.getBoundingClientRect().width > 80 : false;
  })(),
}));
t('窄窗口 + 右面板无页面级横向溢出', layout.bodyOverflow <= 1, `溢出 ${layout.bodyOverflow}px`);
t('窄窗口正文区无需横向滚动', layout.tableOverflow <= 1, `溢出 ${layout.tableOverflow}px`);
t('窄窗口正文仍可读', layout.rowReadable && layout.inspectorVisible);
await shot('narrow-inspector');

/* 4. 长文件名不破坏布局 */
if (fixDir) {
  await page.evaluate(async dir => {
    const { addRefsToShot } = await import('./src/app/asset-actions.js');
    const { state } = await import('./src/app/state.js');
    const r = state.rows.find(x => x.kind === 'line');
    addRefsToShot(r, [
      dir + '/a-very-long-file-name-that-should-not-break-the-layout-图片素材名字特别长用来验证布局不被撑坏.png',
      dir + '/样片.mp4',
    ]);
    document.querySelector('#btnDetail').click();
    document.querySelector('#btnDetail').click();
  }, fixDir);
  await sleep(600);
  const nameFit = await page.evaluate(() => {
    const strongs = [...document.querySelectorAll('.asset-caption strong')];
    return (
      strongs.length > 0 &&
      strongs.every(
        s =>
          s.getBoundingClientRect().width <=
          s.closest('.row-asset, .inspector-asset, .picker-item').getBoundingClientRect().width + 1,
      )
    );
  });
  t('长文件名不撑破素材卡布局', nameFit);
  await shot('long-name');
}

/* 5. 项目文件导出保留片段范围 */
const rt = await page.evaluate(async () => {
  const { buildProjectJson } = await import('./src/core/project-json.js');
  const rows = [{ id: 1, kind: 'line', text: '测试句。', assetUsages: [{ assetId: 'a1', clip: { in: 12, out: 18 } }] }];
  const assets = { a1: { id: 'a1', kind: 'video', path: '/tmp/x.mp4', name: 'x.mp4' } };
  return JSON.parse(buildProjectJson({ title: '回读', rows, assets })).rows[0].assetUsages[0].clip;
});
t('项目文件保留片段范围', rt?.in === 12 && rt?.out === 18, JSON.stringify(rt));

/* 7. 长稿：300+ 句渲染、吸顶与滚动正常 */
await page.setViewport({ width: 1440, height: 940 });
await page.click('#viewToggle button[data-v="table"]'); // 行计数只在表格视图有意义
await sleep(400);
await page.evaluate(async () => {
  const { parseAny } = await import('./src/core/parse.js');
  const storage = await import('./src/app/storage.js');
  const { update } = await import('./src/app/project-events.js');
  let txt = '';
  for (let s = 0; s < 20; s++) {
    txt += `## 第${s}章\n`;
    for (let i = 0; i < 15; i++) txt += `这是第${s}章第${i}句长稿测试内容，验证三百句以上不卡布局。`;
    txt += '\n';
  }
  storage.createProject('长稿布局测试', parseAny(txt));
  update('rows');
});
await sleep(800);
const longOk = await page.evaluate(() => {
  const rows = document.querySelectorAll('.row');
  const wrap = document.querySelector('#tableWrap');
  wrap.scrollTop = wrap.scrollHeight / 2;
  const thead = document.querySelector('#thead').getBoundingClientRect();
  return (
    rows.length === 300 &&
    thead.top >= 0 &&
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  );
});
t(
  '长稿（300 句）渲染与吸顶、无横向溢出',
  longOk,
  `rows=${await page.evaluate(() => document.querySelectorAll('.row').length)}`,
);
await page.evaluate(async () => {
  const storage = await import('./src/app/storage.js');
  const { state } = await import('./src/app/state.js');
  const mine = storage
    .allProjects()
    .filter(p => p.title === '长稿布局测试')
    .map(p => p.id);
  const keep = storage.allProjects().find(p => !mine.includes(p.id));
  if (keep) storage.switchProject(keep.id);
  for (const id of mine) storage.deleteProject(id);
  void state;
});

await page.setViewport({ width: 1440, height: 940 });
console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('✗')).length;
console.log(`\n功能与布局检查：${out.length - failed}/${out.length} 通过`);
process.exitCode = failed ? 1 : 0;
b.disconnect();
