/* 搜索和编号 / 时间直达共用的查询缓存。 */
import { state } from './state.js';
import { viewState } from './view-state.js';
import { timeline, lines, projectRevision } from './project-queries.js';
import { match } from './selection.js';
import { fmtTime } from '../core/text.js';
import { searchLineIds, parseJump, jumpLineIds } from '../core/search.js';
/* 搜索结果与正文高亮共用一份结果，避免把共用备注重复算成组内每一句。 */
let queryKey = '',
  queryRows = null,
  queryTl = null,
  queryIds = [],
  queryJump = null,
  querySet = new Set();
/* 编号 / 时间直达的句子不受类型筛选限制；纯数字、小数点时间直达不到时退回正文搜索。 */
export function queryLineIds() {
  const key = `${projectRevision()}|${state.rows.length}|${viewState.filter}|${viewState.query}`;
  const tl = timeline();
  if (queryRows !== state.rows || queryKey !== key || queryTl !== tl) {
    queryRows = state.rows;
    queryKey = key;
    queryTl = tl;
    const jump = parseJump(viewState.query);
    queryJump = jump ? jumpLineIds(jump, lines(), tl, fmtTime) : null;
    // 纯数字 / 小数点时间能直达就只给那一句；直达不到（比如没有这一句）才当普通文字搜
    const text =
      !jump || (jump.loose && !queryJump.ids.length)
        ? searchLineIds(
            state.rows.filter(r => r.kind === 'line' && match(r)),
            viewState.query,
          )
        : [];
    queryIds = [...new Set([...(queryJump?.ids || []), ...text])];
    if (jump?.loose && text.length) queryJump = null; // 已按文字搜到结果，不再提示「没有第 N 句」
    querySet = new Set(queryIds);
  }
  return queryIds;
}
/* 搜索条上的直达说明（「→ 第 248 句」「26:37 → 第 248 句」），不是编号 / 时间时为空。 */
export function queryJumpLabel() {
  queryLineIds();
  return viewState.query ? queryJump?.label || '' : '';
}
export function qMatch(r) {
  if (!viewState.query) return true;
  queryLineIds();
  return querySet.has(r.id);
}
