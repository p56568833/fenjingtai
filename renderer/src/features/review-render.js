import { viewState } from '../app/view-state.js';

import { state } from '../app/state.js';

import { writeBackFailures } from '../app/candidate-sync.js';

import { batchRun, saveAllLabel } from './review-files.js';
import { retainFrames, paintStrips, paintDoneThumb } from './review-frames.js';

import { usableSeconds } from '../core/candidate-values.js';
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
  openOf,
  trackFill,
  isIdle,
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
  const { cardHTML, doneHTML, paintMotion } = cards;
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
    // 左栏：批次 → 画面
    const nav = $('#vrNav');
    // 别人改了别处 / 后台保存都会走到这里：左栏内容没变就不重写，悬停、滚动和动效都不被打断
    const navNext = navHTML(all, shots);
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

    // 右边：选中画面，按句子排
    const g = shots.find(x => x.key === page.curShot);
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
        <div class="vr-plans"><div class="vr-pbody">${headHTML}<div class="vr-plist">${orderedCandidates(g).map(itemHTML).join('')}</div></div></div>
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
    showTimeline();
    if (top) host.scrollTop = top;
    const shown = open.filter(c => c.id === page.curCand);
    paintMotion(host, g, shown);
    host.querySelector('.vr-shot-head')?.classList.toggle('stuck', host.scrollTop > 2);
    paintStrips(host, shown);
    for (const c of done) if (c.decision === 'ok' && c.savedPath) paintDoneThumb(c, host);
    // 截图只给展开的那个候选：换了画面、换了选中，没轮到的截图任务取消
    retainFrames(shown);
  }
  /* 「对着口播看画面」和两条轨嵌在画面下面：播放器放左边，轨道放候选下面 */
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
