/* 发版清单 latest.json：和 zip / dmg 一起上传到 GitHub Release。软件内更新先读它——
   github.com/<仓库>/releases/latest/download/latest.json 是普通文件下载，不占 GitHub API
   「每个公网 IP 每小时 60 次」的匿名额度。package.mjs 打完包自动生成，也单独导出方便测试。
   格式：{ version, notes, page, assets: [{ name, size, sha256, url }] } */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const { REPO, MANIFEST_NAME } = createRequire(import.meta.url)('../electron/updater.js');

/* UPDATE-NOTES.md 按「# 分镜台 x.y.z」分节、节之间用 --- 隔开；取出某一版的正文，找不到返回空串 */
export function extractNotes(markdown, version) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex(l => l.trim() === `# 分镜台 ${version}`);
  if (start < 0) return '';
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#\s/.test(l) || l.trim() === '---') break;
    out.push(l);
  }
  return out.join('\n').trim();
}

/* files: [{ name, size, sha256 }]；下载地址指向 tag v<版本号>（发版约定 tag = v + package.json 版本号） */
export function buildManifest({ version, notes = '', files }) {
  const v = String(version).trim().replace(/^v/i, '');
  return {
    version: v,
    notes,
    page: `https://github.com/${REPO}/releases/tag/v${v}`,
    assets: files.map(f => ({
      name: f.name,
      size: f.size,
      sha256: f.sha256,
      url: `https://github.com/${REPO}/releases/download/v${v}/${f.name}`,
    })),
  };
}

export function writeManifest(dir, { version, notes, zips }) {
  const files = zips.map(p => ({
    name: path.basename(p),
    size: statSync(p).size,
    sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
  }));
  const out = path.join(dir, MANIFEST_NAME);
  writeFileSync(out, JSON.stringify(buildManifest({ version, notes, files }), null, 2) + '\n');
  return out;
}
