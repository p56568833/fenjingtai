/* 审核页的候选卡片：完整卡片、审过收成的一行、当前候选配的句子高亮、通过 / 不要 / 换一个的动效、播放。 */
import { state } from '../app/state.js';
import { timeOf } from '../app/project-queries.js';
import { assetName } from '../core/asset-model.js';
import { fmtTime, fmtLen } from '../core/text.js';
import { DECISION } from '../core/candidate-values.js';
import { esc } from '../ui/base/dom.js';
import { glide, pop, SPRING } from '../ui/base/motion.js';
import { playerHTML, targetLines, playClip, slotOf } from './clip-player.js';
import { stripHTML, mediaOf } from './review-frames.js';

import { pauseReviewPlayback } from './review-playback.js';

export function createReviewCards({ root, preview, page }) {
  const $ = s => root()?.querySelector(s);
  const { previewHost, showPreview } = preview;

  /* 当前候选排到的那几句：句子左边亮一条主色（待返工页没有方案顺序，亮整个画面） */
  function paintLineFocus(c) {
    const slot = c && page.mode !== 'rework' ? slotOf(c) : null;
    const hit = r => {
      if (!slot) return true;
      const t = timeOf(r.id);
      return !t || Math.min(t.end, slot.end) - Math.max(t.start, slot.start) > 0.05;
    };
    const nos = new Set(
      c
        ? targetLines(c)
            .target.filter(hit)
            .map(r => r.no)
        : [],
    );
    root()
      .querySelectorAll('.vr-line[data-vo-no]')
      .forEach(el => el.classList.toggle('hl', nos.has(+el.dataset.voNo)));
  }

  /* 审核页的动效：通过 / 不要 / 换一个 的底色块滑到选中的那个按钮上（第一次选时弹出来）。
   当前候选的蓝框不做滑动，直接切换（滑动的框看着晃）。 */
  const decisionMemo = new Map(); // 候选 id → 上次的结果
  function paintMotion(host, g, open) {
    const sec = host.querySelector('.vr-shot');
    if (!sec) return;
    for (const c of open) {
      const card = sec.querySelector(`[data-vr-id="${c.id}"]`);
      const on = card?.querySelector('.vr-btn.on[data-vr-d]');
      const before = decisionMemo.has(c.id) ? decisionMemo.get(c.id) : c.decision || ''; // 第一次看到：不算变化
      decisionMemo.set(c.id, c.decision || '');
      if (!on) continue;
      const row = on.parentElement;
      const prevBtn = before && before !== c.decision ? row.querySelector(`.vr-btn.${before}[data-vr-d]`) : null;
      const from = prevBtn
        ? { x: prevBtn.offsetLeft, y: prevBtn.offsetTop, w: prevBtn.offsetWidth, h: prevBtn.offsetHeight }
        : null;
      const pill = glide(row, on, 'vr-dpill', { from, pop: before !== (c.decision || '') });
      pill.dataset.d = c.decision;
    }
  }
  function stamp(id) {
    const card = $(`[data-vr-id="${id}"]`);
    if (!card) return;
    pop(card.querySelector('.vr-tag'), { scale: 1.7, duration: 460 });
    card.animate?.([{ transform: 'scale(0.985)' }, { transform: 'none' }], { duration: 380, easing: SPRING });
  }
  function cardHTML(c) {
    const d = c.decision || '';
    const actions =
      d === 'ok' && c.savedPath
        ? `<span class="vr-saved" title="${esc(c.savedPath)}">已保存：${esc(assetName(c.savedPath))}</span><button class="vr-mini" data-vr-reveal="${c.id}">在访达中显示</button>`
        : '';
    return `<article class="vr-cand ${d ? 'd-' + d : ''}${c.id === page.curCand ? ' focus' : ''}" data-vr-id="${c.id}">
    <div class="vr-head"><strong>${esc(c.title || c.key || '（未命名）')}</strong>${d ? `<span class="vr-tag d-${d}">${DECISION[d]}</span>` : ''}</div>
    <div class="vr-meta">建议 ${fmtTime(c.in)}–${fmtTime(c.out)}（${Math.round(c.out - c.in)} 秒）${c.best ? ` · <b class="vr-best" title="通过后自动设成可用片段；保存的文件仍是建议的整段，前后留着余量">精选 ${fmtTime(c.best.in)}–${fmtTime(c.best.out)}（${fmtLen(c.best.out - c.best.in)}）</b>` : ''} · ${esc(c.license || '版权未注明')} · <button class="vr-link" data-vr-page="${c.id}">原片页面</button></div>
    ${c.why ? `<p class="vr-why">${esc(c.why)}</p>` : ''}
    ${c.limits ? `<p class="vr-cov-note">缺：${esc(c.limits)}</p>` : ''}
    ${stripHTML()}
    ${page.mode === 'rework' ? playerHTML(c) : '' /* 审核页的候选在左边播放器里播；待返工页没有左边播放器，在卡片里播 */}
    <div class="vr-row">
      <button class="vr-btn play" data-vr-play="${c.id}">▶ 播放这段</button>
      <button class="vr-btn ok${d === 'ok' ? ' on' : ''}" data-vr-d="ok" data-vr-for="${c.id}">通过 <kbd>1</kbd></button>
      <button class="vr-btn no${d === 'no' ? ' on' : ''}" data-vr-d="no" data-vr-for="${c.id}">不要 <kbd>2</kbd></button>
      <button class="vr-btn re${d === 're' ? ' on' : ''}" data-vr-d="re" data-vr-for="${c.id}">换一个 <kbd>3</kbd></button>
      <input class="vr-note" data-vr-note="${c.id}" placeholder="意见（可选）：比如要更近景的、换成冷藏车外景…" value="${esc(c.note || '')}">
    </div>
    <div class="vr-row vr-after">${actions}<button class="vr-mini ghost" data-vr-orig="${c.id}">下载完整原片</button>${d ? `<button class="vr-mini" data-vr-fold="${c.id}" title="收成一行，审核结果不变">收起</button>` : ''}</div>
  </article>`;
  }
  /* 审过的候选收成一行：结果、意见、撤回（再点同一个结果 = 撤回）；点这一行（撤回以外的地方）展开成完整卡片看画面，
   审核结果不变，「收起」或换画面后再收回去。
   通过的露一帧画面（已保存的用 macOS 系统缩略图，秒出、不另存文件），一眼看出通过的是什么；
   英文 key 只留给 Claude 读（清单里照旧），界面不显示 */
  function doneHTML(c) {
    const d = c.decision;
    const save = d === 'ok' && c.savedPath ? `<span class="vr-saved">已保存</span>` : '';
    const thumbs =
      d === 'ok'
        ? `<div class="vr-done-thumbs"><div class="vr-cell ld">${c.savedPath ? '载入中…' : '保存后显示画面'}</div></div>`
        : '';
    return `<div class="vr-done d-${d}${thumbs ? ' has-thumbs' : ''}" data-vr-id="${c.id}" title="点开查看画面（审核结果不变）">${thumbs}<span class="vr-tag d-${d}">${DECISION[d]}</span><span class="vr-done-title">${esc(c.title || c.key || '（未命名）')}</span>${c.note ? `<span class="vr-done-note">「${esc(c.note)}」</span>` : ''}<span class="vr-spacer"></span>${save}<button class="vr-mini" data-vr-d="${d}" data-vr-for="${c.id}" title="撤回这个审核结果，回到待审">撤回</button></div>`;
  }

  /* 播放这个候选：审核页在左边播放器里播（候选预览），待返工页在卡片里播。at：从片段里的第几秒开始（点截图） */
  function play(id, at = null) {
    if (previewHost()) return showPreview(id, { at });
    const c = state.candidates.find(x => x.id === id);
    const card = $(`[data-vr-id="${id}"]`);
    if (!c || !card) return;
    const btn = card.querySelector('[data-vr-play]');
    pauseReviewPlayback(); // 下面嵌着的「对着口播看画面」先停，免得两路口播一起响
    const media = mediaOf(c);
    playClip(card, media, { from: at == null ? null : media.in + at, onState: text => (btn.textContent = text) });
  }

  return { paintLineFocus, paintMotion, stamp, cardHTML, doneHTML, play, reset: () => decisionMemo.clear() };
}
