import { createReviewNavigation } from './review-navigation.js';
import { createReviewRenderer } from './review-render.js';
import { createReviewWorkflows } from './review-workflows.js';
import { projectRefresh } from '../core/project-refresh.js';

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
import { state } from '../app/state.js';

import { on } from '../app/events.js';
import {
  decideCandidate,
  setCandidateNote,
  deleteCandidateBatch,
  purgeRejectedCandidates,
} from '../app/candidate-actions.js';
import { flushWriteBack } from '../app/candidate-sync.js';
import { isCandidateBusy, relinkSavedClips, initCandidateMedia } from '../app/candidate-media.js';
import { saveAllApproved, downloadOriginal, ensureMediaDir, batchRun } from './review-files.js';
import { forgetFrames, clearReviewFrames, previewOf } from './review-frames.js';

import { CANDIDATE_VERSION } from '../core/candidate-values.js';
import {
  isReviewPlaybackOpen,
  toggleReviewPlayback,
  pauseReviewPlayback,
  reviewPlaybackKey,
} from './review-playback.js';
import { createReviewPreview } from './review-preview.js';
import { togglePause, seekTrack, stopAllVideos, setVoiceOn } from './clip-player.js';
import * as nat from '../platform/native.js';
import { toast, confirmModal, esc } from '../ui/base/dom.js';
import { slideIn } from '../ui/base/anim.js';
import { roll, pop } from '../ui/base/motion.js';
import { registerCommand, runCommand } from '../ui/base/commands.js';
import { openMenu, closePop, popOpenFor, markPopAnchor, popEl } from '../ui/base/popover.js';

import {
  page,
  touched,
  pendingCount,
  curBatchObj,
  batchLabel,
  batches,
  isPending,
  curShots,
  curGroup,
  openOf,
  curReworkItem,
  reworkList,
  reworkOpen,
} from './review-model.js';
import { batchDetail, fmtDay } from '../core/review-format.js';
import { createReviewCards } from './review-cards.js';

const $ = s => document.querySelector(s);
/* 原生能力统一走 platform/native.js（自测可通过 window.fjtHooks 注入替身） */
const native = name => nat[name];

const preview = createReviewPreview({
  host: () => $('#vrPreview'),
  card: id => $('#vrList')?.querySelector(`[data-vr-id="${CSS.escape(id)}"]`),
  selectedCandidate: () => page.curCand,
  pause: pauseReviewPlayback,
});
const { previewHost, previewingId, showTimeline, followCand } = preview;
const cards = createReviewCards({ root: () => $('#vrList'), preview, page });
const { stamp, paintLineFocus, play } = cards;
let typing = null;
const typingSession = el => (typing?.el === el ? typing : (typing = { el, snapped: false }));
const navigation = createReviewNavigation({ render: renderVideoReview, stop: stopAllVideos, query: $ });
const {
  pickDefaults,
  selectShot,
  advanceAfterDecision,
  openVideoReview,
  closeVideoReview,
  selectBatch,
  setMode,
  selectRework,
  cancelAdvance,
} = navigation;
export const openRework = (...args) => navigation.openRework(...args);
export { closeVideoReview };
const renderer = createReviewRenderer({
  query: $,
  pickDefaults,
  refreshBadge: refreshVideoReviewButton,
  preview,
  cards,
});
const { importCandidates, copyCandidateSpec, setReworkNote, dismissCurrentRework, writeReworkDoc } =
  createReviewWorkflows({ open: openVideoReview, render: renderVideoReview });
function renderVideoReview() {
  renderer.render();
}

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
const setNote = setCandidateNote;

/* ── 界面 ── */

/* 顶栏「视频审核」上的待审数小角标（没有待审就不显示） */
function refreshVideoReviewButton() {
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
      cancelAdvance();
      page.curShot = page.curCand = null;
      deleteCandidateBatch(ids);
      toast(`已删除「${batchLabel(batch)}」的 ${removed.length} 个候选 · ⌘Z 可撤销`, null, 'ok');
    },
  );
}

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
/* 键盘：1 通过 · 2 不要 · 3 换一个 · ↑↓ 换候选 · ←→ 换画面 · 空格 播放 / 暂停这段。在意见框里打字时不抢键 */
function videoReviewKey(e) {
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
  if (/^[ioIO]$/.test(e.key) && isReviewPlaybackOpen()) return reviewPlaybackKey(e);
  if (e.key === ' ') {
    e.preventDefault();
    // 审核页：候选正盖在左边播放器上时，空格暂停 / 继续这个候选；没有候选盖着就播 / 停排好的画面
    const pv = previewingId();
    if (pv) {
      const c = state.candidates.find(x => x.id === pv);
      if (c) togglePause(previewHost(), previewOf(c));
      return true;
    }
    // 有左边播放器（审核页）就播 / 停排好的画面；待返工页没有，才在卡片里播当前候选
    if (toggleReviewPlayback() || !page.curCand) return true;
    const card = $(`#vrList [data-vr-id="${page.curCand}"]`);
    const c = state.candidates.find(x => x.id === page.curCand);
    pauseReviewPlayback();
    if (!card || !c || !togglePause(card, previewOf(c))) play(page.curCand);
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
      if (c && player) seekTrack(player, previewOf(c), track, e.clientX);
      return;
    }
    const pp = t.closest('[data-vr-pp]');
    if (pp) {
      const c = state.candidates.find(x => x.id === pp.dataset.vrPp);
      pauseReviewPlayback();
      if (c && !(player && togglePause(player, previewOf(c)))) play(c.id);
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
  on('project-committed', change => {
    if (change.projectId === state.projectId && projectRefresh(change).review) renderVideoReview();
  });
  on('view-refresh', renderVideoReview);
  on('view', ({ from, view }) => {
    if (from === 'review') {
      renderer.leave();
      stopAll();
      cancelAdvance();
      purgeRejected();
      slideIn($('#tablePage'), 1);
    }
    if (view === 'review') renderVideoReview();
  });
  $('#vrSync').addEventListener('click', e => {
    if (e.target.closest('#vrRetrySync')) flushWriteBack().then(renderer.refreshStatus);
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
    renderer.reset();
    cards.reset();
    showTimeline();
    page.curBatch = page.curShot = page.curCand = page.curRework = null;
    touched.clear();
    clearReviewFrames();
  });
  initCandidateMedia();
  on('candidate-sync', renderer.refreshStatus);
  on('candidate-save-progress', renderer.progress);
  on('candidate-media', renderVideoReview);
  on('candidates-changed', ({ resetIds = [], removedIds = [] } = {}) => {
    const ids = new Set([...resetIds, ...removedIds]);
    for (const id of ids) {
      touched.delete(id);
    }
    forgetFrames(ids);
  });
  registerCommand('video:open', openVideoReview);
  registerCommand('video:rework', openRework);
  registerCommand('video:close', closeVideoReview);
  registerCommand('video:key', videoReviewKey);
  registerCommand('video:import', (doc, path) => importCandidates(doc, path));
  refreshVideoReviewButton();
}
