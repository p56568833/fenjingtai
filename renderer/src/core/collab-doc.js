/* 局域网协作的数据规则（纯函数，无 DOM、无应用状态）。
   · 共享形态：两台电脑之间只传「共享形态」的项目。每台电脑自己的东西不传：
     候选片段保存在本机哪里（savedPath）、候选清单文件在哪（srcFile）、片段下载文件夹、光标位置、素材的旧版文本镜像。
     本机已保存到本地的候选片段，在共享形态里还原成在线地址和原片里的入出点；
     对方收到后，按他电脑上有没有保存过这段，再换成他自己的本地文件。
   · 改动 = 字段级操作：句子按 id 逐字段比较，素材 / 候选按 id 整条比较，项目信息按字段比较；同一处以后改的为准。
   · 句子顺序用「位置键」表示（可以无限细分的字符串，按字典序排）：插句、挪句只改动到的那几句，
     两个人同时在不同地方插句不会互相打乱。
   · base：本机记着的「共享形态」（每项存成稳定排序的 JSON 字符串，比较快）。本机改动 = 本机项目和 base 的差。 */
import { assetName, syncMirror } from './asset-model.js';
import { remotePath, localClip } from './candidates.js';
import { projectFieldKeys } from './project-data.js';

export const COLLAB_PROTO = 1;
export const META_KEYS = projectFieldKeys('sharedMeta');
const ROW_SKIP = new Set(['no', 'assets']); // 句号现算；素材文本镜像里是本机路径，各自生成
const ASSET_SKIP = new Set(['durationSec']); // 时长是各自读文件得到的
const CAND_LOCAL = ['savedPath', 'srcFile'];

/* 键排好序的 JSON：同样的内容一定得到同样的字符串 */
export function stable(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const keys = Object.keys(v)
    .filter(k => v[k] !== undefined)
    .sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
const clone = v => (v === undefined ? undefined : structuredClone(v));
const rid = k => (/^\d+$/.test(k) ? Number(k) : k);

/* ── 位置键 ── */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const digit = (s, i) => (i < s.length ? DIGITS.indexOf(s[i]) : 0);
/* lo < 结果 < hi；lo 为 '' 表示最前，hi 为 null 表示最后。结果不以 0 结尾，所以每个键只有一种写法 */
export function keyBetween(lo, hi) {
  lo = lo || '';
  let out = '';
  for (let i = 0; ; i++) {
    const a = digit(lo, i);
    const b = hi == null ? BASE : digit(hi, i);
    if (b - a > 1) return out + DIGITS[(a + b) >> 1];
    out += DIGITS[a];
    if (b - a === 1) hi = null; // 前缀已经比 hi 小，后面随便取
  }
}
/* n 个均匀分布的键（对半分，键长只按 log 增长）。site：本机记号（一个非 0 字符），
   两台电脑在同一处同时插句也不会得到同一个键 */
export function keysBetween(lo, hi, n, site = '') {
  if (n <= 0) return [];
  const mid = keyBetween(lo, hi) + site;
  const left = (n - 1) >> 1;
  return [...keysBetween(lo, mid, left, site), mid, ...keysBetween(mid, hi, n - 1 - left, site)];
}
export const comparePos = (pa, pb, ida, idb) =>
  pa < pb ? -1 : pa > pb ? 1 : String(ida) < String(idb) ? -1 : String(ida) > String(idb) ? 1 : 0;

/* 按新顺序给句子分配位置键：已有键、相对顺序没变的句子（最长递增子序列）保持原键，
   新句和被挪动的句子在前后邻居之间重新取键。返回 { pos, changed } */
export function assignPositions(ids, prev, site = '') {
  const tails = [],
    tailIdx = [],
    parent = new Array(ids.length).fill(-1);
  ids.forEach((id, i) => {
    const k = prev[id];
    if (k == null) return;
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (tails[m] < k) lo = m + 1;
      else hi = m;
    }
    tails[lo] = k;
    tailIdx[lo] = i;
    parent[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  });
  const keep = new Set();
  for (let i = tails.length ? tailIdx[tails.length - 1] : -1; i >= 0; i = parent[i]) keep.add(i);
  const pos = {},
    changed = [];
  for (let i = 0; i < ids.length;) {
    if (keep.has(i)) {
      pos[ids[i]] = prev[ids[i]];
      i++;
      continue;
    }
    let j = i;
    while (j < ids.length && !keep.has(j)) j++;
    const keys = keysBetween(i > 0 ? pos[ids[i - 1]] : '', j < ids.length ? prev[ids[j]] : null, j - i, site);
    for (let t = i; t < j; t++) {
      pos[ids[t]] = keys[t - i];
      if (prev[ids[t]] !== keys[t - i]) changed.push(ids[t]);
    }
    i = j;
  }
  return { pos, changed };
}

/* 把 ids 这几句挪到位置键对应的地方（其余句子相对顺序不动；没有键的句子原地不动） */
export function placeRows(rows, ids, pos) {
  const want = new Set(ids.map(String));
  const key = r => pos[String(r.id)];
  const less = (a, b) => comparePos(key(a), key(b), a.id, b.id) < 0;
  const moving = rows.filter(r => want.has(String(r.id))).sort((a, b) => comparePos(key(a), key(b), a.id, b.id));
  const rest = rows.filter(r => !want.has(String(r.id)));
  const out = [];
  let j = 0;
  for (const r of rest) {
    while (j < moving.length && key(r) != null && less(moving[j], r)) out.push(moving[j++]);
    out.push(r);
  }
  while (j < moving.length) out.push(moving[j++]);
  rows.splice(0, rows.length, ...out);
}

/* 新句子的编号：两人协作时主机用双数、加入的人用单数，同时插句不会撞号；
   floor = 这个项目用过的最大编号（删掉的句子编号也不再用） */
export function nextRowId(rows, { parity = null, floor = 0 } = {}) {
  let max = floor;
  for (const r of rows) if (typeof r.id === 'number' && r.id > max) max = r.id;
  let id = max + 1;
  if (parity === 0 || parity === 1) while (id % 2 !== parity) id++;
  return id;
}

/* ── 本机形态 ↔ 共享形态 ── */
/* ctx：本机哪些候选片段已经保存到本地（素材 id → 候选），以及本机自己重新定位过的文件（共享路径 → 本机路径） */
export function makeCtx(project, pathMap = {}) {
  const saved = new Map();
  for (const c of project.candidates || []) if (c.savedPath && c.assetId && c.url) saved.set(c.assetId, c);
  const reverse = {};
  for (const [shared, local] of Object.entries(pathMap || {})) reverse[local] = shared;
  return { saved, project, pathMap: pathMap || {}, reverse };
}
/* 这个素材在本机是不是「已保存到本地的候选片段」 */
function localSaved(ctx, assetId) {
  const c = ctx.saved.get(assetId);
  return c && (ctx.project.assets || {})[assetId]?.path === c.savedPath ? c : null;
}
const r2 = n => Math.round(n * 100) / 100;
const needsBase = (row, ctx) =>
  Array.isArray(row.assetUsages) && row.assetUsages.some(u => localSaved(ctx, u?.assetId));

export function sharedRow(row, ctx, baseRow = null) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!ROW_SKIP.has(k) && v !== undefined) out[k] = clone(v);
  if (Array.isArray(out.assetUsages))
    out.assetUsages = out.assetUsages.map((u, i) => {
      const c = u && localSaved(ctx, u.assetId);
      if (!c) return u;
      // 换算回原片里的入出点；和 base 里那条换算到本地后一样，就原样用 base 的（不让四舍五入来回漂）
      const was = baseRow?.assetUsages?.[i];
      if (was?.assetId === u.assetId && stable(localClip(was.clip, c)) === stable(u.clip ?? null))
        return { ...u, clip: clone(was.clip) };
      const clip = u.clip ? { in: r2(u.clip.in + c.in), out: r2(u.clip.out + c.in) } : { in: c.in, out: c.out };
      return { ...u, clip };
    });
  return out;
}
export function localRow(shared, ctx) {
  const out = clone(shared);
  if (Array.isArray(out.assetUsages))
    out.assetUsages = out.assetUsages.map(u => {
      const c = u && localSaved(ctx, u.assetId);
      if (!c) return u;
      const next = { ...u };
      const clip = localClip(u.clip, c);
      if (clip) next.clip = clip;
      else delete next.clip;
      return next;
    });
  return out;
}
export function sharedAsset(a, ctx) {
  const out = {};
  for (const [k, v] of Object.entries(a)) if (!ASSET_SKIP.has(k) && v !== undefined) out[k] = clone(v);
  const c = localSaved(ctx, a.id);
  if (c) {
    out.path = remotePath(c);
    out.name = c.title || out.name;
  } else if (ctx.reverse[out.path]) {
    out.path = ctx.reverse[out.path];
    out.name = assetName(out.path);
  }
  return out;
}
export function localAsset(shared, ctx, existing) {
  const out = clone(shared);
  const c = ctx.saved.get(out.id);
  if (c && out.path === remotePath(c)) {
    out.path = c.savedPath;
    out.name = assetName(c.savedPath);
    out.kind = 'video';
  } else if (ctx.pathMap[out.path]) {
    out.path = ctx.pathMap[out.path];
    out.name = assetName(out.path);
  }
  if (existing?.durationSec && existing.path === out.path) out.durationSec = existing.durationSec;
  return out;
}
export function sharedCand(c) {
  const out = {};
  for (const [k, v] of Object.entries(c)) if (!CAND_LOCAL.includes(k) && v !== undefined) out[k] = clone(v);
  return out;
}
/* 对方改过的候选合进本机那条（原对象原地改，进行中的保存任务认得出它）：本机的保存位置、清单位置留着；
   链接或入出点变了，本机保存的那段就不是它了 */
function mergeCand(existing, shared) {
  const keep = {};
  if (existing.srcFile) keep.srcFile = existing.srcFile;
  if (existing.savedPath && existing.url === shared.url && existing.in === shared.in && existing.out === shared.out)
    keep.savedPath = existing.savedPath;
  for (const k of Object.keys(existing)) delete existing[k];
  return Object.assign(existing, clone(shared), keep);
}
function setFields(target, fields) {
  for (const k of Object.keys(target)) if (!(k in fields)) delete target[k];
  return Object.assign(target, fields);
}
/* 项目信息的共享形态：口播音频的文件位置和素材一样，本机重新定位 / 从对方取过来的只算本机 */
const metaOf = (project, k, ctx) => {
  const v = project[k];
  if (k === 'speechRate') return Number(v) || 4.5;
  if (k === 'voice' && v?.path && ctx?.reverse[v.path]) {
    const path = ctx.reverse[v.path];
    return { ...v, path, name: assetName(path) };
  }
  return v ?? null;
};
const localMeta = (k, v, ctx) => {
  if (k === 'voice' && v?.path && ctx?.pathMap[v.path]) {
    const path = ctx.pathMap[v.path];
    return { ...v, path, name: assetName(path) };
  }
  return clone(v ?? null);
};

/* ── base ── */
export const emptyBase = () => ({ meta: {}, rows: {}, pos: {}, assets: {}, cands: {}, candOrder: [], maxId: 0 });

/* 操作的「键」：同一个键的两次改动，后一次盖掉前一次 */
export function opKey(op) {
  switch (op.t) {
    case 'r':
    case 'rd':
      return `r:${op.id}`;
    case 'rf':
      return `f:${op.id}:${op.k}`;
    case 'p':
      return `p:${op.id}`;
    case 'a':
      return `a:${op.id}`;
    case 'c':
      return `c:${op.id}`;
    case 'co':
      return 'co';
    default:
      return `m:${op.k}`;
  }
}

/* 本机项目和 base 比，得到要发给对方的操作；base 同时更新成本机现在的样子 */
export function diffProject(base, project, ctx, site = '') {
  const ops = [];
  const cands = project.candidates || [];
  const seenC = new Set();
  for (const c of cands) {
    seenC.add(String(c.id));
    const s = sharedCand(c),
      str = stable(s);
    if (base.cands[c.id] !== str) {
      ops.push({ t: 'c', id: c.id, v: s });
      base.cands[c.id] = str;
    }
  }
  for (const id of Object.keys(base.cands))
    if (!seenC.has(id)) {
      ops.push({ t: 'c', id, v: null });
      delete base.cands[id];
    }
  const order = cands.map(c => c.id);
  if (stable(order) !== stable(base.candOrder)) {
    ops.push({ t: 'co', v: order });
    base.candOrder = order;
  }
  const assets = project.assets || {};
  for (const [id, a] of Object.entries(assets)) {
    const s = sharedAsset(a, ctx),
      str = stable(s);
    if (base.assets[id] !== str) {
      ops.push({ t: 'a', id, v: s });
      base.assets[id] = str;
    }
  }
  for (const id of Object.keys(base.assets))
    if (!(id in assets)) {
      ops.push({ t: 'a', id, v: null });
      delete base.assets[id];
    }
  for (const k of META_KEYS) {
    const v = metaOf(project, k, ctx),
      str = stable(v);
    if (base.meta[k] !== str) {
      ops.push({ t: 'm', k, v: clone(v) });
      base.meta[k] = str;
    }
  }
  const rows = project.rows || [];
  const { pos } = assignPositions(
    rows.map(r => r.id),
    base.pos,
    site,
  );
  const seen = new Set();
  for (const r of rows) {
    const k = String(r.id);
    seen.add(k);
    if (typeof r.id === 'number' && r.id > base.maxId) base.maxId = r.id;
    const prevStr = base.rows[k];
    const baseRow = prevStr !== undefined && needsBase(r, ctx) ? JSON.parse(prevStr) : null;
    const s = sharedRow(r, ctx, baseRow),
      str = stable(s);
    if (prevStr === undefined) {
      ops.push({ t: 'r', id: r.id, v: s, pos: pos[k] });
      base.rows[k] = str;
      base.pos[k] = pos[k];
      continue;
    }
    if (prevStr !== str) {
      const old = baseRow || JSON.parse(prevStr);
      for (const f of new Set([...Object.keys(old), ...Object.keys(s)]))
        if (stable(old[f]) !== stable(s[f]))
          ops.push(s[f] === undefined ? { t: 'rf', id: r.id, k: f } : { t: 'rf', id: r.id, k: f, v: s[f] });
      base.rows[k] = str;
    }
    if (base.pos[k] !== pos[k]) {
      ops.push({ t: 'p', id: r.id, v: pos[k] });
      base.pos[k] = pos[k];
    }
  }
  for (const k of Object.keys(base.rows))
    if (!seen.has(k)) {
      ops.push({ t: 'rd', id: rid(k) });
      delete base.rows[k];
      delete base.pos[k];
    }
  return ops;
}

/* 按「键」从 base 取当前值重新组成操作（断线期间攒下的改动，重连后补发） */
export function opsForKeys(keys, base) {
  const ops = [];
  const parse = s => (s === undefined ? undefined : JSON.parse(s));
  for (const key of keys) {
    const [kind, a, ...rest] = key.split(':');
    if (kind === 'co') ops.push({ t: 'co', v: clone(base.candOrder) });
    else if (kind === 'm' && a in base.meta) ops.push({ t: 'm', k: a, v: parse(base.meta[a]) });
    else if (kind === 'a') ops.push({ t: 'a', id: a, v: a in base.assets ? parse(base.assets[a]) : null });
    else if (kind === 'c') ops.push({ t: 'c', id: a, v: a in base.cands ? parse(base.cands[a]) : null });
    else if (kind === 'r')
      ops.push(
        a in base.rows ? { t: 'r', id: rid(a), v: parse(base.rows[a]), pos: base.pos[a] } : { t: 'rd', id: rid(a) },
      );
    else if (kind === 'p' && a in base.pos) ops.push({ t: 'p', id: rid(a), v: base.pos[a] });
    else if (kind === 'f' && a in base.rows) {
      const k = rest.join(':');
      const row = parse(base.rows[a]);
      ops.push(row[k] === undefined ? { t: 'rf', id: rid(a), k } : { t: 'rf', id: rid(a), k, v: row[k] });
    }
  }
  // 插句要排在同一句的字段 / 位置之前；字段在插句里已经带上了
  const inserted = new Set(ops.filter(o => o.t === 'r').map(o => String(o.id)));
  return [
    ...ops.filter(o => o.t !== 'rf' && o.t !== 'p'),
    ...ops.filter(o => (o.t === 'rf' || o.t === 'p') && !inserted.has(String(o.id))),
  ];
}

/* 把对方的操作合进本机项目（原对象原地改）。base 为 null 时只改项目（撤销时把对方的改动补进旧快照用），
   位置键这时从 opts.pos 取。skip(op) 为真的跳过：本机还有没被对方确认的改动盖着这一项。
   返回摘要：哪些句子改了哪些字段、有没有增删挪句、项目信息 / 素材 / 候选有没有变 */
export function applyOps(project, base, ops, { pathMap = {}, skip = () => false, pos = null } = {}) {
  const sum = {
    rows: new Set(),
    fields: new Set(),
    structural: false,
    removed: [],
    meta: new Set(),
    assets: false,
    cands: false,
    applied: [],
  };
  const take = op => {
    if (skip(op)) return false;
    sum.applied.push(op);
    return true;
  };
  const posMap = base ? base.pos : { ...(pos || {}) }; // 撤销补改动时用副本，不动现在的位置键
  // 1. 候选先合：素材、句子要按本机候选判断哪些片段已经存在本地
  project.candidates ||= [];
  for (const op of ops) {
    if ((op.t !== 'c' && op.t !== 'co') || !take(op)) continue;
    sum.cands = true;
    const list = project.candidates;
    if (op.t === 'co') {
      if (base) base.candOrder = clone(op.v);
      const idx = new Map(op.v.map((id, i) => [String(id), i]));
      const at = c => idx.get(String(c.id)) ?? Infinity;
      project.candidates = [...list].sort((a, b) => at(a) - at(b));
      continue;
    }
    const i = list.findIndex(c => String(c.id) === String(op.id));
    if (op.v == null) {
      if (base) delete base.cands[op.id];
      if (i >= 0) project.candidates = list.filter((_, j) => j !== i);
      continue;
    }
    if (base) base.cands[op.id] = stable(op.v);
    if (i >= 0) mergeCand(list[i], op.v);
    else project.candidates = [...list, clone(op.v)];
  }
  // 2. 素材
  project.assets ||= {};
  const ctx = makeCtx(project, pathMap);
  for (const op of ops) {
    if (op.t !== 'a' || !take(op)) continue;
    sum.assets = true;
    if (op.v == null) {
      if (base) delete base.assets[op.id];
      delete project.assets[op.id];
      continue;
    }
    if (base) base.assets[op.id] = stable(op.v);
    const existing = project.assets[op.id];
    const next = localAsset(op.v, ctx, existing);
    if (existing) setFields(existing, next);
    else project.assets[op.id] = next;
  }
  // 3. 项目信息
  for (const op of ops) {
    if (op.t !== 'm' || !META_KEYS.includes(op.k) || !take(op)) continue;
    if (base) base.meta[op.k] = stable(op.v ?? null);
    project[op.k] = localMeta(op.k, op.v, ctx);
    sum.meta.add(op.k);
  }
  // 4. 句子
  const rows = project.rows || (project.rows = []);
  const byId = new Map(rows.map(r => [String(r.id), r]));
  const place = [];
  for (const op of ops) {
    if (!['r', 'rf', 'rd', 'p'].includes(op.t) || !take(op)) continue;
    const k = String(op.id);
    if (op.t === 'rd') {
      if (base) {
        delete base.rows[k];
        delete base.pos[k];
      }
      const r = byId.get(k);
      if (r) {
        rows.splice(rows.indexOf(r), 1);
        byId.delete(k);
        sum.removed.push(op.id);
        sum.structural = true;
      }
      continue;
    }
    if (op.t === 'r') {
      if (base) {
        base.rows[k] = stable(op.v);
        if (typeof op.id === 'number' && op.id > base.maxId) base.maxId = op.id;
      }
      posMap[k] = op.pos;
      const next = localRow(op.v, ctx);
      const r = byId.get(k);
      if (r) setFields(r, next);
      else {
        rows.push(next);
        byId.set(k, next);
      }
      place.push(k);
      sum.rows.add(op.id);
      sum.structural = true;
      continue;
    }
    if (op.t === 'p') {
      posMap[k] = op.v;
      if (byId.has(k)) {
        place.push(k);
        sum.structural = true;
      }
      continue;
    }
    const del = op.v === undefined;
    if (base && base.rows[k] !== undefined) {
      const o = JSON.parse(base.rows[k]);
      if (del) delete o[op.k];
      else o[op.k] = op.v;
      base.rows[k] = stable(o);
    }
    const r = byId.get(k);
    if (!r) continue;
    if (del) delete r[op.k];
    else r[op.k] = op.k === 'assetUsages' ? localRow({ assetUsages: op.v }, ctx).assetUsages : clone(op.v);
    sum.rows.add(op.id);
    sum.fields.add(op.k);
  }
  if (place.length) placeRows(rows, place, posMap);
  if (sum.structural || sum.assets || sum.fields.has('assetUsages')) syncMirror(rows, project.assets);
  return sum;
}

/* ── 整份内容（加入 / 重连时主机发过来的） ── */
export function docFromBase(base) {
  const parseAll = o => Object.fromEntries(Object.entries(o).map(([k, s]) => [k, JSON.parse(s)]));
  return {
    meta: parseAll(base.meta),
    rows: parseAll(base.rows),
    pos: { ...base.pos },
    assets: parseAll(base.assets),
    cands: parseAll(base.cands),
    candOrder: [...base.candOrder],
    maxId: base.maxId,
  };
}
export function baseFromDoc(doc) {
  const strAll = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, stable(v)]));
  return {
    meta: strAll(doc.meta),
    rows: strAll(doc.rows),
    pos: { ...(doc.pos || {}) },
    assets: strAll(doc.assets),
    cands: strAll(doc.cands),
    candOrder: [...(doc.candOrder || [])],
    maxId: Number(doc.maxId) || 0,
  };
}
/* 本机项目换成整份内容（本机的保存位置等照旧接上） */
export function loadDoc(project, doc, pathMap = {}) {
  const old = new Map((project.candidates || []).map(c => [String(c.id), c]));
  const ids = [...(doc.candOrder || [])];
  const listed = new Set(ids.map(String));
  for (const id of Object.keys(doc.cands || {})) if (!listed.has(id)) ids.push(id);
  project.candidates = ids
    .filter(id => doc.cands[id])
    .map(id => (old.has(String(id)) ? mergeCand(old.get(String(id)), doc.cands[id]) : clone(doc.cands[id])));
  const oldAssets = project.assets || {};
  project.assets = {};
  const ctx = makeCtx(project, pathMap);
  for (const [id, a] of Object.entries(doc.assets || {})) project.assets[id] = localAsset(a, ctx, oldAssets[id]);
  for (const k of META_KEYS) if (k in (doc.meta || {})) project[k] = localMeta(k, doc.meta[k], ctx);
  const pos = doc.pos || {};
  project.rows = Object.entries(doc.rows || {})
    .sort(([a], [b]) => comparePos(pos[a], pos[b], a, b))
    .map(([, r]) => localRow(r, ctx));
  syncMirror(project.rows, project.assets);
  return project;
}
/* 从本机项目建 base（开始共享 / 启动时恢复）：已有的位置键沿用，没有的补上 */
export function buildBase(project, ctx, { pos = {}, maxId = 0, site = '' } = {}) {
  const base = emptyBase();
  base.maxId = Number(maxId) || 0;
  // 已删句子的位置键不要；现有句子的键沿用（顺序没变时 assignPositions 不改它们），没有键的补上
  const live = new Set((project.rows || []).map(r => String(r.id)));
  for (const [k, v] of Object.entries(pos || {})) if (live.has(k)) base.pos[k] = v;
  diffProject(base, project, ctx, site);
  return base;
}
