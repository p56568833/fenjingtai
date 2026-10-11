/* 拆分样式后与 Git 中原版逐项对照真实 Chromium 计算结果；原样式只在内存中读取。 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = execFileSync('git', ['show', 'HEAD:renderer/styles.css'], { cwd: root, encoding: 'utf8' });
const stem = mkdtempSync(path.join(os.tmpdir(), 'fjt-style-'));
const work = stem + '.noindex';
rmSync(stem, { recursive: true });
mkdirSync(work);
const harness = path.join(work, 'main.cjs');
writeFileSync(
  harness,
  `const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(work, 'data'))});
app.commandLine.appendSwitch('remote-debugging-port', '0');
BrowserWindow.prototype.show = function() {};
app.on('browser-window-created', (_, w) => w.webContents.setBackgroundThrottling(false));
require(${JSON.stringify(path.join(root, 'electron/main.js'))});`,
);
const child = spawn(path.join(root, 'node_modules/.bin/electron'), [harness], {
  detached: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
const stop = () => {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
};
const watchdog = setTimeout(stop, 45000);
let browser;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('样式测试启动超时')), 15000);
    let log = '';
    child.stderr.on('data', chunk => {
      log += chunk;
      const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`测试退出 ${code}`));
    });
  });
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  const page = (await browser.pages()).find(p => p.url().includes('index.html'));
  assert.ok(page);
  await page.waitForFunction(() => document.querySelectorAll('.row').length > 0);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluate(original => {
    const fixture = document.createElement('div');
    fixture.id = 'styleFixture';
    fixture.innerHTML = `<div class="shared-scene picked"><div class="shared-scene-header"><div class="shared-scene-title"><span>共用画面标题</span></div><span>其他说明</span></div><div class="shared-scene-lines"><div class="row selected"><div class="spine">1</div><div class="sentence">共用句子</div><div class="row-act"><button>操作</button></div></div></div></div>
      <div class="shared-passage"><div class="shared-passage-heading"><div class="shared-passage-title"><span>阅读标题</span></div></div></div>
      <button class="asset-open"><span class="asset-caption"><strong>素材标题</strong></span></button>
      <button class="review-item"><strong>检查标题</strong><span>检查内容</span></button>`;
    document.body.append(fixture);
    const row = document.querySelector('.row');
    row.classList.add('selected');
    const old = document.createElement('style');
    old.id = 'originalStyles';
    old.textContent = original;
    document.head.append(old);
    old.sheet.disabled = true;
    const freeze = document.createElement('style');
    freeze.textContent =
      '*,*::before,*::after{animation:none!important;transition:none!important;content-visibility:visible!important}';
    document.head.append(freeze);
  }, original);
  let checked = 0;
  for (const width of [1440, 1100, 850]) {
    await page.setViewport({ width, height: 1000 });
    for (const dark of [false, true]) {
      const diff = await page.evaluate(async dark => {
        document.body.classList.toggle('dark', dark);
        const link = document.querySelector('link[href="./styles.css"]');
        const old = document.querySelector('#originalStyles');
        const elements = [
          ...document.querySelectorAll('#tablePage *, #styleFixture *, .topbar *, .toolbar *, .outline *'),
        ];
        const props = [
          'display',
          'position',
          'color',
          'backgroundColor',
          'backgroundImage',
          'boxShadow',
          'borderRadius',
          'borderColor',
          'fontSize',
          'fontWeight',
          'lineHeight',
          'padding',
          'margin',
          'width',
          'height',
          'transform',
          'gridTemplateColumns',
          'gap',
          'opacity',
          'overflow',
          'overflowWrap',
        ];
        const read = () =>
          elements.map(el => {
            const cs = getComputedStyle(el);
            return Object.fromEntries(props.map(p => [p, cs[p]]));
          });
        link.sheet.disabled = true;
        old.sheet.disabled = false;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const before = read();
        old.sheet.disabled = true;
        link.sheet.disabled = false;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const after = read();
        const changes = [];
        elements.forEach((el, i) =>
          props.forEach(p => {
            if (before[i][p] !== after[i][p])
              changes.push({ element: el.id || el.className, property: p, before: before[i][p], after: after[i][p] });
          }),
        );
        return { count: elements.length * props.length, changes };
      }, dark);
      checked += diff.count;
      assert.deepEqual(diff.changes, [], `宽 ${width}，${dark ? '深' : '浅'}色主题存在样式差异`);
      console.log(`✓ 宽 ${width}，${dark ? '深' : '浅'}色主题：${diff.count} 项计算样式一致`);
    }
  }
  console.log(`样式对照通过：${checked} 项`);
} finally {
  clearTimeout(watchdog);
  await browser?.disconnect();
  stop();
  await new Promise(resolve => setTimeout(resolve, 150));
  rmSync(work, { recursive: true, force: true });
}
