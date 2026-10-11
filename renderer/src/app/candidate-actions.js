/* 视频审核的数据操作：页面不直接修改候选、素材或返工标记。 */
import { state, rowById, renumber } from './state.js';
import { changeProject } from './project-change.js';
import { forgetPurged } from './undo.js';
import { writeBack, flushWriteBack, syncedFiles } from './candidate-sync.js';
import { candidateBatches } from '../core/candidate-queries.js';
import { shotMembers } from '../core/shots.js';
import { assetName } from '../core/asset-model.js';
import { fmtTime } from '../core/text.js';
import { planImport, attachCandidate, detachCandidate, applyFor, DECISION } from '../core/candidates.js';
import { reworkShots, resolveOnApprove, setRework, setAssetRework, dismissRework } from '../core/rework.js';

/* 不持久化的任务版本：原地更新、撤回再通过也会使旧任务失效。撤销生成的新对象同样不能冒充原任务。 */
const versions = new WeakMap();
export const candidateVersion = c => versions.get(c) || 0;
const invalidateCandidate = c => versions.set(c, candidateVersion(c) + 1);

function batchNameOf(doc, srcFile, plan) {
  const given = String(doc.batch || doc.title || '').trim();
  if (given) return given.slice(0, 40);
  const sections = new Map();
  let section = '';
  for (const r of state.rows) {
    if (r.kind === 'section') section = r.text;
    sections.set(r.id, section);
  }
  const names = [
    ...new Set([...plan.added, ...plan.updated.map(x => x.next)].map(c => sections.get(c.rowId)).filter(Boolean)),
  ];
  return names.length === 1
    ? names[0]
    : names.length
      ? `${names[0]} 等 ${names.length} 章`
      : assetName(srcFile || '') || '视频候选';
}

export function importCandidateData(doc, srcFile) {
  renumber();
  const plan = planImport(doc, srcFile, state.rows, state.candidates);
  if (plan.error || (!plan.added.length && !plan.updated.length)) return plan;
  const batch = {
    batchId: 'vb-' + crypto.randomUUID(),
    batchAt: Date.now(),
    batchName: batchNameOf(doc, srcFile, plan),
    batchNo: Math.max(0, ...candidateBatches(state.candidates).map(b => b.number)) + 1,
  };
  const result = changeProject('导入视频候选', change => {
    let reset = 0;
    const resetIds = [];
    for (const { old, next, changed } of plan.updated) {
      const forChanged = (old.for || '') !== (next.for || '');
      if (changed) {
        invalidateCandidate(old);
        if (old.decision === 'ok' && old.assetId) {
          detachCandidate(old, state.rows, state.assets);
          reset++;
        }
        delete old.assetId;
        delete old.savedPath;
        delete old.decidedAt;
        resetIds.push(old.id);
      }
      Object.assign(old, next);
      const lead = forChanged && old.decision === 'ok' && old.assetId ? rowById(old.rowId) : null;
      if (lead) applyFor(old, shotMembers(state.rows, lead), old.assetId);
      if (!old.decision) Object.assign(old, batch);
    }
    for (const c of plan.added) Object.assign(c, batch);
    state.candidates = [...state.candidates, ...plan.added];
    change.emit('candidates-changed', { resetIds });
    change.emit('rows');
    return { ...plan, batch, reset };
  });
  if (result.reset) writeBack();
  return result;
}

export function decideCandidate(id, decision) {
  const c = state.candidates.find(x => x.id === id);
  if (!c || !Object.hasOwn(DECISION, decision)) return null;
  const next = c.decision === decision ? '' : decision;
  if (next === 'ok' && !rowById(c.rowId)) return { error: '找不到这个候选对应的句子' };
  const result = changeProject(next ? `视频候选：${DECISION[next]}` : '撤回审核', change => {
    let msg = '';
    if (c.decision === 'ok' && next !== 'ok') {
      detachCandidate(c, state.rows, state.assets);
      msg = '已从画面上撤下这个视频 · ⌘Z 可撤销';
    }
    if (next === 'ok') {
      const r = attachCandidate(c, state.rows, state.assets);
      if (r.error) return r;
      c.assetId = r.assetId;
      const old = resolveOnApprove(state.rows, rowById(c.rowId), r.assetId);
      const names = [...new Set([...r.demoted, ...old])].map(x => state.assets[x]?.name || '素材');
      msg = `已挂成主画面（${fmtTime(c.in)}–${fmtTime(c.out)}）${names.length ? `，「${names.join('」「')}」让位成备选` : ''}`;
    }
    invalidateCandidate(c);
    c.decision = next;
    if (next) c.decidedAt = Date.now();
    else delete c.decidedAt;
    change.emit('rows');
    return { candidate: c, next, msg };
  });
  if (!result?.error) writeBack();
  return result;
}

/* 意见打字即存；同一次编辑（session）只拍一张快照，撤销回到这次编辑前 */
export function setCandidateNote(id, text, session) {
  const c = state.candidates.find(x => x.id === id);
  if (!c || (c.note || '') === text) return;
  // 立即把内存改动登记待保存，防抖由存储层负责；切项目不会丢最后一句意见。
  changeProject(session?.snapped ? null : '编辑审核意见', () => {
    if (session) session.snapped = true;
    c.note = text;
  });
  writeBack();
}

export function deleteCandidateBatch(ids) {
  const removed = state.candidates.filter(c => ids.has(c.id));
  if (!removed.length) return [];
  // 清单仍保留原审核结果，删除审核批次不等于否决视频。
  writeBack();
  return changeProject('删除视频审核批次', change => {
    for (const b of candidateBatches(state.candidates)) for (const c of b.cands) c.batchNo = b.number;
    for (const c of removed) invalidateCandidate(c);
    state.candidates = state.candidates.filter(c => !ids.has(c.id));
    change.emit('candidates-changed', { removedIds: removed.map(c => c.id) });
    change.emit('rows');
    return removed;
  });
}

export async function purgeRejectedCandidates() {
  const pid = state.projectId,
    cands = state.candidates;
  if (!cands.some(c => c.decision === 'no')) return [];
  await flushWriteBack(cands);
  if (state.projectId !== pid || state.candidates !== cands) return [];
  const synced = syncedFiles(cands);
  const keep = new Set(reworkShots(state.rows, cands).flatMap(s => s.rejected));
  const drop = c => c.decision === 'no' && !keep.has(c) && (!c.srcFile || synced.has(c.srcFile));
  const removed = cands.filter(drop);
  if (!removed.length) return [];
  return changeProject(null, change => {
    state.candidates = cands.filter(c => !drop(c));
    forgetPurged(removed.map(c => c.id));
    change.emit('candidates-changed', { removedIds: removed.map(c => c.id) });
    return removed;
  });
}

export function saveRework(row, assetId, rework, label) {
  if (!row || rowById(row.id) !== row) return false;
  return changeProject(label, change => {
    if (assetId) setAssetRework(state.rows, row, assetId, rework);
    else setRework(state.rows, row, rework);
    change.emit('rows');
    return row;
  });
}
export function setReworkNote(row, text, session) {
  if (!row || rowById(row.id) !== row) return;
  changeProject(session?.snapped ? null : '编辑返工要求', () => {
    if (session) session.snapped = true;
    const members = shotMembers(state.rows, row);
    if (members.some(m => m.rework)) {
      for (const m of members) if (m.rework) m.rework.note = text;
    } else if (text.trim()) setRework(state.rows, row, { note: text, at: Date.now() });
  });
}
export function dismissShotRework(row) {
  if (!row || rowById(row.id) !== row) return;
  changeProject('不用返工了', change => {
    dismissRework(state.rows, row);
    change.emit('rows');
  });
}
