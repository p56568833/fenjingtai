/* 素材相关的数据操作（会改 state：一次调用 = 一次撤销步）+ 文件探测缓存。
   纯数据规则都在 core/asset-model.js；这里只负责快照、落盘、广播。 */
import { state, emit } from './state.js';
import { notify } from './events.js';
import { persist } from './storage.js';
import { snapshot } from './undo.js';
import { shotMembers, applyRole, applySpan, isRole } from '../core/shots.js';
import { round1 } from '../core/shot-layout.js';
import {
  LINK_RE,
  kindOf,
  assetName,
  usageList,
  cloneUsage,
  syncMirror,
  planAddRefs,
  clipAdjustPlan,
  usagesFromText,
  extraOf,
} from '../core/asset-model.js';
import * as native from '../platform/native.js';

/* 所有共享同一画面的句子一起改（共用画面内使用同一份素材与片段设置） */
function eachMember(row, fn) {
  for (const m of shotMembers(state.rows, row)) fn(m);
}

/* 素材变化不改句子结构：只原地刷新素材卡、右侧面板和顶部进度。
   整表重建会让长稿重新计算所有行高并触发 FLIP 动画，看起来像中间内容“飞走”。 */
function refreshAssets(row = null, { stats = true } = {}) {
  emit('workspace', {
    preservePosition: true,
    rowIds: row ? shotMembers(state.rows, row).map(m => m.id) : null,
    stats,
  });
}

export function addRefsToShot(row, refs) {
  const registry = state.assets;
  const { added, dupes, invalid } = planAddRefs(registry, usageList(row), refs);
  if (!added.length) return { added: [], dupes, invalid };
  snapshot(added.length > 1 ? `添加 ${added.length} 个素材` : '添加素材');
  eachMember(row, m => {
    m.assetUsages = [...usageList(m), ...added.map(u => ({ ...u }))];
  });
  // 新素材默认整段出现；若第一个就是主画面，和组里别的主画面撞车时以已有的为准
  const members = shotMembers(state.rows, row);
  const firstMain = added.find(u => u.role === 'main');
  if (firstMain && members.some(m => usageList(m).some(u => u.role === 'main' && u.assetId !== firstMain.assetId)))
    members.forEach(m => m.assetUsages.forEach(u => u.assetId === firstMain.assetId && (u.role = 'alt')));
  syncMirror(members, registry);
  persist();
  refreshAssets(row);
  return { added, dupes, invalid };
}

export function removeUsage(row, index) {
  const usages = usageList(row);
  if (index < 0 || index >= usages.length) return;
  snapshot('移除素材关联');
  const rest = usages.filter((_, i) => i !== index);
  eachMember(row, m => {
    m.assetUsages = rest.map(cloneUsage);
  });
  syncMirror(shotMembers(state.rows, row), state.assets);
  persist();
  refreshAssets(row);
  notify('已移除关联，本地文件保留 · ⌘Z 可撤销');
}

/* 「编辑链接或文件路径」文本框提交（失焦 / 保存时才调，打字过程中不建素材条目） */
export function setShotRefsFromText(row, text) {
  const before = usageList(row)
    .map(u => state.assets[u.assetId]?.path || '')
    .join('\n');
  const next = String(text || '')
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean)
    .join('\n');
  if (before === next) return false;
  snapshot('编辑素材路径');
  const usages = usagesFromText(state.assets, usageList(row), text);
  eachMember(row, m => {
    // 位置（off）是每句自己的：还留在列表里的素材保留原位置，新写进来的整段出现
    const mine = new Map(usageList(m).map(u => [u.assetId, u]));
    m.assetUsages = usages.map(u => ({ ...cloneUsage(u), ...(mine.get(u.assetId)?.off ? { off: true } : {}) }));
  });
  syncMirror(shotMembers(state.rows, row), state.assets);
  persist();
  refreshAssets(row);
  return true;
}

export function setUsageClip(row, index, clip) {
  const usages = usageList(row);
  if (index < 0 || index >= usages.length) return false;
  snapshot(clip ? '设置视频片段' : '清除视频片段');
  eachMember(row, m => {
    m.assetUsages = usageList(m).map((u, i) => {
      if (i !== index) return { ...u };
      const next = { assetId: u.assetId, ...extraOf(u) };
      if (clip) next.clip = { ...clip };
      return next;
    });
  });
  persist();
  refreshAssets(row, { stats: false });
  return true;
}

/* ── 素材角色与出现位置 ──
   只影响素材卡和面板：广播 workspace 原地刷新，不重建整张表（长稿重建会丢掉离屏行的高度缓存，视口会跳） */

/* 角色：主画面 / 叠加 / 备选（null = 未分配）。共用画面里各句一起改。
   1.8 起一段可以有多个主画面，不再挤掉别的（返回值保留为被降级的素材名，现在总是空） */
export function setUsageRole(row, index, role) {
  const u = usageList(row)[index];
  if (!u || (u.role || null) === (role || null)) return null;
  snapshot('设置素材角色');
  const demoted = applyRole(shotMembers(state.rows, row), u.assetId, role);
  persist();
  refreshAssets(row);
  return demoted.map(id => state.assets?.[id]?.name || '素材');
}

/* 旧项目整理：还没分配角色的素材，一键「第一个当主画面（已有主画面就不动），其余放备选」 */
export function autoAssignRoles(row) {
  const usages = usageList(row);
  const loose = usages.filter(u => !isRole(u.role));
  if (!loose.length) return 0;
  snapshot('整理素材角色');
  const members = shotMembers(state.rows, row);
  let needMain = !usages.some(u => u.role === 'main');
  for (const u of loose) {
    applyRole(members, u.assetId, needMain ? 'main' : 'alt');
    needMain = false;
  }
  persist();
  refreshAssets(row);
  return loose.length;
}

/* 位置：在共用画面的第 from 句到第 to 句出现（members 下标，含两端）。
   几个主画面落在同一段句子上时平分那段时间（见 core/shot-layout.js），不再互相挤掉 */
export function setUsageSpan(row, index, from, to) {
  const u = usageList(row)[index];
  const members = shotMembers(state.rows, row);
  if (!u || members.length < 2) return null;
  snapshot('设置素材位置');
  applySpan(members, u.assetId, from, to);
  const demoted = u.role === 'main' ? applyRole(members, u.assetId, 'main') : [];
  persist();
  refreshAssets(row, { stats: false });
  return demoted.map(id => state.assets?.[id]?.name || '素材');
}

/* ── 主画面的出现时间（1.8，「对着口播看画面」里调）──
   entries：[{assetId, start, end}]，start / end 是相对镜头开头的秒数。一次把这个镜头里所有画面的时间都写上，
   这样拖动一个之后，其他画面的位置也固定下来，不会再随句子范围变。没分配角色的画面（旧项目）顺手设成主画面。 */
export function setShotTimes(row, entries, label = '调整画面出现时间') {
  const members = shotMembers(state.rows, row);
  if (!members.length || !entries?.length) return false;
  const of = members[0].id;
  const want = new Map(entries.map(e => [e.assetId, { start: round1(e.start), end: round1(e.end), of }]));
  const same = [...want].every(([id, at]) => {
    const u = usageList(members[0]).find(x => x.assetId === id);
    return u?.at && u.at.start === at.start && u.at.end === at.end && u.at.of === of && u.role === 'main';
  });
  if (same) return false;
  snapshot(label);
  for (const m of members)
    for (const u of usageList(m)) {
      const at = want.get(u.assetId);
      if (!at) continue;
      u.at = { ...at };
      u.role = 'main';
    }
  persist();
  refreshAssets(row);
  return true;
}

/* 恢复按句子：去掉这个镜头里所有画面的手动时间 */
export function clearShotTimes(row) {
  const members = shotMembers(state.rows, row);
  if (!members.some(m => usageList(m).some(u => u.at))) return false;
  snapshot('画面时间恢复按句子');
  for (const m of members) for (const u of usageList(m)) delete u.at;
  persist();
  refreshAssets(row, { stats: false });
  return true;
}

/* 记下素材的真实时长（只是信息缓存，不进撤销） */
export function rememberDuration(asset, seconds) {
  if (!asset || !isFinite(seconds) || asset.durationSec === seconds) return;
  asset.durationSec = seconds;
  persist();
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
  refreshAssets();
  return { oldName, asset, adjusted };
}

/* 批量重新定位：在一个文件夹的文件清单里按文件名找回失联素材（同名多个时不猜，留给手动） */
export function relinkByNames(missingIds, candidates) {
  const byName = new Map();
  for (const p of candidates) {
    const n = assetName(p);
    byName.set(n, byName.has(n) ? null : p);
  }
  const plan = [];
  for (const id of missingIds) {
    const a = state.assets[id];
    const hit = a && byName.get(a.name || assetName(a.path));
    if (hit) plan.push({ id, path: hit });
  }
  if (!plan.length) return 0;
  snapshot('批量重新定位素材');
  for (const { id, path } of plan) {
    state.assets[id].path = path;
    state.assets[id].name = assetName(path);
  }
  syncMirror(state.rows, state.assets);
  invalidateProbe();
  persist();
  refreshAssets();
  return plan.length;
}

/* 文件探测（存在与否），带缓存；重新定位 / 恢复后调用 invalidateProbe 刷新 */
let probeCache = new Map();
export const invalidateProbe = () => {
  probeCache = new Map();
};
export async function probePaths(paths) {
  const need = [...new Set(paths.filter(p => p && !LINK_RE.test(p) && !probeCache.has(p)))];
  if (need.length) {
    const res = await native.probeAssets(need);
    for (const [p, info] of Object.entries(res || {})) probeCache.set(p, info);
  }
  const out = {};
  for (const p of paths) out[p] = probeCache.get(p) || null;
  return out;
}
export const isMissing = info => info === false || (info && info.exists === false);
