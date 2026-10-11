/* 读进来的稿子 / 项目：项目 JSON 导入时清洗句子，改稿时把旧标注对到新稿上。 */
import { DEFAULT_TYPES } from './types.js';
import { GROUP_ID } from './parse.js';
import { cloneUsages } from './asset-usage.js';
import { STATUS, shots, validGroup } from './shots.js';

const validTime = t => t && Number.isFinite(+t.start) && Number.isFinite(+t.end) && +t.end >= +t.start;
/* 项目 JSON 导入：清洗句子。
   原文件里的 id 是一串不重复的正整数时原样保留（手动秒数 at.of、视频候选 rowId 都按 id 指向句子，保留最省事也最不容易错）；
   有重复 / 缺失 / 非法时才重新编号，并把 at.of 一起换成新 id。旧 id → 新 id 写进 info.idMap，调用方用它改写其他引用 */
export function normalizeProjectRows(rows, types = DEFAULT_TYPES, info = {}) {
  if (!Array.isArray(rows)) throw new Error('项目中没有有效的句子列表');
  const allowed = new Set(types.map(t => t.id));
  const ids = rows.map(r => r?.id);
  const keepIds = ids.every(x => Number.isInteger(x) && x > 0) && new Set(ids).size === ids.length;
  const idMap = new Map();
  let id = 0;
  const nextId = r => {
    const nid = keepIds ? r.id : ++id;
    if (r.id != null && !idMap.has(r.id)) idMap.set(r.id, nid);
    return nid;
  };
  info.idMap = idMap;
  const result = rows.map(r => {
    if (!r || !['line', 'section'].includes(r.kind) || typeof r.text !== 'string') throw new Error('项目格式不完整');
    if (r.kind === 'section') return { id: nextId(r), kind: 'section', text: r.text };
    return {
      id: nextId(r),
      kind: 'line',
      text: r.text,
      type: allowed.has(r.type) ? r.type : null,
      note: typeof r.note === 'string' ? r.note : '',
      assets: typeof r.assets === 'string' ? r.assets : '',
      status: STATUS[r.status] ? r.status : 'todo',
      ...(Array.isArray(r.assetUsages)
        ? { assetUsages: cloneUsages(r.assetUsages.filter(u => u && (u.assetId || u.path))) }
        : {}),
      ...(typeof r.groupId === 'string' && GROUP_ID.test(r.groupId) ? { groupId: r.groupId } : {}),
      para: !!r.para,
      // 待返工的要求 / 「不用返工了」的时间（见 core/rework.js）
      ...(r.rework && typeof r.rework === 'object' && typeof r.rework.note === 'string'
        ? {
            rework: {
              note: r.rework.note,
              at: +r.rework.at || 0,
              ...(typeof r.rework.assetId === 'string' ? { assetId: r.rework.assetId } : {}),
            },
          }
        : {}),
      ...(Number.isFinite(+r.reworkOff) && +r.reworkOff > 0 ? { reworkOff: +r.reworkOff } : {}),
      ...(validTime(r.time)
        ? {
            time: {
              start: +r.time.start,
              end: +r.time.end,
              conf: +r.time.conf || 0,
              st: ['ok', 'low', 'est'].includes(r.time.st) ? r.time.st : 'est',
            },
          }
        : {}),
    };
  });
  // 重新编号时，手动秒数里记的「镜头第一句 id」跟着换
  if (!keepIds)
    for (const r of result)
      for (const u of r.assetUsages || []) if (u.at && idMap.has(u.at.of)) u.at = { ...u.at, of: idMap.get(u.at.of) };
  // A group may not span sections or disconnected runs in an imported project.
  const visited = new Set();
  let last = null;
  for (const r of result) {
    if (r.kind === 'section') {
      last = null;
      continue;
    }
    if (r.groupId && r.groupId !== last) {
      if (visited.has(r.groupId)) throw new Error('共用画面的句子不连续，请检查项目文件');
      visited.add(r.groupId);
    }
    last = r.groupId || null;
  }
  return result;
}
/* Conservative draft update: only unique, unchanged sentences inherit their shot; repeated or edited ones start blank. */
export function reconcileDraft(oldRows, newRows) {
  const key = r => r.text.trim();
  const oldMap = new Map(),
    newCounts = new Map();
  oldRows.filter(r => r.kind === 'line').forEach(r => oldMap.set(key(r), [...(oldMap.get(key(r)) || []), r]));
  newRows.filter(r => r.kind === 'line').forEach(r => newCounts.set(key(r), (newCounts.get(key(r)) || 0) + 1));
  let next = Math.max(0, ...oldRows.map(r => r.id)) + 1,
    kept = 0;
  const result = newRows.map(r => {
    const matches = oldMap.get(key(r));
    if (r.kind === 'line' && matches?.length === 1 && newCounts.get(key(r)) === 1) {
      kept++;
      return { ...matches[0], para: r.para };
    }
    return { ...r, id: next++ };
  });
  for (const group of shots(oldRows).filter(g => g[0].groupId)) {
    const ids = group.map(r => r.id),
      matched = result.filter(r => ids.includes(r.id));
    if (
      matched.length !== ids.length ||
      !validGroup(
        result,
        matched.map(r => r.id),
      ) ||
      matched.some((r, i) => r.id !== ids[i])
    ) {
      matched.forEach(r => {
        delete r.groupId;
      });
    }
  }
  return {
    rows: result,
    kept,
    review: result.filter(r => r.kind === 'line').length - kept,
    removed: oldRows.filter(r => r.kind === 'line' && !result.some(x => x.id === r.id)).length,
  };
}
