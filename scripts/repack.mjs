/* 秒级重打包：只重打 app.asar（electron/ + renderer/ + package.json），Electron 运行时原样不动。
   日常迭代用 npm run repack（1-2 秒）；首次打包、升级依赖、换图标才需要 npm run package。 */
import { createPackageWithOptions } from '@electron/asar';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'dist', '分镜台-darwin-arm64', '分镜台.app');
const ASAR = path.join(APP, 'Contents', 'Resources', 'app.asar');
if(!existsSync(ASAR)){
  console.error('还没打过完整包（找不到 ' + path.relative(ROOT, ASAR) + '），先跑 npm run package');
  process.exit(1);
}

// 只装运行时真正加载的东西：主进程 electron/、渲染层 renderer/、入口声明 package.json。
// node_modules 里全是开发依赖（electron/puppeteer 打包工具链），运行时一个都不 import，不进 asar
const staging = path.join(ROOT, 'dist', '.asar-staging');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
for(const item of ['electron', 'renderer', 'package.json'])
  cpSync(path.join(ROOT, item), path.join(staging, item), { recursive: true });

const tmp = ASAR + '.new';
await createPackageWithOptions(staging, tmp, { dot: true });
renameSync(tmp, ASAR);
rmSync(staging, { recursive: true, force: true });
console.log('完成：app.asar 已更新（运行时未动）—', ASAR);
