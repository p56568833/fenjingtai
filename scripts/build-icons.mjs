/* Regenerate the macOS icon resources from the approved 1024px RGBA master.
   Run on macOS: node scripts/build-icons.mjs */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('图标生成需要 macOS 的 sips 和 iconutil');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const master = path.join(root, 'assets/icon_1024.png');
const png = readFileSync(master);
if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== 1024 || png.readUInt32BE(20) !== 1024)
  throw new Error('assets/icon_1024.png 必须是 1024×1024 PNG');
const iconset = path.join(root, 'assets/icon.iconset');
mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const pixels = size * scale;
    const out = path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
    execFileSync('/usr/bin/sips', ['-z', String(pixels), String(pixels), master, '--out', out], { stdio: 'pipe' });
  }
}
execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'assets/icon.icns')], {
  stdio: 'pipe',
});
writeFileSync(
  path.join(root, 'assets/icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n  <!-- Generated from the approved icon_1024.png by scripts/build-icons.mjs. -->\n  <image width="1024" height="1024" href="data:image/png;base64,${png.toString('base64')}"/>\n</svg>\n`,
);
console.log('已生成 10 个标准尺寸、icon.icns 和自包含 icon.svg');
