/* 选中态视图：可独立刷新，不依赖编辑或整页渲染。 */
import { state, emit, currentSelection, checkedIds } from '../app/state.js';
import { glideSelection } from './motion.js';

/* 只刷选中高亮，不重建 DOM（键盘导航 / 点选时不打断进行中的编辑） */
export function renderSelectionOnly() {
  document.body.classList.toggle('multi-mode', state.multiMode);
  document.body.classList.toggle('multi-active', checkedIds().length > 0); // 勾了一句也一直显示勾，不用等第二句
  document.querySelector('#selectionHeading').textContent = state.multiMode ? '选择 / #' : '#';
  emit('cursor');
  const sel = new Set(currentSelection());
  if (state.view === 'check') {
    document.querySelectorAll('.as').forEach(el => {
      const checked = sel.has(+el.dataset.id);
      el.classList.toggle('cur', checked);
      if (state.multiMode) {
        el.setAttribute('role', 'checkbox');
        el.setAttribute('aria-checked', String(checked));
        el.tabIndex = 0;
      } else {
        el.removeAttribute('role');
        el.removeAttribute('aria-checked');
        el.removeAttribute('tabindex');
      }
    });
    // 共用画面：选中组里任意一句，整段一起框住（和单句选中同一种样式）
    document
      .querySelectorAll('.shared-passage')
      .forEach(p => p.classList.toggle('picked', !!p.querySelector('.as.cur')));
    return;
  }
  const ticked = new Set(checkedIds());
  const only = list => (list.length === 1 ? list[0] : null);
  const before = only(document.querySelectorAll('#rows .row.selected'));
  document.querySelectorAll('.row').forEach(el => {
    el.classList.toggle('selected', sel.has(+el.dataset.id));
    const box = el.querySelector('.row-select');
    if (box) box.checked = ticked.has(+el.dataset.id);
  });
  // 共用画面：选中组里任意一句，整组（句子 + 类型 + 画面描述 + 素材）一起框住——
  // 用的是和单句选中完全一样的灰底灰框，只是范围是一整组；组内当前那句再深一点
  document
    .querySelectorAll('.shared-scene')
    .forEach(sc => sc.classList.toggle('picked', !!sc.querySelector('.row.selected')));
  // 换句：选中条从上一句滑过来
  const after = only(document.querySelectorAll('#rows .row.selected'));
  if (before !== after) glideSelection(before, after);
}
