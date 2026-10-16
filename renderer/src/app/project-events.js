import { state } from './state.js';
/* 一次项目提交只发布一份变化说明。界面按实际变化更新；业务动作通知在提交后发出。 */
import { invalidateProjectQueries } from './project-queries.js';
import { emit } from './events.js';
export function publishProjectEvents(change, events = []) {
  invalidateProjectQueries({ timing: change.timing });
  // 先提供一致的数据和变更范围，再触发局部视图；协作冲突检测不用抢在重绘前读取旧节点。
  for (const [event, payload] of events) if (event === 'candidates-changed') emit(event, payload);
  emit('project-committed', change);
  for (const [event, payload] of events) if (event !== 'candidates-changed') emit(event, payload);
}

/* 外部整体替换的保守入口。普通编辑走 changeProject；纯界面变化发 view-refresh。 */
export function update(evt = 'rows') {
  if (evt === 'rows') {
    invalidateProjectQueries();
    emit('project-committed', {
      projectId: state.projectId,
      source: 'external',
      fields: ['rows'],
      rowIds: null,
      rowFields: null,
      structural: true,
      timing: true,
      assets: true,
      candidates: true,
    });
    return;
  }
  emit(evt);
}
