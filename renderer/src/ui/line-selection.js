/* 素材句子条：点击定位单句、拖动选择连续范围、Shift 延伸；唯一选中句再点转备选。
   拖动只预览，松手才提交一次数据操作，取消时不产生撤销记录。 */
import { state } from '../app/state.js';
import { setUsageLines, toggleAlt } from '../app/asset-actions.js';
import { usageList } from '../core/asset-model.js';
import { shotMembers, usageSpan } from '../core/shots.js';
import { toast } from './base/dom.js';

export function initLineSelection(panel, panelRow, render) {
  let gesture = null;
  let anchorContext = '';
  const anchors = new Map();
  let suppressClick = false;

  const context = r => {
    const key = JSON.stringify([state.projectId, r.id, shotMembers(state.rows, r).map(m => m.id)]);
    if (key !== anchorContext) {
      anchorContext = key;
      anchors.clear();
    }
    return key;
  };
  const anchorOf = (r, assetId, fallback) => {
    context(r);
    return anchors.get(assetId) ?? fallback;
  };
  const commit = (r, assetId, from, to, toggle = false) => {
    const index = usageList(r).findIndex(u => u.assetId === assetId);
    if (index < 0) return;
    const hadManual = shotMembers(state.rows, r).some(m => usageList(m).some(u => u.at));
    if (toggle) toggleAlt(r, index);
    else setUsageLines(r, index, from, to);
    render();
    // 改范围可能重排素材卡；按素材身份找回键盘焦点，不滚动口播或侧栏。
    const nextIndex = usageList(r).findIndex(u => u.assetId === assetId);
    panel.querySelector(`[data-line-usage="${nextIndex}"][data-line="${to}"]`)?.focus({ preventScroll: true });
    if (toggle) toast('已设为备选 · 点击句子可重新上屏 · ⌘Z 可撤销', null, 'ok');
    else if (hadManual) toast('已改回按句子排（手动拖过的秒数清掉了） · ⌘Z 可撤销', null, 'ok');
  };
  const valid = g => {
    const r = panelRow();
    return !panel.hidden && g.strip.isConnected && panel._lineRevision === g.revision && r && context(r) === g.context;
  };
  const preview = g => {
    g.strip.classList.add('is-selecting');
    const from = Math.min(g.anchor, g.end),
      to = Math.max(g.anchor, g.end);
    for (const cell of g.strip.querySelectorAll('[data-line]')) {
      const on = +cell.dataset.line >= from && +cell.dataset.line <= to;
      cell.classList.toggle('on', on);
      cell.setAttribute('aria-pressed', String(on));
    }
  };
  const cancel = () => {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    if (g.dragged) suppressClick = true;
    if (panel.hasPointerCapture(g.pointerId)) panel.releasePointerCapture(g.pointerId);
    if (g.dragged && g.strip.isConnected) render();
  };

  panel.addEventListener('pointerdown', e => {
    suppressClick = false;
    const cell = e.target.closest('[data-line-usage]');
    const r = panelRow();
    if (!cell || !r || e.button !== 0 || !e.isPrimary) return;
    cancel();
    const strip = cell.closest('.line-strip');
    const assetId = strip.dataset.lineAsset;
    const start = +cell.dataset.line;
    const sp = usageSpan(shotMembers(state.rows, r), assetId);
    gesture = {
      strip,
      assetId,
      start,
      end: start,
      pointerId: e.pointerId,
      revision: panel._lineRevision,
      anchor: e.shiftKey ? anchorOf(r, assetId, sp.empty ? start : sp.from) : start,
      context: context(r),
      dragged: false,
    };
    cell.focus({ preventScroll: true });
  });
  document.addEventListener(
    'pointermove',
    e => {
      const g = gesture;
      if (!g || e.pointerId !== g.pointerId) return;
      if (!valid(g)) return cancel();
      if (!(e.buttons & 1)) return cancel();
      const cells = [...g.strip.querySelectorAll('[data-line]')];
      // 按每格真实边界命中；拖出左右边界时钳到首尾句，格间缝隙取邻近句。
      let nearest = cells[0],
        distance = Infinity;
      for (const cell of cells) {
        const rect = cell.getBoundingClientRect();
        const d = Math.max(rect.left - e.clientX, e.clientX - rect.right, 0);
        if (d < distance) {
          nearest = cell;
          distance = d;
        }
      }
      g.end = +nearest.dataset.line;
      if (g.end !== g.start) g.dragged = true;
      if (!g.dragged) return;
      e.preventDefault();
      if (!panel.hasPointerCapture(e.pointerId)) panel.setPointerCapture(e.pointerId);
      preview(g);
    },
    { passive: false },
  );
  document.addEventListener('pointerup', e => {
    const g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    const canCommit = valid(g);
    gesture = null;
    if (panel.hasPointerCapture(e.pointerId)) panel.releasePointerCapture(e.pointerId);
    if (!g.dragged) return; // 普通单击交给 click，同时支持键盘和辅助技术触发。
    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 0);
    if (!canCommit) return;
    anchors.set(g.assetId, g.anchor);
    commit(panelRow(), g.assetId, Math.min(g.anchor, g.end), Math.max(g.anchor, g.end));
  });
  document.addEventListener('pointercancel', e => {
    if (gesture?.pointerId === e.pointerId) cancel();
  });
  panel.addEventListener('lostpointercapture', e => {
    if (gesture?.pointerId === e.pointerId) cancel();
  });
  window.addEventListener('blur', cancel);
  panel.addEventListener('keydown', e => {
    if (e.target.closest('[data-line-usage]') && (e.key === ' ' || e.key === 'Enter') && !e.metaKey && !e.ctrlKey) {
      // 按钮的原生键盘激活优先于全局的空格播放 / 回车编辑备注。
      suppressClick = false;
      e.stopPropagation();
    }
  });
  document.addEventListener(
    'keydown',
    e => {
      if (e.key === 'Escape' && gesture) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancel();
      }
    },
    true,
  );
  panel.addEventListener('click', e => {
    if (suppressClick) {
      e.stopImmediatePropagation();
      return;
    }
    const cell = e.target.closest('[data-line-usage]');
    const r = panelRow();
    if (!cell || !r) return;
    e.stopImmediatePropagation();
    const assetId = cell.closest('.line-strip').dataset.lineAsset;
    const u = usageList(r).find(u => u.assetId === assetId);
    if (!u) return;
    const k = +cell.dataset.line;
    const sp = usageSpan(shotMembers(state.rows, r), assetId);
    const anchor = e.shiftKey ? anchorOf(r, assetId, sp.empty ? k : sp.from) : k;
    context(r);
    anchors.set(assetId, anchor);
    const toggle = !e.shiftKey && u.role !== 'alt' && !sp.empty && sp.from === k && sp.to === k;
    commit(r, assetId, Math.min(anchor, k), Math.max(anchor, k), toggle);
  });
}
