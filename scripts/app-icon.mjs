/* Install both the legacy ICNS and the native macOS 26+ icon catalog.
   All packaging paths use this helper so an update cannot drop the native icon. */
import { copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function installAppIcon(app) {
  const resources = path.join(app, 'Contents/Resources');
  copyFileSync(path.join(root, 'assets/icon.icns'), path.join(resources, 'electron.icns'));
  copyFileSync(path.join(root, 'assets/Assets.car'), path.join(resources, 'Assets.car'));
  const plist = path.join(app, 'Contents/Info.plist');
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIconFile', '-string', 'electron.icns', plist]);
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIconName', '-string', 'AppIcon', plist]);
}
