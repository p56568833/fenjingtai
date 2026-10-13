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

function restoreValue(target, value, references) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (!Array.isArray(target)) return value;
    const original = references.get(target) || target;
    const restored = value.map((item, i) => restoreValue(original[i], item, references));
    target.splice(0, target.length, ...restored);
    return target;
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) return value;
  for (const key of Object.keys(target)) if (!Object.hasOwn(value, key)) delete target[key];
  const original = references.get(target) || target;
  for (const [key, item] of Object.entries(value)) target[key] = restoreValue(original[key], item, references);
  return target;
}

export function restoreMutation(target, checkpoint) {
  try {
    if (JSON.stringify(target) === checkpoint.data) return false;
  } catch {
    // 修改中意外产生循环引用时，仍能用修改前的有效数据恢复。
  }
  const data = JSON.parse(checkpoint.data);
  for (const key of Object.keys(target)) if (!Object.hasOwn(data, key)) delete target[key];
  const original = checkpoint.references.get(target);
  for (const [key, value] of Object.entries(data))
    target[key] = restoreValue(original[key], value, checkpoint.references);
  return true;
}
