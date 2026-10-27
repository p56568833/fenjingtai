/* 运行时指纹：应用里 app.asar 以外的部分（Electron 本体、图标、Info.plist 里分镜台自己写的几项）算一个短哈希，
   写进 Info.plist 的 FenJingTaiRuntime。软件内更新只在指纹相同时下载约 1 MB 的 app.asar 增量包，
   不同（换了 Electron、改了图标或权限说明）就照旧下载完整安装包。打包、本地安装、重打包共用。 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const PLIST_KEYS = [
  'CFBundleIdentifier',
  'CFBundleName',
  'CFBundleIconFile',
  'CFBundleIconName',
  'LSApplicationCategoryType',
  'LSMinimumSystemVersion',
  'NSLocalNetworkUsageDescription',
];
export const RUNTIME_KEY = 'FenJingTaiRuntime';

const plistValue = (plist, key) => {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { stdio: 'pipe' })
      .toString()
      .trim();
  } catch {
    return '';
  }
};

/* 在签名之前调用（改了 Info.plist，签名要在最后） */
export function stampRuntime(app) {
  const res = path.join(app, 'Contents', 'Resources');
  const plist = path.join(app, 'Contents', 'Info.plist');
  const electron = plistValue(
    path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist'),
    'CFBundleVersion',
  );
  if (!electron) throw new Error('读不到应用里的 Electron 版本');
  const hash = createHash('sha256').update(`electron ${electron}\n`);
  for (const key of PLIST_KEYS) hash.update(`${key}=${plistValue(plist, key)}\n`);
  for (const file of ['electron.icns', 'Assets.car']) hash.update(readFileSync(path.join(res, file)));
  const id = `${electron}-${hash.digest('hex').slice(0, 12)}`;
  execFileSync('/usr/bin/plutil', ['-replace', RUNTIME_KEY, '-string', id, plist]);
  return id;
}
