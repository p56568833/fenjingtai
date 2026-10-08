/* 素材数据模型（纯函数，无 DOM、无应用状态）：
   素材库 project.assets = { [assetId]: {id, kind, path, name, durationSec?} }   ← 素材文件本身
   使用记录 row.assetUsages = [ {assetId, clip: null | {in, out, needsAdjust?}, role?, off?} ] ← 画面对素材的使用
   clip 挂在使用上：同一个视频在不同画面里可以各用各的片段。
   role：main 主画面 / overlay 叠加 / alt 备选；缺省 = 未分配。共用画面内各句一致。一个镜头可以有多个主画面。
   at：手动设的出现时间 {start, end, of}（相对镜头开头的秒数），规则见 core/shot-layout.js。
   off：共用画面里这条素材不在这一句出现（每句各存一份副本，所以位置天然跟着句子走）。
   旧项目只有 r.assets 文本（一行一个路径/链接），载入时迁移成上述结构。 */
import { fmtTime } from './text.js';
import { shots, isRole, normalizeUsageSpans } from './shots.js';

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
export const VIDEO_EXT = /\.(mp4|mov|mkv|webm|m4v|avi)$/i;
export const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;
export const DOC_EXT = /\.(pdf|txt|md|csv|pptx|docx)$/i;
export const LINK_RE = /^https?:\/\//i;

export function kindOf(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  // 在线视频文件（.mp4 / .webm …，可带 #t= 片段）当视频处理：能预览、能设片段（视频审核）
  if (LINK_RE.test(ref)) return VIDEO_EXT.test(ref.split(/[?#]/)[0]) ? 'video' : 'link';
  if (IMAGE_EXT.test(ref)) return 'image';
  if (VIDEO_EXT.test(ref)) return 'video';
  if (AUDIO_EXT.test(ref)) return 'audio';
  if (DOC_EXT.test(ref)) return 'doc';
  return null;
}
export const KIND_LABEL = { image: '图片', video: '视频', audio: '音频', doc: '文档', link: '链接' };

export function assetName(ref) {
  try {
    if (LINK_RE.test(ref)) {
      const u = new URL(ref);
      return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
    }
  } catch {}
  return String(ref).split(/[\\/]/).pop() || String(ref);
}

/* <video>/<img> 用的本地文件地址（逐段编码，#、? 等字符不破坏 URL） */
export function fileUrl(p) {
  if (LINK_RE.test(p)) return p;
  const q = String(p).split('/').map(encodeURIComponent).join('/');
  return p.startsWith('/') ? 'file://' + q : 'file:///' + q;
}

export const usageList = row => (Array.isArray(row?.assetUsages) ? row.assetUsages : []);
export const usagePath = (registry, u) => registry[u.assetId]?.path || u.path || '';
export const cloneUsage = u => ({
  ...u,
  ...(u.clip ? { clip: { ...u.clip } } : {}),
  ...(u.at ? { at: { ...u.at } } : {}),
});
/* 使用记录上除 assetId / clip 以外要跟着走的字段（角色、位置、手动设的出现时间 at） */
const cleanAtField = at => {
  if (!at || typeof at !== 'object') return null;
  const start = Number(at.start),
    end = Number(at.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || at.of == null) return null;
  return { start, end, of: at.of };
};
export const extraOf = u => {
  const at = cleanAtField(u?.at);
  return {
    ...(isRole(u?.role) ? { role: u.role } : {}),
    ...(u?.off ? { off: true } : {}),
    ...(at ? { at } : {}),
  };
};
export const cloneUsages = us => us.map(cloneUsage);

export function ensureAsset(registry, ref, extra = {}) {
  const path = String(ref).trim();
  for (const a of Object.values(registry)) if (a.path === path) return a;
  const id = 'as-' + crypto.randomUUID();
  const asset = { id, kind: extra.kind || kindOf(path) || 'doc', path, name: extra.name || assetName(path) };
  if (extra.durationSec != null && isFinite(extra.durationSec)) asset.durationSec = +extra.durationSec;
  registry[id] = asset;
  return asset;
}

/* 由 usages 重建旧版 r.assets 文本镜像（兼容老导出格式与旧版读取） */
export function syncMirror(rows, registry) {
  for (const r of rows) {
    if (r.kind !== 'line') continue;
    r.assets = usageList(r)
      .map(u => usagePath(registry, u))
      .filter(Boolean)
      .join('\n');
  }
}

/* 被引用的素材 id 集合（含口播音频） */
export function referencedAssetIds(rows, extra = []) {
  const ids = new Set(extra.filter(Boolean));
  for (const r of rows) for (const u of usageList(r)) ids.add(u.assetId);
  return ids;
}

/* 早期版本在「编辑链接或文件路径」里每敲一个字就建一条素材（/、/U、/Us…）。
   清理条件很保守：没有任何画面引用，且路径是另一条素材路径的前缀——只有打字残留才长这样。 */
export function pruneTypingJunk(registry, usedIds) {
  const paths = Object.values(registry).map(a => a.path || '');
  let removed = 0;
  for (const [id, a] of Object.entries(registry)) {
    if (usedIds.has(id)) continue;
    const p = a.path || '';
    if (!p || paths.some(other => other !== p && other.startsWith(p))) {
      delete registry[id];
      removed++;
    }
  }
  return removed;
}

/* 载入 / 导入时把旧数据迁移到新结构：
   ① 旧的 r.assets 文本 → 素材库条目 + 使用记录；② 带内联信息的使用记录 → 补进素材库；③ 同一路径全项目去重 */
export function hydrateProjectAssets(p) {
  const registry = p.assets && typeof p.assets === 'object' ? { ...p.assets } : {};
  for (const r of p.rows || []) {
    if (r.kind !== 'line') continue;
    if (Array.isArray(r.assetUsages)) {
      r.assetUsages = r.assetUsages
        .map(u => {
          if (!u || typeof u !== 'object') return null;
          if (u.path) {
            const a = ensureAsset(registry, u.path, { name: u.name, kind: u.kind });
            return { assetId: a.id, ...(u.clip ? { clip: { ...u.clip } } : {}), ...extraOf(u) };
          }
          if (typeof u.assetId === 'string' && registry[u.assetId])
            return { assetId: u.assetId, ...(u.clip ? { clip: { ...u.clip } } : {}), ...extraOf(u) };
          return null;
        })
        .filter(Boolean);
    } else {
      r.assetUsages = String(r.assets || '')
        .split('\n')
        .map(x => x.trim())
        .filter(Boolean)
        .map(ref => ({ assetId: ensureAsset(registry, ref).id }));
    }
  }
  normalizeUsageSpans(p.rows || []);
  pruneTypingJunk(registry, referencedAssetIds(p.rows || []));
  syncMirror(p.rows || [], registry);
  p.assets = registry;
  return registry;
}

/* 使用次数按「独立画面」统计：共用画面算一处 */
export function countAssetShots(rows, assetId) {
  return shots(rows).filter(g => g.some(r => usageList(r).some(u => u.assetId === assetId))).length;
}
export function assetUsageRefs(rows, assetId) {
  const out = [];
  for (const g of shots(rows)) {
    const hit = g.find(r => usageList(r).some(u => u.assetId === assetId));
    if (hit) out.push({ row: hit, members: g });
  }
  return out;
}

/* 片段校验：null = 使用整段；返回中文错误原因，null = 通过 */
export function checkClip(clip, durationSec) {
  if (!clip) return null;
  const { in: cin, out: cout } = clip;
  if (!isFinite(cin) || !isFinite(cout)) return '时间格式不对，试试 00:12';
  if (cin < 0) return '入点不能小于 0';
  if (cout <= cin) return '出点必须大于入点';
  if (durationSec != null && isFinite(durationSec) && cout > durationSec + 0.05)
    return `片段超出视频时长（${fmtTime(durationSec)}）`;
  return null;
}
export const clipText = clip => (clip ? `${fmtTime(clip.in)}–${fmtTime(clip.out)}` : '整段');

/* 加入计划：现有使用记录 + 候选路径 → 去重 / 拒绝不支持格式，不产生无效条目 */
export function planAddRefs(registry, usages, refs) {
  const existing = new Set(usages.map(u => u.assetId));
  const added = [],
    dupes = [],
    invalid = [];
  for (const raw of refs) {
    const ref = String(raw || '').trim();
    if (!ref) continue;
    const kind = kindOf(ref);
    if (!kind) {
      invalid.push(ref);
      continue;
    }
    const asset = ensureAsset(registry, ref);
    if (existing.has(asset.id)) {
      dupes.push(ref);
      continue;
    }
    existing.add(asset.id);
    // 空画面的第一个素材默认当主画面，其余先放备选，用的时候再挑
    added.push({ assetId: asset.id, role: !usages.length && !added.length ? 'main' : 'alt' });
  }
  return { added, dupes, invalid };
}

/* 替换文件后检查片段兼容性：不兼容的标记「待调整」，绝不静默改时间 */
export function clipAdjustPlan(rows, assetId, durationSec) {
  let adjusted = 0;
  for (const r of rows) {
    if (r.kind !== 'line') continue;
    let touched = false;
    const usages = usageList(r).map(u => {
      if (u.assetId !== assetId || !u.clip) return u;
      const err = durationSec != null ? checkClip(u.clip, durationSec) : null;
      if (err) {
        adjusted++;
        touched = true;
        return { ...u, clip: { ...u.clip, needsAdjust: true } };
      }
      if (u.clip.needsAdjust && durationSec != null) {
        touched = true;
        return { assetId: u.assetId, clip: { in: u.clip.in, out: u.clip.out }, ...extraOf(u) };
      }
      return u;
    });
    if (touched) r.assetUsages = usages;
  }
  return { adjusted };
}

/* 文本框里的引用（一行一个）→ 新的使用记录；还在列表里的素材保留各自片段。
   不认识的格式按普通文档收（手写路径是专家入口） */
export function usagesFromText(registry, oldUsages, text) {
  const refs = String(text || '')
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean);
  const old = new Map(oldUsages.map(u => [u.assetId, u]));
  const hadAny = old.size > 0;
  const usages = [];
  const seen = new Set();
  for (const ref of refs) {
    const a = ensureAsset(registry, ref, { kind: kindOf(ref) || 'doc' });
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const prev = old.get(a.id);
    usages.push(
      prev
        ? {
            assetId: a.id,
            ...(prev.clip ? { clip: { ...prev.clip } } : {}),
            ...extraOf({ role: prev.role, at: prev.at }),
          }
        : { assetId: a.id, role: !hadAny && !usages.length ? 'main' : 'alt' },
    );
  }
  return usages;
}

/* 这一句画面上「看得到」的那个素材（视频 / 图片）：连播预览、对口播预览用。
   先找这一句出现的主画面，再找未分配的；备选、叠加不算，off（不在这句出现）的跳过 */
export function firstVisualUsage(registry, row) {
  const visual = u => {
    const a = registry[u.assetId];
    const kind = a?.kind || kindOf(a?.path || '');
    return kind === 'video' || kind === 'image' ? { usage: u, asset: a, kind } : null;
  };
  const here = usageList(row).filter(u => !u.off);
  for (const pick of [u => u.role === 'main', u => !isRole(u.role)]) {
    for (const u of here.filter(pick)) {
      const v = visual(u);
      if (v) return v;
    }
  }
  return null;
}
