/* 视频审核：Claude 找好的视频候选在这里过目，通过的自动挂成主画面。
   流程：导入候选清单（JSON，type = fenjingtai-candidates）→ 每个候选截 6 张图 + 只播建议的那几秒
   → 通过 / 不要 / 换一个 + 意见 → 通过的挂到画面上（角色主画面、片段入出点、画面描述追加来源一行）
   → 审核结果自动写回候选清单文件，Claude 读得到 → 顶部可批量保存已通过片段；完整原片要单独点。
   不下载任何文件，直到你点「保存已通过的片段」或「下载完整原片」。

   审核页是一个「收件箱」，和表格共用顶栏：
   · 批次：每次导入算一批。左栏顶上固定一张当前批次卡片（第 N 批 · 日期 · 待审数 · 进度条），点它在菜单里
     换批次 / 导入新批次；卡片的「⋯」里是更换保存位置、删除此批次。卡片下面是这一批的全部画面。
   · 右边按句子排：每句原文下面直接挂配它的候选，句尾标这句有没有画面（有 / 只覆盖一部分 / 待审 / 还缺）；
     截图只给右边这几个候选截。
   · 审完就走：审过的候选收成一行（能撤回），不再有「已通过」页——通过的结果在表格的画面上看；
     「不要」的离开审核页时自动清掉（结果已写回清单，再导入同一份清单也不会回来）。
   · 键盘：1 通过 · 2 不要 · 3 换一个 · ↑↓ 换候选 · ←→ 换画面 · 空格 播放这段；一个画面审完自动跳到下一个。 */
import { state, update, rowById, renumber, on } from '../app/state.js';
import { persist, markProjectDirty, projectById, allProjects } from '../app/storage.js';
import { snapshot } from '../app/undo.js';
import { invalidateProbe, probePaths, isMissing } from '../app/asset-actions.js';
import { shotMembers } from '../core/shots.js';
import { assetName, syncMirror, usageList, referencedAssetIds } from '../core/asset-model.js';
import { preview } from '../ui/badges.js';
import { fmtTime } from '../core/text.js';
import {
  CANDIDATE_TYPE,
  CANDIDATE_VERSION,
  DECISION,
  planImport,
  attachCandidate,
  detachCandidate,
  swapToLocal,
  reviewPayload,
  applyFor,
  lineTag,
  fileTitle,
  hasLineTag,
  staleOnlineClips,
} from '../core/candidates.js';
import {
  playerHTML,
  targetLines,
  playClip,
  togglePause,
  seekTrack,
  stopAllVideos,
  stopClip,
  setVoiceOn,
} from './clip-player.js';
import * as nat from '../platform/native.js';
import { toast, confirmModal, esc } from '../ui/dom.js';
import { setView, syncViewToggle } from '../ui/render.js';
import { slideIn } from '../ui/anim.js';
import { glide, roll, pop, SPRING } from '../ui/motion.js';
import { registerCommand, runCommand } from '../ui/commands.js';
import { openMenu, closePop, popOpenFor, markPopAnchor, popEl } from '../ui/popover.js';
import { CANDIDATE_SPEC } from '../core/candidate-spec.js';

export { CANDIDATE_TYPE };
const $ = s => document.querySelector(s);
/* 原生能力统一走 platform/native.js（自测可通过 window.fjtHooks 注入替身） */
const native = name => nat[name];

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
    if (lastWritten.get(file) === JSON.stringify(results) && !failedFiles.has(file)) continue;
    pendingWrites.set(file, results);
  }
}
async function runWrites() {
  const jobs = [...pendingWrites.entries()];
  pendingWrites.clear();
  const out = new Map();
  let newlyFailed = 0;
  for (const [file, results] of jobs) {
    let r;
    try {
      r = await native('writeCandidateReview')(file, results);
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
    toast(
      `${newlyFailed} 份候选清单没能写回（${[...failedFiles.values()][0]}）。审核结果仍保存在项目里，下次审核时会再试`,
      null,
      'error',
    );
  refreshVideoReviewButton();
  return out;
}
function writeBack(cands = state.candidates) {
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
function syncedFiles(cands) {
  const ok = new Set();
  for (const [file, results] of reviewPayload(cands))
    if (!failedFiles.has(file) && lastWritten.get(file) === JSON.stringify(results)) ok.add(file);
  return ok;
}

export function importCandidates(doc, srcFile) {
  renumber();
  const plan = planImport(doc, srcFile, state.rows, state.candidates);
  if (plan.error) {
    if (plan.errors) showFormatErrors(plan.errors, srcFile);
    else toast(plan.error);
    return null;
  }
  if (!plan.added.length && !plan.updated.length) {
    toast(plan.skipped.length ? `清单里的 ${plan.skipped.length} 个候选都对不上句子` : '清单里没有候选');
    return plan;
  }
  snapshot('导入视频候选');
  // 每次导入算一批：新加的候选、以及链接 / 时间改了重新回到待审的，都归进这一批
  const batch = {
    batchId: 'vb-' + Date.now().toString(36),
    batchAt: Date.now(),
    batchName: batchNameOf(doc, srcFile, plan),
    batchNo: Math.max(0, ...batches().map(b => b.number)) + 1,
  };
  let reset = 0;
  for (const { old, next, changed } of plan.updated) {
    const forChanged = (old.for || '') !== (next.for || '');
    if (changed) {
      // 链接或片段换了：先把按旧版本挂上的视频从画面上撤下（描述里那行来源也删），旧的已保存状态作废
      if (old.decision === 'ok' && old.assetId) {
        detachCandidate(old, state.rows, state.assets);
        reset++;
      }
      delete old.assetId;
      delete old.savedPath;
      delete old.decidedAt;
      frames.delete(old.id);
    }
    Object.assign(old, next);
    // 已通过的候选补写了「配哪几句」：素材在表格里的出现范围跟着改
    const lead = forChanged && old.decision === 'ok' && old.assetId ? rowById(old.rowId) : null;
    if (lead) applyFor(old, shotMembers(state.rows, lead), old.assetId);
    if (!old.decision) Object.assign(old, batch);
  }
  for (const c of plan.added) Object.assign(c, batch);
  state.candidates = [...state.candidates, ...plan.added];
  persist();
  update('rows');
  curBatch = batch.batchId;
  curShot = null;
  openVideoReview();
  toast(
    `已导入 ${plan.added.length} 个视频候选${plan.updated.length ? `，更新 ${plan.updated.length} 个` : ''}${reset ? `（其中 ${reset} 个已通过的换了链接或片段，已撤下旧视频、回到待审）` : ''}${plan.skipped.length ? ` · ${plan.skipped.length} 个对不上句子，已跳过` : ''}`,
    null,
    plan.skipped.length ? 'warn' : 'ok',
  );
  if (reset) writeBack();
  return plan;
}

/* 格式不对的清单整份不导入：弹窗逐条写出错在哪；「复制给 AI」把全部错误连同格式规范一起复制，
   粘贴给找素材的 AI 让它照着改 */
const SPEC_NAME = `《分镜台候选清单格式 v${CANDIDATE_VERSION}》`;
function showFormatErrors(errors, srcFile) {
  const shown = errors.slice(0, 8);
  const more = errors.length > shown.length ? `\n…还有 ${errors.length - shown.length} 处` : '';
  const name = assetName(srcFile || '') || '这份清单';
  confirmModal(
    '候选清单格式不对，没有导入',
    `「${name}」没有按${SPEC_NAME}写，共 ${errors.length} 处问题，整份都没有导入：\n\n· ${shown.join('\n· ')}${more}\n\n点「复制给 AI」，会把全部问题和格式规范一起复制下来，粘贴给找素材的 AI，让它改好再导入。`,
    '复制给 AI',
    () =>
      copyText(
        `这份视频候选清单（${name}）没有通过分镜台的格式检查，整份没有导入。请按下面的规范逐条改好，输出完整的 JSON 文件：\n\n${errors.map(e => '- ' + e).join('\n')}\n\n---\n\n${CANDIDATE_SPEC}`,
        '已复制问题和格式规范，粘贴给 AI 即可',
      ),
    { cancelText: '关闭', danger: false },
  );
}
async function copyText(text, okMsg) {
  try {
    await (window.fjtHooks?.copyText || (t => navigator.clipboard.writeText(t)))(text);
    toast(okMsg, null, 'ok');
  } catch {
    toast('复制失败，请再试一次', null, 'error');
  }
}
export const copyCandidateSpec = () =>
  copyText(
    `请按下面的规范把找到的视频素材写成候选清单（.json），不合规范的分镜台不会导入。\n\n${CANDIDATE_SPEC}`,
    `已复制${SPEC_NAME}，发给找素材的 AI 即可`,
  );

/* 批次名：清单里写了 batch / title 就用它，否则用涉及的章节名，再不行用文件名 */
function batchNameOf(doc, srcFile, plan) {
  const given = String(doc.batch || doc.title || '').trim();
  if (given) return given.slice(0, 40);
  const secs = [];
  for (const c of [...plan.added, ...plan.updated.map(x => x.next)]) {
    const name = sectionOf(c.rowId);
    if (name && !secs.includes(name)) secs.push(name);
  }
  if (secs.length === 1) return secs[0];
  if (secs.length > 1) return `${secs[0]} 等 ${secs.length} 章`;
  return assetName(srcFile || '') || '视频候选';
}

export function setDecision(id, d) {
  const c = state.candidates.find(x => x.id === id);
  if (!c) return;
  const next = c.decision === d ? '' : d;
  snapshot(next ? `视频候选：${DECISION[next]}` : '撤回审核');
  let msg = '';
  if (c.decision === 'ok' && next !== 'ok') {
    detachCandidate(c, state.rows, state.assets);
    msg = '已从画面上撤下这个视频 · ⌘Z 可撤销';
  }
  if (next === 'ok') {
    const r = attachCandidate(c, state.rows, state.assets);
    if (r.error) {
      toast(r.error);
      return;
    }
    c.assetId = r.assetId;
    const names = r.demoted.map(x => state.assets[x]?.name || '素材');
    msg = `已挂成主画面（${fmtTime(c.in)}–${fmtTime(c.out)}）${names.length ? `，「${names.join('」「')}」让位成备选` : ''}`;
  }
  c.decision = next;
  if (next) c.decidedAt = Date.now();
  else delete c.decidedAt;
  touched.add(c.id);
  persist();
  update('rows');
  writeBack();
  if (next === 'ok') relinkSavedClips(); // 这一段以前保存过（自己或重复批次里的同一段）：直接换成本地文件，不再挂在线地址
  if (next) advanceAfterDecision(c);
  renderVideoReview();
  if (next) stamp(c.id);
  if (msg) toast(msg);
}
let noteTimer = null;
export function setNote(id, text) {
  const c = state.candidates.find(x => x.id === id);
  if (!c) return;
  c.note = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    persist();
    writeBack();
  }, 400);
}

async function ensureMediaDir(force = false) {
  if (state.mediaDir && !force) return state.mediaDir;
  const dir = await native('pickFolder')(state.mediaDir || '');
  if (!dir) return null;
  state.mediaDir = dir;
  persist();
  renderVideoReview();
  return dir;
}
const busy = new Set();
/* 截取进度：id → 0–1（主进程按 ffmpeg 的 -progress 回报）。只原地改批量按钮，不重画整个窗口 */
const prog = new Map();
let batchRun = null; // 「保存已通过的片段」进行中：{ i, n, id }
const pctOf = id => Math.round((prog.get(id) || 0) * 100);
function saveAllLabel() {
  if (!batchRun) return null;
  const p = batchRun.id && prog.has(batchRun.id) ? ` · ${pctOf(batchRun.id)}%` : '';
  return `正在保存 ${batchRun.i}/${batchRun.n}${p}`;
}
function paintProgress(id) {
  const all = $('#vrSaveAll');
  const label = saveAllLabel();
  if (all && label) {
    all.textContent = label;
    all.style.setProperty('--p', (batchRun.id && batchRun.id === id ? pctOf(id) : 0) + '%');
  }
}
export async function saveSegment(id, { quiet = false } = {}) {
  const c = state.candidates.find(x => x.id === id);
  if (!c || c.decision !== 'ok' || busy.has(id)) return null;
  const pid = state.projectId,
    projTitle = state.title;
  const dir = await ensureMediaDir();
  if (!dir || state.projectId !== pid) return null;
  busy.add(id);
  prog.delete(id);
  renderVideoReview();
  let r;
  try {
    renumber();
    r = await native('saveVideoSegment')({
      url: c.url,
      start: c.in,
      end: c.out,
      dir,
      name: fileTitle(c, state.rows),
      token: id,
    });
  } finally {
    busy.delete(id);
    prog.delete(id);
  }
  if (!r || !r.ok) {
    renderVideoReview();
    if (r?.needFfmpeg)
      confirmModal('需要先装 ffmpeg', r.error, '知道了', () => {}, { cancelText: '关闭', danger: false });
    else if (!quiet) toast('保存失败：' + (r?.error || '未知原因'), null, 'error');
    return r;
  }
  // 截取期间切走了项目：结果写进原来那个项目（不碰现在打开的项目和它的撤销记录）
  if (state.projectId !== pid) {
    applySavedElsewhere(pid, id, r.path);
    if (!quiet) toast(`「${projTitle}」的片段已保存：${assetName(r.path)}`, null, 'ok');
    return r;
  }
  const cur = state.candidates.find(x => x.id === id);
  if (!cur || cur.decision !== 'ok' || cur.url !== c.url || cur.in !== c.in || cur.out !== c.out) {
    // 截取期间撤回了通过、或候选被更新成别的片段：文件留着，但不再挂到画面上
    if (!quiet) toast(`片段已保存到 ${assetName(r.path)}，但这个候选已经变了，没有挂到画面上`, null, 'warn');
    return r;
  }
  snapshot('保存视频片段');
  cur.savedPath = r.path;
  swapToLocal(cur, r.path, state.rows, state.assets);
  invalidateProbe();
  persist();
  update('rows');
  writeBack();
  renderVideoReview();
  if (!quiet)
    toast(`已保存：${assetName(r.path)}`, { label: '在访达中显示', cb: () => native('revealAsset')(r.path) }, 'ok');
  return r;
}
function applySavedElsewhere(pid, candId, path) {
  const p = projectById(pid);
  const c = p?.candidates?.find(x => x.id === candId);
  if (!p || !c || c.decision !== 'ok') return;
  c.savedPath = path;
  swapToLocal(c, path, p.rows || [], p.assets || {});
  markProjectDirty(pid);
  writeBack(p.candidates);
}
/* 旧版本保存的片段文件名只有视频标题：载入项目时在原文件夹里补上句号（第125-127句_…），
   素材库路径、候选记录、候选清单一起改。找不到文件的跳过，不进撤销（改的是磁盘上的文件名） */
let tagging = false,
  tagAgain = false;
export async function tagOldSavedClips() {
  if (tagging) {
    tagAgain = true; // 正在改上一个项目的：改完再看一遍当前项目
    return 0;
  }
  const pid = state.projectId;
  const todo = state.candidates.filter(c => c.savedPath && !hasLineTag(c.savedPath));
  if (!todo.length) return 0;
  tagging = true;
  const { rows, assets, candidates } = state;
  const moved = new Map(); // 旧路径 → 新路径
  try {
    renumber();
    for (const c of todo) {
      const old = c.savedPath;
      if (!moved.has(old)) {
        const tag = lineTag(c, rows);
        if (!tag) continue;
        const r = await native('tagSavedClip')(old, tag);
        if (!r?.ok || !r.path || r.path === old) continue;
        moved.set(old, r.path);
      }
    }
  } finally {
    tagging = false;
    if (tagAgain) {
      tagAgain = false;
      setTimeout(tagOldSavedClips, 0);
    }
  }
  if (!moved.size) return 0;
  // 别的项目（比如「改稿前」副本）也可能引用同一个文件：一起改成新路径，不留失联
  for (const p of allProjects()) {
    if (p.id === pid) continue;
    let hit = false;
    for (const a of Object.values(p.assets || {}))
      if (moved.has(a.path)) {
        a.path = moved.get(a.path);
        a.name = assetName(a.path);
        hit = true;
      }
    for (const c of p.candidates || [])
      if (moved.has(c.savedPath)) {
        c.savedPath = moved.get(c.savedPath);
        hit = true;
      }
    if (hit) {
      syncMirror(p.rows || [], p.assets || {});
      markProjectDirty(p.id);
    }
  }
  for (const c of candidates) if (moved.has(c.savedPath)) c.savedPath = moved.get(c.savedPath);
  for (const a of Object.values(assets || {}))
    if (moved.has(a.path)) {
      a.path = moved.get(a.path);
      a.name = assetName(a.path);
    }
  if (state.projectId !== pid) {
    markProjectDirty(pid); // 中途切了项目：改的是原项目的数据，单独标记写盘
    return moved.size;
  }
  syncMirror(rows, assets);
  invalidateProbe();
  persist();
  update('rows');
  writeBack();
  const first = [...moved.values()][0];
  toast(`已给 ${moved.size} 个保存过的视频片段补上句号，例如「${assetName(first)}」`, {
    label: '在访达中显示',
    cb: () => native('revealAsset')(first),
  });
  return moved.size;
}

/* 保存过的片段换回本地文件（见 core/candidates.js 的 staleOnlineClips）。本地文件还在就直接换上；
   文件已经被删掉的，清掉「已保存」，「保存已通过的片段」会重新截。不进撤销（只是把数据改回应有的样子） */
let relinking = null;
export function relinkSavedClips({ quiet = false } = {}) {
  relinking ||= (async () => {
    const pid = state.projectId;
    const stale = staleOnlineClips(state.candidates, state.rows, state.assets);
    if (!stale.length) return 0;
    const info = await probePaths(stale.map(x => x.cand.savedPath));
    if (state.projectId !== pid) return 0;
    let fixed = 0,
      gone = 0;
    for (const { asset, cand } of stale) {
      // 等待期间撤回了 / 换了片段：这个不动
      if (!state.candidates.includes(cand) || state.assets[asset.id] !== asset || !cand.savedPath) continue;
      const got = info[cand.savedPath];
      if (got && !isMissing(got)) {
        // 候选原来记着的素材已经不在表格上了（撤回时拿掉的）：改记成现在挂着的这个，以后撤回能拿对
        if (!referencedAssetIds(state.rows).has(cand.assetId)) cand.assetId = asset.id;
        if (swapToLocal({ assetId: asset.id }, cand.savedPath, state.rows, state.assets)) fixed++;
      } else if (isMissing(got)) {
        delete cand.savedPath;
        gone++;
      }
    }
    if (!fixed && !gone) return 0;
    invalidateProbe();
    persist();
    update('rows');
    writeBack();
    if (!quiet || gone)
      toast(
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
  })().finally(() => (relinking = null));
  return relinking;
}

/* 载入项目时：先给旧文件名补句号，再把保存过却还挂在线地址的片段换回本地文件（顺序不能反：补句号会改文件名） */
const tidySavedClips = () =>
  tagOldSavedClips()
    .catch(() => 0)
    .then(() => relinkSavedClips());

export async function saveAllApproved() {
  await relinkSavedClips({ quiet: true }); // 已经存在本地的先换上，不重复下载
  const list = state.candidates.filter(c => c.decision === 'ok' && !c.savedPath);
  if (!list.length) {
    toast('没有待保存的已通过片段');
    return;
  }
  if (!(await ensureMediaDir())) return;
  if (batchRun) return;
  let ok = 0,
    fail = 0;
  const reasons = new Map(); // 失败原因 → 段数：批量时不逐条弹提示，最后汇总告诉用户为什么失败
  batchRun = { i: 0, n: list.length, id: null };
  const pid = state.projectId;
  try {
    for (const c of list) {
      if (state.projectId !== pid) break; // 切了项目：后面的不再继续截
      batchRun.i = ok + fail + 1;
      batchRun.id = c.id;
      paintProgress(c.id);
      const r = await saveSegment(c.id, { quiet: true });
      if (r?.ok) ok++;
      else {
        fail++;
        if (r?.needFfmpeg) return;
        const why = r?.error || '未知原因';
        reasons.set(why, (reasons.get(why) || 0) + 1);
      }
    }
  } finally {
    batchRun = null;
    renderVideoReview();
  }
  if (!fail) return toast(`已保存 ${ok} 段`, null, 'ok');
  const [top, n] = [...reasons].sort((a, b) => b[1] - a[1])[0] || ['未知原因', fail];
  const more = reasons.size > 1 ? `等 ${reasons.size} 种原因` : '';
  toast(
    `已保存 ${ok} 段，${fail} 段失败（可再次批量尝试）。${n < fail || more ? `主要原因（${n} 段）` : '原因'}：${top}${more ? '，' + more : ''}`,
    null,
    ok ? 'warn' : 'error',
  );
}
export function downloadOriginal(id) {
  const c = state.candidates.find(x => x.id === id);
  if (!c) return;
  confirmModal(
    '下载完整原片？',
    `会把整部视频下载到保存位置，可能有几百 MB，需要一段时间。\n\n${c.title}\n${c.url}`,
    '下载',
    async () => {
      const dir = await ensureMediaDir();
      if (!dir) return;
      toast('开始下载完整原片…', { label: '取消', cb: () => native('cancelDownload')(c.url) }, 'info');
      renumber();
      const r = await native('downloadOriginalVideo')({ url: c.url, dir, name: fileTitle(c, state.rows) });
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

/* ── 界面 ── */
let curBatch = null; // 正在看的批次
let curShot = null; // 右边显示的画面（画面第一句的 id）
let curCand = null; // 键盘焦点所在的候选
/* 刚审过的候选先展开留在原处（来得及写意见、撤回），换画面后收成一行 */
const touched = new Set();
const frames = new Map(); // 候选 id → 已截好的帧（重绘时直接搬过去，不重复请求）
const pendingCount = () => state.candidates.filter(c => !c.decision).length;
const isPending = c => !c.decision;
export const candidatesForRow = row =>
  row ? state.candidates.filter(c => shotMembers(state.rows, row).some(m => m.id === c.rowId)) : [];

/* 顶栏「视频审核」上的待审数小角标（没有待审就不显示） */
export function refreshVideoReviewButton() {
  const badge = $('#vtBadge');
  if (!badge) return;
  const p = pendingCount();
  const text = p > 99 ? '99+' : String(p);
  const was = !badge.hidden;
  badge.hidden = !p;
  // 待审数变化：数字滚过去；角标刚出现时弹一下
  if (was && p) roll(badge, text);
  else {
    badge.textContent = text;
    badge.dataset.moRoll = text;
    if (p) pop(badge, { scale: 0.3 });
  }
  const b = badge.closest('button');
  if (b)
    b.title = p
      ? `视频审核：${p} 个候选待审 (⌘T)`
      : state.candidates.length
        ? '视频审核：这个项目的候选都审完了 (⌘T)'
        : '视频审核：让 Claude 找好候选清单后导入 (⌘T)';
  // 角标出现 / 消失会改变按钮宽度：刷新后再量，不能沿用刷新前的选中底块。
  syncViewToggle();
}

/* 句子所在章节名 */
function sectionOf(rowId) {
  let name = '';
  for (const r of state.rows) {
    if (r.kind === 'section') name = r.text;
    if (r.id === rowId) return name;
  }
  return '';
}
const leadOf = c => {
  const row = rowById(c.rowId);
  return row ? shotMembers(state.rows, row)[0] : null;
};

/* 批次：按导入时间新的在前；1.8 以前导入的没有批次，归成「之前导入的」 */
function batches() {
  const map = new Map();
  for (const c of state.candidates) {
    const id = c.batchId || 'legacy';
    if (!map.has(id))
      map.set(id, { id, name: c.batchId ? c.batchName || '视频候选' : '之前导入的', at: c.batchAt || 0, cands: [] });
    map.get(id).cands.push(c);
  }
  const all = [...map.values()].sort((a, b) => b.at - a.at);
  return all.map((b, i) => ({
    ...b,
    number: b.cands.find(c => Number.isSafeInteger(c.batchNo) && c.batchNo > 0)?.batchNo || all.length - i,
  }));
}
const batchLabel = b => `${b.id === 'legacy' ? '' : `第 ${b.number} 批 · `}${b.name}`;

function confirmDeleteBatch() {
  const batch = curBatchObj();
  if (!batch || batchRun || batch.cands.some(c => busy.has(c.id))) return;
  const pid = state.projectId;
  const ids = new Set(batch.cands.map(c => c.id));
  confirmModal(
    '删除这个批次？',
    `将从视频审核中移除「${batchLabel(batch)}」的 ${ids.size} 个候选。\n\n已通过并挂到表格的素材、已下载文件和原候选清单都会保留。删除后可用 ⌘Z 撤销。`,
    '删除此批次',
    () => {
      if (state.projectId !== pid) return;
      const removed = state.candidates.filter(c => ids.has(c.id));
      if (!removed.length || batchRun || removed.some(c => busy.has(c.id))) return;
      snapshot('删除视频审核批次');
      // 保留其他批次原来的编号，删除第 7 批后第 8 批仍是第 8 批。
      for (const b of batches()) for (const c of b.cands) c.batchNo = b.number;
      writeBack(); // 未写完的审核意见照常写回，不把删除批次改成「不要」。
      stopAll();
      clearTimeout(advanceTimer);
      for (let i = queue.length - 1; i >= 0; i--) if (ids.has(queue[i].c.id)) queue.splice(i, 1);
      for (const c of removed) {
        frames.delete(c.id);
        touched.delete(c.id);
      }
      state.candidates = state.candidates.filter(c => !ids.has(c.id));
      curShot = curCand = null;
      persist();
      update('rows');
      toast(`已删除「${batchLabel(batch)}」的 ${removed.length} 个候选 · ⌘Z 可撤销`);
    },
  );
}
/* 一批里的画面：按稿子顺序，带章节名和待审数 */
function shotsOf(batch) {
  const order = new Map(state.rows.map((r, i) => [r.id, i]));
  const map = new Map();
  for (const c of batch?.cands || []) {
    const lead = leadOf(c);
    const key = lead ? lead.id : 'missing';
    if (!map.has(key)) map.set(key, { key, lead, cands: [] });
    map.get(key).cands.push(c);
  }
  return [...map.values()]
    .sort((a, b) => (order.get(a.lead?.id) ?? 1e9) - (order.get(b.lead?.id) ?? 1e9))
    .map(g => ({
      ...g,
      section: g.lead ? sectionOf(g.lead.id) : '',
      pending: g.cands.filter(isPending).length,
      ok: g.cands.filter(c => c.decision === 'ok').length,
      re: g.cands.filter(c => c.decision === 're').length,
    }));
}
const curBatchObj = () => batches().find(b => b.id === curBatch) || null;
const curShots = () => shotsOf(curBatchObj());
const curGroup = () => curShots().find(g => g.key === curShot) || null;

/* 打开时选哪一批、哪个画面：指定了画面就去它那一批；否则最新一批里第一个还有待审的画面 */
function pickDefaults(rowId) {
  const all = batches();
  if (rowId != null) {
    const row = rowById(rowId);
    const lead = row ? shotMembers(state.rows, row)[0] : null;
    const hits = state.candidates.filter(c => lead && leadOf(c)?.id === lead.id);
    const hit = hits.find(isPending) || hits[hits.length - 1];
    if (hit) {
      curBatch = hit.batchId || 'legacy';
      curShot = lead.id;
      return;
    }
  }
  if (!all.some(b => b.id === curBatch)) curBatch = (all.find(b => b.cands.some(isPending)) || all[0])?.id ?? null;
  const shots = curShots();
  if (!shots.some(g => g.key === curShot)) curShot = (shots.find(g => g.pending) || shots[0])?.key ?? null;
}
function selectShot(key) {
  if (key === curShot) return;
  const order = curShots().map(x => x.key);
  const dir = order.indexOf(key) >= order.indexOf(curShot) ? 1 : -1;
  curShot = key;
  curCand = null;
  touched.clear();
  stopAll();
  renderVideoReview();
  $('#vrList')?.scrollTo?.({ top: 0 });
  slideIn($('#vrList'), dir); // 下一个画面从右边滑进来，往回翻从左边
}
/* 审完一个：焦点移到这个画面的下一个待审候选；这个画面都审完了，稍等一下跳到下一个还有待审的画面 */
let advanceTimer = null;
function advanceAfterDecision(c) {
  const g = curGroup();
  if (!g || !g.cands.includes(c)) return;
  const next = layoutShot(g).order.find(x => x !== c && isPending(x)); // 按界面上从上到下的顺序
  if (next) {
    curCand = next.id;
    return;
  }
  clearTimeout(advanceTimer);
  const from = curShot;
  advanceTimer = setTimeout(() => {
    if (curShot !== from || state.view !== 'review') return;
    const shots = curShots();
    if (shots.find(x => x.key === from)?.pending) return renderVideoReview(); // 中途撤销了：留在这个画面
    const i = shots.findIndex(x => x.key === from);
    const after = [...shots.slice(i + 1), ...shots.slice(0, i)].find(x => x.pending);
    if (after) selectShot(after.key);
    else renderVideoReview();
  }, 600);
}

/* 审核和表格共用视图状态与布局，不登记弹窗，也不盖在表格上。 */
export function openVideoReview(rowId = null) {
  touched.clear();
  curCand = null;
  pickDefaults(rowId);
  const wasOpen = state.view === 'review';
  setView('review');
  if (!wasOpen) slideIn($('#reviewPage'), -1);
  else renderVideoReview();
}
export const closeVideoReview = () => {
  if (state.view === 'review') setView('table');
};
const stopAll = stopAllVideos;
/* 「不要」的候选离开审核页时清掉：结果已经写回清单（Claude 读得到），留着只会越堆越多。
   只清确实写进了清单文件的；写失败的留在项目里（下次离开审核页再试），没有来源文件的照旧清掉 */
async function purgeRejected() {
  const pid = state.projectId;
  const cands = state.candidates;
  if (!cands.some(c => c.decision === 'no')) return;
  await flushWriteBack(cands);
  if (state.projectId !== pid || state.candidates !== cands) return; // 等待期间切了项目或数据被替换：这次不动
  const synced = syncedFiles(cands);
  const drop = c => c.decision === 'no' && (!c.srcFile || synced.has(c.srcFile));
  if (!cands.some(drop)) return;
  state.candidates = cands.filter(c => !drop(c));
  for (const id of [...frames.keys()]) if (!state.candidates.some(c => c.id === id)) frames.delete(id);
  persist();
  refreshVideoReviewButton();
}

const fmtDay = t => {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const rangeText = lead => {
  if (!lead) return '找不到对应句子';
  const members = shotMembers(state.rows, lead);
  return members.length > 1 ? `第 ${members[0].no}–${members[members.length - 1].no} 句` : `第 ${members[0].no} 句`;
};

/* 批次在左栏的显示名：机器名的下划线换成「·」、去掉末尾 8 位日期（日期另外显示）；完整名字在悬停提示里 */
const prettyBatch = name =>
  String(name || '')
    .replace(/[_\s-]*\d{8}$/, '')
    .replace(/_+/g, ' · ')
    .trim() || String(name || '');
const fmtDate = t => {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};
const batchNo = b => (b.id === 'legacy' ? '之前导入的' : `第 ${b.number} 批`);

/* 只覆盖一部分：清单写了 coverageStatus: "partial"；旧清单没有这个字段时，看标题里有没有「只覆盖 / 部分覆盖」 */
const isPartial = c => c.coverage === 'partial' || (!c.coverage && /只覆盖|部分覆盖/.test(c.title || ''));

/* 一个画面按句子排：每个候选挂在它「配」的第一句下面；画面不止一句、又没写配哪句的，归到「整段」 */
function layoutShot(g) {
  const members = g?.lead ? shotMembers(state.rows, g.lead) : [];
  const whole = [];
  const byNo = new Map();
  for (const c of g?.cands || []) {
    const t = targetLines(c);
    const no = members.length > 1 && t.whole ? null : t.target[0]?.no;
    if (no == null || !members.some(m => m.no === no)) whole.push(c);
    else {
      if (!byNo.has(no)) byNo.set(no, []);
      byNo.get(no).push(c);
    }
  }
  return { members, whole, byNo, order: [...whole, ...members.flatMap(m => byNo.get(m.no) || [])] };
}
/* 展开着的候选（待审的 + 这次刚审过的），按界面上从上到下的顺序——↑↓ 换候选也按这个顺序走 */
const openOf = g => layoutShot(g).order.filter(c => isPending(c) || touched.has(c.id));

/* 这句有没有画面：看这个画面所有批次的候选；都没有时再看表格里这句挂没挂别的素材 */
function coverageOf(row, shotCands) {
  const hits = shotCands.filter(c => targetLines(c).target.some(r => r.id === row.id));
  const ok = hits.filter(c => c.decision === 'ok');
  if (ok.some(c => !isPartial(c))) return { cls: 'ok', text: '✓ 有画面' };
  if (ok.length) return { cls: 'part', text: '只覆盖一部分', tip: ok.map(c => c.limits || c.title).join('\n') };
  if (hits.some(isPending)) return { cls: 'wait', text: '待审' };
  if (usageList(row).some(u => !u.off)) return { cls: 'has', text: '表格里有其他素材' };
  if (hits.some(c => c.decision === 're')) return { cls: 'miss', text: '等新候选' };
  return { cls: 'miss', text: '还缺画面' };
}

/* 左栏：当前批次标题打开切换菜单，进度独立显示；下面是这一批的全部画面（按章节） */
function navHTML(all, shots) {
  let sec = null;
  const shotsHTML = shots
    .map(g => {
      const head = g.section !== sec ? `<div class="vr-nav-sec">${esc(g.section || '（没有章节）')}</div>` : '';
      sec = g.section;
      const status = g.pending
        ? `<span class="vr-nav-n">${g.pending} 待审</span>`
        : g.ok
          ? '<span class="vr-nav-done ok">✓ 已通过</span>'
          : g.re
            ? '<span class="vr-nav-done re">等新候选</span>'
            : '<span class="vr-nav-done">已审完</span>';
      const label = g.cands[0]?.label ? `<small>${esc(g.cands[0].label)}</small>` : '';
      return `${head}<button class="vr-nav-shot${g.key === curShot ? ' on' : ''}${g.pending ? '' : ' done'}" data-vr-goto="${esc(String(g.key))}"><span>${rangeText(g.lead)}${label}</span>${status}</button>`;
    })
    .join('');
  const b = all.find(x => x.id === curBatch);
  if (!b)
    return `<button class="vr-batch-add" id="vrImport" title="把 Claude 找好的候选清单（.json）导进来；也可以直接拖进窗口">＋ 导入候选清单…</button>
      <button class="vr-batch-add ghost" id="vrCopySpec" title="候选清单必须按这份规范写才能导入">复制格式规范（发给找素材的 AI）</button>`;
  const n = b.cands.length;
  const pending = b.cands.filter(isPending).length;
  const reviewed = n - pending;
  const reviewedPct = n ? (reviewed / n) * 100 : 0;
  const status = pending ? `<span class="vr-nav-n">${pending} 待审</span>` : '<span class="vr-bdone">✓ 已审完</span>';
  const name = b.id === 'legacy' ? '' : prettyBatch(b.name);
  const others = all.filter(x => x !== b);
  const otherPending = others.reduce((s, x) => s + x.cands.filter(isPending).length, 0);
  const tip = `${batchLabel(b)}${b.at ? ` · ${fmtDay(b.at)}` : ''}\n点击切换批次（共 ${all.length} 批）`;
  return `<div class="vr-picker">
      <div class="vr-bh${pending ? '' : ' complete'}">
        <div class="vr-bheader">
          <button class="vr-batch-head" id="vrBatchPick" data-vr-batch="${esc(b.id)}" title="${esc(tip)}" aria-label="${esc(batchLabel(b))}，切换批次，共 ${all.length} 批" aria-haspopup="menu">
            <b>${batchNo(b)}</b><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
          </button>
          <span class="vr-bdate">${fmtDate(b.at)}</span>
          <button class="vr-batch-more" id="vrBatchMore" title="这一批的操作：保存位置、删除批次" aria-label="批次操作" aria-haspopup="menu">⋯</button>
        </div>
        ${name ? `<div class="vr-bname" title="${esc(name)}">${esc(name)}</div>` : ''}
        <div class="vr-bprogress">${status}<span class="vr-bcount">已审 ${reviewed}/${n}</span></div>
        <div class="vr-bbar" role="progressbar" aria-label="本批审核进度" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${reviewed}"><i style="width:${reviewedPct.toFixed(1)}%"></i></div>
        ${otherPending ? `<div class="vr-bother">其他批次还有 ${otherPending} 个待审</div>` : ''}
      </div>
    </div>
    <div class="vr-shots">${shotsHTML}</div>`;
}

/* 换批次的菜单：新的在上，每批写待审数 / 审完，当前批次打勾；最下面是导入新批次 */
function openBatchPicker(anchor) {
  const all = batches();
  const items = all
    .map(b => {
      const p = b.cands.filter(isPending).length;
      const okN = b.cands.filter(c => c.decision === 'ok').length;
      const name = b.id === 'legacy' ? '' : prettyBatch(b.name);
      return `<div class="pop-item vr-bpick${b.id === curBatch ? ' cur' : ''}" data-vrb="pick" data-id="${esc(b.id)}" title="${esc(batchLabel(b))}"><span class="main"><span>${esc(batchNo(b))}${b.at ? `<span class="vr-bpick-date">${fmtDate(b.at)}</span>` : ''}</span>${name ? `<span class="desc">${esc(name)}</span>` : ''}</span><span class="vr-bpick-st${p ? ' wait' : ''}">${p ? `${p} 待审` : `✓ ${okN}/${b.cands.length}`}</span>${b.id === curBatch ? '<span class="chk">✓</span>' : ''}</div>`;
    })
    .join('');
  openMenu(
    anchor,
    `<div class="p-title">选择批次 · 共 ${all.length} 批</div>
      <div class="vr-bpick-list">${items}</div>
      <div class="pop-sep"></div>
      <div class="pop-item" data-vrb="import"><svg class="mi" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span class="main">导入新批次…<span class="desc">Claude 找好的候选清单（.json），也可以直接拖进窗口</span></span></div>
      <div class="pop-item" data-vrb="spec"><svg class="mi" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span class="main">复制候选清单格式规范<span class="desc">发给找素材的 AI，按 v${CANDIDATE_VERSION} 格式写才能导入</span></span></div>`,
  );
  markPopAnchor(anchor);
  popEl?.querySelector('.vr-bpick.cur')?.scrollIntoView({ block: 'nearest' });
}

/* 批次「⋯」菜单：保存位置（平时不占主界面）、删除此批次（危险操作收进菜单） */
function openBatchMenu(anchor) {
  const batch = curBatchObj();
  if (!batch) return;
  const locked = !!batchRun || batch.cands.some(c => busy.has(c.id));
  openMenu(
    anchor,
    `<div class="p-title">${esc(batchNo(batch))}${batch.at ? ` · ${fmtDay(batch.at)}` : ''}</div>
      <div class="pop-item" data-vrb="dir"><svg class="mi" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg><span class="main">更换保存位置…<span class="desc vr-pop-path">${esc(state.mediaDir || '还没选（第一次保存片段时会问）')}</span></span></div>
      <div class="pop-sep"></div>
      <div class="pop-item danger${locked ? ' disabled' : ''}" id="vrDeleteBatch" data-vrb="delete" title="${locked ? '片段保存完成后可以删除批次' : '移除这一批的审核候选，保留表格素材和本地文件'}"><svg class="mi" viewBox="0 0 24 24"><path d="M4 7h16M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg><span class="main">删除此批次<span class="desc">${batch.cands.length} 个候选 · 表格里的素材和本地文件保留</span></span></div>`,
  );
  markPopAnchor(anchor);
}
function selectBatch(id) {
  if (id === curBatch) return;
  curBatch = id;
  curShot = curCand = null;
  touched.clear();
  stopAll();
  clearTimeout(advanceTimer);
  renderVideoReview();
  $('#vrList')?.scrollTo?.({ top: 0 });
}

/* 当前候选配的那几句：句子左边亮一条主色 */
function paintLineFocus(c) {
  const nos = new Set(c ? targetLines(c).target.map(r => r.no) : []);
  document
    .querySelectorAll('#vrList .vr-line[data-vo-no]')
    .forEach(el => el.classList.toggle('hl', nos.has(+el.dataset.voNo)));
}

export function renderVideoReview() {
  refreshVideoReviewButton();
  const host = $('#vrList');
  if (!host || state.view !== 'review') return;
  pickDefaults(null);
  const all = batches();
  const batch = curBatchObj();
  const shots = shotsOf(batch);
  const bc = batch?.cands || [];
  const left = bc.filter(isPending).length;
  const ok = bc.filter(c => c.decision === 'ok');
  const unsaved = state.candidates.filter(c => c.decision === 'ok' && !c.savedPath).length;
  // 顶栏：这一批的进度。还有待审时先写剩几个；审完就只剩「共 N 个 · 已通过 M 个」
  $('#vrSummary').innerHTML = batch
    ? `${left ? `还剩 <b>${left}</b> 个待审<i></i>` : ''}共 <b>${bc.length}</b> 个${ok.length ? `<i></i>已通过 <b class="ok">${ok.length}</b> 个<i></i><button class="vr-link" id="vrSeeOk">在表格里看</button>` : ''}`
    : '';
  $('#vrSummary').hidden = !batch;
  const saveAll = $('#vrSaveAll');
  saveAll.hidden = !unsaved && !batchRun;
  saveAll.disabled = !!batchRun;
  saveAll.classList.toggle('saving', !!batchRun);
  saveAll.textContent = saveAllLabel() || `保存已通过的片段（${unsaved}）`;
  saveAll.title = `把已通过、还没保存的片段都截下来存到本地${state.mediaDir ? `\n保存到：${state.mediaDir}` : ''}`;
  const mine = new Set(state.candidates.map(c => c.srcFile).filter(Boolean));
  const fails = writeBackFailures().filter(([f]) => mine.has(f));
  const sync = $('#vrSync');
  sync.hidden = !fails.length;
  if (fails.length)
    sync.innerHTML = `${fails.length} 份清单没写回：${esc(fails[0][1])} <button class="vr-link" id="vrRetrySync">重试</button>`;

  // 左栏：批次 → 画面
  const nav = $('#vrNav');
  nav.innerHTML = navHTML(all, shots);
  nav.querySelector('.vr-nav-shot.on')?.scrollIntoView({ block: 'nearest' });
  glide(nav, nav.querySelector('.vr-nav-shot.on'), 'vrnav-glide'); // 左边的高亮块滑到当前画面

  // 右边：选中画面，按句子排
  const g = shots.find(x => x.key === curShot);
  if (!state.candidates.length) {
    host.innerHTML =
      '<p class="vr-empty">还没有视频候选。先点左边「复制格式规范」发给找素材的 AI，让它按规范写好候选清单（.json），再拖进窗口或点「导入候选清单」。</p>';
    return;
  }
  if (!g) {
    host.innerHTML = '<p class="vr-empty">这一批没有候选。</p>';
    return;
  }
  const { members, whole, byNo } = layoutShot(g);
  const open = openOf(g);
  const done = g.cands.filter(c => !isPending(c) && !touched.has(c.id));
  if (!open.some(c => c.id === curCand)) curCand = open.find(isPending)?.id || open[0]?.id || null;
  const shotCands = candidatesForRow(g.lead);
  const spanOf = c => {
    const t = targetLines(c);
    return !t.whole && t.target.length > 1
      ? `<p class="vr-span">配 第 ${t.target[0].no}–${t.target[t.target.length - 1].no} 句</p>`
      : '';
  };
  const group = list => {
    const o = list.filter(c => isPending(c) || touched.has(c.id));
    const d = list.filter(c => !isPending(c) && !touched.has(c.id));
    if (!o.length && !d.length) return '';
    return `<div class="vr-line-cands">${o.map(c => spanOf(c) + cardHTML(c)).join('')}${d.length ? `<div class="vr-done-list">${d.map(doneHTML).join('')}</div>` : ''}</div>`;
  };
  const lineHTML = m => {
    const cov = coverageOf(m, shotCands);
    return `<div class="vr-line" data-vo-no="${m.no}">
        <div class="vr-line-text"><span class="vr-line-no">${m.no}</span><p>${esc(m.text)}</p><span class="vr-cov ${cov.cls}"${cov.tip ? ` title="${esc(cov.tip)}"` : ''}>${cov.text}</span></div>
        ${group(byNo.get(m.no) || [])}
      </div>`;
  };
  // 前后各露一句（淡色），判断画面能不能接上
  const allLines = state.rows.filter(r => r.kind === 'line');
  const i0 = members.length ? allLines.indexOf(members[0]) : -1;
  const i1 = members.length ? allLines.indexOf(members[members.length - 1]) : -1;
  const ctx = (r, where) =>
    r
      ? `<p class="vr-ctx ${where}"><span class="vr-line-no">${r.no}</span><span>${where === 'before' ? '上一句' : '下一句'} · ${esc(r.text)}</span></p>`
      : '';
  const need = g.cands.find(c => c.need)?.need || '';
  stopClip(); // 重画会换掉播放器：先停掉，口播声音不会留在后台继续放
  host.innerHTML = `<section class="vr-shot" data-vr-shot="${esc(String(g.key))}">
      <div class="vr-shot-head"><h4><span class="vr-shot-range">${rangeText(g.lead)}</span>${g.cands[0]?.label ? `<span class="vr-shot-label">${esc(g.cands[0].label)}</span>` : ''}</h4>
      ${need ? `<p class="vr-need"><b>要的画面</b>${esc(need)}</p>` : ''}</div>
      ${i0 > 0 ? ctx(allLines[i0 - 1], 'before') : ''}
      ${
        whole.length
          ? `<div class="vr-line whole"><div class="vr-line-text"><span class="vr-line-no">整段</span><p>${members.length ? `配${rangeText(g.lead)}全部` : '找不到对应句子'}</p></div>${group(whole)}</div>`
          : ''
      }
      ${members.map(lineHTML).join('')}
      ${i1 >= 0 && i1 < allLines.length - 1 ? ctx(allLines[i1 + 1], 'after') : ''}
    </section>`;
  paintLineFocus(state.candidates.find(c => c.id === curCand) || null);
  paintMotion(host, g, open);
  host.querySelector('.vr-shot-head')?.classList.toggle('stuck', host.scrollTop > 2);
  for (const c of open) {
    const strip = host.querySelector(`[data-vr-id="${c.id}"] .vr-strip`);
    if (!strip) continue;
    const got = frames.get(c.id);
    if (got && got.length) strip.replaceChildren(...got.map(x => x.cell));
    else queueFrames(c);
  }
  for (const c of done) if (c.decision === 'ok' && c.savedPath) paintDoneThumb(c);
  // 截图只给右边这几个候选：换了画面，没轮到的截图任务取消
  for (let i = queue.length - 1; i >= 0; i--) if (!open.some(c => c.id === queue[i].c.id)) queue.splice(i, 1);
}
/* 审核页的动效：通过 / 不要 / 换一个 的底色块滑到选中的那个按钮上（第一次选时弹出来）。
   当前候选的蓝框不做滑动，直接切换（滑动的框看着晃）。 */
const decisionMemo = new Map(); // 候选 id → 上次的结果
function paintMotion(host, g, open) {
  const sec = host.querySelector('.vr-shot');
  if (!sec) return;
  for (const c of open) {
    const card = sec.querySelector(`[data-vr-id="${c.id}"]`);
    const on = card?.querySelector('.vr-btn.on[data-vr-d]');
    const before = decisionMemo.has(c.id) ? decisionMemo.get(c.id) : c.decision || ''; // 第一次看到：不算变化
    decisionMemo.set(c.id, c.decision || '');
    if (!on) continue;
    const row = on.parentElement;
    const prevBtn = before && before !== c.decision ? row.querySelector(`.vr-btn.${before}[data-vr-d]`) : null;
    const from = prevBtn
      ? { x: prevBtn.offsetLeft, y: prevBtn.offsetTop, w: prevBtn.offsetWidth, h: prevBtn.offsetHeight }
      : null;
    const pill = glide(row, on, 'vr-dpill', { from, pop: before !== (c.decision || '') });
    pill.dataset.d = c.decision;
  }
}
function stamp(id) {
  const card = $(`#vrList [data-vr-id="${id}"]`);
  if (!card) return;
  pop(card.querySelector('.vr-tag'), { scale: 1.7, duration: 460 });
  card.animate?.([{ transform: 'scale(0.985)' }, { transform: 'none' }], { duration: 380, easing: SPRING });
}
function cardHTML(c) {
  const d = c.decision || '';
  const actions =
    d === 'ok' && c.savedPath
      ? `<span class="vr-saved">已保存：${esc(assetName(c.savedPath))}</span><button class="vr-mini" data-vr-reveal="${c.id}">在访达中显示</button>`
      : '';
  return `<article class="vr-cand ${d ? 'd-' + d : ''}${c.id === curCand ? ' focus' : ''}" data-vr-id="${c.id}">
    <div class="vr-head"><strong>${esc(c.title || c.key || '（未命名）')}</strong>${d ? `<span class="vr-tag d-${d}">${DECISION[d]}</span>` : ''}</div>
    <div class="vr-meta">建议 ${fmtTime(c.in)}–${fmtTime(c.out)}（${Math.round(c.out - c.in)} 秒）· ${esc(c.license || '版权未注明')} · <button class="vr-link" data-vr-page="${c.id}">原片页面</button></div>
    ${c.why ? `<p class="vr-why">${esc(c.why)}</p>` : ''}
    <div class="vr-strip">${'<div class="vr-cell ld">载入中…</div>'.repeat(6)}</div>
    ${playerHTML(c)}
    <div class="vr-row">
      <button class="vr-btn play" data-vr-play="${c.id}">▶ 播放这段</button>
      <button class="vr-btn ok${d === 'ok' ? ' on' : ''}" data-vr-d="ok" data-vr-for="${c.id}">通过 <kbd>1</kbd></button>
      <button class="vr-btn no${d === 'no' ? ' on' : ''}" data-vr-d="no" data-vr-for="${c.id}">不要 <kbd>2</kbd></button>
      <button class="vr-btn re${d === 're' ? ' on' : ''}" data-vr-d="re" data-vr-for="${c.id}">换一个 <kbd>3</kbd></button>
      <input class="vr-note" data-vr-note="${c.id}" placeholder="意见（可选）：比如要更近景的、换成冷藏车外景…" value="${esc(c.note || '')}">
    </div>
    <div class="vr-row vr-after">${actions}<button class="vr-mini ghost" data-vr-orig="${c.id}">下载完整原片</button></div>
  </article>`;
}
/* 审过的候选收成一行：结果、意见、撤回（再点同一个结果 = 撤回）。
   通过的露一帧画面（已保存的用 macOS 系统缩略图，秒出、不另存文件），一眼看出通过的是什么；
   英文 key 只留给 Claude 读（清单里照旧），界面不显示 */
function doneHTML(c) {
  const d = c.decision;
  const save = d === 'ok' && c.savedPath ? `<span class="vr-saved">已保存</span>` : '';
  const thumbs =
    d === 'ok'
      ? `<div class="vr-done-thumbs"><div class="vr-cell ld">${c.savedPath ? '载入中…' : '保存后显示画面'}</div></div>`
      : '';
  return `<div class="vr-done d-${d}${thumbs ? ' has-thumbs' : ''}" data-vr-id="${c.id}">${thumbs}<span class="vr-tag d-${d}">${DECISION[d]}</span><span class="vr-done-title">${esc(c.title || c.key || '（未命名）')}</span>${c.note ? `<span class="vr-done-note">「${esc(c.note)}」</span>` : ''}<span class="vr-spacer"></span>${save}<button class="vr-mini" data-vr-d="${d}" data-vr-for="${c.id}" title="撤回这个审核结果，回到待审">撤回</button></div>`;
}

/* 截图：同时最多 2 个视频在截，每个候选在建议片段里均匀取 6 帧 */
const queue = [];
let running = 0;
function queueFrames(c) {
  if (queue.some(q => q.c.id === c.id) || frames.has(c.id)) return;
  queue.push({ c });
  pump();
}
function pump() {
  while (running < 2 && queue.length) {
    const { c } = queue.shift();
    running++;
    grab(c).finally(() => {
      running--;
      pump();
    });
  }
}
/* 截好的帧最多留 60 个候选的（每个 6 张），更早看过的先丢，重新看到时再截 */
const FRAME_KEEP = 60;
function trimFrames() {
  if (frames.size <= FRAME_KEEP) return;
  const onScreen = new Set([...document.querySelectorAll('#vrList [data-vr-id]')].map(el => el.dataset.vrId));
  for (const id of frames.keys()) {
    if (frames.size <= FRAME_KEEP) break;
    if (!onScreen.has(id)) frames.delete(id);
  }
}
async function grab(c) {
  const cells = [];
  frames.set(c.id, cells);
  trimFrames();
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = c.url.split('#')[0];
  const place = () => {
    const strip = document.querySelector(`[data-vr-id="${c.id}"] .vr-strip`);
    if (strip)
      strip.replaceChildren(
        ...cells.map(x => x.cell),
        ...Array.from({ length: 6 - cells.length }, () => loadingCell()),
      );
  };
  try {
    await loadMeta(v);
  } catch {
    frames.delete(c.id);
    const strip = document.querySelector(`[data-vr-id="${c.id}"] .vr-strip`);
    if (strip)
      strip.innerHTML = '<div class="vr-cell fail">截图失败（网站不让读或网络不通），点「播放这段」直接看</div>';
    return;
  }
  for (let i = 0; i < 6; i++) {
    // 片段均匀分成 6 段，各取中点（片段不足 1 秒也不会取到入点之前）
    const t = c.in + (Math.max(0, c.out - c.in) * (i + 0.5)) / 6;
    cells.push({ cell: await frameAt(v, t, fmtTime(t)) });
    place();
  }
  v.removeAttribute('src');
  v.load();
}
const loadMeta = v =>
  new Promise((res, rej) => {
    v.onloadedmetadata = res;
    v.onerror = rej;
    setTimeout(rej, 30000);
  });
/* 跳到 t 秒，等这一帧真的画出来，再画到一张小画布上（右下角标时间） */
async function frameAt(v, t, label) {
  v.currentTime = Math.max(0, t);
  await new Promise(r => {
    let done = false;
    const fin = () => {
      if (!done) {
        done = true;
        r();
      }
    };
    const f = () => {
      v.removeEventListener('seeked', f);
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => setTimeout(fin, 60));
      setTimeout(fin, 1500);
    };
    v.addEventListener('seeked', f);
    setTimeout(fin, 15000);
  });
  const cv = document.createElement('canvas');
  cv.width = 320;
  cv.height = Math.round((320 * v.videoHeight) / v.videoWidth) || 240;
  try {
    cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
  } catch {}
  const cell = document.createElement('div');
  cell.className = 'vr-cell';
  const tag = document.createElement('i');
  tag.textContent = label;
  cell.append(cv, tag);
  return cell;
}

/* 审过「通过」的那一行：已保存的片段用 macOS 系统缩略图（和表格里的素材缩略图同一套，系统自己缓存，
   分镜台不另存任何图片；内存里只留最近几十张，关掉软件就没了） */
function paintDoneThumb(c) {
  const path = c.savedPath;
  preview(path).then(url => {
    const cell = document.querySelector(`#vrList .vr-done[data-vr-id="${c.id}"] .vr-done-thumbs .vr-cell`);
    const cur = state.candidates.find(x => x.id === c.id);
    if (!cell || cur?.savedPath !== path) return; // 换了画面 / 片段被换掉：这张不用了
    if (!url) {
      cell.textContent = '没有缩略图';
      return;
    }
    const img = document.createElement('img');
    img.alt = '';
    img.src = url;
    cell.classList.remove('ld');
    cell.replaceChildren(img);
  });
}
function loadingCell(text = '载入中…') {
  const d = document.createElement('div');
  d.className = 'vr-cell ld';
  d.textContent = text;
  return d;
}
function play(id) {
  const c = state.candidates.find(x => x.id === id);
  const card = document.querySelector(`[data-vr-id="${id}"]`);
  if (!c || !card) return;
  const btn = card.querySelector('[data-vr-play]');
  playClip(card, c, { onState: text => (btn.textContent = text) });
}

/* 键盘：1 通过 · 2 不要 · 3 换一个 · ↑↓ 换候选 · ←→ 换画面 · 空格 播放 / 暂停这段。在意见框里打字时不抢键 */
export function videoReviewKey(e) {
  if (e.target?.closest?.('.vr-note, select')) {
    if (e.key === 'Enter' || (e.key === 'Escape' && e.target.matches('.vr-note'))) {
      e.preventDefault();
      e.target.blur();
      return true;
    }
    return e.key !== 'Escape' && !e.metaKey;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const open = openOf(curGroup());
  const k = open.findIndex(c => c.id === curCand);
  const move = d => {
    if (!open.length) return;
    curCand = open[Math.max(0, Math.min(open.length - 1, (k < 0 ? 0 : k) + d))].id;
    renderVideoReview();
    $(`#vrList [data-vr-id="${curCand}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const DKEYS = { 1: 'ok', 2: 'no', 3: 're' };
  if (DKEYS[e.key]) {
    e.preventDefault();
    if (curCand) setDecision(curCand, DKEYS[e.key]);
    return true;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    move(e.key === 'ArrowDown' ? 1 : -1);
    return true;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const shots = curShots();
    const i = shots.findIndex(x => x.key === curShot);
    const j = Math.max(0, Math.min(shots.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
    if (shots[j]) selectShot(shots[j].key);
    return true;
  }
  if (e.key === ' ') {
    e.preventDefault();
    if (!curCand) return true;
    const card = $(`#vrList [data-vr-id="${curCand}"]`);
    const c = state.candidates.find(x => x.id === curCand);
    if (!card || !c || !togglePause(card, c)) play(curCand);
    return true;
  }
  return false;
}

export function initVideoReview() {
  $('#tablePage').insertAdjacentHTML(
    'afterend',
    `<main class="workspace-page vr-page" id="reviewPage" aria-labelledby="vrTitle" hidden>
      <div class="vr-top">
        <h3 id="vrTitle">视频审核</h3>
        <div id="vrSummary" class="vr-summary" role="status"></div>
        <span id="vrSync" class="vr-sync" role="status" hidden></span>
        <div class="vr-top-r">
          <button class="btn" id="vrSaveAll" hidden title="把已通过、还没保存的片段都截下来存到本地">保存已通过的片段</button>
        </div>
      </div>
      <div class="vr-body">
        <nav id="vrNav" class="vr-nav" aria-label="批次和画面"></nav>
        <div id="vrList"></div>
      </div>
    </main>`,
  );
  $('#vrSaveAll').onclick = () => saveAllApproved();
  $('#vrNav').addEventListener('click', e => {
    if (e.target.closest('#vrImport')) return runCommand('import:file');
    if (e.target.closest('#vrCopySpec')) return copyCandidateSpec();
    const menuBtn = e.target.closest('#vrBatchMore, #vrBatchPick');
    if (menuBtn) {
      e.stopPropagation(); // 不让全局「点外面收起菜单」把刚打开的菜单又关掉
      if (popOpenFor(menuBtn)) closePop();
      else if (menuBtn.id === 'vrBatchMore') openBatchMenu(menuBtn);
      else openBatchPicker(menuBtn);
      return;
    }
    const b = e.target.closest('[data-vr-goto]');
    if (!b) return;
    const key = curShots().find(g => String(g.key) === b.dataset.vrGoto)?.key;
    if (key != null) selectShot(key);
  });
  $('#vrSummary').addEventListener('click', e => {
    if (!e.target.closest('#vrSeeOk')) return;
    // 通过的结果在表格的画面上：切到表格，跳到这一批第一个通过的画面
    const c = (curBatchObj()?.cands || []).find(x => x.decision === 'ok');
    closeVideoReview();
    if (c) runCommand('nav:jump', c.rowId);
  });
  // 往下翻候选时，钉在顶上的画面标题下沿加一道淡影，看得出下面还有内容在滚
  $('#vrList').addEventListener(
    'scroll',
    e => e.currentTarget.querySelector('.vr-shot-head')?.classList.toggle('stuck', e.currentTarget.scrollTop > 2),
    { passive: true },
  );
  $('#vrList').addEventListener('click', e => {
    const t = e.target;
    const card = t.closest('.vr-cand');
    if (card && card.dataset.vrId !== curCand) {
      curCand = card.dataset.vrId;
      document.querySelectorAll('#vrList .vr-cand').forEach(el => el.classList.toggle('focus', el === card));
      paintLineFocus(state.candidates.find(x => x.id === curCand));
    }
    const track = t.closest('[data-vr-track]');
    if (track) {
      const c = state.candidates.find(x => x.id === track.dataset.vrTrack);
      if (c) seekTrack(card, c, track, e.clientX);
      return;
    }
    const pp = t.closest('[data-vr-pp]');
    if (pp) {
      const c = state.candidates.find(x => x.id === pp.dataset.vrPp);
      if (c && !togglePause(card, c)) play(c.id);
      return;
    }
    const d = t.closest('[data-vr-d]');
    if (d) return setDecision(d.dataset.vrFor, d.dataset.vrD);
    const p = t.closest('[data-vr-play]');
    if (p) return play(p.dataset.vrPlay);
    const o = t.closest('[data-vr-orig]');
    if (o) return downloadOriginal(o.dataset.vrOrig);
    const pg = t.closest('[data-vr-page]');
    if (pg) {
      const c = state.candidates.find(x => x.id === pg.dataset.vrPage);
      if (c) native('openAsset')(c.page || c.url);
      return;
    }
    const rv = t.closest('[data-vr-reveal]');
    if (rv) {
      const c = state.candidates.find(x => x.id === rv.dataset.vrReveal);
      if (c?.savedPath) native('revealAsset')(c.savedPath);
    }
  });
  $('#vrList').addEventListener('change', e => {
    if (e.target.matches?.('[data-vr-voice]')) setVoiceOn(e.target.checked); // 「口播声音」开关记住，下次默认照旧
  });
  $('#vrList').addEventListener('input', e => {
    const n = e.target.closest('[data-vr-note]');
    if (n) setNote(n.dataset.vrNote, n.value);
  });
  // 批量截取进度：顶部按钮显示当前片段的百分比和进度条
  nat.onSegmentProgress(({ token, p }) => {
    if (!busy.has(token)) return;
    prog.set(token, p);
    paintProgress(token);
  });
  // 下载完整原片的进度：提示条里显示百分比
  nat.onDownloadProgress(({ url, got, total }) => {
    if (total && got < total)
      toast(
        `正在下载完整原片… ${Math.floor((got / total) * 100)}%`,
        { label: '取消', cb: () => native('cancelDownload')(url) },
        'info',
      );
  });
  on('rows', renderVideoReview); // 撤销 / 重做 / 切项目后按钮和列表跟着刷新
  on('view', ({ from, view }) => {
    if (from === 'review') {
      stopAll();
      clearTimeout(advanceTimer);
      purgeRejected();
      slideIn($('#tablePage'), 1);
    }
    if (view === 'review') renderVideoReview();
  });
  // 撤销 / 重做改回了审核结果：清单文件也跟着改回去（内容没变就不写）
  on('history', () => {
    if (state.candidates.length) writeBack();
  });
  $('#vrSync').addEventListener('click', e => {
    if (e.target.closest('#vrRetrySync')) flushWriteBack().then(() => renderVideoReview());
  });
  // 批次菜单（换批次 / 导入）和「⋯」菜单（保存位置 / 删除）里的项
  document.addEventListener('click', e => {
    const it = e.target.closest?.('.popover .pop-item[data-vrb]');
    if (!it || it.classList.contains('disabled')) return;
    closePop();
    const act = it.dataset.vrb;
    if (act === 'dir') ensureMediaDir(true);
    else if (act === 'delete') confirmDeleteBatch();
    else if (act === 'pick') selectBatch(it.dataset.id);
    else if (act === 'import') runCommand('import:file');
    else if (act === 'spec') copyCandidateSpec();
  });
  on('project-loaded', () => {
    curBatch = curShot = curCand = null;
    touched.clear();
    setTimeout(tidySavedClips, 0);
  });
  setTimeout(tidySavedClips, 0); // 启动时的项目在这之前就载入了
  registerCommand('video:open', openVideoReview);
  registerCommand('video:close', closeVideoReview);
  registerCommand('video:key', videoReviewKey);
  registerCommand('video:import', (doc, path) => importCandidates(doc, path));
  refreshVideoReviewButton();
}
