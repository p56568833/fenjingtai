/* 每句有没有画面（按画面排布算，和预览播出来一样）：表格的「每句的画面」、句子上的「没画面」、审核页的秒数共用这一处。 */
import { state, timeline, types } from './state.js';
import { lineCoverage } from '../core/coverage.js';
import { typeIndex } from '../core/types.js';
import { spanOf } from '../core/timeline.js';

/* 一个画面的口播秒数（含句间停顿，和画面排布同一条时间轴）；不知道时间返回 null */
export function shotSeconds(members) {
  const sp = spanOf(
    timeline(),
    members.map(m => m.id),
  );
  return sp ? sp.end - sp.start : null;
}

/* 这个镜头的类型不需要画面（A roll 等）时返回 null；还没标类型的照样算 */
export function shotLineCoverage(members) {
  const lead = members[0];
  if (!lead || (lead.type && !typeIndex(types().list).needsVisual(lead.type))) return null;
  return lineCoverage(state.assets || {}, members, timeline());
}
