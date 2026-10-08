/* 一条命令跑完自测：造隔离测试素材 → 起隐藏的 Electron → 轮询 9222 就绪 → 读结果 → 杀干净进程。
   用法：npm test。窗口不弹到用户面前、进程自动清理、失败退出码非 0（以前要手动起实例 + read-selftest.mjs 两步）。 */
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

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
  await b.disconnect();
} catch (e) {
  console.error('SELFTEST_FAIL:', e.message);
  process.exitCode = 1;
} finally {
  killAll();
  rmSync(fixDir, { recursive: true, force: true });
}
