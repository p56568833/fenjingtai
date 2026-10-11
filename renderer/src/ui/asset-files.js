/* 素材文件的状态：是否失联、本地视频的时长（读元数据，不解码画面）。 */
import { state, emit } from '../app/state.js';
import { probePaths, isMissing, rememberDuration } from '../app/asset-actions.js';
import { usageList, kindOf, LINK_RE, referencedAssetIds } from '../core/asset-model.js';
import { probeDuration } from './base/media.js';

let missingSet = new Set(); // 文件失联探测结果（与「无缩略图」「格式不支持」分开统计）
export const missingPaths = () => missingSet;

/* ── 文件时长：表格里用到的本地视频，没记过时长的读一下元数据（不解码画面），记进素材库，
   「文件 / 可用」就有数了。同时最多读 3 个；读不出来的本次不再试 ── */
const durTried = new Set();
const durQueue = [];
let durBusy = 0;
export function probeDurations(onFound) {
  const registry = state.assets || {};
  for (const id of referencedAssetIds(state.rows)) {
    const a = registry[id];
    if (!a || !a.path || Number.isFinite(a.durationSec)) continue;
    if ((a.kind || kindOf(a.path)) !== 'video' || LINK_RE.test(a.path)) continue;
    if (missingSet.has(a.path) || durTried.has(a.path)) continue;
    durTried.add(a.path);
    durQueue.push(a);
  }
  pumpDurations(onFound);
}
function pumpDurations(onFound) {
  while (durBusy < 3 && durQueue.length) {
    const a = durQueue.shift();
    const path = a.path,
      pid = state.projectId;
    durBusy++;
    readDuration(path).then(sec => {
      durBusy--;
      // 等待期间换了项目 / 换了文件：不记。按 id 重新取条目——撤销 / 重做会换成新对象，结果照样记得上
      const cur = state.projectId === pid ? state.assets?.[a.id] : null;
      if (sec && cur?.path === path) {
        rememberDuration(cur, sec);
        const ids = state.rows
          .filter(r => r.kind === 'line' && usageList(r).some(u => u.assetId === a.id))
          .map(r => r.id);
        if (ids.length) onFound?.(ids);
        emit('durations', a.id);
      }
      pumpDurations(onFound);
    });
  }
}
const readDuration = path => probeDuration(path, 15000);

/* 探测素材文件是否还在；结果有变化才回调（重画徽标 / 面板） */
export async function refreshMissing(onChange) {
  const paths = [
    ...new Set(
      Object.values(state.assets || {})
        .map(a => a.path)
        .filter(Boolean),
    ),
  ];
  const probe = await probePaths(paths);
  const next = new Set(paths.filter(p => isMissing(probe[p])));
  const changed = next.size !== missingSet.size || [...next].some(p => !missingSet.has(p));
  missingSet = next;
  if (changed) onChange?.();
}
export const resetMissing = () => {
  missingSet = new Set();
  durTried.clear(); // 换项目 / 重新探测：读不出时长的文件再给一次机会
};
