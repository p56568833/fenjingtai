/* 素材数据层：区分「素材文件本身」（项目级素材库）与「画面对素材的使用」（句级引用 + 片段范围）。
   素材库 project.assets = { [assetId]: {id, kind, path, name, durationSec?} }
   画面对素材的使用 row.assetUsages = [ {assetId, clip: null | {in, out, needsAdjust?}} ]
   clip 挂在使用上：同一个视频在不同画面里可以各用各的片段。
   旧项目只有 r.assets 文本（一行一个路径/链接），载入时自动迁移成上述结构，无需重新导入。 */
import { state, update } from './state.js';
import { persist } from './storage.js';
import { snapshot } from './undo.js';
import { toast, fmtTime, parseTime } from './util.js';
import { shotMembers, shots } from './production.js';

export { fmtTime, parseTime };

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
export const VIDEO_EXT = /\.(mp4|mov|mkv|webm|m4v|avi)$/i;
export const AUDIO_EXT = /\.(mp3|wav|m4a)$/i;
export const DOC_EXT = /\.(pdf|txt|md|csv|pptx|docx)$/i;
export const LINK_RE = /^https?:\/\//i;

export function kindOf(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  if (LINK_RE.test(ref)) return 'link';
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

/* 时间工具 fmtTime / parseTime 在 util.js（production.js 也要用），这里转引 */

/* 渲染进程里给 <video>/<img> 用的本地文件地址（逐段编码，#、? 等字符不破坏 URL） */
export function fileUrl(p) {
  if (LINK_RE.test(p)) return p;
  const q = String(p).split('/').map(encodeURIComponent).join('/');
  return p.startsWith('/') ? 'file://' + q : 'file:///' + q;
}

/* ── 素材库（纯函数：传 registry，方便无窗口测试） ── */
export function ensureAsset(registry, ref, extra = {}) {
  const path = String(ref).trim();
  for (const a of Object.values(registry)) if (a.path === path) return a;
  const id = 'as-' + crypto.randomUUID();
  const asset = { id, kind: extra.kind || kindOf(path) || 'doc', path, name: extra.name || assetName(path) };
  if (extra.durationSec != null && isFinite(extra.durationSec)) asset.durationSec = +extra.durationSec;
  registry[id] = asset;
  return asset;
}

export const usageList = row => (Array.isArray(row?.assetUsages) ? row.assetUsages : []);
export const usagePath = (registry, u) => registry[u.assetId]?.path || u.path || '';

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
            // MD 回读等自包含格式：先入库再挂引用
            const a = ensureAsset(registry, u.path, { name: u.name, kind: u.kind });
            return { assetId: a.id, ...(u.clip ? { clip: { ...u.clip } } : {}) };
          }
          if (typeof u.assetId === 'string' && registry[u.assetId])
            return { assetId: u.assetId, ...(u.clip ? { clip: { ...u.clip } } : {}) };
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

/* 加入计划（纯）：现有使用记录 + 候选路径 → 去重 / 拒绝不支持格式，不产生无效条目 */
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
    added.push({ assetId: asset.id });
  }
  return { added, dupes, invalid };
}

/* 替换文件后检查片段兼容性（纯）：不兼容的标记「待调整」，绝不静默改时间 */
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
        return { assetId: u.assetId, clip: { in: u.clip.in, out: u.clip.out } };
      }
      return u;
    });
    if (touched) r.assetUsages = usages;
  }
  return { adjusted };
}

/* ── 以下操作会改 state：一次调用 = 一次撤销步 ── */

/* 所有共享同一画面的句子一起改（共用画面内使用同一份素材与片段设置） */
function eachMember(row, fn) {
  for (const m of shotMembers(state.rows, row)) fn(m);
}

export function addRefsToShot(row, refs) {
  const registry = state.assets;
  const { added, dupes, invalid } = planAddRefs(registry, usageList(row), refs);
  if (!added.length) return { added: [], dupes, invalid };
  snapshot(added.length > 1 ? `添加 ${added.length} 个素材` : '添加素材');
  eachMember(row, m => {
    m.assetUsages = [...usageList(m), ...added.map(u => ({ ...u }))];
  });
  syncMirror(shotMembers(state.rows, row), registry);
  persist();
  update('rows');
  return { added, dupes, invalid };
}

export function removeUsage(row, index) {
  const usages = usageList(row);
  if (index < 0 || index >= usages.length) return;
  snapshot('移除素材关联');
  const rest = usages.filter((_, i) => i !== index).map(u => ({ ...u, ...(u.clip ? { clip: { ...u.clip } } : {}) }));
  eachMember(row, m => {
    m.assetUsages = rest.map(u => ({ ...u, ...(u.clip ? { clip: { ...u.clip } } : {}) }));
  });
  syncMirror(shotMembers(state.rows, row), state.assets);
  persist();
  update('rows');
  toast('已移除关联，本地文件保留 · ⌘Z 可撤销');
}

/* 「编辑链接或文件路径」文本框：一行一个引用，重排整组使用记录。
   还留在列表里的素材保留各自片段设置；不认识的格式按普通文档收（用户手写的路径是专家入口） */
export function setShotRefsFromText(row, text) {
  const refs = String(text || '')
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean);
  const registry = state.assets;
  const old = new Map(usageList(row).map(u => [u.assetId, u.clip]));
  const usages = [];
  const seen = new Set();
  for (const ref of refs) {
    const a = ensureAsset(registry, ref, { kind: kindOf(ref) || 'doc' });
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const clip = old.get(a.id);
    usages.push(clip ? { assetId: a.id, clip: { ...clip } } : { assetId: a.id });
  }
  eachMember(row, m => {
    m.assetUsages = usages.map(u => ({ ...u, ...(u.clip ? { clip: { ...u.clip } } : {}) }));
  });
  syncMirror(shotMembers(state.rows, row), registry);
}

export function setUsageClip(row, index, clip) {
  const usages = usageList(row);
  if (index < 0 || index >= usages.length) return false;
  snapshot(clip ? '设置视频片段' : '清除视频片段');
  eachMember(row, m => {
    m.assetUsages = usageList(m).map((u, i) => {
      if (i !== index) return { ...u };
      const next = { assetId: u.assetId };
      if (clip) next.clip = { ...clip };
      return next;
    });
  });
  persist();
  update('rows');
  return true;
}

/* 重新定位失联文件：改的是素材库条目，项目内所有引用一起修好 */
export function relocateAsset(assetId, newPath, { durationSec } = {}) {
  const asset = state.assets[assetId];
  if (!asset || !newPath) return null;
  snapshot('重新定位素材');
  const oldName = asset.name;
  asset.path = String(newPath).trim();
  asset.name = assetName(asset.path);
  const kind = kindOf(asset.path);
  if (kind) asset.kind = kind;
  if (durationSec != null && isFinite(durationSec)) asset.durationSec = +durationSec;
  else delete asset.durationSec;
  // 新文件时长和已有片段范围不兼容的，标记「待调整」，不静默改时间
  const { adjusted } = clipAdjustPlan(state.rows, assetId, durationSec != null ? durationSec : null);
  syncMirror(state.rows, state.assets);
  invalidateProbe();
  persist();
  update('rows');
  return { oldName, asset, adjusted };
}

/* 文件探测（存在与否），带缓存；重新定位 / 恢复后调用 invalidateProbe 刷新 */
let probeCache = new Map();
export const invalidateProbe = () => {
  probeCache = new Map();
};
export async function probePaths(paths) {
  const need = [...new Set(paths.filter(p => p && !LINK_RE.test(p) && !probeCache.has(p)))];
  if (need.length && window.native?.probeAssets) {
    const res = await window.native.probeAssets(need);
    for (const [p, info] of Object.entries(res || {})) probeCache.set(p, info);
  }
  const out = {};
  for (const p of paths) out[p] = probeCache.get(p) || null;
  return out;
}
export const isMissing = info => info === false || (info && info.exists === false);
