/* Compile the native macOS 26+ catalog without changing the global Xcode selection.
   Run after scripts/build-icons.mjs when replacing the approved raster master. */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('原生图标编译需要 macOS 和 Xcode 26 或更新版本');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const developer = process.env.DEVELOPER_DIR || '/Applications/Xcode.app/Contents/Developer';
const actool = path.join(developer, 'usr/bin/actool');
if (!existsSync(actool)) throw new Error('未找到 actool，请安装完整 Xcode 或通过 DEVELOPER_DIR 指定其开发工具目录');
const source = path.join(root, 'assets/AppIcon.icon');
copyFileSync(path.join(root, 'assets/icon_1024.png'), path.join(source, 'Assets/ApprovedArtwork.png'));
const work = mkdtempSync(path.join(os.tmpdir(), 'fjt-icon-'));
try {
  execFileSync(
    actool,
    [
      source,
      '--compile',
      work,
      '--platform',
      'macosx',
      '--minimum-deployment-target',
      '13.0',
      '--app-icon',
      'AppIcon',
      '--include-all-app-icons',
      '--output-partial-info-plist',
      path.join(work, 'partial.plist'),
    ],
    {
      env: { ...process.env, DEVELOPER_DIR: developer },
      stdio: 'inherit',
    },
  );
  copyFileSync(path.join(work, 'Assets.car'), path.join(root, 'assets/Assets.car'));
  console.log('已生成 macOS 26+ 原生图标 Assets.car（AppIcon）');
} finally {
  rmSync(work, { recursive: true, force: true });
}
