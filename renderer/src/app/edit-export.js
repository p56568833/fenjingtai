/* 导出到剪映的应用编排：保存 → 深拷贝快照 → 本机预检 → 通用导出计划 → 原生任务。
   只读项目：不进撤销栈、不发 project-committed、不碰句子 / 素材 / 候选；
   剪映路径、草稿位置与导出偏好都留在本机设置（library.settings），不进共享项目字段。
   任务按 jobId + projectId + 快照绑定，进度 / 取消 / 结果都只对发起它的那次导出生效。 */
import { state } from './state.js';
import { current as currentProject, settings, saveSettings } from './storage.js';
import { saveCurrentProject } from './project-change.js';
import { probePaths } from './asset-actions.js';
import { buildEditExportPlan } from '../core/edit-export-plan.js';
import { kindOf } from '../core/asset-model.js';
import * as native from '../platform/native.js';

export const EXPORT_DEFAULTS = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 30,
  subtitles: false,
  altAssets: false,
});
const PREFS_KEY = 'jianyingExport';
const LOCAL_PATH = /^\/(?!\/)/; // 本机素材只认绝对路径；链接素材交给计划标问题

/* ── 本机偏好 ── */
function normalizeOptions(raw = {}) {
  const width = Math.round(Number(raw.width));
  const height = Math.round(Number(raw.height));
  const fps = Math.round(Number(raw.fps));
  return {
    width: width >= 320 && width <= 7680 ? width : EXPORT_DEFAULTS.width,
    height: height >= 320 && height <= 7680 ? height : EXPORT_DEFAULTS.height,
    fps: [24, 25, 30, 50, 60].includes(fps) ? fps : EXPORT_DEFAULTS.fps,
    subtitles: !!raw.subtitles,
    altAssets: !!raw.altAssets,
  };
}

/* 首次打开返回 configured:false（界面展开完整设置），成功导出一次后为 true。 */
function readSavedSettings() {
  try {
    return settings()?.[PREFS_KEY] || null;
  } catch {
    return null;
  }
}

export function loadJianyingSettings() {
  const saved = readSavedSettings();
  return {
    configured: saved?.configured === true,
    mode: saved?.mode === 'folder' ? 'folder' : 'library',
    destDir: typeof saved?.destDir === 'string' ? saved.destDir : '',
    options: normalizeOptions(saved?.options || saved || {}),
  };
}

export function saveJianyingSettings(patch = {}) {
  try {
    const host = settings();
    if (!host) return false;
    const next = { ...(host[PREFS_KEY] || {}), ...patch };
    if (patch.options) next.options = normalizeOptions(patch.options);
    host[PREFS_KEY] = next;
    saveSettings();
    return true;
  } catch (error) {
    console.warn('保存剪映导出设置失败', error);
    return false;
  }
}

/* ── 快照：保存后深拷贝，后续异步任务只认这一份 ── */
export function captureExportSnapshot() {
  if (!state.projectId) return { ok: false, error: '先打开一个项目再导出' };
  try {
    saveCurrentProject();
  } catch (error) {
    return { ok: false, error: '导出前保存项目失败：' + (error?.message || error) };
  }
  let snapshot;
  try {
    snapshot = structuredClone({
      projectId: state.projectId,
      title: state.title || '未命名项目',
      rows: state.rows,
      assets: state.assets || {},
      types: state.types,
      speechRate: state.speechRate,
      voice: state.voice || null,
      updatedAt: Number(currentProject()?.updatedAt) || Date.now(),
    });
  } catch (error) {
    return { ok: false, error: '整理导出快照失败：' + (error?.message || error) };
  }
  return { ok: true, snapshot };
}

/* ── 本机预检：文件是否还在、多大；只有这两件事，不改项目 ── */
function localPathOf(value) {
  return typeof value === 'string' && LOCAL_PATH.test(value) ? value : '';
}

async function preflightFiles(snapshot) {
  const probes = {};
  const add = (path, extra = {}) => {
    if (!path) return;
    probes[path] ||= { exists: null, size: null, durationSec: null, isImage: false };
    Object.assign(probes[path], extra);
  };
  for (const asset of Object.values(snapshot.assets || {})) {
    const path = localPathOf(asset?.path);
    if (!path) continue;
    add(path, {
      durationSec: Number.isFinite(asset.durationSec) && asset.durationSec > 0 ? asset.durationSec : null,
      isImage: kindOf(path) === 'image',
    });
  }
  const voicePath = localPathOf(snapshot.voice?.path);
  if (voicePath)
    add(voicePath, {
      durationSec:
        Number.isFinite(snapshot.voice.duration) && snapshot.voice.duration > 0 ? snapshot.voice.duration : null,
      isImage: false,
    });

  const paths = Object.keys(probes);
  if (!paths.length) return probes;
  const [existence, sizes] = await Promise.all([
    probePaths(paths).catch(() => null),
    typeof native.packSizes === 'function' ? native.packSizes(paths).catch(() => null) : null,
  ]);
  for (const path of paths) {
    const known = existence?.[path];
    if (known && typeof known.exists === 'boolean') probes[path].exists = known.exists;
    const size = sizes?.[path];
    if (size) {
      if (Number.isFinite(size.size)) probes[path].size = size.size;
      if (typeof size.exists === 'boolean' && probes[path].exists == null) probes[path].exists = size.exists;
    }
  }
  return probes;
}

/* 计划自己会把失联文件标成 block；这里只补“计划没拿到那条素材”的兜底，避免静默漏文件。 */
function missingFileIssues(plan, probes) {
  const seen = new Set();
  const issues = [];
  for (const asset of [...(plan.assets || []), ...(plan.altAssets || [])]) {
    const path = asset?.path;
    if (!path || probes[path]?.exists !== false || seen.has(path)) continue;
    seen.add(path);
    issues.push({
      level: 'block',
      code: 'missing-file',
      message: `素材文件找不到：${asset.name || path.split('/').pop() || path}`,
      assetId: asset.sourceAssetId || null,
    });
  }
  return issues;
}

function mergeIssues(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const issue of group || []) {
      if (!issue || typeof issue !== 'object') continue;
      const key = [
        issue.level,
        issue.code,
        issue.rowId ?? '',
        issue.lineNo ?? '',
        issue.assetId ?? '',
        issue.message ?? '',
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(issue);
    }
  }
  return out;
}

/* 复制体积只用计划真正会带进草稿的文件估算；定格图由主进程抽帧，单独按张数提示。 */
function estimateVolume(plan, probes) {
  const seen = new Set();
  let bytes = 0;
  let files = 0;
  let unknown = 0;
  for (const asset of [...(plan.assets || []), ...(plan.altAssets || [])]) {
    const path = asset?.path;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const info = probes[path];
    if (info?.exists === false) continue;
    if (Number.isFinite(info?.size) && info.size > 0) {
      bytes += info.size;
      files++;
    } else unknown++;
  }
  return { bytes, files, unknown, freezeCount: (plan.derived || []).length };
}

let idSeq = 0;
function idFor(prefix) {
  return `${String(prefix || 'id')}_${Date.now().toString(36)}${(++idSeq).toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/* 纯计划只依赖显式快照和注入的 deps；重复生成（改设置、正式导出）都从这里走。 */
export async function prepareJianyingExport(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, error: '没有可导出的项目快照' };
  const normalized = normalizeOptions(options);
  const probes = await preflightFiles(snapshot);
  let plan;
  try {
    plan = buildEditExportPlan(snapshot, normalized, { idFor, probes });
  } catch (error) {
    console.error('生成剪映导出计划失败', error);
    return { ok: false, error: '生成导出计划失败：' + (error?.message || error) };
  }
  if (!plan || !Array.isArray(plan.tracks?.video)) return { ok: false, error: '导出计划不完整，先别导出' };
  return {
    ok: true,
    snapshot,
    options: normalized,
    plan,
    probes,
    issues: mergeIssues(plan.issues, missingFileIssues(plan, probes)),
    volume: estimateVolume(plan, probes),
  };
}

/* ── 剪映探测 / 本机入口 ── */
const unavailable = () => ({
  ok: false,
  unavailable: true,
  supported: false,
  issues: [],
  error: '这个版本还不支持导出到剪映，请重新安装分镜台',
});

export async function detectJianying() {
  if (typeof native.jianyingDetect !== 'function') return unavailable();
  try {
    const info = await native.jianyingDetect();
    if (!info || typeof info !== 'object')
      return { ok: false, supported: false, issues: [], error: '没有读到剪映信息' };
    return {
      ok: !!info.ok,
      appPath: String(info.appPath || ''),
      version: String(info.version || ''),
      draftRoot: String(info.draftRoot || ''),
      running: !!info.running,
      canRegister: !!info.canRegister,
      supported: !!info.supported,
      fingerprint: info.fingerprint || null,
      issues: Array.isArray(info.issues) ? info.issues : [],
      error: info.error ? String(info.error) : '',
    };
  } catch (error) {
    return { ok: false, supported: false, issues: [], error: String(error?.message || error) };
  }
}

export async function openJianyingApp() {
  if (typeof native.jianyingOpenApp !== 'function') return false;
  try {
    const result = await native.jianyingOpenApp();
    return !result || result.ok !== false;
  } catch (error) {
    console.warn('打开剪映失败', error);
    return false;
  }
}

export async function revealJianyingDraft(path) {
  if (!path || typeof path !== 'string') return false;
  try {
    if (typeof native.jianyingReveal === 'function') {
      const result = await native.jianyingReveal(path);
      return !result || result.ok !== false;
    }
    if (typeof native.revealAsset === 'function') {
      await native.revealAsset(path);
      return true;
    }
  } catch (error) {
    console.warn('在访达中显示草稿失败', error);
  }
  return false;
}

export async function pickJianyingFolder(current) {
  if (typeof native.jianyingPickFolder !== 'function') return null;
  try {
    const picked = await native.jianyingPickFolder(typeof current === 'string' ? current : '');
    return typeof picked === 'string' && picked ? picked : null;
  } catch (error) {
    console.warn('选择草稿保存位置失败', error);
    return null;
  }
}

export async function registerJianyingDraft(draftDir) {
  if (!draftDir) return { ok: false, error: '没有草稿位置' };
  if (typeof native.jianyingRegister !== 'function')
    return { ok: false, error: '这个版本还不支持自动加入剪映草稿列表' };
  try {
    const result = await native.jianyingRegister({ draftDir });
    if (!result || typeof result !== 'object') return { ok: false, error: '加入剪映草稿列表失败' };
    return {
      ok: !!result.ok,
      registered: !!result.registered,
      needsQuit: !!result.needsQuit,
      error: result.error ? String(result.error) : '',
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/* ── 任务：jobId + projectId + 快照一次绑定 ── */
const jobs = new Map(); // jobId → job
let listenersReady = false;

function bindNativeEvents() {
  if (listenersReady) return true;
  if (typeof native.onJianyingProgress !== 'function' || typeof native.onJianyingResult !== 'function') return false;
  native.onJianyingProgress(progress => {
    const job = jobs.get(progress?.jobId);
    if (!job) return; // 别的窗口 / 上一次任务：不串台
    try {
      job.onProgress?.(progress);
    } catch (error) {
      console.error('处理剪映导出进度失败', error);
    }
  });
  native.onJianyingResult(result => {
    const job = jobs.get(result?.jobId);
    if (job) finishJob(job, result);
  });
  listenersReady = true;
  return true;
}

export const jianyingAvailable = () =>
  typeof native.jianyingDetect === 'function' &&
  typeof native.jianyingExport === 'function' &&
  typeof native.onJianyingResult === 'function';

function makeJobId() {
  return `jy_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function finishJob(job, raw) {
  if (job.settled) return;
  job.settled = true;
  jobs.delete(job.jobId);
  if (job.nativeJobId) jobs.delete(job.nativeJobId);
  job.resolve?.({
    ...raw,
    jobId: job.jobId,
    projectId: job.projectId,
    projectTitle: job.snapshot.title,
    projectChanged: state.projectId !== job.projectId,
    ok: !!raw?.ok,
    canceled: !!raw?.canceled,
    error: raw?.error ? String(raw.error) : '',
    draftDir: String(raw?.draftDir || ''),
    draftName: String(raw?.draftName || job.draftName || ''),
    segmentCount: Number.isFinite(raw?.segmentCount) ? raw.segmentCount : 0,
    assetCount: Number.isFinite(raw?.assetCount) ? raw.assetCount : 0,
    freezeCount: Number.isFinite(raw?.freezeCount) ? raw.freezeCount : 0,
    registered: !!raw?.registered,
    needsQuit: !!raw?.needsQuit,
    reportPath: String(raw?.reportPath || ''),
    notes: Array.isArray(raw?.notes) ? raw.notes : [],
    issues: Array.isArray(raw?.issues) ? raw.issues : [],
    planIssues: job.issues,
    planStats: job.plan?.stats || null,
  });
}

/* 生成草稿：返回的 Promise 在原生 result 事件到达时解析一次；进度通过 onProgress 实时给。
   onJob 在原生任务真正创建后触发（jobId 可用于取消），此时界面已经开始收进度。
   prepared 来自 prepareJianyingExport：界面已经用它显示了摘要，导出时直接复用同一份计划。 */
export async function startPreparedJianyingExport(
  prepared,
  { mode = 'library', destDir = '', draftName = '', onProgress = null, onJob = null } = {},
) {
  if (!prepared?.ok || !prepared.snapshot || !prepared.plan)
    return { ok: false, error: '导出计划还没准备好，稍后再试' };
  if (!bindNativeEvents()) return { ok: false, ...unavailable() };
  const blocking = (prepared.issues || []).filter(issue => issue.level === 'block');
  if (blocking.length)
    return {
      ok: false,
      error: `有 ${blocking.length} 项阻塞问题，先在分镜台里处理后再导出`,
      issues: prepared.issues,
      snapshot: prepared.snapshot,
    };

  const snapshot = prepared.snapshot;
  const jobId = makeJobId();
  const normalizedMode = mode === 'folder' ? 'folder' : 'library';
  const name = String(draftName || snapshot.title || '未命名项目').trim() || '未命名项目';
  const req = {
    jobId,
    projectId: snapshot.projectId,
    plan: prepared.plan,
    snapshot: { title: snapshot.title, updatedAt: snapshot.updatedAt },
    options: {
      mode: normalizedMode,
      destDir: normalizedMode === 'folder' ? String(destDir || '') : '',
      draftName: name,
    },
  };
  const job = {
    jobId,
    nativeJobId: '',
    projectId: snapshot.projectId,
    snapshot,
    plan: prepared.plan,
    issues: prepared.issues,
    draftName: name,
    onProgress,
    resolve: null,
    settled: false,
  };
  jobs.set(jobId, job);
  const result = new Promise(resolve => {
    job.resolve = resolve;
  });
  let started;
  try {
    started = await native.jianyingExport(req);
  } catch (error) {
    finishJob(job, { ok: false, error: '启动剪映导出任务失败：' + (error?.message || error) });
    return result;
  }
  if (!started || started.ok === false) {
    finishJob(job, { ok: false, error: started?.error || '剪映导出任务没能启动' });
    return result;
  }
  if (started.jobId && started.jobId !== jobId) {
    jobs.set(started.jobId, job);
    job.nativeJobId = started.jobId;
  }
  try {
    onJob?.({ jobId: job.nativeJobId || jobId, projectId: job.projectId });
  } catch (error) {
    console.error('通知导出任务已开始失败', error);
  }
  return result;
}

/* 一步到位版本：保存 → 快照 → 计划 → 原生任务。界面通常先 prepare 预览，再调上面的接口。 */
export async function startJianyingExport({
  mode = 'library',
  destDir = '',
  draftName = '',
  options = {},
  onProgress = null,
  onJob = null,
} = {}) {
  if (!bindNativeEvents()) return { ok: false, ...unavailable() };
  const captured = captureExportSnapshot();
  if (!captured.ok) return captured;
  const prepared = await prepareJianyingExport(captured.snapshot, options);
  if (!prepared.ok) return prepared;
  return startPreparedJianyingExport(prepared, { mode, destDir, draftName, onProgress, onJob });
}

export async function cancelJianyingExport(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.settled) return false;
  if (typeof native.jianyingCancel !== 'function') return false;
  try {
    return !!(await native.jianyingCancel(job.nativeJobId || jobId));
  } catch (error) {
    console.warn('取消剪映导出失败', error);
    return false;
  }
}
