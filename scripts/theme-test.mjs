/* 真实 Electron 渲染回归：高分屏与缩放下的水波圆心、连续点击、减少动态效果。
   使用临时数据目录与隐藏窗口，不触碰已安装应用或用户项目。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(os.tmpdir(), 'fjt-theme-')) + '.noindex';
// mkdtemp 的原目录只用于生成唯一名字，不留下空目录。
rmSync(work.replace(/\.noindex$/, ''), { recursive: true });
const { mkdirSync } = await import('node:fs');
mkdirSync(work);
const harness = path.join(work, 'main.cjs');
writeFileSync(
  harness,
  `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(work, 'data'))});
app.commandLine.appendSwitch('remote-debugging-port', '0');
BrowserWindow.prototype.show = function () {};
app.on('browser-window-created', (_, w) => {
  w.webContents.setBackgroundThrottling(false);
  w.webContents.on('did-finish-load', () => {
    w.webContents.setZoomFactor(Number(new URL(w.webContents.getURL()).searchParams.get('themeZoom') || 1));
  });
});
require(${JSON.stringify(path.join(root, 'electron/main.js'))});
`,
);
const child = spawn(path.join(root, 'node_modules/.bin/electron'), [harness], {
  detached: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let browser;
const watchdog = setTimeout(() => {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}, 30000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('测试窗口启动超时')), 15000);
    let output = '';
    child.stderr.on('data', chunk => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`测试窗口退出：${code}`));
    });
  });
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  const page = (await browser.pages()).find(page => page.url().includes('index.html'));
  assert.ok(page, '存在应用页面');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = page.url().replace(/\?.*$/, '');
  for (const zoom of [1, 1.5, 0.8]) {
    await page.goto(`${url}?themeZoom=${zoom}`);
    await page.waitForFunction(() => document.querySelectorAll('.row').length > 0);
    await pause(150);
    await page.evaluate(() => {
      const start = document.startViewTransition.bind(document);
      window.__themeTransitions = 0;
      document.startViewTransition = update => {
        window.__themeTransitions++;
        return (window.__themeVt = start(update));
      };
    });
    const info = await page.evaluate(async () => {
      const oldDark = document.body.classList.contains('dark');
      document.querySelector('#btnTheme').click();
      await window.__themeVt.ready;
      const a = document.documentElement
        .getAnimations({ subtree: true })
        .find(a => a.effect?.pseudoElement === '::view-transition-new(root)');
      if (!a) throw new Error('未生成水波动画');
      const frames = a.effect.getKeyframes();
      if (frames.some(frame => !/^circle\([\d.]+% at [\d.]+% [\d.]+%\)$/.test(frame.clipPath)))
        throw new Error('圆心和半径必须采用比例坐标');
      // 固定小圆，直接检查合成后的像素，而非只核对 CSS 字符串。
      a.pause();
      a.effect.setKeyframes(
        frames.map(frame => ({ clipPath: frame.clipPath.replace(/^circle\([\d.]+%/, 'circle(4%') })),
      );
      a.currentTime = 0;
      const b = document.querySelector('#btnTheme').getBoundingClientRect();
      return {
        oldDark,
        x: b.left + b.width / 2,
        y: b.top + b.height / 2,
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      };
    });
    await pause(80);
    const png = await page.screenshot({ encoding: 'base64' });
    const samples = await page.evaluate(
      async ({ png, info }) => {
        const blob = new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], { type: 'image/png' });
        const image = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const sample = (x, y) =>
          Array.from(
            context.getImageData(
              Math.round((x / info.width) * image.width),
              Math.round((y / info.height) * image.height),
              1,
              1,
            ).data,
          ).slice(0, 3);
        // 按钮旁空白背景应已变色；窗口中部仍应保留原色。
        const near = sample(info.x, info.y + 22);
        const middle = sample(info.width / 2, info.height - 40);
        image.close();
        return { near, middle };
      },
      { png, info },
    );
    const isDark = pixel => pixel.every(channel => channel < 90);
    assert.equal(isDark(samples.near), !info.oldDark, `zoom=${zoom}：圆心落在按钮处 ${samples.near}`);
    assert.equal(isDark(samples.middle), info.oldDark, `zoom=${zoom}：中间没有提前切换 ${samples.middle}`);
    await page.evaluate(async () => {
      window.__themeVt.skipTransition();
      await window.__themeVt.finished;
    });
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('theme-vt')), false);
    console.log(`✓ 水波圆心像素验证：缩放 ${zoom}，像素比 ${info.dpr}`);
  }
  for (const count of [2, 3, 10]) {
    await pause(220);
    const result = await page.evaluate(async count => {
      const before = document.body.classList.contains('dark');
      const starts = window.__themeTransitions;
      for (let i = 0; i < count; i++) document.querySelector('#btnTheme').click();
      await window.__themeVt.finished;
      await new Promise(resolve => requestAnimationFrame(resolve));
      return {
        expected: count % 2 ? !before : before,
        actual: document.body.classList.contains('dark'),
        pref: localStorage.getItem('fjz:theme'),
        captures: window.__themeTransitions - starts,
        classLeft: document.documentElement.classList.contains('theme-vt'),
      };
    }, count);
    assert.equal(result.actual, result.expected);
    assert.equal(result.pref, result.expected ? 'dark' : 'light');
    assert.equal(result.captures, 1, '连续点击只截取一次整窗');
    assert.equal(result.classLeft, false);
    console.log(`✓ 连续点击 ${count} 次：最终主题准确，仅一次整窗切换`);
  }
  await pause(220);
  // 真正点按钮：截图层不能拦住鼠标；反向沿同一圆边收回，不跳到整窗新主题。
  const beforeReverse = await page.evaluate(() => document.body.classList.contains('dark'));
  await page.click('#btnTheme');
  await page.evaluate(async () => {
    await window.__themeVt.ready;
    const a = document.documentElement
      .getAnimations({ subtree: true })
      .find(a => a.effect?.pseudoElement === '::view-transition-new(root)');
    a.pause();
    a.currentTime = 160;
    window.__reverseAnimation = a;
    window.__reverseStarts = window.__themeTransitions;
  });
  await page.click('#btnTheme');
  const reverse = await page.evaluate(() => ({
    rate: window.__reverseAnimation.playbackRate,
    time: window.__reverseAnimation.currentTime,
    captures: window.__themeTransitions - window.__reverseStarts,
  }));
  assert.equal(reverse.rate, -1, '鼠标再次点击可反向播放');
  assert.ok(reverse.time > 0 && reverse.time <= 160, '反向从当前圆边继续');
  assert.equal(reverse.captures, 0, '反向不重新截图');
  await page.evaluate(() => window.__themeVt.finished);
  assert.equal(await page.evaluate(() => document.body.classList.contains('dark')), beforeReverse);
  console.log('✓ 中途鼠标切回：同一圆边连续收回，最终主题准确');

  // 反播过程中再点一次，继续向外展开；同一动画和截图可往返。
  const reforward = await page.evaluate(async () => {
    const before = document.body.classList.contains('dark');
    const starts = window.__themeTransitions;
    document.querySelector('#btnTheme').click();
    await window.__themeVt.ready;
    const a = document.documentElement
      .getAnimations({ subtree: true })
      .find(a => a.effect?.pseudoElement === '::view-transition-new(root)');
    a.pause();
    a.currentTime = 220;
    document.querySelector('#btnTheme').click();
    a.pause();
    a.currentTime = 120;
    document.querySelector('#btnTheme').click();
    const time = a.currentTime;
    const rate = a.playbackRate;
    await window.__themeVt.finished;
    return {
      expected: !before,
      actual: document.body.classList.contains('dark'),
      captures: window.__themeTransitions - starts,
      time,
      rate,
    };
  });
  assert.equal(reforward.rate, 1);
  assert.equal(reforward.time, 120);
  assert.equal(reforward.captures, 1);
  assert.equal(reforward.actual, reforward.expected);
  console.log('✓ 展开 / 收回 / 再展开：圆边连续，无重复截图');

  const repeated = await page.evaluate(async () => {
    document.querySelector('#btnTheme').click();
    await window.__themeVt.finished;
    const starts = window.__themeTransitions;
    const before = document.body.classList.contains('dark');
    document.querySelector('#btnTheme').click();
    await window.__themeVt.finished;
    return {
      captures: window.__themeTransitions - starts,
      changed: document.body.classList.contains('dark') !== before,
    };
  });
  assert.equal(repeated.captures, 1);
  assert.equal(repeated.changed, true);
  console.log('✓ 动画结束后立即再切换：正常播放过渡，不突然跳色');
  const timing = await page.evaluate(async () => {
    const started = performance.now();
    document.querySelector('#btnTheme').click();
    await window.__themeVt.ready;
    const preparation = performance.now() - started;
    const frames = [];
    let watching = true;
    const sample = time => {
      frames.push(time);
      if (watching) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    await window.__themeVt.finished;
    watching = false;
    const gaps = frames.slice(1).map((time, i) => time - frames[i]);
    return {
      preparation: Math.round(preparation),
      frames: frames.length,
      maxGap: Math.round(Math.max(0, ...gaps)),
    };
  });
  console.log(`✓ 正常切换采样：准备 ${timing.preparation} ms，${timing.frames} 帧，最大帧间隔 ${timing.maxGap} ms`);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const reduced = await page.evaluate(async () => {
    const before = document.body.classList.contains('dark');
    const starts = window.__themeTransitions;
    document.querySelector('#btnTheme').click();
    const immediate = document.body.classList.contains('dark');
    await new Promise(resolve => requestAnimationFrame(resolve));
    return {
      before,
      immediate,
      captures: window.__themeTransitions - starts,
      classLeft: document.documentElement.classList.contains('theme-vt'),
    };
  });
  assert.notEqual(reduced.immediate, reduced.before);
  assert.equal(reduced.captures, 0);
  assert.equal(reduced.classLeft, false);
  console.log('✓ 减少动态效果：立即切换，无截图、无残留动画');
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement
          .getAnimations({ subtree: true })
          .filter(a => a.effect?.pseudoElement === '::view-transition-new(root)').length,
    ),
    0,
    '切换结束后释放所有主题动画',
  );
  console.log('✓ 反复切换后没有残留主题动画');
  assert.deepEqual(errors, [], '无页面错误或未处理的动画 Promise');
} finally {
  clearTimeout(watchdog);
  await browser?.disconnect();
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
  await pause(150);
  rmSync(work, { recursive: true, force: true });
}
