/* 远端变更落地：规范化、保存、选择恢复和刷新描述集中在同一处。 */
import { state } from './state.js';
import { viewState } from './view-state.js';
import * as storage from './storage.js';
import { notify } from './events.js';
import { invalidateProbe } from './asset-actions.js';
import { writeBack } from './candidate-sync.js';
import { normalizeGroups } from '../core/shots.js';
import { publishProjectEvents } from './project-events.js';
export function applyRemoteProject(s, sum, { full = false } = {}) {
  const project = storage.projectForId(s.pid);
  if (!project) return;
  sum ||= {
    structural: true,
    assets: true,
    cands: true,
    fields: new Set(),
    meta: new Set(),
    rows: new Set(project.rows.map(r => r.id)),
    removed: [],
  };
  if (full || sum.structural || sum.fields.has('groupId')) normalizeGroups(project.rows);
  if (full || sum.assets) invalidateProbe();
  // 对方的审核结果写回这台电脑上的候选清单（清单文件只在导入它的那台电脑上，写回只管本机有的）
  if (full || sum.cands) writeBack(project.candidates || []);
  if (s.pid !== state.projectId) {
    storage.markProjectDirty(s.pid);
    return;
  }
  storage.persist();
  // 对方的改动已经写进数据、界面还没开始刷新：要和刷新前比一比的（镜头轨认「对方改了这个画面」）先看
  const events = [];
  const has = id => state.rows.some(r => r.id === id && r.kind === 'line');
  if (viewState.sel != null && !has(viewState.sel)) {
    if (sum?.removed?.includes(viewState.sel)) notify(`你停着的这句被${s.peer || '对方'}删掉了`, null, 'info');
    viewState.sel = state.rows.find(r => r.kind === 'line')?.id ?? null;
  }
  if (viewState.multi) {
    viewState.multi = viewState.multi.filter(has);
    if (!viewState.multi.length) viewState.multi = null;
  }
  if (full || sum.cands) events.push(['candidates-changed', {}]);
  const ids = [...sum.rows];
  publishProjectEvents(
    {
      projectId: s.pid,
      source: 'remote',
      fields: [
        ...new Set([
          ...sum.meta,
          ...(ids.length || sum.structural ? ['rows'] : []),
          ...(sum.assets ? ['assets'] : []),
          ...(sum.cands ? ['candidates'] : []),
        ]),
      ],
      full,
      rowFields: [...sum.fields],
      rowIds: ids,
      structural: full || sum.structural,
      timing:
        full ||
        sum.structural ||
        sum.fields.has('text') ||
        sum.fields.has('time') ||
        sum.meta.has('voice') ||
        sum.meta.has('speechRate'),
      assets: full || sum.assets || sum.fields.has('assetUsages') || sum.fields.has('groupId'),
      candidates: full || sum.cands,
    },
    events,
  );
}
