import { viewState } from '../app/view-state.js';

import { state } from '../app/state.js';

import { writeBackFailures } from '../app/candidate-sync.js';

import { batchRun, saveAllLabel } from './review-files.js';
import { retainFrames, paintStrips } from './review-frames.js';

import { mountReviewPlayback, closeReviewPlayback } from './review-playback.js';

import { stopClip } from './clip-player.js';

import { esc } from '../ui/base/dom.js';

import { glide } from '../ui/base/motion.js';

import {
  page,
  curBatchObj,
  batches,
  isPending,
  orderedCandidates,
  shotsOf,
  trackFill,
  rangeText,
} from './review-model.js';
import { secText } from '../core/review-format.js';

import { renderRework } from './review-rework.js';
import { navHTML, paintTabs } from './review-nav.js';

import { deferRenderWhileEditing, clearDeferredRender } from '../ui/base/edit-session.js';

/* 审核视图负责增量绘制和播放器挂载；导航与业务流程由宿主注入。 */
export function createReviewRenderer({
  query: $,
  pickDefaults,
  refreshBadge: refreshVideoReviewButton,
  preview,
  cards,
}) {
  const { showTimeline, followCand } = preview;
  const { pickHTML, detailHTML, paintMotion } = cards;
  function refreshReviewStatus() {
    refreshVideoReviewButton();
    if (!$('#vrSaveAll')) return;
    // 这一批的进度只在左栏批次卡片上写（待审数 + 进度条），顶栏不再重复
    const unsaved = state.candidates.filter(c => c.decision === 'ok' && !c.savedPath).length;
    const saveAll = $('#vrSaveAll');
    // 待返工页和保存片段无关：不占一整行，正在保存时才露出进度
    saveAll.hidden = !batchRun && (!unsaved || page.mode === 'rework');
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
    // 保存片段和写回提醒放在左栏底部；都没有时整块收起。
    $('#reviewPage .vr-top').hidden = saveAll.hidden && sync.hidden;
  }

  let reviewProject = null;
  let navShown = null; // 左栏上次滚进视野的是哪个画面
  function renderVideoReview() {
    refreshReviewStatus();
    if (viewState.view !== 'review') return;
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
    if (!host || viewState.view !== 'review') return;
    pickDefaults(null);
    const all = batches();
    const batch = curBatchObj();
    const shots = shotsOf(batch);
    refreshReviewStatus();

    if (page.mode === 'rework') {
      closeReviewPlayback();
      painted.shot = null;
      return renderRework(host, $('#vrNav'), cards);
    }
    // 选中的画面和候选：候选列在左栏这个画面下面，右边只放选中那个的详情
    const g = shots.find(x => x.key === page.curShot);
    const list = g ? orderedCandidates(g) : [];
    if (g && !list.some(c => c.id === page.curCand)) page.curCand = (list.find(isPending) || list[0])?.id || null;
    const shown = list.filter(c => c.id === page.curCand);
    // 左栏：批次 → 画面 → 当前画面的候选
    const nav = $('#vrNav');
    // 别人改了别处 / 后台保存都会走到这里：左栏内容没变就不重写，悬停、滚动和动效都不被打断
    const navNext = navHTML(all, shots, x =>
      x === g ? list.map(c => pickHTML(c, c.id === page.curCand)).join('') : '',
    );
    if (navNext !== painted.nav || painted.navEl?.parentNode !== nav) {
      nav.innerHTML = navNext;
      painted.nav = navNext;
      painted.navEl = nav.firstElementChild;
    }
    paintTabs(nav);
    // 换了画面才把它滚进视野：保存片段等后台重画时，不把你正在翻的左栏拽回去
    const navKey = `${state.projectId}|${page.curBatch}|${page.curShot}`;
    if (navKey !== navShown) nav.querySelector('.vr-nav-shot.on')?.scrollIntoView({ block: 'nearest' });
    navShown = navKey;
    glide(nav, nav.querySelector('.vr-nav-shot.on'), 'vrnav-glide'); // 左边的高亮块滑到当前画面

    if (!state.candidates.length) {
      closeReviewPlayback();
      painted.shot = null;
      host.innerHTML =
        '<p class="vr-empty">还没有视频候选。先点左边「复制格式规范」发给找素材的 AI，让它按规范写好候选清单（.json），再拖进窗口或点「导入候选清单」。</p>';
      return;
    }
    if (!g) {
      closeReviewPlayback();
      painted.shot = null;
      host.innerHTML = '<p class="vr-empty">这一批没有候选。</p>';
      return;
    }
    // 右边：左栏选中那个候选的详情和审核按钮，位置固定不跳；下面是左右拉通的时间轨
    const fill = trackFill(g);
    const fillHTML = fill
      ? `<span class="vr-pst ${fill.full ? 'ok' : 'has'}" title="主画面排了多少秒 / 这个画面的口播有多长">已排 ${secText(fill.got)} / 口播 ${secText(fill.dur)} 秒</span>`
      : '';
    const reworkNote = g.cands.find(c => c.reworkNote)?.reworkNote || '';
    const shotHTML = `<section class="vr-shot vr-desk" data-vr-shot="${esc(String(g.key))}">
      <div class="vr-shot-head"><h4><span class="vr-shot-range">${rangeText(g.lead)}</span>${g.cands[0]?.label ? `<span class="vr-shot-label">${esc(g.cands[0].label)}</span>` : ''}</h4><span class="vr-spacer"></span>${fillHTML}
      ${reworkNote ? `<p class="vr-need vr-rework-note"><b>原返工意见</b>${esc(reworkNote)}</p>` : ''}</div>
      <div class="vr-split">
        <div class="vr-watch">
          <div class="vr-dock-wrap"><div id="vrDockPlayer" aria-label="对着口播看画面"></div><div class="vr-preview" id="vrPreview" aria-label="候选预览" hidden></div></div>
        </div>
        <div class="vr-plans"><div class="vr-pbody">${shown.map(detailHTML).join('')}</div></div>
      </div>
      <div class="vr-timeline" id="vrDockTrack"></div>
    </section>`;
    // 这个画面显示的内容一点没变（协作者改的是别的句子、后台存了文件…）：不重建，正在播的视频、截图和滚动位置都留着
    if (shotHTML === painted.shot && painted.shotEl?.parentNode === host) {
      followCand();
      paintStrips(host, shown);
      return;
    }
    // 同一个画面重画时，右边列表滚到哪还在哪
    const sameShot = painted.shotEl?.parentNode === host && painted.shotEl.dataset.vrShot === String(g.key);
    const top = sameShot ? host.scrollTop : 0;
    stopClip(); // 重画会换掉播放器：先停掉，口播声音不会留在后台继续放
    if (sameShot) {
      // 同一画面仅更新标题和候选列表；播放器、时间轨与正在拖动的节点保持连接。
      const next = document.createElement('template');
      next.innerHTML = shotHTML;
      host.querySelector('.vr-shot-head').replaceWith(next.content.querySelector('.vr-shot-head'));
      host.querySelector('.vr-plans').replaceWith(next.content.querySelector('.vr-plans'));
    } else {
      closeReviewPlayback();
      host.innerHTML = shotHTML;
    }
    painted.shot = shotHTML;
    painted.shotEl = host.firstElementChild;
    mountPlayback(g);
    if (sameShot) followCand();
    else showTimeline();
    if (top) host.scrollTop = top;
    paintMotion(host, g, shown);
    host.querySelector('.vr-shot-head')?.classList.toggle('stuck', host.scrollTop > 2);
    paintStrips(host, shown);
    // 截图只给选中的那个候选：换了画面、换了选中，没轮到的截图任务取消
    retainFrames(shown);
  }
  /* 「对着口播看画面」放左边，两条轨在下面左右拉通 */
  function mountPlayback(g) {
    const player = $('#vrDockPlayer'),
      track = $('#vrDockTrack');
    if (!player || !track || !g?.lead) return closeReviewPlayback();
    mountReviewPlayback({ player, track }, g.lead.id, showTimeline);
  }
  function reset() {
    reviewProject = navShown = null;
    painted.shot = painted.nav = null;
    painted.shotEl = painted.navEl = null;
  }
  function progress({ label, percent }) {
    const button = $('#vrSaveAll');
    if (button && label) {
      button.textContent = label;
      button.style.setProperty('--p', percent + '%');
    }
  }
  return {
    progress,
    render: renderVideoReview,
    refreshStatus: refreshReviewStatus,
    reset,
    leave: () => {
      closeReviewPlayback();
      painted.shot = null;
    },
  };
}
