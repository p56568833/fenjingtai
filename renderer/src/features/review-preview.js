/* 审核页左边播放器平时放排好的画面（画面时间，下面的时间条也归它）。点候选的「播放这段」或截图时，
   候选临时盖在上面播，左上角标着「候选」；播完、点「回到画面时间」或碰下面的时间条，就收起来回到排好的画面。
   候选盖着时空格暂停 / 继续候选，收起后空格才管排好的画面。待返工页没有左边播放器，候选照旧在卡片里播。 */
import { state } from '../app/state.js';
import { fmtTime } from '../core/text.js';
import { esc } from '../ui/base/dom.js';
import { playerHTML, playClip, stopClip } from './clip-player.js';
import { previewOf } from './review-frames.js';
import { candName } from './review-model.js';

/* 宿主提供候选预览位置和卡片位置，组件不查询整张页面。 */
export function createReviewPreview({ host, card, selectedCandidate, pause: pauseReviewPlayback }) {
  const candOf = id => state.candidates.find(x => x.id === id);
  let shown = null; // 正盖在左边播放的候选 id

  const previewHost = host;
  const previewingId = () => (previewHost() ? shown : null);

  /* 播放按钮上的字（载入中… / ↻ 重播这段）写回右边那张卡片 */
  const labelFor = id => text => {
    const btn = card(id)?.querySelector('[data-vr-play]');
    if (btn) btn.textContent = text;
  };

  /* 在左边播这个候选（盖在排好的画面上面）。at：从片段里的第几秒开始（截图上点的位置） */
  function showPreview(id, { at = null } = {}) {
    const host = previewHost();
    const c = candOf(id);
    if (!host || !c) return false;
    if (shown !== id || !host.querySelector('.vr-stage')) {
      stopClip();
      host.innerHTML = `<div class="vr-pv-head"><span class="vr-pv-badge">候选</span><span class="vr-pv-title">${esc(candName(c))} · ${fmtTime(c.best?.in ?? c.in)}–${fmtTime(c.best?.out ?? c.out)}</span><button class="vr-pv-close" data-vr-pv-close title="收起候选，回到排好的画面">回到画面时间</button></div>${playerHTML(previewOf(c))}`;
    }
    shown = id;
    host.hidden = false;
    host.parentElement?.classList.add('previewing');
    host.querySelector('.vr-stage').hidden = false;
    const wait = host.querySelector('.vr-wait');
    wait.classList.remove('err');
    wait.textContent = '载入中…';
    pauseReviewPlayback(); // 排好的画面先停，免得两路口播一起响
    const media = previewOf(c);
    playClip(host, media, {
      from: at == null ? null : media.in + at,
      onState: labelFor(id),
      onEnd: () => shown === id && showTimeline(), // 播完了：收起来，回到排好的画面
    });
    return true;
  }

  /* 收起候选，回到排好的画面 */
  function showTimeline() {
    const host = previewHost();
    if (shown) stopClip();
    shown = null;
    if (host) {
      host.hidden = true;
      host.replaceChildren();
      host.parentElement?.classList.remove('previewing');
    }
  }

  /* 选中的候选换了：正在左边播的不是它了，收起来 */
  function followCand() {
    if (shown && shown !== selectedCandidate()) showTimeline();
  }

  return { previewHost, previewingId, showPreview, showTimeline, followCand };
}
