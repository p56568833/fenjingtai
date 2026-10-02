/* Refresh existing runtimes offline; --archives also refreshes ZIP/DMG installers. */
import { createPackageWithOptions } from '@electron/asar';
import { cpSync, existsSync, readFileSync, mkdirSync, renameSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staging = path.join(ROOT, 'dist', '.asar-staging');
const architectures = ['arm64', 'x64'].filter(arch =>
  existsSync(path.join(ROOT, 'dist', `分镜台-darwin-${arch}`, '分镜台.app')),
);
if (!architectures.length) throw new Error('尚无应用运行时，请先运行 npm run package');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
// 自测文件只在开发环境用（发布版不接受 --selftest），不进安装包
for (const item of ['electron', 'renderer', 'package.json'])
  cpSync(path.join(ROOT, item), path.join(staging, item), {
    recursive: true,
    filter: src => !/selftest\.js$/.test(src) && !/\.DS_Store$/.test(src),
  });
const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
try {
  for (const arch of architectures) {
    const app = path.join(ROOT, 'dist', `分镜台-darwin-${arch}`, '分镜台.app');
    const asar = path.join(app, 'Contents', 'Resources', 'app.asar');
    await createPackageWithOptions(staging, asar + '.new', { dot: true });
    renameSync(asar + '.new', asar);
    const plist = path.join(app, 'Contents', 'Info.plist');
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion'])
      run('/usr/bin/plutil', ['-replace', key, '-string', version, plist]);
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    utimesSync(app, new Date(), new Date());
    console.log(`${arch} 应用已更新并校验签名：${app}`);
    if (process.argv.includes('--archives')) {
      const release = path.join(ROOT, 'dist', 'release');
      mkdirSync(release, { recursive: true });
      const stem = `FenJingTai-mac-${arch}`;
      run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, path.join(release, stem + '.zip')]);
      const dmgStage = path.join(ROOT, 'dist', `.dmg-stage-${arch}`);
      mkdirSync(dmgStage, { recursive: true });
      try {
        run('/usr/bin/ditto', [app, path.join(dmgStage, '分镜台.app')]);
        symlinkSync('/Applications', path.join(dmgStage, 'Applications'));
        run('/usr/bin/hdiutil', [
          'create',
          '-volname',
          '分镜台',
          '-srcfolder',
          dmgStage,
          '-ov',
          '-format',
          'UDZO',
          path.join(release, stem + '.dmg'),
        ]);
      } finally {
        rmSync(dmgStage, { recursive: true, force: true });
      }
      console.log(`${arch} ZIP / DMG 已更新`);
    }
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
