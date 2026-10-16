/* 审核页的播放宿主。实例只属于当前画面，不借用连播窗口的节点和状态。 */
import { on, emit } from '../app/events.js';
import { createPlaybackView } from './playback-view.js';
let view = null;
let host = null;
export function mountReviewPlayback(slots, rowId, onPlay) {
  const root = slots.player.closest('.vr-shot');
  if (host !== root) {
    closeReviewPlayback();
    host = root;
    view = createPlaybackView({
      root,
      playerHost: slots.player,
      trackHost: slots.track,
      embedded: true,
      onPlay: () => {
        emit('playback-starting', { owner: 'review' });
        onPlay();
      },
    });
    view.start(rowId, { only: true });
  } else view.refreshShot(rowId);
}
export function closeReviewPlayback() {
  view?.destroy();
  view = host = null;
}
export const isReviewPlaybackOpen = () => !!view?.isOpen();
export const pauseReviewPlayback = () => {
  if (view?.snapshot().playing) view.pause();
};
export const toggleReviewPlayback = () => view?.toggle() || false;
export const reviewPlaybackKey = e => view?.handleKey(e) || false;
export const reviewPlaybackState = () => view?.snapshot();
on('project-committed', change => (change.source === 'remote' ? view?.remote() : view?.refresh()));
on('project-loaded', closeReviewPlayback);
on('playback-starting', ({ owner }) => {
  if (owner !== 'review') pauseReviewPlayback();
});
