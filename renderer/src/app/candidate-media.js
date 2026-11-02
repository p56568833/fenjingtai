/* 候选媒体任务：用启动时的不可变信息定位结果，完成时只提交到仍匹配的原项目。 */
import { state } from './state.js';
import { renumber } from './project-queries.js';
import { on } from './events.js';
import { emit, notify } from './events.js';
import { projectForId, allProjects } from './storage.js';
import { changeProject } from './project-change.js';
import { candidateVersion } from './candidate-actions.js';
import { writeBack } from './candidate-sync.js';
import { followMovedPaths } from './undo.js';
import { invalidateProbe, probePaths, isMissing } from './asset-actions.js';
import { swapToLocal, fileTitle, staleOnlineClips, hasLineTag, lineTag } from '../core/candidate-placement.js';
import { assetName, syncMirror, referencedAssetIds } from '../core/asset-model.js';
import { fetchClip, collabSession } from './collab.js';
import { retagPlan } from '../core/candidate-queries.js';
import * as native from '../platform/native.js';

const jobs = new Map();
const jobKey = (pid, id) => `${pid}|${id}`;
export const isCandidateBusy = (id, pid = state.projectId) => jobs.has(jobKey(pid, id));
const sourceOf = c => JSON.stringify([c.url, c.in, c.out, c.rowId, c.best || null, c.assetId]);
const projectOf = projectForId;

export function captureSaveTask(id) {
  const c = state.candidates.find(x => x.id === id);
  if (!c || c.decision !== 'ok' || isCandidateBusy(id)) return null;
  renumber();
  return Object.freeze({
    projectId: state.projectId,
    projectTitle: state.title,
    candidateId: id,
    candidate: c,
    version: candidateVersion(c),
    source: sourceOf(c),
    url: c.url,
    start: c.in,
    end: c.out,
    name: fileTitle(c, state.rows),
  });
}
function matchingCandidate(task) {
  const p = projectOf(task.projectId);
  const c = p?.candidates?.find(x => x.id === task.candidateId);
  return c &&
    c === task.candidate &&
    c.decision === 'ok' &&
    candidateVersion(c) === task.version &&
    sourceOf(c) === task.source
    ? c
    : null;
}
export function setMediaDirectory(projectId, dir) {
  if (!dir || !projectOf(projectId)) return false;
  return changeProject(
    null,
    (change, p) => {
      p.mediaDir = dir;
    },
    { projectId },
  );
}

export async function saveCandidateSegment(task, dir) {
  if (!task || !dir || !matchingCandidate(task) || isCandidateBusy(task.candidateId, task.projectId)) return null;
  const key = jobKey(task.projectId, task.candidateId);
  const token = crypto.randomUUID();
  jobs.set(key, { token, task });
  emit('candidate-media');
  let result;
  try {
    // 协作中：对方保存过同一段就从他电脑上拷，拷不到再从网站截取
    const progress = p => emit('candidate-progress', { projectId: task.projectId, id: task.candidateId, p });
    const copying = fetchClip(
      task.projectId,
      { id: task.candidateId, url: task.url, in: task.start, out: task.end },
      { dir, name: task.name, onProgress: progress },
    );
    result =
      (copying && (await copying)) ||
      (await native.saveVideoSegment({
        url: task.url,
        start: task.start,
        end: task.end,
        name: task.name,
        dir,
        token,
      }));
    if (!result?.ok) return result;
    const c = matchingCandidate(task);
    if (!c) return { ...result, attached: false };
    const committed = changeProject(
      task.projectId === state.projectId ? '保存视频片段' : null,
      (change, p) => {
        c.savedPath = result.path;
        swapToLocal(c, result.path, p.rows, p.assets || {});
        invalidateProbe();
      },
      { projectId: task.projectId },
    );
    // 修改真的提交了才排写回：失败回滚时不把内容排进外部清单（成功时 mutate 常常返回 undefined）
    if (committed !== false && !committed?.error) writeBack(projectOf(task.projectId));
    return { ...result, attached: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  } finally {
    jobs.delete(key);
    emit('candidate-media');
  }
}
native.onSegmentProgress(({ token, p }) => {
  for (const { task, token: expected } of jobs.values())
    if (expected === token) emit('candidate-progress', { projectId: task.projectId, id: task.candidateId, p });
});

/* 文件改名涉及磁盘，不进撤销；所有引用该路径的项目同时更新。 */
export function applyMovedPaths(moved) {
  if (!moved.size) return;
  followMovedPaths(moved);
  for (const stored of allProjects()) {
    const p = projectOf(stored.id);
    if (!p) continue;
    const hit =
      Object.values(p.assets || {}).some(a => moved.has(a.path)) ||
      (p.candidates || []).some(c => moved.has(c.savedPath));
    if (!hit) continue;
    const committed = changeProject(
      null,
      (change, project) => {
        for (const a of Object.values(project.assets || {}))
          if (moved.has(a.path)) {
            a.path = moved.get(a.path);
            a.name = assetName(a.path);
          }
        for (const c of project.candidates || []) if (moved.has(c.savedPath)) c.savedPath = moved.get(c.savedPath);
        syncMirror(project.rows || [], project.assets || {});
        invalidateProbe();
      },
      { projectId: stored.id },
    );
    // 回滚的项目不排写回：外部清单不能拿到这次没提交的路径
    if (committed !== false && !committed?.error) writeBack(projectOf(stored.id));
  }
}
/* 批量改名失败：按批次汇总一条提示（不逐文件弹、不自动立刻重试）；成功改了的照常更新引用 */
function movedFailureText(action, movedCount, failures) {
  const example = failures.find(f => f.path);
  const reason = failures[0]?.reason || '未知原因';
  const detail = example ? `（例如「${assetName(example.path)}」：${reason}）` : `（${reason}）`;
  const done = movedCount ? `已${action} ${movedCount} 个片段；` : '';
  const retry = action === '改名' ? '下次改句号时会再试' : '下次打开项目时会再试';
  return `${done}${failures.length} 个片段没能${action === '改名' ? '按句号改名' : '补上句号'}${detail}。文件仍在原处，${retry}`;
}
let tagging = null,
  tagAgain = false;
export function tagOldSavedClips() {
  if (tagging) {
    tagAgain = true;
    return tagging;
  }
  const pid = state.projectId;
  const todo = state.candidates.filter(c => c.savedPath && !hasLineTag(c.savedPath));
  if (!todo.length) return Promise.resolve(0);
  renumber();
  const plan = new Map(todo.map(c => [c.savedPath, lineTag(c, state.rows)]).filter(([, tag]) => tag));
  tagging = (async () => {
    const moved = new Map();
    const failures = [];
    try {
      // 逐项来：一项失败（返回 ok:false 或抛错）不拖累其他项，已改名的照样记下来
      for (const [old, tag] of plan) {
        try {
          const r = await native.tagSavedClip(old, tag);
          if (r?.ok && r.path && r.path !== old) moved.set(old, r.path);
          else if (!r?.ok) failures.push({ path: old, reason: r?.error || '改名失败' });
        } catch (error) {
          failures.push({ path: old, reason: String(error?.message || error) });
        }
      }
    } finally {
      // 无论成功、部分失败还是异常，这一轮改成功的映射都要落到项目引用上（磁盘已经改了名）
      try {
        applyMovedPaths(moved);
      } catch (error) {
        failures.push({ path: '', reason: `引用更新失败：${String(error?.message || error)}` });
      }
    }
    if (failures.length) notify(movedFailureText('补句号', moved.size, failures), null, 'warn');
    else if (moved.size && state.projectId === pid) {
      const first = [...moved.values()][0];
      notify(
        `已给 ${moved.size} 个保存过的视频片段补上句号，例如「${assetName(first)}」`,
        {
          label: '在访达中显示',
          cb: () => native.revealAsset(first),
        },
        'ok',
      );
    }
    return moved.size;
  })().finally(() => {
    tagging = null;
    if (tagAgain) {
      tagAgain = false;
      setTimeout(tidySavedClips, 0);
    }
  });
  return tagging;
}

const relinking = new Map();
export function relinkSavedClips({ quiet = false } = {}) {
  const pid = state.projectId;
  if (relinking.has(pid)) return relinking.get(pid);
  const stale = staleOnlineClips(state.candidates, state.rows, state.assets).map(x => ({
    ...x,
    source: sourceOf(x.cand),
    version: candidateVersion(x.cand),
    savedPath: x.cand.savedPath,
  }));
  if (!stale.length) return Promise.resolve(0);
  const job = (async () => {
    const info = await probePaths(stale.map(x => x.savedPath));
    const p = projectOf(pid);
    if (!p) return 0;
    const valid = stale.filter(
      x =>
        p.candidates.includes(x.cand) &&
        p.assets[x.asset.id] === x.asset &&
        sourceOf(x.cand) === x.source &&
        candidateVersion(x.cand) === x.version &&
        x.cand.savedPath === x.savedPath,
    );
    if (!valid.length) return 0;
    let fixed = 0,
      gone = 0;
    const committed = changeProject(
      null,
      (change, project) => {
        for (const { asset, cand, savedPath } of valid) {
          const got = info[savedPath];
          if (got && !isMissing(got)) {
            if (!referencedAssetIds(project.rows).has(cand.assetId)) cand.assetId = asset.id;
            if (swapToLocal({ assetId: asset.id, in: cand.in, out: cand.out }, savedPath, project.rows, project.assets))
              fixed++;
          } else if (isMissing(got)) {
            delete cand.savedPath;
            gone++;
          }
        }
        if (!fixed && !gone) return false;
        invalidateProbe();
      },
      { projectId: pid },
    );
    // 修改提交后才排写回；回滚时不把这次内容排进外部清单
    if (committed !== false && !committed?.error && (fixed || gone)) writeBack(projectOf(pid));
    if ((!quiet || gone) && (fixed || gone))
      notify(
        [
          fixed ? `${fixed} 个已保存的片段换回了本地文件` : '',
          gone ? `${gone} 个片段的本地文件找不到了，点「保存已通过的片段」重新保存` : '',
        ]
          .filter(Boolean)
          .join('；'),
        null,
        gone ? 'warn' : 'ok',
      );
    return fixed;
  })().finally(() => relinking.delete(pid));
  relinking.set(pid, job);
  return job;
}
/* 定时 / 载入后的整理入口：任何一步失败都不能留下未处理的 Promise 拒绝 */
const tidySavedClips = () => {
  const pid = state.projectId;
  return tagOldSavedClips()
    .catch(() => 0)
    .then(() => (state.projectId === pid ? relinkSavedClips() : 0))
    .catch(() => 0);
};
/* 素材换了句子（轨上拖动、改了配哪几句、改稿后句号变了）：文件名开头的「第N句」自动跟着改，不用手动点。
   只改名不移动；改名涉及磁盘，不进撤销（撤销后位置变回去，会再自动改回来）。协作中不自动改，免得两边来回改名 */
let retagTimer = 0,
  retagging = false,
  retagAgain = false;
export function scheduleRetag(delay = 600) {
  clearTimeout(retagTimer);
  retagTimer = setTimeout(() => {
    // 定时入口自己兜住失败：不能变成未处理的 Promise 拒绝
    retagLineFiles().catch(() => 0);
  }, delay);
}
export async function retagLineFiles() {
  if (retagging) {
    retagAgain = true;
    return 0;
  }
  if (collabSession()) return 0;
  renumber();
  const plan = retagPlan(state.rows, state.assets, state.candidates);
  if (!plan.size) return 0;
  retagging = true;
  const moved = new Map();
  const failures = [];
  try {
    // 逐项来：一项失败（返回 ok:false 或抛错）不拖累其他项，已改名的照样记下来
    for (const [old, tag] of plan) {
      try {
        const r = await native.retagLineFile(old, tag);
        if (r?.ok && r.path && r.path !== old) moved.set(old, r.path);
        else if (!r?.ok) failures.push({ path: old, reason: r?.error || '改名失败' });
      } catch (error) {
        failures.push({ path: old, reason: String(error?.message || error) });
      }
    }
  } finally {
    // 无论成功、部分失败还是异常，这一轮改成功的映射都要落到项目引用上（磁盘已经改了名）
    try {
      applyMovedPaths(moved);
    } catch (error) {
      failures.push({ path: '', reason: `引用更新失败：${String(error?.message || error)}` });
    }
    retagging = false;
    if (retagAgain) {
      retagAgain = false;
      scheduleRetag(0);
    }
  }
  if (failures.length) notify(movedFailureText('改名', moved.size, failures), null, 'warn');
  return moved.size;
}

let initialized = false;
export function initCandidateMedia() {
  if (initialized) return;
  initialized = true;
  on('project-loaded', () => setTimeout(tidySavedClips, 0));
  on('project-loaded', () => scheduleRetag());
  on('project-committed', () => scheduleRetag());
  setTimeout(tidySavedClips, 0);
}
