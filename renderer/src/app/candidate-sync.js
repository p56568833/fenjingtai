import { state, on } from './state.js';
import { emit, notify } from './events.js';
import { reviewPayload } from '../core/candidates.js';
import * as native from '../platform/native.js';

/* ── 写回候选清单 ──
   调用时立刻按「当时的候选」算好每个文件要写的内容（不等 500 毫秒后再读全局状态：期间切了项目也不会写错）；
   内容和上次成功写入的一样就不再写；写失败的记下来，界面上能看到、下次再试。 */
let writeTimer = null;
const pendingWrites = new Map(); // 文件 → 结果列表
const lastWritten = new Map(); // 文件 → 上次写成功的内容（JSON）
const failedFiles = new Map(); // 文件 → 失败原因
export const writeBackFailures = () => [...failedFiles.entries()];
function queueWrites(cands) {
  for (const [file, results] of reviewPayload(cands)) {
    if (
      lastWritten.get(file) === JSON.stringify(results) &&
      !failedFiles.has(file) &&
      !writing &&
      !pendingWrites.has(file)
    )
      continue;
    pendingWrites.set(file, structuredClone(results));
  }
}
async function performWrites(jobs) {
  const out = new Map();
  let newlyFailed = 0;
  for (const [file, results] of jobs) {
    let r;
    try {
      r = await native.writeCandidateReview(file, results);
    } catch (e) {
      r = { ok: false, error: String(e?.message || e) };
    }
    const ok = !!r && r.ok !== false;
    out.set(file, ok);
    if (ok) {
      lastWritten.set(file, JSON.stringify(results));
      failedFiles.delete(file);
    } else {
      if (!failedFiles.has(file)) newlyFailed++;
      failedFiles.set(file, r?.error || '写入失败');
    }
  }
  if (newlyFailed)
    notify(
      `${newlyFailed} 份候选清单没能写回（${[...failedFiles.values()][0]}）。审核结果仍保存在项目里，下次审核时会再试`,
      null,
      'error',
    );
  emit('candidate-sync');
  return out;
}
let writes = Promise.resolve();
let writing = 0;
function runWrites() {
  const jobs = [...pendingWrites.entries()];
  pendingWrites.clear();
  writing++;
  const next = writes.then(() => performWrites(jobs));
  writes = next.catch(() => {}).finally(() => writing--);
  return next;
}

export function writeBack(cands = state.candidates) {
  queueWrites(cands);
  clearTimeout(writeTimer);
  writeTimer = setTimeout(runWrites, 500);
}
/* 立即写完（返回每个文件是否写成功） */
export const flushWriteBack = (cands = state.candidates) => {
  clearTimeout(writeTimer);
  queueWrites(cands);
  return runWrites();
};
/* 这些候选的结果是否已经原样在清单文件里了 */
export function syncedFiles(cands) {
  const ok = new Set();
  for (const [file, results] of reviewPayload(cands))
    if (!failedFiles.has(file) && lastWritten.get(file) === JSON.stringify(results)) ok.add(file);
  return ok;
}

on('history', () => {
  if (state.candidates.length) writeBack();
});
