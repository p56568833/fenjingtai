#!/usr/bin/env node
/* 一键打发布包：@electron/packager 出 Apple Silicon(arm64) + Intel(x64) 两个 分镜台.app，
   ad-hoc 签名（macOS 要求至少 ad-hoc 才能启动），每个架构产出一个 .dmg（带「拖到 Applications」
   快捷方式）和一个 .zip（给脚本/curl 和软件内更新下载）；再出一个只含应用代码的增量包
   FenJingTai-app.asar.gz（约 1 MB，Electron 本体没变的老用户软件内更新只下它），最后生成 latest.json
   （软件内更新先读它，不占 GitHub API 匿名额度），统一落在临时 .noindex 目录，文件名用 ASCII 方便直链。
   用法：npm run package */
import { packager } from '@electron/packager';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { installAppIcon } from './app-icon.mjs';
import { applyAppPlist } from './app-plist.mjs';
import { stampRuntime } from './app-runtime.mjs';
import { shouldIgnore } from './package-filter.mjs';
import { checkNotes, extractNotes, notesHistory, PATCH_NAME, writeManifest } from './release-manifest.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';

// 先查更新说明的格式：不合格就不打包（规则见 release-manifest.mjs 的 checkNotes 和 AGENTS.md）
{
  const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const problems = checkNotes(readFileSync(path.join(ROOT, 'UPDATE-NOTES.md'), 'utf8'), version);
  if (problems.length) {
    console.error(
      `UPDATE-NOTES.md 里「# 分镜台 ${version}」这一节不合格式，先改好再打包：\n- ${problems.join('\n- ')}`,
    );
    process.exit(1);
  }
}

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
  applyAppPlist(plist);
  // 应用分类：视频（访达「应用程序」按类别排列、启动台归类时用）
  execFileSync('/usr/bin/plutil', [
    '-replace',
    'LSApplicationCategoryType',
    '-string',
    'public.app-category.video',
    plist,
  ]);
  const runtime = stampRuntime(APP); // 运行时指纹：要在 Info.plist 全部改完之后、签名之前
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
  const asar = path.join(BUILD_ROOT, `app-${arch}.asar`);
  copyFileSync(path.join(APP, 'Contents/Resources/app.asar'), asar);
  rmSync(out[0], { recursive: true, force: true });

  const size = n => (statSync(n).size / 1048576).toFixed(1) + ' MB';
  console.log(`[${arch}] 完成：\n  ${zipPath}（${size(zipPath)}）\n  ${dmgPath}（${size(dmgPath)}）`);
  return { zipPath, runtime, asar };
}

/* 增量包：两个芯片的 app.asar 和运行时指纹应当一模一样（应用代码不含原生模块），一样才发；
   不一样就不发增量，所有人照旧下载完整安装包 */
function buildPatch(builds) {
  const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const [first, ...rest] = builds;
  const asarSha256 = sha(first.asar);
  if (rest.some(b => b.runtime !== first.runtime || sha(b.asar) !== asarSha256)) {
    console.warn('[增量] 两个芯片的应用代码或运行时不一致，这一版不发增量包');
    return null;
  }
  const file = path.join(RELEASE_DIR, PATCH_NAME);
  writeFileSync(file, gzipSync(readFileSync(first.asar), { level: 9 }));
  console.log(`[增量] ${file}（${(statSync(file).size / 1048576).toFixed(2)} MB，运行时 ${first.runtime}）`);
  return { file, runtime: first.runtime, asarSha256 };
}

try {
  const builds = [];
  for (const arch of ['arm64', 'x64']) builds.push(await buildOne(arch));
  const zips = builds.map(b => b.zipPath);
  const patch = buildPatch(builds);
  for (const b of builds) rmSync(b.asar, { force: true });
  const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const notesMd = readFileSync(path.join(ROOT, 'UPDATE-NOTES.md'), 'utf8');
  const notes = extractNotes(notesMd, version);
  const manifest = writeManifest(RELEASE_DIR, { version, notes, zips, patch, history: notesHistory(notesMd) });
  console.log(`[清单] ${manifest}（软件内更新先读它，不占 GitHub API 次数）`);
  console.log(`\n全部完成，发布物在 ${RELEASE_DIR}（arm64 = M 系列芯片，x64 = Intel 芯片）`);
  console.log(
    `发布：GitHub Release 的 tag 写 v${version}，把目录里的 2 个 zip、2 个 dmg、${patch ? `${PATCH_NAME}、` : ''}latest.json 全部上传。`,
  );
  console.log('上传后请删除整个临时构建目录。');
} catch (error) {
  rmSync(BUILD_ROOT, { recursive: true, force: true });
  throw error;
}
