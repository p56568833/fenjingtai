/* 项目加载边界：旧格式迁移、数据规范化和初始选区。 */
import { state } from './state.js';
import { viewState } from './view-state.js';
import { emit } from './events.js';
import { types, timeline, invalidateProjectQueries } from './project-queries.js';
import { hydrateProjectAssets } from '../core/asset-model.js';
import { projectData, normalizeProjectData } from '../core/project-data.js';
import { syncSpansFromTimes } from '../core/shot-layout.js';
/* 载入一个项目到 state（切换项目 / 初次打开 / 导入）。
   老项目只有 r.assets 文本，hydrateProjectAssets 载入时迁移成素材库 + 使用记录（含片段范围） */
export function loadProjectIntoState(p) {
  state.projectId = p.id;
  Object.assign(p, normalizeProjectData(p));
  hydrateProjectAssets(p);
  Object.assign(state, projectData(p));
  // 清掉 v1.1 短暂存在过的「B roll·未细分」试验类型
  for (const r of state.rows) if (r.kind === 'line' && r.type === 'b' && !types().has('b')) r.type = null;
  viewState.filter = 'all';
  viewState.multi = null;
  viewState.multiMode = false;
  viewState.query = '';
  const first = state.rows.find(r => r.kind === 'line');
  viewState.sel = state.rows.some(r => r.kind === 'line' && r.id === p.cursorId) ? p.cursorId : (first?.id ?? null);
  invalidateProjectQueries();
  syncSpansFromTimes(state.rows, timeline()); // 拖过时间的画面：句子范围跟着时间走
  emit('project-loaded');
}
