import { viewState } from '../app/view-state.js';

import { state } from '../app/state.js';
import { rowById } from '../app/project-queries.js';

import { shotMembers } from '../core/shots.js';

import { slideIn } from '../ui/base/anim.js';

import { runCommand } from '../ui/base/commands.js';

import {
  page,
  touched,
  batches,
  leadOf,
  isPending,
  curShots,
  curGroup,
  orderedCandidates,
  reworkList,
} from './review-model.js';

/* 导航拥有批次、画面切换和审后跳转；宿主提供重画、停止播放和节点查询。 */
export function createReviewNavigation({ render: renderVideoReview, stop: stopAll, query: $ }) {
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
    const next = orderedCandidates(g).find(x => x !== c && isPending(x));
    if (next) {
      page.curCand = next.id;
      return;
    }
    clearTimeout(advanceTimer);
    const from = page.curShot;
    advanceTimer = setTimeout(() => {
      if (page.curShot !== from || viewState.view !== 'review') return;
      const shots = curShots();
      if (shots.find(x => x.key === from)?.pending) return renderVideoReview(); // 中途撤销了：留在这个画面
      const i = shots.findIndex(x => x.key === from);
      const after = [...shots.slice(i + 1), ...shots.slice(0, i)].find(x => x.pending);
      if (after) selectShot(after.key);
      else renderVideoReview();
    }, 600);
  }

  /* 审核和表格共用视图状态与布局，不登记弹窗，也不盖在表格上。 */
  function openVideoReview(rowId = null) {
    page.mode = 'review';
    touched.clear();
    page.curCand = null;
    pickDefaults(rowId);
    const wasOpen = viewState.view === 'review';
    runCommand('view:set', 'review');
    if (!wasOpen) slideIn($('#reviewPage'), -1);
    else renderVideoReview();
  }
  const closeVideoReview = () => {
    if (viewState.view === 'review') runCommand('view:set', 'table');
  };
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
  function openRework(rowId = null) {
    if (rowId != null) {
      // 从表格进来：选这句所在的那一项（这句自己的优先，没有就选同一画面的第一项）
      const row = rowById(rowId);
      const lead = row ? shotMembers(state.rows, row)[0] : null;
      const items = reworkList().filter(s => s.lead === lead);
      const own = items.find(s => s.target.includes(row)) || items[0];
      if (own) page.curRework = own.key;
    }
    page.mode = 'rework';
    touched.clear();
    page.curCand = null;
    const wasOpen = viewState.view === 'review';
    runCommand('view:set', 'review');
    if (!wasOpen) slideIn($('#reviewPage'), -1);
    else renderVideoReview();
  }

  const cancelAdvance = () => {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  };
  return {
    pickDefaults,
    selectShot,
    advanceAfterDecision,
    openVideoReview,
    closeVideoReview,
    selectBatch,
    setMode,
    selectRework,
    openRework,
    cancelAdvance,
  };
}
