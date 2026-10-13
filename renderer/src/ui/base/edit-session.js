/* 编辑生命周期的协调点：视图切换请求提交，后台刷新等待输入结束。 */
const flushers = new Set();
export function registerEditFlush(flush) {
  flushers.add(flush);
  return () => flushers.delete(flush);
}
export function flushPendingEdits() {
  for (const flush of [...flushers]) flush();
}

const deferred = new Map();
let listening = false;
let resumeTimer = null;
function editingIn(root) {
  const el = document.activeElement;
  return (
    !!el?.closest?.(root) &&
    (el.isContentEditable ||
      el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range)$/.test(el.type)))
  );
}
export const clearDeferredRender = key => deferred.delete(key);
export function deferRenderWhileEditing(key, root, render) {
  if (!editingIn(root)) return false;
  deferred.set(key, { root, render });
  if (!listening) {
    listening = true;
    document.addEventListener('focusout', () => {
      clearTimeout(resumeTimer);
      // 失焦提交先完成，再按最新数据刷新；移到另一个编辑器时继续等待。
      resumeTimer = setTimeout(() => {
        for (const [name, job] of [...deferred]) {
          if (editingIn(job.root)) continue;
          deferred.delete(name);
          job.render();
        }
      }, 0);
    });
  }
  return true;
}
