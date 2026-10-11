/* 编辑生命周期的协调点：视图切换只请求提交，不依赖具体编辑器。 */
const flushers = new Set();
export function registerEditFlush(flush) {
  flushers.add(flush);
  return () => flushers.delete(flush);
}
export function flushPendingEdits() {
  for (const flush of [...flushers]) flush();
}
