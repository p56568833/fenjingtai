/* 待返工页的右边：画面原文、要换掉的素材、补充要求、没过关的候选。左栏在 review-nav.js。 */
import { state } from '../app/state.js';
import { ROLES as ROLE_NAMES } from '../core/shots.js';
import { assetName, usageList } from '../core/asset-model.js';
import { esc } from '../ui/base/dom.js';
import { glide } from '../ui/base/motion.js';
import { stopClip } from './clip-player.js';
import { retainFrames, paintStrips, paintDoneThumb } from './review-frames.js';
import { page, touched, reworkList, reworkShown, reworkOpen, batchOfCand, reworkLabel } from './review-model.js';
import { reworkNavHTML, paintTabs } from './review-nav.js';

export function renderRework(host, nav, { cardHTML, doneHTML, paintLineFocus }) {
  const list = reworkList();
  if (!list.some(s => s.key === page.curRework)) page.curRework = list[0]?.key ?? null;
  nav.innerHTML = reworkNavHTML(list);
  paintTabs(nav);
  nav.querySelector('.vr-nav-shot.on')?.scrollIntoView({ block: 'nearest' });
  glide(nav, nav.querySelector('.vr-nav-shot.on'), 'vrnav-glide');
  const s = list.find(x => x.key === page.curRework);
  if (!s) {
    stopClip();
    host.innerHTML =
      '<p class="vr-empty">没有待返工的画面。审核时点「不要 / 换一个」、又没有别的候选通过的画面，或者在右侧面板对某个素材点了「不满意」、点了「让 AI 再找一个」的画面，都会列在这里。</p>';
    return;
  }
  const shown = reworkShown(s);
  const open = reworkOpen(s);
  if (!open.some(c => c.id === page.curCand)) page.curCand = open[0]?.id || null;
  const reg = state.assets || {};
  const out = new Set(s.replaces.map(x => x.assetId));
  const nameOf = id => reg[id]?.name || assetName(reg[id]?.path || '') || '素材';
  const replaceHTML = s.replaces
    .map(
      x =>
        `<p class="vr-rw-replace">要换掉：<b>${esc(nameOf(x.assetId))}</b>${x.note ? `<span>「${esc(x.note)}」</span>` : ''}</p>`,
    )
    .join('');
  const seen = new Set();
  // 只列这几句上挂着的素材（共用画面里配别的句子的不相干）
  const current = s.target
    .flatMap(m => usageList(m).filter(u => !u.off))
    .filter(u => reg[u.assetId] && !seen.has(u.assetId) && seen.add(u.assetId))
    .map(
      u =>
        `<span class="vr-rw-asset${out.has(u.assetId) ? ' out' : ''}">${esc(ROLE_NAMES[u.role] || '未分配')} · ${esc(reg[u.assetId].name || assetName(reg[u.assetId].path || ''))}</span>`,
    )
    .join('');
  const cardsOf = list =>
    list
      .map(
        c =>
          `<p class="vr-span">${esc(batchOfCand(c))}</p>${c.decision === 'ok' && !touched.has(c.id) ? doneHTML(c) : cardHTML(c)}`,
      )
      .join('');
  stopClip();
  host.innerHTML = `<section class="vr-shot vr-rw" data-vr-shot="${esc(s.key)}">
      <div class="vr-shot-head"><h4><span class="vr-shot-range">${reworkLabel(s)}</span>${s.cands[0]?.label ? `<span class="vr-shot-label">${esc(s.cands[0].label)}</span>` : ''}</h4></div>
      ${s.target.map(m => `<div class="vr-line" data-vo-no="${m.no}"><div class="vr-line-text"><span class="vr-line-no">${m.no}</span><p>${esc(m.text)}</p></div></div>`).join('')}
      <div class="vr-rw-req">
        ${replaceHTML ? `${replaceHTML}<p class="vr-rw-tip">新的候选通过后，要换掉的素材挪到备选。</p>` : ''}
        <label for="vrReworkNote">补充要求<span>会写进返工单交给 AI</span></label>
        <textarea id="vrReworkNote" data-vr-rw-note rows="2" placeholder="还想要什么样的画面？比如：要近景、要彩色的、再补一个工厂外景…">${esc(s.request?.note || '')}</textarea>
        ${current ? `<div class="vr-rw-current"><span>现在挂着</span>${current}</div>` : ''}
        <div class="vr-row"><button class="vr-mini" data-vr-rw-off title="这几句不用再找了；之后再否掉候选，它会重新出现">不用返工了</button></div>
      </div>
      ${shown.length ? `<div class="vr-line-cands">${cardsOf(shown.filter(c => c.decision !== 'ok'))}${cardsOf(shown.filter(c => c.decision === 'ok'))}</div>` : ''}
    </section>`;
  paintLineFocus(state.candidates.find(c => c.id === page.curCand) || null);
  paintStrips(host, open);
  for (const c of shown) if (c.decision === 'ok' && c.savedPath && !touched.has(c.id)) paintDoneThumb(c, host);
  retainFrames(open);
}
