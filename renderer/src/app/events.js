/* 事件总线：数据层（app/）只广播「发生了什么」，界面层（ui/、features/）订阅后自己决定怎么刷。
   数据层因此不需要知道任何 DOM。
   常用事件：
     project-committed {projectId,source,fields,rowIds,rowFields,structural,timing,assets,candidates} 一次已完成的项目修改
     view-refresh    筛选或布局改变，需要重新呈现当前视图（不修改项目或失效数据缓存）
     view-painted    表格/原文已更新，播放高亮可重新附着
     selection       只变选中态 → 原地高亮
     candidates-changed {resetIds?, removedIds?} 候选生命周期：在项目通知前清理旧的展开与缩略图
     candidate-sync  清单写回状态变化
     candidate-media 媒体任务状态变化
     candidate-progress {projectId, id, p} 原项目候选的截取进度
     workspace       界面布局 / 侧栏刷新请求（仅界面层使用）
     cursor          光标换句
     annotated {ids, type}
     project-loaded  切换 / 载入项目
     history {sel}   撤销 / 重做恢复了快照
     notify {msg, action, kind}   给用户的一句提示（由界面层 toast 出来；kind 见 ui/dom.js toast） */
const listeners = new Map();

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt)?.delete(fn);
}
export function emit(evt, payload) {
  for (const fn of [...(listeners.get(evt) || [])]) fn(payload);
}

/* 数据层给用户的提示：不直接操作 DOM，由界面层注册的 notify 处理 */
export const notify = (msg, action, kind) => emit('notify', { msg, action, kind });
