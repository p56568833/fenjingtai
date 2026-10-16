/* 红字、每句画面条和全片总览共用同一份项目覆盖结果。 */
import { state } from './state.js';
import { timeline, types } from './project-queries.js';
import { on } from './events.js';
import { buildPictureCoverage } from '../core/coverage.js';
import { missingPaths, missingRevision } from './asset-status.js';
import { spanOf } from '../core/timeline.js';

let cached = null,
  key = null;
const invalidate = () => {
  cached = null;
};
for (const event of ['project-committed', 'project-loaded', 'durations']) on(event, invalidate);

export function projectPictureCoverage({ refresh = false } = {}) {
  const tl = timeline(),
    lostRevision = missingRevision();
  if (
    refresh ||
    !cached ||
    key.projectId !== state.projectId ||
    key.rows !== state.rows ||
    key.assets !== state.assets ||
    key.types !== state.types ||
    key.timeline !== tl ||
    key.missing !== lostRevision
  ) {
    cached = buildPictureCoverage(state.rows, state.assets || {}, tl, { missing: missingPaths(), types: types().list });
    key = {
      projectId: state.projectId,
      rows: state.rows,
      assets: state.assets,
      types: state.types,
      timeline: tl,
      missing: lostRevision,
    };
  }
  return cached;
}

export function shotSeconds(members) {
  const sp = spanOf(
    timeline(),
    members.map(m => m.id),
  );
  return sp ? sp.end - sp.start : null;
}

/* 是否标红由展示层决定；不需要画面的类型沿用原来的隐藏规则。 */
export function shotLineCoverage(members) {
  const lead = members[0];
  if (!lead) return null;
  const shot = projectPictureCoverage().byShot.get(lead.id);
  return shot?.needsVisual ? shot.lines : null;
}
