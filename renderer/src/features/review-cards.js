/* 审核页的候选：左栏的一行、右边的详情、通过 / 不要的动效、播放。 */
import { state } from '../app/state.js';
import { assetName } from '../core/asset-model.js';
import { fmtTime, fmtLen } from '../core/text.js';
import { DECISION, usableSeconds } from '../core/candidate-values.js';
import { secText } from '../core/review-format.js';
import { esc } from '../ui/base/dom.js';
import { glide, pop, SPRING } from '../ui/base/motion.js';
import { playClip } from './clip-player.js';
import { stripHTML, previewOf } from './review-frames.js';
import { candName, isIdle } from './review-model.js';

import { pauseReviewPlayback } from './review-playback.js';

export function createReviewCards({ root, preview, page }) {
  const $ = s => root()?.querySelector(s);
  const { previewHost, showPreview } = preview;

  /* 审核页的动效：通过 / 不要 的底色块滑到选中的那个按钮上（第一次选时弹出来）。
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
  /* 左栏当前画面下面的候选：每个一行、样子都一样（名字；状态 · 可用秒数 · AI 写的标题），点一行右边换成它的详情 */
  function pickHTML(c, on) {
    const st = c.decision || (isIdle(c) ? 'idle' : 'wait');
    const label = c.decision ? DECISION[c.decision] : st === 'idle' ? '未采用' : '待审';
    const tip = st === 'idle' ? '它给的那几句已经有通过的主画面，点开还能审' : c.title || '';
    return `<button class="vr-pick d-${st}${on ? ' on' : ''}" role="option" aria-selected="${!!on}" data-vr-pick="${c.id}" title="${esc(tip)}"><span class="vr-pick-name">${esc(candName(c))}</span><span class="vr-pick-sub"><span class="vr-pick-st">${label}</span> · ${secText(usableSeconds(c))} 秒${c.title ? ` · ${esc(c.title)}` : ''}</span></button>`;
  }
  /* 审核页选中候选的详情：说明 → 截图 → 来源 → 审核按钮和意见。按钮一直在同一个位置，审完不跳；再点一次同一个结果 = 撤回 */
  function detailHTML(c) {
    const d = c.decision || '';
    const seg = c.best || c;
    const segTip = c.best
      ? `用这一段：通过后自动设成可用片段。保存的文件是 ${fmtTime(c.in)}–${fmtTime(c.out)}，前后留着余量`
      : '';
    const btnOf = (key, kbd) =>
      `<button class="vr-btn ${key}${d === key ? ' on' : ''}" data-vr-d="${key}" data-vr-for="${c.id}"${d === key ? ' title="再点一次撤回"' : ''}>${DECISION[key]} <kbd>${kbd}</kbd></button>`;
    const saved =
      d === 'ok' && c.savedPath
        ? `<span class="vr-saved" title="${esc(c.savedPath)}">已保存：${esc(assetName(c.savedPath))}</span><button class="vr-link" data-vr-reveal="${c.id}">在访达中显示</button>`
        : '';
    return `<article class="vr-cand vr-detail${d ? ' d-' + d : ''}" data-vr-id="${c.id}">
    <div class="vr-head"><strong>${esc(candName(c))}</strong>${d ? `<span class="vr-tag d-${d}">${DECISION[d]}</span>` : ''}<span class="vr-spacer"></span><button class="vr-mini" data-vr-play="${c.id}">▶ 播放这段</button></div>
    ${c.why ? `<p class="vr-why">${esc(c.why)}</p>` : ''}
    ${c.limits ? `<p class="vr-cov-note">缺：${esc(c.limits)}</p>` : ''}
    ${c.short ? `<p class="vr-cov-note">不够长：${esc(c.short)}</p>` : ''}
    ${stripHTML(c)}
    <div class="vr-meta"><span class="vr-src-title">${esc(c.title || '')}</span><span class="vr-best"${segTip ? ` title="${esc(segTip)}"` : ''}>片段 ${fmtTime(seg.in)}–${fmtTime(seg.out)}（${fmtLen(seg.out - seg.in)}）</span><span>${esc(c.license || '版权未注明')}</span><button class="vr-link" data-vr-page="${c.id}">原片页面</button><button class="vr-link" data-vr-orig="${c.id}">下载完整原片</button></div>
    <div class="vr-row vr-decide">${btnOf('ok', 1)}${btnOf('no', 2)}</div>
    <input class="vr-note" data-vr-note="${c.id}" placeholder="意见（可选）：比如要更近景的、换成冷藏车外景…" value="${esc(c.note || '')}">
    ${saved || d ? `<div class="vr-row vr-after">${saved}<span class="vr-spacer"></span>${d ? `<button class="vr-link" data-vr-d="${d}" data-vr-for="${c.id}" title="撤回这个审核结果，回到待审">撤回</button>` : ''}</div>` : ''}
  </article>`;
  }
  /* 播放这个候选：审核页在左边播放器里播（候选预览），待返工页在卡片里播。at：从片段里的第几秒开始（点截图） */
  function play(id, at = null) {
    if (previewHost()) return showPreview(id, { at });
    const c = state.candidates.find(x => x.id === id);
    const card = $(`[data-vr-id="${id}"]`);
    if (!c || !card) return;
    const btn = card.querySelector('[data-vr-play]');
    pauseReviewPlayback(); // 下面嵌着的「对着口播看画面」先停，免得两路口播一起响
    const media = previewOf(c);
    playClip(card, media, { from: at == null ? null : media.in + at, onState: text => (btn.textContent = text) });
  }

  return {
    paintMotion,
    stamp,
    pickHTML,
    detailHTML,
    play,
    reset: () => decisionMemo.clear(),
  };
}
