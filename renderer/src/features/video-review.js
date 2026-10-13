/* 视频审核：Claude 找好的视频候选在这里过目，通过的自动挂成主画面。
   流程：导入候选清单（JSON，type = fenjingtai-candidates）→ 每个候选截 6 张图 + 只播建议的那几秒
   → 通过 / 不要 / 换一个 + 意见 → 通过的挂到画面上（角色主画面、片段入出点、画面描述追加来源一行）
   → 审核结果自动写回候选清单文件，Claude 读得到 → 顶部可批量保存已通过片段；完整原片要单独点。
   不下载任何文件，直到你点「保存已通过的片段」或「下载完整原片」。

   审核页是一个「收件箱」，和表格共用顶栏：
   · 批次：每次导入算一批。左栏顶上固定一张当前批次卡片（第 N 批 · 日期 · 待审数 · 进度条），点它在菜单里
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
  switchPlan,
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
import { CANDIDATE_TYPE, CANDIDATE_VERSION, planName, planOf, usableSeconds } from '../core/candidates.js';
import { circled } from '../core/shot-layout.js';
import { togglePause, seekTrack, stopAllVideos, stopClip, setVoiceOn } from './clip-player.js';
import * as nat from '../platform/native.js';
import { toast, confirmModal, esc } from '../ui/base/dom.js';
import { slideIn } from '../ui/base/anim.js';
import { shotLineCoverage } from '../app/line-coverage.js';
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
  prettyBatch,
  batchNo,
  fmtDate,
  fmtDay,
  shotsOf,
  openOf,
  candidatesForRow,
  coverageOf,
  secText,
  plansOfGroup,
  activePlan,
  usingPlan,
  planStatus,
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
  const { candidate: c, next, msg, offer } = result;
  if (next === 'ok') relinkSavedClips();
  if (next) advanceAfterDecision(c);
  renderVideoReview();
  if (next) stamp(c.id);
  if (offer)
    toast(
      `${planName(offer.plan)}已经填满，表格里还在用别的方案`,
      { label: `改用${planName(offer.plan)}`, cb: () => switchPlan(offer.row, offer.plan) && renderVideoReview() },
      'ok',
    );
  else if (msg) toast(msg, null, 'ok');
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
  // 先在这个方案里往下找；这个方案审完了、别的方案还有待审（画面还没填满），切到那个方案的 Tab
  const order = layoutShot(g).order;
  const next =
    order.find(x => x !== c && isPending(x) && planOf(x) === planOf(c)) || order.find(x => x !== c && isPending(x));
  if (next) {
    if (planOf(next) !== planOf(c)) page.plans.set(g.key, planOf(next));
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
      const name = b.id === 'legacy' ? '' : prettyBatch(b.name);
      return `<div class="pop-item vr-bpick${b.id === page.curBatch ? ' cur' : ''}" data-vrb="pick" data-id="${esc(b.id)}" title="${esc(batchLabel(b))}"><span class="main"><span>${esc(batchNo(b))}${b.at ? `<span class="vr-bpick-date">${fmtDate(b.at)}</span>` : ''}</span>${name ? `<span class="desc">${esc(name)}</span>` : ''}</span><span class="vr-bpick-st${p ? ' wait' : ''}">${p ? `${p} 待审` : `✓ ${okN}/${b.cands.length}`}</span>${b.id === page.curBatch ? '<span class="chk">✓</span>' : ''}</div>`;
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
    `<div class="p-title">${esc(batchNo(batch))}${batch.at ? ` · ${fmtDay(batch.at)}` : ''}</div>
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
export function renderVideoReview() {
  refreshReviewStatus();
  if (state.view !== 'review') return;
  if (reviewProject === state.projectId && deferRenderWhileEditing('video-review', '#vrList', renderVideoReview))
    return;
  clearDeferredRender('video-review');
  reviewProject = state.projectId;
  paintVideoReview();
}

function paintVideoReview() {
  refreshVideoReviewButton();
  const host = $('#vrList');
  if (!host || state.view !== 'review') return;
  pickDefaults(null);
  const all = batches();
  const batch = curBatchObj();
  const shots = shotsOf(batch);
  refreshReviewStatus();

  if (page.mode === 'rework') return renderRework(host);
  // 左栏：批次 → 画面
  const nav = $('#vrNav');
  nav.innerHTML = navHTML(all, shots);
  paintTabs();
  nav.querySelector('.vr-nav-shot.on')?.scrollIntoView({ block: 'nearest' });
  glide(nav, nav.querySelector('.vr-nav-shot.on'), 'vrnav-glide'); // 左边的高亮块滑到当前画面

  // 右边：选中画面，按句子排
  const g = shots.find(x => x.key === page.curShot);
  if (!state.candidates.length) {
    host.innerHTML =
      '<p class="vr-empty">还没有视频候选。先点左边「复制格式规范」发给找素材的 AI，让它按规范写好候选清单（.json），再拖进窗口或点「导入候选清单」。</p>';
    return;
  }
  if (!g) {
    host.innerHTML = '<p class="vr-empty">这一批没有候选。</p>';
    return;
  }
  const { members } = layoutShot(g);
  const plans = plansOfGroup(g);
  const plan = activePlan(g, plans);
  const cur = plans.find(p => p.plan === plan) || null;
  const using = usingPlan(g);
  const open = openOf(g);
  if (!open.some(c => c.id === page.curCand)) page.curCand = open.find(isPending)?.id || open[0]?.id || null;
  const done = g.cands.filter(c => c.id !== page.curCand && !isPending(c));
  const shotCands = candidatesForRow(g.lead);
  const lineCov = members.length ? shotLineCoverage(members) : null; // 每句实际有没有画面（和表格同一套算法）
  // 左边：口播一句一行，句尾标这句有没有画面
  const lineHTML = m => {
    const cov = coverageOf(m, shotCands, lineCov);
    return `<div class="vr-line" data-vo-no="${m.no}">
        <div class="vr-line-text"><span class="vr-line-no">${m.no}</span><p>${esc(m.text)}</p><span class="vr-cov ${cov.cls}"${cov.tip ? ` title="${esc(cov.tip)}"` : ''}>${cov.text}${cov.sec ? `<em>${cov.sec}</em>` : ''}</span>${cov.note ? `<p class="vr-cov-note">缺：${esc(cov.note)}</p>` : ''}</div>
      </div>`;
  };
  // 右边：方案 Tab（只有一个方案时不显示 Tab），下面是填满进度和按顺序排的视频
  const tabsHTML =
    plans.length > 1
      ? `<div class="vr-ptabs" role="tablist" aria-label="方案">${plans
          .map(p => {
            const st = planStatus(p);
            return `<button class="vr-ptab${p.plan === plan ? ' on' : ''}" role="tab" aria-selected="${p.plan === plan}" data-vr-plan="${p.plan}">${planName(p.plan)}<span class="vr-pst ${st.cls}">${st.text}</span>${p.plan === using ? '<span class="vr-puse" title="表格、连播预览、导出用的是这个方案">正在用</span>' : ''}</button>`;
          })
          .join('')}</div>`
      : '';
  const fillHTML = p => {
    if (!p) return '';
    const total = p.need || p.live.reduce((t, c) => t + usableSeconds(c), 0) || 1;
    let used = 0;
    const segs = p.live
      .map((c, i) => {
        const len = usableSeconds(c);
        const left = used;
        used += len;
        const w = Math.max(0, Math.min(len, total - left));
        const cls = c.decision === 'ok' ? 'ok' : isIdle(c) ? 'idle' : 'wait';
        return w > 0
          ? `<i class="vr-pseg ${cls}" style="width:${(w / total) * 100}%" title="${circled(i + 1)} ${esc(c.title || c.key || '')} · ${secText(len)} 秒"></i>`
          : '';
      })
      .join('');
    // 最后一个超出一点会被截掉，不算问题；整个视频都排不进口播里才提醒「排不下」
    let at = 0;
    const out = p.need ? p.live.filter(c => (at += usableSeconds(c)) - usableSeconds(c) >= p.need - 0.05).length : 0;
    const st = planStatus(p);
    const head = p.need
      ? `通过的 ${secText(p.okLen)} / 口播 ${secText(p.need)} 秒${p.live.length > p.ok.length ? ` · 全部通过共 ${secText(p.liveLen)} 秒` : ''}`
      : `通过的 ${secText(p.okLen)} 秒`;
    const switchBtn =
      p.ok.length && using != null && p.plan !== using
        ? `<button class="vr-mini" data-vr-useplan="${p.plan}" title="表格、连播预览、导出改用这个方案；${planName(using)}存成备选，随时能换回来">改用${planName(p.plan)}</button>`
        : '';
    return `<div class="vr-pfill">
        <div class="vr-pfill-head"><span>${head}</span>${plans.length > 1 ? '' : `<span class="vr-pst ${st.cls}">${st.text}</span>`}${out ? `<span class="vr-pst miss" title="方案里的视频加起来比口播长很多，排在最后的 ${out} 个放不进口播里">排不下 ${out} 个</span>` : ''}<span class="vr-spacer"></span>${switchBtn}</div>
        <div class="vr-pfill-bar">${segs}</div>
        ${p.short ? `<p class="vr-pfill-short"><b>找不到够长的</b>${esc(p.short)}</p>` : ''}
      </div>`;
  };
  // 只有选中的那个视频展开成完整卡片，其余都收成一行：待审 / 未采用 / 审过的，点一行就展开它
  const rowOf = (c, cls, tag, tip) =>
    `<div class="vr-done d-${cls}" data-vr-id="${c.id}" title="${tip}"><span class="vr-tag d-${cls}">${tag}</span><span class="vr-done-title">${esc(c.title || c.key || '（未命名）')}</span><span class="vr-spacer"></span><span class="vr-done-note">${secText(usableSeconds(c))} 秒</span></div>`;
  const itemHTML = (c, i) => {
    const body =
      c.id === page.curCand
        ? cardHTML(c)
        : isIdle(c)
          ? rowOf(c, 'idle', '未采用', '这个画面已经填满，点开还能审')
          : isPending(c)
            ? rowOf(c, 'wait', '待审', '点开看画面、审核')
            : doneHTML(c);
    return `<div class="vr-pitem"><span class="vr-pno" aria-hidden="true">${circled(i + 1)}</span>${body}</div>`;
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
      <div class="vr-split">
        <div class="vr-lines">${members.length ? members.map(lineHTML).join('') : '<p class="vr-empty">找不到对应句子</p>'}</div>
        <div class="vr-plans">
          ${tabsHTML}
          <div class="vr-pbody" role="tabpanel">${fillHTML(cur)}<div class="vr-plist">${(cur?.cands || []).map(itemHTML).join('')}</div></div>
        </div>
      </div>
      ${i1 >= 0 && i1 < allLines.length - 1 ? ctx(allLines[i1 + 1], 'after') : ''}
    </section>`;
  paintLineFocus(state.candidates.find(c => c.id === page.curCand) || null);
  const shown = open.filter(c => c.id === page.curCand);
  paintMotion(host, g, shown);
  host.querySelector('.vr-shot-head')?.classList.toggle('stuck', host.scrollTop > 2);
  paintStrips(host, shown);
  for (const c of done) if (c.decision === 'ok' && c.savedPath) paintDoneThumb(c);
  // 截图只给展开的那个候选：换了画面、换了选中，没轮到的截图任务取消
  retainFrames(shown);
}
/* 换方案 Tab：只是换着看，不改表格 */
function selectPlan(plan) {
  const g = curGroup();
  if (!g || activePlan(g) === plan) return;
  page.plans.set(g.key, plan);
  page.curCand = null;
  stopAll();
  renderVideoReview();
}
/* 表格、连播预览、导出改用这个方案 */
function usePlanHere(plan) {
  const g = curGroup();
  if (!g?.lead || !switchPlan(g.lead, plan)) return;
  toast(`${rangeText(g.lead)} 改用${planName(plan)} · ⌘Z 可撤销`, null, 'ok');
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
  const list = reworkList();
  if (!list.length) return toast('没有待返工的画面', null, 'info');
  const dir = await ensureMediaDir();
  if (!dir) return;
  renumber();
  const title = state.title || '未命名项目';
  const doc = buildReworkDoc({ title, shots: list, registry: state.assets || {}, batchName: batchOfCand });
  const file = `${dir.replace(/\/+$/, '')}/返工单·${safeFileName(title)}.json`;
  const r = await native('writeReworkDoc')(file, JSON.stringify(doc, null, 2));
  if (!r?.ok) return toast('返工单没写进去：' + (r?.error || '未知原因'), null, 'error');
  page.reworkDocAt = Date.now();
  renderVideoReview();
  await copyText(
    `读一下「${file}」：这是分镜台的返工单，${list.length} 个画面。按每个画面的要求和否掉的理由重新找视频候选，用候选清单格式 v${CANDIDATE_VERSION} 写一份新的候选清单给我导入。`,
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
  if (e.key === ' ') {
    e.preventDefault();
    if (!page.curCand) return true;
    const card = $(`#vrList [data-vr-id="${page.curCand}"]`);
    const c = state.candidates.find(x => x.id === page.curCand);
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
    }
    const track = t.closest('[data-vr-track]');
    if (track) {
      const c = state.candidates.find(x => x.id === track.dataset.vrTrack);
      if (c) seekTrack(card, mediaOf(c), track, e.clientX);
      return;
    }
    const pp = t.closest('[data-vr-pp]');
    if (pp) {
      const c = state.candidates.find(x => x.id === pp.dataset.vrPp);
      if (c && !togglePause(card, mediaOf(c))) play(c.id);
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
    const tab = t.closest('[data-vr-plan]');
    if (tab) return selectPlan(+tab.dataset.vrPlan);
    const use = t.closest('[data-vr-useplan]');
    if (use) return usePlanHere(+use.dataset.vrUseplan);
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
  on('view', ({ from, view }) => {
    if (from === 'review') {
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
