#!/usr/bin/env node
/* 一键打发布包：@electron/packager 出 Apple Silicon(arm64) + Intel(x64) 两个 分镜台.app，
   ad-hoc 签名（macOS 要求至少 ad-hoc 才能启动），每个架构产出一个 .dmg（带「拖到 Applications」
   快捷方式）和一个 .zip（给脚本/curl 和软件内更新下载），再生成一份 latest.json（软件内更新先读它，
   不占 GitHub API 匿名额度），统一落在临时 .noindex 目录，文件名用 ASCII 方便直链。
   用法：npm run package */
import { packager } from '@electron/packager';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { installAppIcon } from './app-icon.mjs';
import { shouldIgnore } from './package-filter.mjs';
import { extractNotes, notesHistory, writeManifest } from './release-manifest.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';

const BUILD_ROOT = path.join(os.tmpdir(), `fenjingtai-release-${randomUUID()}.noindex`);
const RELEASE_DIR = path.join(BUILD_ROOT, 'release');
mkdirSync(RELEASE_DIR, { recursive: true });
const sh = (cmd, args) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

/* 打一个架构：.app → 改图标/Bundle ID → ad-hoc 签名 → zip + dmg */
async function buildOne(arch) {
  const out = await packager({
    dir: ROOT,
    name: '分镜台',
    platform: 'darwin',
    arch,
    out: BUILD_ROOT,
    overwrite: true,
    asar: true, // 应用代码打成 app.asar：不散落成一堆可随手改的源文件
    // 白名单：只打包运行必需的三样（和 repack.mjs 一致）。项目根目录里的备份文件夹、旧版 HTML、
    // 源码包、自测脚本一律不进安装包——以前按黑名单排除，漏掉的「备份-*」会把整个旧 .app 打进去
    ignore: shouldIgnore,
  });

  // v20 返回输出目录；真实 bundle 在 <name>.app 子目录
  let APP = out[0];
  if (!APP.endsWith('.app')) APP = path.join(APP, '分镜台.app');
  if (!existsSync(APP)) throw new Error('打包产物缺失: ' + APP);

  installAppIcon(APP);
  const plist = path.join(APP, 'Contents/Info.plist');
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.andychen.fenjingtai', plist]);
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', '分镜台', plist]);
  // 应用分类：视频（访达「应用程序」按类别排列、启动台归类时用）
  execFileSync('/usr/bin/plutil', [
    '-replace',
    'LSApplicationCategoryType',
    '-string',
    'public.app-category.video',
    plist,
  ]);
  // 图标和 Info.plist 都动过了，原有签名已失效；重新 ad-hoc 签一遍，arm64 没签名根本起不来
  sh('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', APP]);
  utimesSync(APP, new Date(), new Date()); // 摸一下 mtime，让 Finder 刷新图标缓存

  // 文件名不带版本号：GitHub 的 releases/latest/download/<文件名> 直链才能跨版本长期有效
  const stem = `FenJingTai-mac-${arch}`;
  const zipPath = path.join(RELEASE_DIR, `${stem}.zip`);
  sh('/usr/bin/ditto', ['-c', '-k', '--keepParent', APP, zipPath]);

  // dmg 内容：app + Applications 软链，用户打开后拖进去即装
  const stage = path.join(BUILD_ROOT, `dmg-stage-${arch}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  execFileSync('/usr/bin/ditto', [APP, path.join(stage, '分镜台.app')]);
  symlinkSync('/Applications', path.join(stage, 'Applications'));
  const dmgPath = path.join(RELEASE_DIR, `${stem}.dmg`);
  sh('/usr/bin/hdiutil', ['create', '-volname', '分镜台', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmgPath]);
  rmSync(stage, { recursive: true, force: true });
  rmSync(out[0], { recursive: true, force: true });

  const size = n => (statSync(n).size / 1048576).toFixed(1) + ' MB';
  console.log(`[${arch}] 完成：\n  ${zipPath}（${size(zipPath)}）\n  ${dmgPath}（${size(dmgPath)}）`);
  return zipPath;
}

try {
  const zips = [];
  for (const arch of ['arm64', 'x64']) zips.push(await buildOne(arch));
  const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const notesMd = readFileSync(path.join(ROOT, 'UPDATE-NOTES.md'), 'utf8');
  const notes = extractNotes(notesMd, version);
  if (!notes) console.warn(`⚠️ UPDATE-NOTES.md 里没找到「# 分镜台 ${version}」这一节，软件里的更新说明会是空的`);
  const manifest = writeManifest(RELEASE_DIR, { version, notes, zips, history: notesHistory(notesMd) });
  console.log(`[清单] ${manifest}（软件内更新先读它，不占 GitHub API 次数）`);
  console.log(`\n全部完成，发布物在 ${RELEASE_DIR}（arm64 = M 系列芯片，x64 = Intel 芯片）`);
  console.log(`发布：GitHub Release 的 tag 写 v${version}，把目录里的 2 个 zip、2 个 dmg 和 latest.json 全部上传。`);
  console.log('上传后请删除整个临时构建目录。');
} catch (error) {
  rmSync(BUILD_ROOT, { recursive: true, force: true });
  throw error;
}
