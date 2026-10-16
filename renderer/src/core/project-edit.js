/* 小字段编辑先完整校验和计算差异，再一次应用；不开放任意修改回调。
   结构、素材、字幕等复杂操作仍走完整事务。 */
import { projectDelta } from './project-delta.js';
const allowed = {
  project: new Set(['title', 'speechRate']),
  rows: new Set(['text', 'note', 'rework', 'reworkOff']),
  candidates: new Set(['note']),
};
function checkedValue(key, value) {
  if (['title', 'text', 'note'].includes(key)) {
    if (typeof value !== 'string') throw new TypeError(`字段 ${key} 必须是文字`);
  } else if (key === 'speechRate') {
    if (!Number.isFinite(value) || value < 1 || value > 10) throw new TypeError('语速超出范围');
  } else if (key === 'reworkOff') {
    if (value !== undefined && !Number.isFinite(value)) throw new TypeError('返工时间无效');
  } else if (key === 'rework' && value !== undefined) {
    if (!value || typeof value !== 'object' || typeof value.note !== 'string') throw new TypeError('返工意见无效');
    return JSON.parse(JSON.stringify(value));
  }
  return value;
}
export function prepareProjectEdit(project, patch) {
  const before = { rows: [], candidates: [] };
  const after = { rows: [], candidates: [] };
  const writes = [];
  const add = (kind, target, values, old, next) => {
    for (const [key, input] of Object.entries(values)) {
      if (!allowed[kind].has(key)) throw new Error(`局部编辑不支持 ${kind}.${key}`);
      const value = checkedValue(key, input);
      old[key] = target[key];
      next[key] = value;
      if (JSON.stringify(target[key]) === JSON.stringify(value)) continue;
      writes.push({ target, key, value, had: Object.hasOwn(target, key), previous: target[key] });
    }
  };
  for (const kind of Object.keys(patch)) if (!allowed[kind]) throw new Error(`未知编辑范围：${kind}`);
  add('project', project, patch.project || {}, before, after);
  for (const kind of ['rows', 'candidates']) {
    const edits = patch[kind] || [];
    if (!edits.length) continue;
    const index = new Map((project[kind] || []).map(item => [item.id, item]));
    const seen = new Set();
    for (const { id, values } of edits) {
      const target = index.get(id);
      if (!target || seen.has(id)) throw new Error(`编辑对象已失效或重复：${kind}.${id}`);
      seen.add(id);
      const old = { id, ...(kind === 'rows' ? { kind: target.kind } : {}) };
      const next = { ...old };
      add(kind, target, values, old, next);
      before[kind].push(old);
      after[kind].push(next);
    }
  }
  const changes = projectDelta(before, after);
  let applied = [];
  const rollback = () => {
    for (const entry of applied.reverse()) {
      if (entry.had) entry.target[entry.key] = entry.previous;
      else delete entry.target[entry.key];
    }
    applied = [];
  };
  return {
    changed: writes.length > 0,
    changes,
    apply() {
      try {
        for (const entry of writes) {
          if (entry.value === undefined) delete entry.target[entry.key];
          else entry.target[entry.key] = entry.value;
          applied.push(entry);
        }
      } catch (error) {
        rollback();
        throw error;
      }
    },
    rollback,
  };
}
