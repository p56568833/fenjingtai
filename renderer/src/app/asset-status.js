/* 项目级文件状态，仅作运行期信息；界面和覆盖查询读取同一个结果。 */
import { state } from './state.js';

let projectId = null;
let missing = new Set();
let revision = 0;

export function missingPaths() {
  if (projectId !== state.projectId) {
    projectId = state.projectId;
    missing = new Set();
    revision++;
  }
  return missing;
}
export const missingRevision = () => {
  missingPaths();
  return revision;
};
export function setMissingPaths(paths, ownerId = state.projectId) {
  if (ownerId !== state.projectId) return false;
  const current = missingPaths(),
    next = new Set(paths);
  if (next.size === current.size && [...next].every(p => current.has(p))) return false;
  missing = next;
  revision++;
  return true;
}
