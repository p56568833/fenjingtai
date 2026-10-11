/* 发版清单 latest.json：和 zip / dmg 一起上传到 GitHub Release。软件内更新先读它——
   github.com/<仓库>/releases/latest/download/latest.json 是普通文件下载，不占 GitHub API
   「每个公网 IP 每小时 60 次」的匿名额度。package.mjs 打完包自动生成，也单独导出方便测试。
   格式：{ version, notes, history: [{ version, notes }], page, assets: [{ name, size, sha256, url }] } */
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

/* 更新说明格式（从 1.11.0 起）：只用下面四个分组，顺序固定，空的分组不写；每条以「• 」开头、一句话。
   软件里的更新窗口按分组上色显示；旧版的纯文字窗口和 GitHub 发布页也照样整齐。
     【新增】
     • 素材句子条：可直接指定素材对应哪几句口播
   不合格式时返回每一处问题（打包和 npm run test:data 都会拦下） */
export const NOTE_GROUPS = ['新增', '支持', '优化', '修复'];
export const NOTE_MAX_ITEM = 40; // 每条最多几个字
export const NOTE_MAX_ITEMS = 10; // 一版最多几条
export function checkNotes(markdown, version) {
  const notes = extractNotes(markdown, version);
  if (!notes) return [`UPDATE-NOTES.md 里没有「# 分镜台 ${version}」这一节（软件里显示的更新说明）`];
  const errors = [];
  const seen = [];
  let group = null;
  let total = 0;
  const counts = {};
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(/^【(.+)】$/);
    if (head) {
      const name = head[1];
      if (!NOTE_GROUPS.includes(name)) {
        errors.push(`「${line}」不是允许的分组，只能用 ${NOTE_GROUPS.map(g => `【${g}】`).join('')}`);
        continue;
      }
      if (seen.includes(name)) errors.push(`【${name}】重复出现，同一分组的条目写在一起`);
      else if (seen.length && NOTE_GROUPS.indexOf(name) < NOTE_GROUPS.indexOf(seen.at(-1)))
        errors.push(`分组顺序要按 ${NOTE_GROUPS.join(' → ')}，【${name}】不能排在【${seen.at(-1)}】后面`);
      seen.push(name);
      group = name;
      counts[name] = 0;
      continue;
    }
    const item = line.match(/^•\s*(.+)$/);
    if (!item) {
      errors.push(
        `「${line.slice(0, 30)}${line.length > 30 ? '…' : ''}」：每条要以「• 」开头写在分组下面，不写整段文字或 Markdown 标记`,
      );
      continue;
    }
    if (!group) errors.push(`「${line.slice(0, 30)}」前面要先有分组标题，如【新增】`);
    else counts[group]++;
    total++;
    const len = [...item[1]].length;
    if (len > NOTE_MAX_ITEM)
      errors.push(`「${item[1].slice(0, 20)}…」有 ${len} 个字，每条不超过 ${NOTE_MAX_ITEM} 个字，只写用户能感知的变化`);
  }
  for (const g of seen) if (!counts[g]) errors.push(`【${g}】下面没有条目，空的分组不要写`);
  if (!total) errors.push('这一版没有任何条目');
  if (total > NOTE_MAX_ITEMS) errors.push(`一共 ${total} 条，一版最多 ${NOTE_MAX_ITEMS} 条，挑最重要的写`);
  return errors;
}

/* UPDATE-NOTES.md 里最近几版的说明（新的在前）：[{ version, notes }]。
   放进 latest.json，隔了好几版的人一次更新到最新时，能看到中间每一版改了什么 */
export function notesHistory(markdown, limit = 15) {
  const out = [];
  for (const m of String(markdown || '').matchAll(/^# 分镜台 (\d+\.\d+(?:\.\d+)?)\s*$/gm)) {
    const notes = extractNotes(markdown, m[1]);
    if (notes && !out.some(x => x.version === m[1])) out.push({ version: m[1], notes });
    if (out.length >= limit) break;
  }
  return out;
}

/* files: [{ name, size, sha256 }]；下载地址指向 tag v<版本号>（发版约定 tag = v + package.json 版本号） */
export function buildManifest({ version, notes = '', files, history = [] }) {
  const v = String(version).trim().replace(/^v/i, '');
  return {
    version: v,
    notes,
    history,
    page: `https://github.com/${REPO}/releases/tag/v${v}`,
    assets: files.map(f => ({
      name: f.name,
      size: f.size,
      sha256: f.sha256,
      url: `https://github.com/${REPO}/releases/download/v${v}/${f.name}`,
    })),
  };
}

export function writeManifest(dir, { version, notes, zips, history = [] }) {
  const files = zips.map(p => ({
    name: path.basename(p),
    size: statSync(p).size,
    sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
  }));
  const out = path.join(dir, MANIFEST_NAME);
  writeFileSync(out, JSON.stringify(buildManifest({ version, notes, files, history }), null, 2) + '\n');
  return out;
}
