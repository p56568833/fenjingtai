import { createPreviewMedia } from '../features/playthrough-media.js';
import { state } from '../app/state.js';
import { update } from '../app/project-events.js';
import * as storage from '../app/storage.js';
import { parseAny } from '../core/parse.js';
import { groupSelectionAction } from '../app/actions.js';
import { addRefsToShot, setUsageLines, setShotTimes } from '../app/asset-actions.js';
import { runCommand } from '../ui/base/commands.js';
import { playthroughState, closePlaythrough } from '../features/playthrough.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const pause = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
  for (let i = 0; i < ms / 20 && !fn(); i++) await pause(20);
  return !!fn();
};

export async function runPlaythroughMediaTests(t) {
  const fx = window.native.fixtureInfo();
  if (!fx?.hasVideo) return t('切换预加载（缺视频测试素材，跳过）', true);
  const stage = document.createElement('div');
  stage.className = 'pt-stage';
  stage.style.cssText = 'position:fixed;top:0;left:0;width:320px;height:180px;z-index:9999';
  document.body.append(stage);
  const media = createPreviewMedia(stage);
  const video = cin => ({
    kind: 'video',
    asset: { path: fx.dir + '/样片.mp4' },
    usage: { clip: { in: cin, out: 1.9 } },
  });
  const visible = () => stage.querySelector('.pt-media:not(.pt-pending)');
  let failed = 0;
  try {
    const a = media.show('a', video(0), 0, () => failed++);
    await a.play();
    await until(() => visible() === a);
    a.pause();
    t('视频首帧解码后才显示', visible() === a && a.readyState >= 2);
    media.prefetch('b', video(0.4));
    const b = stage.querySelector('[data-preview-key="b"]');
    await until(() => b.dataset.previewReady === 'true');
    t(
      '下一段提前解码并停在片段入点',
      b.dataset.previewReady === 'true' && b.paused && Math.abs(b.currentTime - 0.4) < 0.04,
    );
    const reused = media.show('b', video(0.4), 0.4, () => failed++);
    t('切换时复用已准备的首帧，立即交接、不出现黑屏', reused === b && visible() === b && !stage.contains(a));

    // 零入点的视频无需依赖 seeked 事件，也能在播放前准备好。
    media.prefetch('c', video(0));
    const c = stage.querySelector('[data-preview-key="c"]');
    await until(() => c.dataset.previewReady === 'true');
    t('从零秒开始的视频也能提前准备好首帧', c.dataset.previewReady === 'true' && c.paused);
    media.show('c', video(0), 0, () => failed++);
    t('连续切换只保留当前与下一段，旧视频释放', visible() === c && stage.querySelectorAll('video').length === 1);

    // 模拟新素材迟迟没有元数据：超过旧实现的 1.5 秒也不能强行撤掉上一帧。
    const originalSrc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, get: originalSrc.get, set() {} });
    let slow;
    try {
      slow = media.show('slow', video(0), 0, () => failed++);
    } finally {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', originalSrc);
    }
    await pause(1600);
    t('下一段加载较慢时保留上一帧，不按超时强行露出黑屏', visible() === c && slow.classList.contains('pt-pending'));
    media.show('d', video(0.2), 0.2, () => failed++);
    const d = stage.querySelector('[data-preview-key="d"]');
    await d.play();
    await until(() => visible() === d);
    slow.dispatchEvent(new Event('error'));
    t(
      '快速切换后迟到的旧素材事件不会覆盖新画面',
      visible() === d && failed === 0 && !slow.isConnected,
      JSON.stringify({ visible: visible()?.dataset.previewKey, failed, staleConnected: slow.isConnected }),
    );
    media.clear();
    t('关闭预览释放播放中和预加载中的视频', !stage.children.length && d.paused && !d.hasAttribute('src'));
  } finally {
    media.clear();
    stage.remove();
  }

  const original = state.projectId;
  try {
    storage.createProject('预览自然停顿回归', parseAny('第一句。第二句。第三句。第四句。'));
    const rows = state.rows.filter(r => r.kind === 'line');
    [
      [0, 0.5],
      [1, 1.5],
      [2.3, 2.8],
      [3.3, 3.8],
    ].forEach(([start, end], i) => {
      rows[i].time = { start, end, st: 'ok' };
    });
    update('rows');
    groupSelectionAction([rows[0].id, rows[1].id]);
    addRefsToShot(rows[0], [fx.dir + '/样片.mp4', fx.dir + '/样图.png']);
    setUsageLines(rows[0], 0, 0, 0);
    setUsageLines(rows[0], 1, 1, 1);
    addRefsToShot(rows[2], [fx.dir + '/样片.mp4']);
    runCommand('playthrough:shot', rows[0].id);
    await until(() => $('#ptStage .pt-media:not(.pt-pending)'));
    // 时间轴胶片：视频色块铺上真截图，图片色块直接平铺图片，名字条叠在上面
    await until(() => $('#pttLane .ptt-block[data-film-src] .ptt-frame canvas'), 8000);
    t(
      '时间轴视频色块铺上胶片截图，图片色块平铺图片',
      $$('#pttLane .ptt-block[data-film-src] .ptt-frame canvas').length >= 1 &&
        !!$('#pttLane .ptt-block[data-film-img] .ptt-film.img') &&
        getComputedStyle($('#pttLane .ptt-block[data-film-src] .ptt-label')).backgroundColor !== 'rgba(0, 0, 0, 0)',
      `截图 ${$$('#pttLane .ptt-frame canvas').length} 张`,
    );
    let blanks = 0;
    const samples = [];
    const watcher = new MutationObserver(() => {
      if ($('#ptStage .pt-gap')) blanks++;
    });
    watcher.observe($('#ptStage'), { childList: true });
    await pause(750);
    samples.push($('#ptStage .pt-gap'));
    t('同一镜头两句之间的字幕停顿保留上一帧', !samples[0] && !$('#ptStage .pt-card'));
    const held = $('#ptStage video.pt-media:not(.pt-pending)');
    t('停顿里上一段视频接着播，不定格', !!held && !held.paused, `time=${playthroughState().time}`);
    await until(() => playthroughState().time >= 1.6);
    t(
      '句间停顿字幕停在刚说完的那句，不跳回镜头第一句',
      $('#ptSub').textContent === rows[1].text,
      `time=${playthroughState().time} sub=${$('#ptSub').textContent}`,
    );
    await until(() => playthroughState().row === rows[2].id);
    watcher.disconnect();
    t('跨镜头的字幕停顿也不断画面', blanks === 0 && playthroughState().row === rows[2].id, `黑屏次数=${blanks}`);
    closePlaythrough();
    // 明确设置的手动空白仍然保留。
    setShotTimes(rows[0], [
      { assetId: rows[0].assetUsages[0].assetId, start: 0, end: 0.3 },
      { assetId: rows[0].assetUsages[1].assetId, start: 1, end: 1.5 },
    ]);
    runCommand('playthrough:shot', rows[0].id);
    await pause(650);
    t('手动留出的空白仍按用户设置显示', !!$('#ptStage .pt-gap'));
  } finally {
    closePlaythrough();
    storage.switchProject(original);
  }
}
