/* 视频审核的数据操作：页面不直接修改候选、素材或返工标记。 */
import { state } from './state.js';
import { rowById, renumber, timeline } from './project-queries.js';
import { changeProject, editProjectFields } from './project-change.js';
import { forgetPurged } from './undo.js';
import { writeBack, flushWriteBack, syncedFiles } from './candidate-sync.js';
import { assetName, usageList } from '../core/asset-model.js';
import { removeUsage } from './asset-actions.js';
import { fmtTime } from '../core/text.js';
import { planImport, footageTakenBy } from '../core/candidates.js';
import { attachCandidate, detachCandidate } from '../core/candidate-placement.js';
import { DECISION } from '../core/candidate-values.js';
import { normalizeReviewBatches } from '../core/review-batches.js';
import { reworkShots, resolveOnApprove, setRework, setAssetRework, dismissRework, reworkText } from '../core/rework.js';

/* shots：groupReworkItems 的结果（一个画面一条，和返工单里的 shots 一一对应）。forIds：要补的那几句，回复的 for 只能落在这里 */
export function registerReworkRequest(doc, shots, path = '') {
  return changeProject('生成返工单', () => {
    state.reworkRequests = {
      ...state.reworkRequests,
      [doc.id]: {
        at: Date.parse(doc.createdAt),
        path,
        targets: shots.map((s, i) => ({
          rowIds: s.members.map(m => m.id),
          forIds: s.target.map(m => m.id),
          note: [
            ...s.requests,
            ...doc.shots[i].replace.map(x => `${x.name}：${x.note}`),
            ...doc.shots[i].rejected.map(x => `${x.title}（${x.decision}）：${x.note}`),
          ]
            .filter(Boolean)
            .join('\n'),
        })),
      },
    };
  });
}

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
  const rework = reworkShots(state.rows, state.candidates);
  const plan = planImport(doc, srcFile, state.rows, state.candidates, {
    tl: timeline(),
    reworkRequests: state.reworkRequests,
    reworkRowIds: rework.flatMap(s => s.members.map(m => m.id)),
  });
  if (plan.error || (!plan.added.length && !plan.updated.length)) return plan;
  const batch = {
    batchId: 'vb-' + crypto.randomUUID(),
    batchAt: Date.now(),
    batchName: batchNameOf(doc, srcFile, plan),
    ...(doc.reworkId || plan.added.some(c => rework.some(s => s.members.some(m => m.id === c.rowId)))
      ? { batchKind: 'rework' }
      : {}),
  };
  const result = changeProject('导入视频候选', change => {
    const metadata = normalizeReviewBatches(state.reviewBatches, state.candidates);
    const number = Math.max(0, ...Object.values(metadata).map(b => b.number)) + 1;
    batch.batchNo = number;
    state.reviewBatches = { ...metadata, [batch.batchId]: { number, title: '' } };
    let reset = 0;
    const resetIds = [];
    for (const { old, next, changed } of plan.updated) {
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
      if (!old.decision) Object.assign(old, batch);
    }
    for (const c of plan.added) Object.assign(c, batch);
    state.candidates = [...state.candidates, ...plan.added];
    change.emit('candidates-changed', { resetIds });

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
  // 同一段画面不能配两处：已经有别的句子用上了这段画面，先撤回那边才能通过这里
  const taken =
    next === 'ok'
      ? footageTakenBy(
          c,
          state.candidates.filter(x => x.decision === 'ok'),
        )
      : null;
  if (taken)
    return {
      error: `这段画面已经用在第 ${rowById(taken.rowId)?.no ?? taken.lines} 句（${taken.title || taken.key}），同一段画面不能配两处。要用在这里，先把那边撤回`,
    };
  const result = changeProject(next ? `视频候选：${DECISION[next]}` : '撤回审核', change => {
    let msg = '';
    if (c.decision === 'ok' && next !== 'ok') {
      detachCandidate(c, state.rows, state.assets);
      msg = '已从画面上撤下这个视频 · ⌘Z 可撤销';
    }
    if (next === 'ok') {
      renumber();
      const r = attachCandidate(c, state.rows, state.assets, { tl: timeline() });
      if (r.error) return r;
      c.assetId = r.assetId;
      if (r.current) {
        const old = resolveOnApprove(state.rows, rowById(c.rowId), r.assetId);
        const names = [...new Set([...r.demoted, ...old])].map(x => state.assets[x]?.name || '素材');
        msg = `已设为主画面（${fmtTime(c.in)}–${fmtTime(c.out)}）${names.length ? `，「${names.join('」「')}」让位成备选` : ''}`;
      } else msg = '已通过；这几句已经有主画面，先放进备选，拖上去就能换上';
    }
    invalidateCandidate(c);
    c.decision = next;
    if (next) c.decidedAt = Date.now();
    else delete c.decidedAt;

    return { candidate: c, next, msg };
  });
  if (!result?.error) writeBack();
  return result;
}

/* 这个素材是不是审核通过后挂上画面的视频：是就返回那条通过的候选 */
export function approvedCandidateOf(assetId) {
  const cid = state.assets?.[assetId]?.source?.candidate;
  return cid ? state.candidates.find(c => c.id === cid && c.decision === 'ok' && c.assetId === assetId) || null : null;
}

/* 从画面上删一个素材（画面轨、详情面板都走这里）：审核通过的视频 = 撤回通过、回到待审，
   不能只解除关联——否则候选还标着「通过」，画面却空了，这几句的其他候选又会冒回待审。
   返回 { withdrawn } 或 { error }；其余素材只解除关联，本地文件保留 */
export function removeFromShot(row, assetId) {
  const cand = approvedCandidateOf(assetId);
  if (cand) {
    const r = decideCandidate(cand.id, 'ok'); // 再点一次「通过」= 撤回
    return r?.error ? { error: r.error } : { withdrawn: true };
  }
  const index = usageList(row).findIndex(u => u.assetId === assetId);
  if (index >= 0) removeUsage(row, index);
  return { withdrawn: false };
}

/* 意见打字即存；同一次编辑（session）只拍一张快照，撤销回到这次编辑前 */
export function setCandidateNote(id, text, session) {
  const c = state.candidates.find(x => x.id === id);
  if (!c || (c.note || '') === text) return;
  // 立即把内存改动登记待保存，防抖由存储层负责；切项目不会丢最后一句意见。
  const changed = editProjectFields(session?.snapped ? null : '编辑审核意见', {
    candidates: [{ id, values: { note: text } }],
  });
  if (changed && session) session.snapped = true;
  writeBack();
}

export function deleteCandidateBatch(ids) {
  const removed = state.candidates.filter(c => ids.has(c.id));
  if (!removed.length) return [];
  // 清单仍保留原审核结果，删除审核批次不等于否决视频。
  writeBack();
  return changeProject('删除视频审核批次', change => {
    state.reviewBatches = normalizeReviewBatches(state.reviewBatches, state.candidates);
    for (const c of removed) invalidateCandidate(c);
    state.candidates = state.candidates.filter(c => !ids.has(c.id));
    change.emit('candidates-changed', { removedIds: removed.map(c => c.id) });

    return removed;
  });
}

export function renameCandidateBatch(id, title) {
  if (!state.candidates.some(c => (c.batchId || 'legacy') === id)) return false;
  return changeProject('重命名审核批次', () => {
    const metadata = normalizeReviewBatches(state.reviewBatches, state.candidates);
    metadata[id] = { ...metadata[id], title: String(title).trim().slice(0, 40) };
    state.reviewBatches = metadata;
    return true;
  });
}

export async function purgeRejectedCandidates() {
  const pid = state.projectId;
  // 捕获这一轮的项目上下文：写回 / 已同步判断都按启动时的 rows 和 candidates，不随后续切项目改主意
  const context = { rows: state.rows, candidates: state.candidates };
  const cands = context.candidates;
  if (!cands.some(c => c.decision === 'no')) return [];
  await flushWriteBack(context);
  if (state.projectId !== pid || state.candidates !== cands) return [];
  const synced = syncedFiles(context);
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

    return row;
  });
}
/* 待返工页里改「不满意的地方」：素材照旧要换，只改意见；标记的时间不变 */
export function setAssetReworkNote(item, assetId, text) {
  const row = item?.lead && rowById(item.lead.id);
  const cur = item?.replaces.find(x => x.assetId === assetId);
  const note = reworkText(text);
  if (!row || !cur || reworkText(cur.note) === note) return false;
  return saveRework(row, assetId, { note, at: cur.at || Date.now() }, '修改不满意的地方');
}
/* 待返工页的补充要求：写在这一项的那几句上（共用画面里的别的句子不动） */
export function setReworkNote(target, text, session) {
  const members = target.filter(m => rowById(m.id) === m);
  if (!members.length) return;
  const existing = members.filter(m => m.rework && !m.rework.assetId);
  const rows = existing.length
    ? existing.map(m => ({ id: m.id, values: { rework: { ...m.rework, note: text } } }))
    : text.trim()
      ? members.map(m => ({ id: m.id, values: { rework: { note: text, at: Date.now() }, reworkOff: undefined } }))
      : [];
  const changed = editProjectFields(session?.snapped ? null : '编辑返工要求', { rows });
  if (changed && session) session.snapped = true;
}
export function dismissShotRework(item) {
  if (!item?.target?.length || rowById(item.lead.id) !== item.lead) return;
  changeProject('不用返工了', change => {
    dismissRework(state.rows, item);
  });
}
