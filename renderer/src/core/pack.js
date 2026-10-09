/* 项目打包的数据层（纯函数，无 DOM）：
   - packPlan：这个项目要带走哪些本地文件，每个文件在包里叫什么（素材/、候选清单/、口播/，重名自动加 (2)）
   - toPacked：项目数据里的本地路径换成包内相对路径（找不到的文件保持原路径，导入后显示失联）
   - fromPacked：导入时把包内相对路径换回解压位置的绝对路径
   路径一律用 /（只在 macOS 上用）。 */
import { referencedAssetIds, usageList } from './asset-model.js';

export const PACK_VERSION = 1;
const LINK = /^[a-z][a-z0-9+.-]*:/i;
const isLocal = p => typeof p === 'string' && p.startsWith('/');
const baseName = p => p.split('/').pop() || 'file';

function splitExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

/* 包内相对路径：不是绝对路径、不是链接、没有 . / .. 段 */
export function isPackRel(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || LINK.test(p) || p.includes('\\')) return false;
  return p.split('/').every(s => s && s !== '.' && s !== '..');
}

/* opts.includeAlt：备选素材也带上（默认带） */
export function packPlan(project, { includeAlt = true } = {}) {
  const rows = project.rows || [];
  const assets = project.assets || {};
  const used = new Set();
  for (const r of rows) for (const u of usageList(r)) if (includeAlt || u.role !== 'alt') used.add(u.assetId);
  const files = new Map(); // 本地绝对路径 → 包内相对路径
  const taken = new Set();
  const add = (src, folder) => {
    if (!isLocal(src) || files.has(src)) return;
    const [stem, ext] = splitExt(baseName(src));
    let rel = `${folder}/${stem}${ext}`;
    for (let i = 2; taken.has(rel.toLowerCase()); i++) rel = `${folder}/${stem} (${i})${ext}`;
    taken.add(rel.toLowerCase());
    files.set(src, rel);
  };
  for (const id of referencedAssetIds(rows)) if (used.has(id)) add(assets[id]?.path, '素材');
  for (const c of project.candidates || [])
    if (c.savedPath && (!c.assetId || used.has(c.assetId))) add(c.savedPath, '素材');
  for (const c of project.candidates || []) add(c.srcFile, '候选清单');
  if (project.voice) add(project.voice.path, '口播');
  return files;
}

/* 按映射改写项目里的路径（toPacked / fromPacked 共用）；map(path) 返回新路径或 null（不改） */
function rewrite(project, map) {
  const p = structuredClone(project);
  for (const a of Object.values(p.assets || {})) {
    const n = map(a.path);
    if (n) a.path = n;
  }
  for (const c of p.candidates || []) {
    for (const k of ['savedPath', 'srcFile']) {
      const n = map(c[k]);
      if (n) c[k] = n;
    }
  }
  if (p.voice) {
    const n = map(p.voice.path);
    if (n) p.voice = { ...p.voice, path: n };
  }
  for (const r of p.rows || []) {
    if (r.kind !== 'line') continue;
    if (typeof r.assets === 'string' && r.assets)
      r.assets = r.assets
        .split('\n')
        .map(x => map(x) || x)
        .join('\n');
    for (const u of r.assetUsages || []) {
      if (u && typeof u.path === 'string') {
        const n = map(u.path);
        if (n) u.path = n;
      }
    }
  }
  return p;
}

/* 打包用的项目数据：本地路径换成包内相对路径；mediaDir（片段保存位置）是本机的，不带走 */
export function toPacked(project, files) {
  const p = rewrite(project, x => (files.has(x) ? files.get(x) : null));
  delete p.mediaDir;
  p.pack = { v: PACK_VERSION, files: files.size, packedAt: new Date().toISOString() };
  return p;
}

/* 导入：包内相对路径 → 解压位置下的绝对路径；新的片段默认也存到解压位置的「素材」里 */
export function fromPacked(project, dir) {
  const base = String(dir || '').replace(/\/+$/, '');
  const p = rewrite(project, x => (isPackRel(x) ? `${base}/${x}` : null));
  delete p.pack;
  p.mediaDir = `${base}/素材`;
  return p;
}
