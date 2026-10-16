import { viewState } from '../app/view-state.js';
/* 面板改变正文宽度时，保持正在看的句子在视口中的位置。
   只测可见块里的句子，避免展开长稿中所有 content-visibility 占位块。 */
import { state } from '../app/state.js';
import { scrollGuard } from './base/scroll-guard.js';

let cancelPending = null;

function visibleSentence(wrap) {
  const view = wrap.getBoundingClientRect();
  let top = view.top;
  for (const heading of wrap.querySelectorAll('.section-row,.sec-pin.on,.ck-sec')) {
    const box = heading.getBoundingClientRect();
    if (box.top <= view.top + 1 && box.bottom > top) top = box.bottom;
  }
  const blocks = wrap.querySelectorAll(
    '.rows > .row,.rows > .shared-scene,.sec-block > .row,.sec-block > .shared-scene,.ck-article > .ck-p,.ck-article > .shared-passage',
  );
  for (const block of blocks) {
    const box = block.getBoundingClientRect();
    if (box.bottom <= top || box.top >= view.bottom) continue;
    for (const sentence of block.querySelectorAll('.sent[data-id],.as[data-id]')) {
      const rect = sentence.getBoundingClientRect();
      if (rect.bottom > top && rect.top < view.bottom && rect.height > 0)
        return { sentence, offset: rect.top - view.top };
    }
  }
  return null;
}

export function preserveReadingPosition(changeLayout) {
  cancelPending?.();
  const wrap = document.querySelector('#tableWrap');
  const anchor = wrap && visibleSentence(wrap);
  if (!anchor) return changeLayout();
  const project = state.projectId,
    view = viewState.view,
    oldOverflowAnchor = wrap.style.overflowAnchor;
  let frame = null,
    done = false,
    scrollTop = wrap.scrollTop;
  // 浏览器的自动滚动锚点和我们的句子锚点不能同时调整同一个视口。
  wrap.style.overflowAnchor = 'none';
  const guard = scrollGuard(() => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    wrap.style.overflowAnchor = oldOverflowAnchor;
    if (cancelPending === guard.cancel) cancelPending = null;
  });
  const cancel = guard.cancel;
  cancelPending = cancel;
  // 重画可能把锚定的句子元素整个换掉（如去掉搜索高亮），按句子 id 找回新元素继续对齐
  const id = anchor.sentence.dataset.id;
  const current = () =>
    anchor.sentence.isConnected ? anchor.sentence : wrap.querySelector(`.sent[data-id="${id}"],.as[data-id="${id}"]`);
  const fix = () => {
    if (!guard.active()) return;
    const sentence = current();
    if (
      done ||
      state.projectId !== project ||
      viewState.view !== view ||
      !sentence ||
      Math.abs(wrap.scrollTop - scrollTop) > 1
    ) {
      cancel();
      return;
    }
    anchor.sentence = sentence;
    const delta = anchor.sentence.getBoundingClientRect().top - wrap.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) >= 1) wrap.scrollTop += delta;
    scrollTop = wrap.scrollTop;
  };
  changeLayout();
  // 重画中内容高度临时变化会让浏览器夹住 scrollTop，这不是用户在滚，不能当成操作而放弃校准
  scrollTop = wrap.scrollTop;
  fix(); // 同一帧内完成，避免先跳一下再跳回来。
  let remaining = 3;
  const settle = () => {
    fix();
    if (done) return;
    // 屏幕外占位块在新宽度下展开后，继续校准几帧；用户开始操作立即停止。
    if (--remaining) frame = requestAnimationFrame(settle);
    else cancel();
  };
  if (!done) frame = requestAnimationFrame(settle);
}
