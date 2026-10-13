/* 候选媒体任务：用启动时的不可变信息定位结果，完成时只提交到仍匹配的原项目。 */
import { state, renumber, on } from './state.js';
import { emit, notify } from './events.js';
import { projectById, allProjects } from './storage.js';
import { changeProject } from './project-change.js';
import { candidateVersion } from './candidate-actions.js';
import { writeBack } from './candidate-sync.js';
import { invalidateProbe, probePaths, isMissing } from './asset-actions.js';
import { swapToLocal, fileTitle, staleOnlineClips, hasLineTag, lineTag } from '../core/candidates.js';
import { assetName, syncMirror, referencedAssetIds } from '../core/asset-model.js';
import * as native from '../platform/native.js';

const jobs = new Map();
const jobKey = (pid, id) => `${pid}|${id}`;
export const isCandidateBusy = (id, pid = state.projectId) => jobs.has(jobKey(pid, id));
const sourceOf = c => JSON.stringify([c.url, c.in, c.out, c.rowId, c.best || null, c.assetId]);
const projectOf = pid => (pid === state.projectId ? state : projectById(pid));

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
      change.emit('candidate-media');
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
    result = await native.saveVideoSegment({
      url: task.url,
      start: task.start,
      end: task.end,
      name: task.name,
      dir,
      token,
    });
    if (!result?.ok) return result;
    const c = matchingCandidate(task);
    if (!c) return { ...result, attached: false };
    changeProject(
      task.projectId === state.projectId ? '保存视频片段' : null,
      (change, p) => {
        c.savedPath = result.path;
        swapToLocal(c, result.path, p.rows, p.assets || {});
        invalidateProbe();
        writeBack(p.candidates);
        change.emit('rows');
      },
      { projectId: task.projectId },
    );
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
  for (const stored of allProjects()) {
    const p = projectOf(stored.id);
    if (!p) continue;
    const hit =
      Object.values(p.assets || {}).some(a => moved.has(a.path)) ||
      (p.candidates || []).some(c => moved.has(c.savedPath));
    if (!hit) continue;
    changeProject(
      null,
      (change, project) => {
        for (const a of Object.values(project.assets || {}))
          if (moved.has(a.path)) {
            a.path = moved.get(a.path);
            a.name = assetName(a.path);
          }
        for (const c of project.candidates || []) if (moved.has(c.savedPath)) c.savedPath = moved.get(c.savedPath);
        syncMirror(project.rows || [], project.assets || {});
        writeBack(project.candidates || []);
        invalidateProbe();
        change.emit('rows');
      },
      { projectId: stored.id },
    );
  }
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
    for (const [old, tag] of plan) {
      const r = await native.tagSavedClip(old, tag);
      if (r?.ok && r.path && r.path !== old) moved.set(old, r.path);
    }
    applyMovedPaths(moved);
    if (moved.size && state.projectId === pid) {
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
    changeProject(
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
        writeBack(project.candidates);
        change.emit('rows');
      },
      { projectId: pid },
    );
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
const tidySavedClips = () => {
  const pid = state.projectId;
  return tagOldSavedClips()
    .catch(() => 0)
    .then(() => (state.projectId === pid ? relinkSavedClips() : 0));
};
let initialized = false;
export function initCandidateMedia() {
  if (initialized) return;
  initialized = true;
  on('project-loaded', () => setTimeout(tidySavedClips, 0));
  setTimeout(tidySavedClips, 0);
}
