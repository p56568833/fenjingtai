/* 事件总线：数据层（app/）只广播「发生了什么」，界面层（ui/、features/）订阅后自己决定怎么刷。
   数据层因此不需要知道任何 DOM。
   常用事件：
     rows            结构或标注变化 → 全量重渲染
     selection       只变选中态 → 原地高亮
     marks {ids}     这些句子的类型变了（界面可原地刷新）
     notes {ids}     这些句子的画面描述变了
     text {id}       这句的文字变了
     workspace       侧栏 / 工具条 / 徽标需要刷新
     cursor          光标换句
     annotated {ids, type}
     project-loaded  切换 / 载入项目
     history {sel}   撤销 / 重做恢复了快照
     types           当前项目的类型表变了
     voice           口播音频变了
     notify {msg, action}   给用户的一句提示（由界面层 toast 出来） */
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
export const notify = (msg, action) => emit('notify', { msg, action });
