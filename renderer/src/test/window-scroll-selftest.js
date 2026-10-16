import { viewState } from '../app/view-state.js';
import { state } from '../app/state.js';
import { update } from '../app/project-events.js';
import * as storage from '../app/storage.js';
import { jumpTo, revealSavedCursor } from '../ui/workspace.js';
import { preserveReadingPosition } from '../ui/reading-position.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const $ = selector => document.querySelector(selector);

export async function runWindowScrollTests(t) {
  const original = state.projectId;
  const previousView = viewState.view;
  let project;
  try {
    project = storage.createProject(
      '窗口切换定位回归',
      Array.from({ length: 150 }, (_, i) => ({
        id: i + 1,
        kind: 'line',
        text: `第 ${i + 1} 句。` + '长稿协作时保留正在阅读的位置。'.repeat(5),
        note: '',
      })),
    );
    for (const view of ['table', 'check']) {
      viewState.view = view;
      update('rows');
      await pause(180);
      const target = () => $(`.row[data-id="91"],.as[data-id="91"]`);
      target().scrollIntoView({ block: 'center' });
      await pause(100);
      target().scrollIntoView({ block: 'center' });
      await pause(100);
      viewState.sel = 1; // 选中句仍在前面，阅读位置已经往后。
      update('selection');
      await pause(400); // 等滚动后屏幕附近的占位块排完，量到的才是稳定位置
      const before = target();
      const top = before.getBoundingClientRect().top;
      window.dispatchEvent(new Event('blur'));
      for (let i = 0; i < 3; i++) {
        state.rows[10].text = `同事第 ${i + 1} 次修改。`;
        update('rows');
      }
      t(
        `${view} 切到剪辑软件时同事的修改照常显示，正在看的句子不换元素`,
        target() === before && $('#rows').textContent.includes('同事第 3 次修改。'),
      );
      window.dispatchEvent(new Event('focus'));
      await pause(200);
      const drift = target().getBoundingClientRect().top - top;
      t(
        `${view} 切回后阅读位置不动`,
        target() === before && viewState.sel === 1 && Math.abs(drift) < 2,
        `句子偏移 ${drift.toFixed(1)}px`,
      );

      let calls = 0;
      const el = target();
      const scroll = el.scrollIntoView;
      el.scrollIntoView = function (options) {
        calls++;
        return scroll.call(this, options);
      };
      try {
        jumpTo(91);
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
        await pause(100);
        t(`${view} 切出再切回不继续执行旧跳句校准`, calls === 1, `定位执行 ${calls} 次`);
        calls = 0;
        revealSavedCursor();
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
        await pause(80);
        t(`${view} 切出窗口取消尚未执行的旧光标恢复`, calls === 0);
      } finally {
        el.scrollIntoView = scroll;
      }

      const overflowAnchor = $('#tableWrap').style.overflowAnchor;
      preserveReadingPosition(() => {});
      window.dispatchEvent(new Event('blur'));
      t(`${view} 切出窗口立即释放面板布局的位置校准`, $('#tableWrap').style.overflowAnchor === overflowAnchor);
      window.dispatchEvent(new Event('focus'));
    }
  } finally {
    window.dispatchEvent(new Event('focus'));
    storage.switchProject(original);
    if (project) storage.deleteProject(project);
    viewState.view = previousView;
    update('rows');
    await pause(180);
  }
}
