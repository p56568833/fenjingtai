/* 审核文件操作的交互：选择位置、确认、进度和结果提示。 */
import { state } from '../app/state.js';
import { renumber } from '../app/project-queries.js';
import { on, emit } from '../app/events.js';
import { captureSaveTask, saveCandidateSegment, setMediaDirectory, relinkSavedClips } from '../app/candidate-media.js';
import { fileTitle } from '../core/candidate-placement.js';
import { assetName } from '../core/asset-model.js';
import { toast, confirmModal } from '../ui/base/dom.js';
import * as nat from '../platform/native.js';
const native = name => nat[name];

export async function ensureMediaDir(force = false) {
  if (state.mediaDir && !force) return state.mediaDir;
  const pid = state.projectId;
  const dir = await native('pickFolder')(state.mediaDir || '');
  if (!dir || state.projectId !== pid) return null;
  setMediaDirectory(pid, dir);
  return dir;
}
/* 截取进度：id → 0–1（主进程按 ffmpeg 的 -progress 回报）。只原地改批量按钮，不重画整个窗口 */
const prog = new Map();
export let batchRun = null; // 「保存已通过的片段」进行中：{ i, n, id }
const pctOf = id => Math.round((prog.get(id) || 0) * 100);
export function saveAllLabel() {
  if (!batchRun) return null;
  const p = batchRun.id && prog.has(batchRun.id) ? ` · ${pctOf(batchRun.id)}%` : '';
  return `正在保存 ${batchRun.i}/${batchRun.n}${p}`;
}
function paintProgress(id) {
  emit('candidate-save-progress', {
    label: saveAllLabel(),
    percent: batchRun?.id === id ? pctOf(id) : 0,
  });
}
async function saveSegment(id, { quiet = false } = {}) {
  const task = captureSaveTask(id);
  if (!task) return null;
  const dir = await ensureMediaDir();
  if (!dir || state.projectId !== task.projectId) return null;
  const r = await saveCandidateSegment(task, dir);
  if (!r?.ok) {
    if (r?.needFfmpeg)
      confirmModal('需要先装 ffmpeg', r.error, '知道了', () => {}, { cancelText: '关闭', danger: false });
    else if (!quiet && r) toast('保存失败：' + (r.error || '未知原因'), null, 'error');
    return r;
  }
  if (!r.attached) {
    if (!quiet) toast(`片段已保存到 ${assetName(r.path)}，但这个候选已经变了，没有挂到画面上`, null, 'warn');
  } else if (!quiet)
    toast(
      `「${task.projectTitle}」的片段已${r.peer ? `从 ${r.peer} 的电脑拷来` : '保存'}：${assetName(r.path)}`,
      { label: '在访达中显示', cb: () => native('revealAsset')(r.path) },
      'ok',
    );
  return r;
}

export async function saveAllApproved() {
  const pid = state.projectId;
  await relinkSavedClips({ quiet: true }); // 已经存在本地的先换上，不重复下载
  if (state.projectId !== pid) return;
  const list = state.candidates.filter(c => c.decision === 'ok' && !c.savedPath);
  if (!list.length) {
    toast('没有待保存的已通过片段', null, 'info');
    return;
  }
  if (!(await ensureMediaDir())) return;
  if (batchRun || state.projectId !== pid) return;
  let ok = 0,
    fail = 0,
    copied = 0; // 其中从对方电脑拷来的
  const reasons = new Map(); // 失败原因 → 段数：批量时不逐条弹提示，最后汇总告诉用户为什么失败
  batchRun = { i: 0, n: list.length, id: null };
  try {
    for (const c of list) {
      if (state.projectId !== pid) break; // 切了项目：后面的不再继续截
      batchRun.i = ok + fail + 1;
      batchRun.id = c.id;
      paintProgress(c.id);
      const r = await saveSegment(c.id, { quiet: true });
      if (r?.ok) {
        ok++;
        if (r.peer) copied++;
      } else {
        fail++;
        if (r?.needFfmpeg) return;
        const why = r?.error || '未知原因';
        reasons.set(why, (reasons.get(why) || 0) + 1);
      }
    }
  } finally {
    batchRun = null;
    emit('candidate-media');
  }
  const fromPeer = copied ? `（${copied} 段从对方电脑拷来）` : '';
  if (!fail) return toast(`已保存 ${ok} 段${fromPeer}`, null, 'ok');
  const [top, n] = [...reasons].sort((a, b) => b[1] - a[1])[0] || ['未知原因', fail];
  const more = reasons.size > 1 ? `等 ${reasons.size} 种原因` : '';
  toast(
    `已保存 ${ok} 段${fromPeer}，${fail} 段失败（可再次批量尝试）。${n < fail || more ? `主要原因（${n} 段）` : '原因'}：${top}${more ? '，' + more : ''}`,
    null,
    ok ? 'warn' : 'error',
  );
}
export function downloadOriginal(id) {
  const original = state.candidates.find(x => x.id === id);
  if (!original) return;
  const c = { ...original };
  const pid = state.projectId;
  renumber();
  const name = fileTitle(c, state.rows);
  confirmModal(
    '下载完整原片？',
    `会把整部视频下载到保存位置，可能有几百 MB，需要一段时间。\n\n${c.title}\n${c.url}`,
    '下载',
    async () => {
      const dir = await ensureMediaDir();
      if (!dir || state.projectId !== pid) return;
      toast('开始下载完整原片…', { label: '取消', cb: () => native('cancelDownload')(c.url) }, 'info');
      renumber();
      const r = await native('downloadOriginalVideo')({ url: c.url, dir, name });
      if (r?.ok)
        toast(
          `原片已下载：${assetName(r.path)}`,
          { label: '在访达中显示', cb: () => native('revealAsset')(r.path) },
          'ok',
        );
      else if (r?.canceled) toast('已取消下载原片', null, 'info');
      else toast('下载失败：' + (r?.error || '未知原因'), null, 'error');
    },
    { danger: false },
  );
}

on('candidate-progress', ({ projectId, id, p }) => {
  if (projectId !== state.projectId) return;
  prog.set(id, p);
  paintProgress(id);
});
nat.onDownloadProgress(({ url, got, total }) => {
  if (total && got < total)
    toast(
      `正在下载完整原片… ${Math.floor((got / total) * 100)}%`,
      { label: '取消', cb: () => native('cancelDownload')(url) },
      'info',
    );
});
