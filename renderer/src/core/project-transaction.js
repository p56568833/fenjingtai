/* 同步修改的失败恢复，独立于用户撤销历史。
   恢复时尽量保留原来的行、素材、候选对象，让进行中的任务和项目库引用继续有效。 */
export function captureMutation(target) {
  const data = JSON.stringify(target);
  const references = new WeakMap();
  const remember = value => {
    if (!value || typeof value !== 'object' || references.has(value)) return;
    const children = Array.isArray(value) ? value.slice() : { ...value };
    references.set(value, children);
    Object.values(children).forEach(remember);
  };
  remember(target);
  return { data, references };
}

function restoreValue(target, value, references, state) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (!Array.isArray(target)) return value;
    const original = references.get(target) || target;
    const restored = value.map((item, i) => restoreValue(original[i], item, references, state));
    if (target.length !== restored.length) state.changed = true;
    target.length = restored.length;
    for (let i = 0; i < restored.length; i++) {
      if (!Object.is(target[i], restored[i])) state.changed = true;
      target[i] = restored[i];
    }
    return target;
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) return value;
  for (const key of Object.keys(target))
    if (!Object.hasOwn(value, key)) {
      delete target[key];
      state.changed = true;
    }
  const original = references.get(target) || target;
  for (const [key, item] of Object.entries(value)) {
    const restored = restoreValue(original[key], item, references, state);
    if (!Object.hasOwn(target, key) || !Object.is(target[key], restored)) state.changed = true;
    target[key] = restored;
  }
  return target;
}

export function restoreMutation(target, checkpoint) {
  const data = JSON.parse(checkpoint.data);
  const state = { changed: false };
  for (const key of Object.keys(target))
    if (!Object.hasOwn(data, key)) {
      delete target[key];
      state.changed = true;
    }
  const original = checkpoint.references.get(target) || target || {};
  for (const [key, value] of Object.entries(data)) {
    const restored = restoreValue(original[key], value, checkpoint.references, state);
    if (!Object.hasOwn(target, key) || !Object.is(target[key], restored)) state.changed = true;
    target[key] = restored;
  }
  return state.changed;
}
