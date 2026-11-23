/* 项目打包的数据层（纯函数，无 DOM）：
   - packPlan：这个项目要带走哪些本地文件，每个文件在包里叫什么（素材/、候选清单/、口播/，重名自动加 (2)）
   - toPacked：项目数据里的本地路径换成包内相对路径（找不到的文件保持原路径，导入后显示失联）
   - fromPacked：导入时把包内相对路径换回解压位置的绝对路径
   路径一律用 /（只在 macOS 上用）。 */
import { referencedAssetIds, usageList } from './asset-model.js';

export const PACK_VERSION = 1;
const LINK = /^[a-z][a-z0-9+.-]*:/i;
const FRAG_RE = /(#t=[\d.,]+)$/;
const PACK_DIRS = new Set(['素材', '候选清单', '返工单', '口播']);
const splitFrag = p => {
  if (typeof p !== 'string') return ['', ''];
  const m = p.match(FRAG_RE);
  return m ? [p.slice(0, m.index), m[1]] : [p, ''];
};
const isLocal = p => {
  const [clean] = splitFrag(p);
  return typeof clean === 'string' && clean.startsWith('/');
};
const baseName = p => p.split('/').pop() || 'file';

function splitExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

/* 包内相对路径：必须落在包内目录（素材/、候选清单/、返工单/、口播/）下，不含 . / .. 段 */
export function isPackRel(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || LINK.test(p) || p.includes('\\')) return false;
  const [clean] = splitFrag(p);
  const segs = clean.split('/');
  if (segs.length < 2 || !PACK_DIRS.has(segs[0])) return false;
  return segs.every(s => s && s !== '.' && s !== '..');
}

/* opts.includeAlt：备选素材也带上（默认带） */
export function packPlan(project, { includeAlt = true } = {}) {
  const rows = project.rows || [];
  const assets = project.assets || {};
  const used = new Set();
  for (const r of rows) for (const u of usageList(r)) if (includeAlt || u.role !== 'alt') used.add(u.assetId);
  const files = new Map(); // 本地绝对路径（不含 #t= 片段）→ 包内相对路径
  const taken = new Set();
  const add = (src, folder) => {
    if (!isLocal(src)) return;
    const [clean] = splitFrag(src);
    if (files.has(clean)) return;
    const [stem, ext] = splitExt(baseName(clean));
    let rel = `${folder}/${stem}${ext}`;
    for (let i = 2; taken.has(rel.toLowerCase()); i++) rel = `${folder}/${stem} (${i})${ext}`;
    taken.add(rel.toLowerCase());
    files.set(clean, rel);
  };
  for (const id of referencedAssetIds(rows)) if (used.has(id)) add(assets[id]?.path, '素材');
  for (const c of project.candidates || []) {
    if (c.savedPath && (!c.assetId || used.has(c.assetId))) add(c.savedPath, '素材');
    if (isLocal(c.url)) add(c.url, '素材');
  }
  for (const c of project.candidates || []) add(c.srcFile, '候选清单');
  for (const r of Object.values(project.reworkRequests || {})) add(r.path, '返工单');
  if (project.voice) add(project.voice.path, '口播');
  return files;
}

/* 按映射改写项目里的路径（toPacked / fromPacked 共用）；map(path) 返回新路径或 null（不改），自动保留 #t= 后缀 */
function rewrite(project, map) {
  const p = structuredClone(project);
  const mapPath = raw => {
    if (typeof raw !== 'string' || !raw) return null;
    const [clean, frag] = splitFrag(raw);
    const mapped = map(clean);
    return mapped ? mapped + frag : null;
  };
  for (const a of Object.values(p.assets || {})) {
    const n = mapPath(a.path);
    if (n) a.path = n;
  }
  for (const c of p.candidates || []) {
    for (const k of ['savedPath', 'srcFile', 'url']) {
      const n = mapPath(c[k]);
      if (n) c[k] = n;
    }
    delete c.peerPath;
  }
  for (const r of Object.values(p.reworkRequests || {})) {
    const n = mapPath(r.path);
    if (n) r.path = n;
  }
  if (p.voice) {
    const n = mapPath(p.voice.path);
    if (n) p.voice = { ...p.voice, path: n };
  }
  for (const r of p.rows || []) {
    if (r.kind !== 'line') continue;
    if (typeof r.assets === 'string' && r.assets)
      r.assets = r.assets
        .split('\n')
        .map(x => mapPath(x) || x)
        .join('\n');
    for (const u of r.assetUsages || []) {
      if (u && typeof u.path === 'string') {
        const n = mapPath(u.path);
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
