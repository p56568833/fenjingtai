#!/usr/bin/env node
/* 一键打发布包：@electron/packager 出 Apple Silicon(arm64) + Intel(x64) 两个 分镜台.app，
   ad-hoc 签名（macOS 要求至少 ad-hoc 才能启动），每个架构产出一个 .dmg（带「拖到 Applications」
   快捷方式）和一个 .zip（给脚本/curl 直接下载），统一落在 dist/release/，文件名用 ASCII 方便直链。
   用法：npm run package */
import { packager } from '@electron/packager';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';

const RELEASE_DIR = path.join(ROOT, 'dist', 'release');
mkdirSync(RELEASE_DIR, { recursive: true });
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/* 打一个架构：.app → 改图标/Bundle ID → ad-hoc 签名 → zip + dmg */
async function buildOne(arch){
  const out = await packager({
    dir: ROOT,
    name: '分镜台',
    platform: 'darwin',
    arch,
    out: path.join(ROOT, 'dist'),
    overwrite: true,
    ignore: [/^\/dist/, /^\/scripts/, /^\/assets/, /^\/\.git/, /^\/\.DS_Store/],
  });

  // v20 返回输出目录；真实 bundle 在 <name>.app 子目录
  let APP = out[0];
  if (!APP.endsWith('.app')) APP = path.join(APP, '分镜台.app');
  if (!existsSync(APP)) throw new Error('打包产物缺失: ' + APP);

  copyFileSync(path.join(ROOT, 'assets/icon.icns'), path.join(APP, 'Contents/Resources/electron.icns'));
  const plist = path.join(APP, 'Contents/Info.plist');
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.andychen.fenjingtai', plist]);
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', '分镜台', plist]);
  // 图标和 Info.plist 都动过了，原有签名已失效；重新 ad-hoc 签一遍，arm64 没签名根本起不来
  sh('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', APP]);
  utimesSync(APP, new Date(), new Date());   // 摸一下 mtime，让 Finder 刷新图标缓存

  // 文件名不带版本号：GitHub 的 releases/latest/download/<文件名> 直链才能跨版本长期有效
  const stem = `FenJingTai-mac-${arch}`;
  const zipPath = path.join(RELEASE_DIR, `${stem}.zip`);
  sh('/usr/bin/ditto', ['-c', '-k', '--keepParent', APP, zipPath]);

  // dmg 内容：app + Applications 软链，用户打开后拖进去即装
  const stage = path.join(ROOT, 'dist', `dmg-stage-${arch}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  execFileSync('/usr/bin/ditto', [APP, path.join(stage, '分镜台.app')]);
  symlinkSync('/Applications', path.join(stage, 'Applications'));
  const dmgPath = path.join(RELEASE_DIR, `${stem}.dmg`);
  sh('/usr/bin/hdiutil', ['create', '-volname', '分镜台', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmgPath]);
  rmSync(stage, { recursive: true, force: true });

  const size = n => (statSync(n).size / 1048576).toFixed(1) + ' MB';
  console.log(`[${arch}] 完成：\n  ${zipPath}（${size(zipPath)}）\n  ${dmgPath}（${size(dmgPath)}）`);
}

for (const arch of ['arm64', 'x64']) await buildOne(arch);
console.log(`\n全部完成，发布物在 dist/release/（arm64 = M 系列芯片，x64 = Intel 芯片）`);
