/* 一条命令跑完自测：造隔离测试素材 → 起隐藏的 Electron → 轮询 9222 就绪 → 读结果 → 杀干净进程。
   用法：npm test。窗口不弹到用户面前、进程自动清理、失败退出码非 0（以前要手动起实例 + read-selftest.mjs 两步）。 */
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { testLineSelectionPointer } from './line-selection-pointer.mjs';
import { testShotEditPointer } from './shot-edit-pointer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tryPort = () =>
  new Promise(res => {
    const s = net.connect(9222, '127.0.0.1');
    s.on('connect', () => {
      s.destroy();
      res(true);
    });
    s.on('error', () => res(false));
  });

/* 测试素材：一次性临时目录（长文件名 / 坏视频 / 真视频），跑完即焚，绝不碰用户真实素材 */
const fixDir = mkdtempSync(path.join(os.tmpdir(), '分镜台fixtures-'));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
writeFileSync(path.join(fixDir, '样图.png'), PNG);
for (const name of ['角色-主.png', '角色-叠.png']) writeFileSync(path.join(fixDir, name), PNG);
writeFileSync(
  path.join(
    fixDir,
    'a-very-long-file-name-that-should-not-break-the-layout-图片素材名字特别长用来验证布局不被撑坏.png',
  ),
  PNG,
);
writeFileSync(path.join(fixDir, '坏视频.mp4'), Buffer.from('这不是一个能播放的视频文件，用于验证解码失败提示。'));
for (const ffmpeg of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
  try {
    execFileSync(
      ffmpeg,
      ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2', '-pix_fmt', 'yuv420p', path.join(fixDir, '样片.mp4')],
      { stdio: 'ignore' },
    );
    // 口播音频：8 秒正弦波（测逐句播放、按音频长度推算时间）
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', path.join(fixDir, '口播.wav')], {
      stdio: 'ignore',
    });
    break;
  } catch {}
}

/* 新版 electron 包不再在 npm install 时下载程序本体，而是第一次运行时才下载；
   先同步把它下好，免得下载耗时被当成「Electron 没起来」 */
if (existsSync(path.join(fixDir, '样片.mp4')))
  copyFileSync(path.join(fixDir, '样片.mp4'), path.join(fixDir, '角色-备.mp4'));
if (!existsSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'))) {
  console.log('首次运行：下载 Electron 程序本体…');
  process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron', 'install.js')], { stdio: 'inherit' });
}

/* detached 建独立进程组，收尾时整组杀掉——.bin/electron 只是包装脚本，直接 kill 会留下孤儿 Electron */
const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'electron'), ['.', '--selftest'], {
  cwd: ROOT,
  stdio: 'ignore',
  detached: true,
  env: { ...process.env, FJT_FIXTURE_DIR: fixDir },
});
const killAll = () => {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
};

let portUp = false;
for (let i = 0; i < 80 && child.exitCode === null; i++) {
  portUp = await tryPort();
  if (portUp) break;
  await sleep(150);
}
if (!portUp) {
  console.error('测试启动失败：9222 端口不通（Electron 没起来）');
  killAll();
  process.exit(1);
}

try {
  const b = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  const page = (await b.pages()).find(p => p.url().includes('renderer/index.html'));
  if (!page) throw new Error('没找到自测页面');
  let result = null;
  for (let i = 0; i < 360 && !result; i++) {
    result = await page.evaluate(() => window.__SELFTEST_RESULT__ || null);
    if (!result) await sleep(250);
  }
  if (!result) throw new Error('自测 90 秒内没跑完');
  const line = (ok, name, detail) => `${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`;
  console.log(`\n自测结果：${result.total - result.failed}/${result.total} 通过\n`);
  for (const c of result.cases) console.log(line(c.ok, c.name, c.ok ? '' : c.detail));
  process.exitCode = result.failed ? 1 : 0;
  if (!result.failed) {
    // 真鼠标验证长录音里的窄灰色缺口，合成 input 事件测不到原生滑块头造成的偏移。
    const fixture = await page.evaluate(async () => {
      const { state, update } = await import('./src/app/state.js');
      const storage = await import('./src/app/storage.js');
      const { parseAny } = await import('./src/core/parse.js');
      const { setView } = await import('./src/ui/render.js');
      const original = state.projectId;
      storage.createProject('时间条鼠标定位回归', parseAny('开头。第一处缺口。中段。第二处缺口。结尾。'));
      const lines = state.rows.filter(r => r.kind === 'line');
      state.assets = { p: { id: 'p', path: 'https://example.com/pointer.png', kind: 'image' } };
      const starts = [0, 360, 366, 3240, 3246];
      lines.forEach((r, i) => {
        r.type = 'real';
        r.time = { start: starts[i], end: starts[i + 1] ?? 3600, st: 'ok' };
        r.assetUsages = i % 2 ? [] : [{ assetId: 'p', role: 'main' }];
      });
      state.voice = { path: '/tmp/pointer-recording.wav', name: '录音.wav', duration: 3600 };
      state.sel = lines[0].id;
      setView('table');
      update('rows');
      return { original, ids: lines.map(r => r.id) };
    });
    try {
      const bar = await page.$eval('#segbar', el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, width: r.width, y: r.top + r.height / 2 };
      });
      const point = seconds => bar.left + (seconds / 3600) * bar.width;
      const checkSelection = async (name, id) => {
        const selected = await page.evaluate(async () => (await import('./src/app/state.js')).state.sel);
        const ok = selected === id;
        console.log(line(ok, name, ok ? '' : `选中 ${selected}，应为 ${id}`));
        if (!ok) process.exitCode = 1;
      };
      await page.mouse.click(point(363), bar.y);
      await checkSelection('真实鼠标准确点中长录音左侧六秒灰色缺口', fixture.ids[1]);
      await page.mouse.click(point(3243), bar.y);
      await checkSelection('真实鼠标准确点中长录音右侧六秒灰色缺口', fixture.ids[3]);
      await page.mouse.move(point(363), bar.y);
      await page.mouse.down();
      await page.mouse.move(point(3243), bar.y, { steps: 5 });
      await checkSelection('时间条按住拖动仍按实际落点选句', fixture.ids[3]);
      await page.mouse.move(bar.left + bar.width + 10, bar.y);
      await checkSelection('时间条拖出右边界选择最后一句', fixture.ids[4]);
      await page.mouse.up();
      await page.mouse.move(point(363), bar.y);
      await checkSelection('松开后移动鼠标不再改变选中句子', fixture.ids[4]);
      await page.keyboard.press('Home');
      await checkSelection('鼠标操作后仍可用键盘回到首句', fixture.ids[0]);
    } finally {
      await page.evaluate(async original => {
        const storage = await import('./src/app/storage.js');
        storage.switchProject(original);
        (await import('./src/app/state.js')).update('rows');
      }, fixture.original);
    }
  }
  if (!result.failed) {
    const passed = await testLineSelectionPointer(page, (ok, name, detail) => console.log(line(ok, name, detail)));
    if (!passed) process.exitCode = 1;
  }
  // 镜头轨使用真实鼠标：命中把手、指针捕获与松手提交。
  if (!result.failed && process.exitCode !== 1) {
    const passed = await testShotEditPointer(page, (ok, name, detail) => console.log(line(ok, name, detail)));
    if (!passed) process.exitCode = 1;
  }
  await b.disconnect();
} catch (e) {
  console.error('SELFTEST_FAIL:', e.message);
  process.exitCode = 1;
} finally {
  killAll();
  rmSync(fixDir, { recursive: true, force: true });
}
