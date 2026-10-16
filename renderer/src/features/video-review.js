/* 视频审核：Claude 找好的视频候选在这里过目，通过的自动挂成主画面。
   流程：导入候选清单（JSON，type = fenjingtai-candidates）→ 每个候选截 6 张图 + 只播建议的那几秒
   → 通过 / 不要 / 换一个 + 意见 → 通过的挂到画面上（角色主画面、片段入出点、画面描述追加来源一行）
   → 审核结果自动写回候选清单文件，Claude 读得到 → 顶部可批量保存已通过片段；完整原片要单独点。
   不下载任何文件，直到你点「保存已通过的片段」或「下载完整原片」。

   审核页是一个「收件箱」，和表格共用顶栏：
   · 批次：每次导入算一批。左栏顶上固定一张当前批次卡片（实际句子 · 日期 · 待审数 · 进度条），点它在菜单里
     换批次 / 导入新批次；卡片的「⋯」里是更换保存位置、删除此批次。卡片下面是这一批的全部画面。
   · 右边分两栏：左边口播一句一行（标这句有没有画面），右边是方案——几个方案时用 Tab 换着看，
     方案上面一条填满进度，下面按播放顺序 ①②③ 排视频；聚焦哪个视频，左边亮它排到的那几句。
     画面已经填满后，别的没审的视频收成「未采用」。截图只给正在看的方案里的候选截。
   · 审完就走：审过的候选收成一行（能撤回），不再有「已通过」页——通过的结果在表格的画面上看；
     「不要」的在待返工里保留；画面有候选通过后，离开审核页时清掉已写回清单的否决项。
   · 键盘：1 通过 · 2 不要 · 3 换一个 · ↑↓ 换候选 · ←→ 换画面 · 空格 播放这段；一个画面审完自动跳到下一个。 */
import { state, rowById, renumber, on } from '../app/state.js';
import {
  importCandidateData,
  decideCandidate,
  setCandidateNote,
  deleteCandidateBatch,
  purgeRejectedCandidates,
  setReworkNote as updateReworkNote,
  dismissShotRework,
  registerReworkRequest,
} from '../app/candidate-actions.js';
import { flushWriteBack, writeBackFailures } from '../app/candidate-sync.js';
import { isCandidateBusy, relinkSavedClips, initCandidateMedia } from '../app/candidate-media.js';
import {
  saveAllApproved,
  downloadOriginal,
  retagLineFiles,
  ensureMediaDir,
  batchRun,
  saveAllLabel,
} from './review-files.js';
import {
  retainFrames,
  forgetFrames,
  clearReviewFrames,
  paintStrips,
  paintDoneThumb,
  mediaOf,
} from './review-frames.js';
import { shotMembers } from '../core/shots.js';
import { assetName } from '../core/asset-model.js';
import { CANDIDATE_TYPE, CANDIDATE_VERSION, usableSeconds } from '../core/candidates.js';
import {
  dockPlaythrough,
  undockPlaythrough,
  isDocked,
  toggleDocked,
  playthroughKey,
  pauseDocked,
  trackDragging,
} from './playthrough.js';
import { previewHost, previewingId, showTimeline, followCand } from './review-preview.js';
import { togglePause, seekTrack, stopAllVideos, stopClip, setVoiceOn } from './clip-player.js';
import * as nat from '../platform/native.js';
import { toast, confirmModal, esc } from '../ui/base/dom.js';
import { slideIn } from '../ui/base/anim.js';
import { glide, roll, pop } from '../ui/base/motion.js';
import { registerCommand, runCommand } from '../ui/base/commands.js';
import { openMenu, closePop, popOpenFor, markPopAnchor, popEl } from '../ui/base/popover.js';
import { CANDIDATE_SPEC } from '../core/candidate-spec.js';
import { buildReworkDoc } from '../core/rework.js';
import {
  page,
  touched,
  pendingCount,
  curBatchObj,
  batchLabel,
  batches,
  leadOf,
  isPending,
  curShots,
  curGroup,
  layoutShot,
  batchDetail,
  fmtDay,
  shotsOf,
  openOf,
  secText,
  trackFill,
  isIdle,
  rangeText,
  curReworkItem,
  reworkList,
  batchOfCand,
  reworkOpen,
} from './review-model.js';
import { stamp, cardHTML, doneHTML, paintLineFocus, paintMotion, play } from './review-cards.js';
import { renderRework } from './review-rework.js';
import { navHTML, paintTabs } from './review-nav.js';
import { safeFileName } from '../core/text.js';
import { deferRenderWhileEditing, clearDeferredRender } from '../ui/base/edit-session.js';

export { CANDIDATE_TYPE };
const $ = s => document.querySelector(s);
/* 原生能力统一走 platform/native.js（自测可通过 window.fjtHooks 注入替身） */
const native = name => nat[name];

export { flushWriteBack, writeBackFailures } from '../app/candidate-sync.js';
export { saveSegment, saveAllApproved, retagLineFiles } from './review-files.js';
export { tagOldSavedClips, relinkSavedClips } from '../app/candidate-media.js';
export { retagPlan } from '../core/candidate-queries.js';

export function importCandidates(doc, srcFile) {
  const plan = importCandidateData(doc, srcFile);
  if (plan.error) {
    if (plan.errors) showFormatErrors(plan.errors, srcFile);
    else toast(plan.error, null, 'error');
    return null;
  }
  if (!plan.added.length && !plan.updated.length) {
    toast(plan.skipped.length ? `清单里的 ${plan.skipped.length} 个候选都对不上句子` : '清单里没有候选', null, 'warn');
    return plan;
  }
  page.curBatch = plan.batch.batchId;
  page.curShot = null;
  openVideoReview();
  toast(
    `已导入 ${plan.added.length} 个视频候选${plan.updated.length ? `，更新 ${plan.updated.length} 个` : ''}${plan.reset ? `（其中 ${plan.reset} 个已通过的换了链接或片段，已撤下旧视频、回到待审）` : ''}${plan.skipped.length ? ` · ${plan.skipped.length} 个对不上句子，已跳过` : ''}`,
    null,
    plan.skipped.length ? 'warn' : 'ok',
  );
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

export function setDecision(id, d) {
  touched.add(id);
  const result = decideCandidate(id, d);
  if (!result || result.error) {
    if (result?.error) toast(result.error, null, 'error');
    return;
  }
  const { candidate: c, next, msg } = result;
  if (next === 'ok') relinkSavedClips();
  if (next) advanceAfterDecision(c);
  renderVideoReview();
  if (next) stamp(c.id);
  if (msg) toast(msg, null, 'ok');
}
export const setNote = setCandidateNote;

/* ── 界面 ── */

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
  runCommand('view:sync-toggle');
}

function confirmDeleteBatch() {
  const batch = curBatchObj();
  if (!batch || batchRun || batch.cands.some(c => isCandidateBusy(c.id))) return;
  const pid = state.projectId;
  const ids = new Set(batch.cands.map(c => c.id));
  confirmModal(
    '删除这个批次？',
    `将从视频审核中移除「${batchLabel(batch)}」的 ${ids.size} 个候选。\n\n已通过并挂到表格的素材、已下载文件和原候选清单都会保留。删除后可用 ⌘Z 撤销。`,
    '删除此批次',
    () => {
      if (state.projectId !== pid) return;
      const removed = state.candidates.filter(c => ids.has(c.id));
      if (!removed.length || batchRun || removed.some(c => isCandidateBusy(c.id))) return;
      stopAll();
      clearTimeout(advanceTimer);
      page.curShot = page.curCand = null;
      deleteCandidateBatch(ids);
      toast(`已删除「${batchLabel(batch)}」的 ${removed.length} 个候选 · ⌘Z 可撤销`, null, 'ok');
    },
  );
}

/* 打开时选哪一批、哪个画面：指定了画面就去它那一批；否则最新一批里第一个还有待审的画面 */
function pickDefaults(rowId) {
  const all = batches();
  if (rowId != null) {
    const row = rowById(rowId);
    const lead = row ? shotMembers(state.rows, row)[0] : null;
    const hits = state.candidates.filter(c => lead && leadOf(c)?.id === lead.id);
    const hit = hits.find(isPending) || hits[hits.length - 1];
    if (hit) {
      page.curBatch = hit.batchId || 'legacy';
      page.curShot = lead.id;
      return;
    }
  }
  if (!all.some(b => b.id === page.curBatch))
    page.curBatch = (all.find(b => b.cands.some(isPending)) || all[0])?.id ?? null;
  const shots = curShots();
  if (!shots.some(g => g.key === page.curShot)) page.curShot = (shots.find(g => g.pending) || shots[0])?.key ?? null;
}
function selectShot(key) {
  if (key === page.curShot) return;
  const order = curShots().map(x => x.key);
  const dir = order.indexOf(key) >= order.indexOf(page.curShot) ? 1 : -1;
  page.curShot = key;
  page.curCand = null;
  touched.clear();
  stopAll();
  renderVideoReview();
  $('#vrList')?.scrollTo?.({ top: 0 });
  slideIn($('#vrList'), dir); // 下一个画面从右边滑进来，往回翻从左边
}
/* 审完一个：焦点移到这个画面的下一个待审候选；这个画面都审完了，稍等一下跳到下一个还有待审的画面 */
let advanceTimer = null;
function advanceAfterDecision(c) {
  if (page.mode === 'rework') return; // 待返工页：通过的画面自己会离开列表，不用跳
  const g = curGroup();
  if (!g || !g.cands.includes(c)) return;
  const next = layoutShot(g).order.find(x => x !== c && isPending(x));
  if (next) {
    page.curCand = next.id;
    return;
  }
  clearTimeout(advanceTimer);
  const from = page.curShot;
  advanceTimer = setTimeout(() => {
    if (page.curShot !== from || state.view !== 'review') return;
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
  page.mode = 'review';
  touched.clear();
  page.curCand = null;
  pickDefaults(rowId);
  const wasOpen = state.view === 'review';
  runCommand('view:set', 'review');
  if (!wasOpen) slideIn($('#reviewPage'), -1);
  else renderVideoReview();
}
export const closeVideoReview = () => {
  if (state.view === 'review') runCommand('view:set', 'table');
};
const stopAll = stopAllVideos;
/* 离开审核页时，只清已完成返工画面里的「不要」候选。
   有来源文件的只清确实写进了清单的；写失败的留在项目里（下次离开审核页再试）。 */
const purgeRejected = purgeRejectedCandidates;

/* 换批次的菜单：新的在上，每批写待审数 / 审完，当前批次打勾；最下面是导入新批次 */
function openBatchPicker(anchor) {
  const all = batches();
  const items = all
    .map(b => {
      const p = b.cands.filter(isPending).length;
      const okN = b.cands.filter(c => c.decision === 'ok').length;
      const name = batchDetail(b);
      const tip = [batchLabel(b), name, fmtDay(b.at), `原清单名称：${b.name}`].filter(Boolean).join('\n');
      return `<div class="pop-item vr-bpick${b.id === page.curBatch ? ' cur' : ''}" data-vrb="pick" data-id="${esc(b.id)}" title="${esc(tip)}"><span class="main"><span>${esc(batchLabel(b))}${b.at ? `<span class="vr-bpick-date">${fmtDay(b.at)}</span>` : ''}</span>${name ? `<span class="desc">${esc(name)}</span>` : ''}</span><span class="vr-bpick-st${p ? ' wait' : ''}">${p ? `${p} 待审` : `✓ ${okN}/${b.cands.length}`}</span>${b.id === page.curBatch ? '<span class="chk">✓</span>' : ''}</div>`;
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
  const locked = !!batchRun || batch.cands.some(c => isCandidateBusy(c.id));
  openMenu(
    anchor,
    `<div class="p-title">${esc(batchLabel(batch))}${batch.at ? ` · ${fmtDay(batch.at)}` : ''}</div>
      <div class="pop-item" data-vrb="dir"><svg class="mi" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg><span class="main">更换保存位置…<span class="desc vr-pop-path">${esc(state.mediaDir || '还没选（第一次保存片段时会问）')}</span></span></div>
      <div class="pop-sep"></div>
      <div class="pop-item danger${locked ? ' disabled' : ''}" id="vrDeleteBatch" data-vrb="delete" title="${locked ? '片段保存完成后可以删除批次' : '移除这一批的审核候选，保留表格素材和本地文件'}"><svg class="mi" viewBox="0 0 24 24"><path d="M4 7h16M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg><span class="main">删除此批次<span class="desc">${batch.cands.length} 个候选 · 表格里的素材和本地文件保留</span></span></div>`,
  );
  markPopAnchor(anchor);
}
function selectBatch(id) {
  if (id === page.curBatch) return;
  page.curBatch = id;
  page.curShot = page.curCand = null;
  touched.clear();
  stopAll();
  clearTimeout(advanceTimer);
  renderVideoReview();
  $('#vrList')?.scrollTo?.({ top: 0 });
}

function refreshReviewStatus() {
  refreshVideoReviewButton();
  if (!$('#vrSaveAll')) return;
  // 这一批的进度只在左栏批次卡片上写（待审数 + 进度条），顶栏不再重复
  const unsaved = state.candidates.filter(c => c.decision === 'ok' && !c.savedPath).length;
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
  // 没有保存任务或写回提醒时，正文直接从页面顶端开始，不保留空的标题栏。
  $('#reviewPage .vr-top').hidden = saveAll.hidden && sync.hidden;
}

let reviewProject = null;
let navShown = null; // 左栏上次滚进视野的是哪个画面
let dragWait = null;
export function renderVideoReview() {
  refreshReviewStatus();
  if (state.view !== 'review') return;
  // 正在拖下面的画面时间轴：等松手再重画，不然轨道被换掉、拖动就断了
  if (trackDragging()) {
    dragWait ||= setTimeout(() => {
      dragWait = null;
      renderVideoReview();
    }, 150);
    return;
  }
  if (reviewProject === state.projectId && deferRenderWhileEditing('video-review', '#vrList', renderVideoReview))
    return;
  clearDeferredRender('video-review');
  reviewProject = state.projectId;
  paintVideoReview();
}

/* 上次写进页面的内容：一样就不重写（见 paintVideoReview） */
const painted = { nav: null, navEl: null, shot: null, shotEl: null };
function paintVideoReview() {
  refreshVideoReviewButton();
  const host = $('#vrList');
  if (!host || state.view !== 'review') return;
  pickDefaults(null);
  const all = batches();
  const batch = curBatchObj();
  const shots = shotsOf(batch);
  refreshReviewStatus();

  if (page.mode === 'rework') {
    undockPlaythrough();
    painted.shot = null;
    return renderRework(host);
  }
  // 左栏：批次 → 画面
  const nav = $('#vrNav');
  // 别人改了别处 / 后台保存都会走到这里：左栏内容没变就不重写，悬停、滚动和动效都不被打断
  const navNext = navHTML(all, shots);
  if (navNext !== painted.nav || painted.navEl?.parentNode !== nav) {
    nav.innerHTML = navNext;
    painted.nav = navNext;
    painted.navEl = nav.firstElementChild;
  }
  paintTabs();
  // 换了画面才把它滚进视野：保存片段等后台重画时，不把你正在翻的左栏拽回去
  const navKey = `${state.projectId}|${page.curBatch}|${page.curShot}`;
  if (navKey !== navShown) nav.querySelector('.vr-nav-shot.on')?.scrollIntoView({ block: 'nearest' });
  navShown = navKey;
  glide(nav, nav.querySelector('.vr-nav-shot.on'), 'vrnav-glide'); // 左边的高亮块滑到当前画面

  // 右边：选中画面，按句子排
  const g = shots.find(x => x.key === page.curShot);
  if (!state.candidates.length) {
    undockPlaythrough();
    painted.shot = null;
    host.innerHTML =
      '<p class="vr-empty">还没有视频候选。先点左边「复制格式规范」发给找素材的 AI，让它按规范写好候选清单（.json），再拖进窗口或点「导入候选清单」。</p>';
    return;
  }
  if (!g) {
    undockPlaythrough();
    painted.shot = null;
    host.innerHTML = '<p class="vr-empty">这一批没有候选。</p>';
    return;
  }
  const open = openOf(g);
  if (!open.some(c => c.id === page.curCand)) page.curCand = open.find(isPending)?.id || open[0]?.id || null;
  const done = g.cands.filter(c => c.id !== page.curCand && !isPending(c));
  const fill = trackFill(g);
  // 右边：这个画面的全部视频，只有选中的那个展开成完整卡片，其余收成一行：待审 / 未采用 / 审过的，点一行就展开它
  const rowOf = (c, cls, tag, tip) =>
    `<div class="vr-done d-${cls}" data-vr-id="${c.id}" title="${tip}"><span class="vr-tag d-${cls}">${tag}</span><span class="vr-done-title">${esc(c.title || c.key || '（未命名）')}</span><span class="vr-spacer"></span><span class="vr-done-note">${secText(usableSeconds(c))} 秒</span></div>`;
  const itemHTML = c =>
    c.id === page.curCand
      ? cardHTML(c)
      : isIdle(c)
        ? rowOf(c, 'idle', '未采用', '正片轨已经排满，点开还能审')
        : isPending(c)
          ? rowOf(c, 'wait', '待审', '点开看画面、审核')
          : doneHTML(c);
  const okN = g.cands.filter(c => c.decision === 'ok').length;
  const headHTML = `<div class="vr-pfill-head"><span>素材 ${g.cands.length} 个 · 通过 ${okN}</span><span class="vr-spacer"></span>${
    fill
      ? `<span class="vr-pst ${fill.full ? 'ok' : fill.got > 0 ? 'part' : 'miss'}" title="正片轨上排了多少秒 / 这个画面的口播有多长">已排 ${secText(fill.got)} / 口播 ${secText(fill.dur)} 秒</span>`
      : ''
  }</div>`;
  const reworkNote = g.cands.find(c => c.reworkNote)?.reworkNote || '';
  const shotHTML = `<section class="vr-shot" data-vr-shot="${esc(String(g.key))}">
      <div class="vr-shot-head"><h4><span class="vr-shot-range">${rangeText(g.lead)}</span>${g.cands[0]?.label ? `<span class="vr-shot-label">${esc(g.cands[0].label)}</span>` : ''}</h4>
      ${reworkNote ? `<p class="vr-need vr-rework-note"><b>原返工意见</b>${esc(reworkNote)}</p>` : ''}</div>
      <div class="vr-split">
        <div class="vr-watch">
          <div class="vr-dock-wrap"><div id="vrDockPlayer" aria-label="对着口播看画面"></div><div class="vr-preview" id="vrPreview" aria-label="候选预览" hidden></div></div>
        </div>
        <div class="vr-plans"><div class="vr-pbody">${headHTML}<div class="vr-plist">${layoutShot(g).order.map(itemHTML).join('')}</div></div></div>
      </div>
      <div class="vr-timeline" id="vrDockTrack"></div>
    </section>`;
  // 这个画面显示的内容一点没变（协作者改的是别的句子、后台存了文件…）：不重建，正在播的视频、截图和滚动位置都留着
  if (shotHTML === painted.shot && painted.shotEl?.parentNode === host) {
    followCand();
    paintStrips(
      host,
      open.filter(c => c.id === page.curCand),
    );
    return;
  }
  // 同一个画面重画时，右边列表滚到哪还在哪
  const sameShot = painted.shotEl?.parentNode === host && painted.shotEl.dataset.vrShot === String(g.key);
  const top = sameShot ? host.scrollTop : 0;
  stopClip(); // 重画会换掉播放器：先停掉，口播声音不会留在后台继续放
  host.innerHTML = shotHTML;
  painted.shot = shotHTML;
  painted.shotEl = host.firstElementChild;
  // 先把播放器和画面时间轴接回来再恢复滚动：接回来之前页面短了一大截，滚动位置会被压到顶上，
  // 拖完一下审核页就跳回最上面
  dockHere(g);
  showTimeline(); // 整块重画换掉了播放器：盖着的候选收起，回到排好的画面
  if (top) host.scrollTop = top;
  const shown = open.filter(c => c.id === page.curCand);
  paintMotion(host, g, shown);
  host.querySelector('.vr-shot-head')?.classList.toggle('stuck', host.scrollTop > 2);
  paintStrips(host, shown);
  for (const c of done) if (c.decision === 'ok' && c.savedPath) paintDoneThumb(c);
  // 截图只给展开的那个候选：换了画面、换了选中，没轮到的截图任务取消
  retainFrames(shown);
}
/* 「对着口播看画面」和两条轨嵌在画面下面：播放器放左边，轨道放候选下面 */
function dockHere(g) {
  const player = $('#vrDockPlayer'),
    track = $('#vrDockTrack');
  if (!player || !track || !g?.lead) return undockPlaythrough();
  dockPlaythrough({ player, track }, g.lead.id, {
    onPlay: showTimeline, // 开始播排好的画面：候选停下，左边回到画面时间
    onLost: () => {
      // 弹窗版借走后还回来：审核页还开着就接回去
      painted.shot = null;
      renderVideoReview();
    },
  });
}
function setMode(next) {
  if (next === page.mode) return;
  page.mode = next;
  page.curCand = null;
  touched.clear();
  stopAll();
  clearTimeout(advanceTimer);
  renderVideoReview();
  $('#vrList')?.scrollTo?.({ top: 0 });
}
function selectRework(id) {
  if (id === page.curRework) return;
  page.curRework = id;
  page.curCand = null;
  touched.clear();
  stopAll();
  renderVideoReview();
  $('#vrList')?.scrollTo?.({ top: 0 });
}
/* 返工要求：打字即存，停手后写盘；第一次写字就把这个画面标成「有要求」。
   同一个输入框连续打字算一步撤销，换了输入框（重渲染 / 换画面）就是新的一步 */
let typing = null;
const typingSession = el => (typing?.el === el ? typing : (typing = { el, snapped: false }));
function setReworkNote(text, session) {
  const s = curReworkItem();
  if (s) updateReworkNote(s.lead, text, session);
}
function dismissCurrentRework() {
  const s = curReworkItem();
  if (!s) return;
  dismissShotRework(s.lead);
  toast(`${rangeText(s.lead)} 不用返工了 · ⌘Z 可撤销`, null, 'ok');
}
/* 待返工页 → 返工单：写到片段保存位置，再把交给 AI 的那句话复制好 */
async function writeReworkDoc() {
  const pid = state.projectId;
  if (!reworkList().length) return toast('没有待返工的画面', null, 'info');
  const dir = await ensureMediaDir();
  if (!dir || state.projectId !== pid) return;
  renumber();
  const list = reworkList().map(s => ({ ...s, members: s.members.map(m => ({ ...m })) }));
  if (!list.length) return toast('没有待返工的画面', null, 'info');
  const title = state.title || '未命名项目';
  const doc = buildReworkDoc({ title, shots: list, registry: state.assets || {}, batchName: batchOfCand });
  const file = `${dir.replace(/\/+$/, '')}/返工单·${safeFileName(title)}.json`;
  const r = await native('writeReworkDoc')(file, JSON.stringify(doc, null, 2));
  if (!r?.ok) return toast('返工单没写进去：' + (r?.error || '未知原因'), null, 'error');
  if (state.projectId !== pid) return toast('返工单已写入，但项目已切换，请回到原项目重新生成', null, 'warn');
  registerReworkRequest(doc, list);
  page.reworkDocAt = Date.now();
  renderVideoReview();
  await copyText(
    `读一下「${file}」：这是分镜台的返工单，${list.length} 个画面（${doc.sentences}）。按每个画面的要求和否掉的理由重新找视频候选，用候选清单格式 v${CANDIDATE_VERSION} 写一份新的候选清单给我导入。顶层 reworkId 必须写 "${doc.id}"；shots[].lines 逐项照抄，分散句子分别写，禁止扩成首尾整段或添加返工单之外的画面。`,
    `返工单已生成（${list.length} 个画面），交给 AI 的话已复制`,
  );
}
export function openRework(rowId = null) {
  if (rowId != null) {
    const row = rowById(rowId);
    if (row) page.curRework = shotMembers(state.rows, row)[0].id;
  }
  page.mode = 'rework';
  touched.clear();
  page.curCand = null;
  const wasOpen = state.view === 'review';
  runCommand('view:set', 'review');
  if (!wasOpen) slideIn($('#reviewPage'), -1);
  else renderVideoReview();
}

/* 键盘：1 通过 · 2 不要 · 3 换一个 · ↑↓ 换候选 · ←→ 换画面 · 空格 播放 / 暂停这段。在意见框里打字时不抢键 */
export function videoReviewKey(e) {
  if (e.target?.closest?.('.vr-note, select, textarea')) {
    // 意见框回车收起；返工要求是多行的，回车照常换行，Esc 收起
    if (
      (e.key === 'Enter' && !e.target.matches('textarea')) ||
      (e.key === 'Escape' && e.target.matches('.vr-note, textarea'))
    ) {
      e.preventDefault();
      e.target.blur();
      return true;
    }
    return e.key !== 'Escape' && !e.metaKey;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const open = page.mode === 'rework' ? reworkOpen(curReworkItem()) : openOf(curGroup());
  const k = open.findIndex(c => c.id === page.curCand);
  const move = d => {
    if (!open.length) return;
    page.curCand = open[Math.max(0, Math.min(open.length - 1, (k < 0 ? 0 : k) + d))].id;
    renderVideoReview();
    $(`#vrList [data-vr-id="${page.curCand}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const DKEYS = { 1: 'ok', 2: 'no', 3: 're' };
  if (DKEYS[e.key]) {
    e.preventDefault();
    if (page.curCand) setDecision(page.curCand, DKEYS[e.key]);
    return true;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    move(e.key === 'ArrowDown' ? 1 : -1);
    return true;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    if (page.mode === 'rework') {
      const ids = reworkList().map(x => x.lead.id);
      const i = ids.indexOf(page.curRework);
      const j = Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
      if (ids[j] != null) selectRework(ids[j]);
      return true;
    }
    const shots = curShots();
    const i = shots.findIndex(x => x.key === page.curShot);
    const j = Math.max(0, Math.min(shots.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
    if (shots[j]) selectShot(shots[j].key);
    return true;
  }
  // I / O：把选中的画面裁到播放位置（和「对着口播看画面」一样）
  if (/^[ioIO]$/.test(e.key) && isDocked()) return playthroughKey(e);
  if (e.key === ' ') {
    e.preventDefault();
    // 审核页：候选正盖在左边播放器上时，空格暂停 / 继续这个候选；没有候选盖着就播 / 停排好的画面
    const pv = previewingId();
    if (pv) {
      const c = state.candidates.find(x => x.id === pv);
      if (c) togglePause(previewHost(), mediaOf(c));
      return true;
    }
    // 有左边播放器（审核页）就播 / 停排好的画面；待返工页没有，才在卡片里播当前候选
    if (toggleDocked() || !page.curCand) return true;
    const card = $(`#vrList [data-vr-id="${page.curCand}"]`);
    const c = state.candidates.find(x => x.id === page.curCand);
    pauseDocked();
    if (!card || !c || !togglePause(card, mediaOf(c))) play(page.curCand);
    return true;
  }
  return false;
}

export function initVideoReview() {
  $('#tablePage').insertAdjacentHTML(
    'afterend',
    `<main class="workspace-page vr-page" id="reviewPage" aria-label="视频审核" hidden>
      <div class="vr-top" hidden>
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
    const tab = e.target.closest('[data-vr-tab]');
    if (tab) return setMode(tab.dataset.vrTab);
    const rw = e.target.closest('[data-vr-rw]');
    if (rw) return selectRework(+rw.dataset.vrRw);
    if (e.target.closest('#vrReworkDoc')) return writeReworkDoc();
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
  // 碰下面的画面时间条（点、拖、裁）：左边回到画面时间，看的就是时间条上的画面
  $('#vrList').addEventListener(
    'pointerdown',
    e => {
      if (previewingId() && e.target.closest?.('#vrDockTrack')) showTimeline();
    },
    true,
  );
  // 往下翻候选时，钉在顶上的画面标题下沿加一道淡影，看得出下面还有内容在滚
  $('#vrList').addEventListener(
    'scroll',
    e => e.currentTarget.querySelector('.vr-shot-head')?.classList.toggle('stuck', e.currentTarget.scrollTop > 2),
    { passive: true },
  );
  $('#vrList').addEventListener('click', e => {
    const t = e.target;
    const card = t.closest('.vr-cand');
    if (card && card.dataset.vrId !== page.curCand) {
      page.curCand = card.dataset.vrId;
      document.querySelectorAll('#vrList .vr-cand').forEach(el => el.classList.toggle('focus', el === card));
      paintLineFocus(state.candidates.find(x => x.id === page.curCand));
      followCand();
    }
    // 盖在左边的候选：收起，回到排好的画面
    if (t.closest('[data-vr-pv-close]')) return showTimeline();
    // 截图：从这一帧开始，在左边播放器里播
    const cell = t.closest('.vr-cand .vr-cell[data-vr-at]');
    if (cell && card) return play(card.dataset.vrId, +cell.dataset.vrAt);
    // 片段播放器（审核页在左边的候选预览里，待返工页在卡片里）
    const player = t.closest('#vrPreview') || card;
    const track = t.closest('[data-vr-track]');
    if (track) {
      const c = state.candidates.find(x => x.id === track.dataset.vrTrack);
      if (c && player) seekTrack(player, mediaOf(c), track, e.clientX);
      return;
    }
    const pp = t.closest('[data-vr-pp]');
    if (pp) {
      const c = state.candidates.find(x => x.id === pp.dataset.vrPp);
      pauseDocked();
      if (c && !(player && togglePause(player, mediaOf(c)))) play(c.id);
      return;
    }
    if (t.closest('[data-vr-rw-off]')) return dismissCurrentRework();
    const d = t.closest('[data-vr-d]');
    if (d) return setDecision(d.dataset.vrFor, d.dataset.vrD);
    const fold = t.closest('[data-vr-fold]');
    if (fold) {
      stopAll();
      touched.delete(fold.dataset.vrFold);
      if (page.curCand === fold.dataset.vrFold) page.curCand = null;
      return renderVideoReview();
    }
    const go = t.closest('[data-vr-goto]');
    if (go) {
      const id = go.dataset.vrGoto;
      const target = $(`#vrList [data-vr-id="${id}"]`);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target?.classList.remove('vr-flash');
      void target?.offsetWidth;
      target?.classList.add('vr-flash');
      return;
    }
    const doneRow = t.closest('.vr-done[data-vr-id]');
    if (doneRow && !t.closest('button')) {
      const id = doneRow.dataset.vrId;
      touched.add(id); // 和刚审过的一样展开显示
      page.curCand = id;
      renderVideoReview();
      $(`#vrList .vr-cand[data-vr-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
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
    if (n) setNote(n.dataset.vrNote, n.value, typingSession(n));
    if (e.target.closest('[data-vr-rw-note]')) setReworkNote(e.target.value, typingSession(e.target));
  });
  // 离开输入框（change 在失焦时触发）：下次再打字算新的一步
  $('#vrList').addEventListener('focusout', e => {
    if (typing?.el === e.target) typing = null;
  });
  on('rows', renderVideoReview); // 撤销 / 重做 / 切项目后按钮和列表跟着刷新
  on('assets-changed', renderVideoReview); // 两条轨上拖过画面：「已排几秒」、未采用跟着变
  on('view', ({ from, view }) => {
    if (from === 'review') {
      undockPlaythrough();
      painted.shot = null;
      stopAll();
      clearTimeout(advanceTimer);
      purgeRejected();
      slideIn($('#tablePage'), 1);
    }
    if (view === 'review') renderVideoReview();
  });
  $('#vrSync').addEventListener('click', e => {
    if (e.target.closest('#vrRetrySync')) flushWriteBack().then(refreshReviewStatus);
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
    page.curBatch = page.curShot = page.curCand = page.curRework = null;
    touched.clear();
    clearReviewFrames();
  });
  initCandidateMedia();
  on('candidate-sync', refreshReviewStatus);
  on('candidate-media', renderVideoReview);
  on('candidates-changed', ({ resetIds = [], removedIds = [] } = {}) => {
    const ids = new Set([...resetIds, ...removedIds]);
    for (const id of ids) {
      touched.delete(id);
    }
    forgetFrames(ids);
    refreshVideoReviewButton();
  });
  registerCommand('video:open', openVideoReview);
  registerCommand('video:rework', openRework);
  registerCommand('video:close', closeVideoReview);
  registerCommand('video:key', videoReviewKey);
  registerCommand('video:import', (doc, path) => importCandidates(doc, path));
  registerCommand('assets:retag', retagLineFiles);
  refreshVideoReviewButton();
}
