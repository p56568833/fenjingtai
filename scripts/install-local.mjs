#!/usr/bin/env node
/* 本机更新安装：把当前源码装进 /Applications/分镜台.app（只在 macOS 上用）。用法：npm run install-local
   做法和 repack.mjs 一样，不重新下载 Electron：拿已安装应用里的运行时，只换 app.asar，再 ad-hoc 签名。
   按 AGENTS.md：构建放在带 .noindex 的临时目录（不被启动台 / Spotlight 收录），装好后清掉；
   只保留最新版本，不做软件备份。没有已安装的应用时，请先 npm run package 打一次完整包。 */
import { createPackageWithOptions } from '@electron/asar';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('只能在 macOS 上安装');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLED = '/Applications/分镜台.app';
if (!existsSync(INSTALLED)) throw new Error('没找到 /Applications/分镜台.app，请先 npm run package 打一次完整包再安装');
const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const work = path.join(os.tmpdir(), `fenjingtai-build-${Date.now()}.noindex`);
const stage = path.join(work, 'stage');
const app = path.join(work, '分镜台.app');
mkdirSync(stage, { recursive: true });
try {
  // 1. 运行时：复制一份已安装的应用（ditto 保留签名需要的扩展属性和符号链接）
  run('/usr/bin/ditto', [INSTALLED, app]);
  // 2. 应用代码：只要 electron / renderer / package.json，自测文件不进安装包
  for (const item of ['electron', 'renderer', 'package.json'])
    cpSync(path.join(ROOT, item), path.join(stage, item), {
      recursive: true,
      filter: src =>
        !/selftest\.js$/.test(src) && !/[\\/]renderer[\\/]src[\\/]test([\\/]|$)/.test(src) && !/\.DS_Store$/.test(src),
    });
  const asar = path.join(app, 'Contents', 'Resources', 'app.asar');
  rmSync(asar, { force: true });
  await createPackageWithOptions(stage, asar, { dot: true });
  // 3. 版本号 + 重新 ad-hoc 签名并校验
  const plist = path.join(app, 'Contents', 'Info.plist');
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion'])
    run('/usr/bin/plutil', ['-replace', key, '-string', version, plist]);
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  console.log(`已构建 ${version} 并校验签名`);
  // 4. 退出正在运行的分镜台（它会先把没存完的改动存盘），再替换
  const running = () => {
    try {
      run('/usr/bin/pgrep', ['-f', '/Applications/分镜台.app/Contents/MacOS/']);
      return true;
    } catch {
      return false;
    }
  };
  if (running()) {
    try {
      run('/usr/bin/osascript', ['-e', 'tell application "/Applications/分镜台.app" to quit']);
    } catch {}
    for (let i = 0; i < 60 && running(); i++) await sleep(250);
    if (running()) throw new Error('分镜台还开着、没能自动退出，请手动退出后再运行一次');
  }
  // 5. 先把新版完整拷进 /Applications 里的隐藏临时位置并校验，再两次改名换上去：
  //    中途任何一步失败，原来的应用都还在，不会出现「旧的删了、新的没装上」
  const incoming = '/Applications/.分镜台-安装中.app';
  const outgoing = '/Applications/.分镜台-替换下来.app';
  rmSync(incoming, { recursive: true, force: true });
  rmSync(outgoing, { recursive: true, force: true });
  run('/usr/bin/ditto', [app, incoming]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', incoming]);
  renameSync(INSTALLED, outgoing);
  try {
    renameSync(incoming, INSTALLED);
  } catch (e) {
    renameSync(outgoing, INSTALLED); // 换不上就把原来的放回去
    throw e;
  }
  rmSync(outgoing, { recursive: true, force: true }); // 只保留最新版本，不留旧版
  utimesSync(INSTALLED, new Date(), new Date()); // 让 Finder 刷新
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', INSTALLED]);
  console.log(`已安装到 ${INSTALLED}（${version}）`);
  run('/usr/bin/open', [INSTALLED]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
