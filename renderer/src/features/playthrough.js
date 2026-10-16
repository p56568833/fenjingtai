import { viewState } from '../app/view-state.js';
/* 连播窗口的宿主：创建独立播放实例、登记命令并订阅项目变化。 */
import { on, emit } from '../app/events.js';
import { registerCommand } from '../ui/base/commands.js';
import { createPlaybackView } from './playback-view.js';
let view = null;
const mask = () => document.querySelector('#ptMask');
export function closePlaythrough() {
  view?.close();
  mask()?.classList.remove('show');
}
export const playthroughKey = e => view?.handleKey(e) || false;
export const trackDragging = () => view?.isDragging() || false;
export const playthroughState = () => view?.snapshot();
export function initPlaythrough() {
  document.body.insertAdjacentHTML('beforeend', '<div class="modal-mask pt-mask" id="ptMask"></div>');
  view = createPlaybackView({ root: mask(), onPlay: () => emit('playback-starting', { owner: 'window' }) });
  mask().querySelector('[data-pt="ptClose"]').onclick = closePlaythrough;
  mask().addEventListener('click', e => {
    if (e.target === mask()) closePlaythrough();
  });
  const open = (id, only) => {
    mask().classList.add('show');
    mask().querySelector('[data-pt="ptTitle"]').textContent = only ? '对着口播看画面' : '连播预览';
    if (!view.start(id ?? viewState.sel, { only, autoplay: true })) closePlaythrough();
  };
  on('project-committed', change => (change.source === 'remote' ? view.remote() : view.refresh()));
  on('project-loaded', closePlaythrough);
  on('view', () => {
    if (view.snapshot().playing) view.pause();
  });
  on('playback-starting', ({ owner }) => {
    if (owner !== 'window' && view.snapshot().playing) view.pause();
  });
  registerCommand('playthrough:from', id => open(id, false));
  registerCommand('playthrough:shot', id => open(id, true));
}
