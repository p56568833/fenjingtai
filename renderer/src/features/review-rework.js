/* 待返工页的右边：画面原文、当前画面（要换掉的素材 + 不满意的地方）、想要的新画面、新候选和否掉的候选。左栏在 review-nav.js。 */
import { state } from '../app/state.js';
import { ROLES as ROLE_NAMES } from '../core/shots.js';
import { assetName, usageList } from '../core/asset-model.js';
import { reworkText, followRework } from '../core/rework.js';
import { esc } from '../ui/base/dom.js';
import { glide } from '../ui/base/motion.js';
import { runCommand } from '../ui/base/commands.js';
import { stopClip } from './clip-player.js';
import { retainFrames, paintStrips } from './review-frames.js';
import {
  page,
  touched,
  reworkList,
  reworkShown,
  reworkOpen,
  batchOfCand,
  reworkLabel,
  reworkState,
} from './review-model.js';
import { reworkNavHTML, paintTabs } from './review-nav.js';

/* 上次画在右边的那一项：它的 key（句子范围）变了、或者它离开了列表，用它找接上的那一项，不跳回第一项 */
let lastShown = null;

export function renderRework(host, nav, { cardHTML, doneHTML, paintLineFocus }) {
  const list = reworkList();
  if (!list.some(s => s.key === page.curRework))
    page.curRework = followRework(list, lastShown?.key === page.curRework ? lastShown : null)?.key ?? null;
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
  lastShown = { key: s.key, leadId: s.lead.id, from: s.from, to: s.to, index: list.indexOf(s) };
  const shown = reworkShown(s);
  const open = reworkOpen(s);
  if (!open.some(c => c.id === page.curCand)) page.curCand = open[0]?.id || null;
  const reg = state.assets || {};
  const out = new Set(s.replaces.map(x => x.assetId));
  const nameOf = id => reg[id]?.name || assetName(reg[id]?.path || '') || '素材';
  const seen = new Set();
  // 只列这几句上挂着的素材（共用画面里配别的句子的不相干）
  const current = s.target
    .flatMap(m => usageList(m).filter(u => !u.off))
    .filter(u => reg[u.assetId] && !seen.has(u.assetId) && seen.add(u.assetId));
  const roleOf = id => ROLE_NAMES[current.find(u => u.assetId === id)?.role] || '未分配';
  // 当前画面：要换掉的素材，一个一块：缩略图、名字、在画面里的位置，下面直接改不满意的地方
  const nowHTML = s.replaces
    .map(x => {
      const a = reg[x.assetId];
      const thumb = a?.path
        ? `<span class="asset-thumb vr-rw-thumb" data-preview-path="${esc(a.path)}" data-kind="${esc(a.kind || '')}">${a.kind === 'image' ? '图片' : '视频'}</span>`
        : '<span class="asset-thumb vr-rw-thumb">素材</span>';
      return `<div class="vr-rw-now">${thumb}<div class="vr-rw-now-body">
          <div class="vr-rw-now-head"><span class="vr-tag d-out">要换掉</span><b>${esc(nameOf(x.assetId))}</b><small>${esc(roleOf(x.assetId))}</small></div>
          <label class="vr-rw-why"><span>不满意</span><input data-vr-rw-why="${esc(x.assetId)}" value="${esc(reworkText(x.note))}" placeholder="哪里不满意？比如：太暗了，要近景"></label>
        </div></div>`;
    })
    .join('');
  const others = current
    .filter(u => !out.has(u.assetId))
    .map(
      u =>
        `<span class="vr-rw-asset">${esc(ROLE_NAMES[u.role] || '未分配')} · ${esc(reg[u.assetId].name || assetName(reg[u.assetId].path || ''))}</span>`,
    )
    .join('');
  // 候选按「新候选待审 / 否掉的」分两组；批次只在换了批次时写一次。待审的和刚审过的展开，否掉的收成一行（点开再看）
  const groupHTML = (title, list) => {
    if (!list.length) return '';
    let batch = null;
    const items = list
      .map(c => {
        const b = batchOfCand(c);
        const head = b && b !== batch ? `<p class="vr-span">来自批次 ${esc(b)}</p>` : '';
        batch = b;
        return `${head}${!c.decision || touched.has(c.id) ? cardHTML(c) : doneHTML(c)}`;
      })
      .join('');
    return `<h5 class="vr-rw-group">${title}<span>${list.length}</span></h5>${items}`;
  };
  const fresh = shown.filter(c => !c.decision || c.decision === 'ok');
  const rejected = shown.filter(c => c.decision && c.decision !== 'ok');
  const st = reworkState(s);
  stopClip();
  host.innerHTML = `<section class="vr-shot vr-rw" data-vr-shot="${esc(s.key)}">
      <div class="vr-shot-head"><h4><span class="vr-shot-range">${reworkLabel(s)}</span>${s.cands[0]?.label ? `<span class="vr-shot-label">${esc(s.cands[0].label)}</span>` : ''}</h4><span class="vr-rw-state s-${st.key}">${st.text}</span></div>
      ${s.target.map(m => `<div class="vr-line" data-vo-no="${m.no}"><div class="vr-line-text"><span class="vr-line-no">${m.no}</span><p>${esc(m.text)}</p></div></div>`).join('')}
      <div class="vr-rw-req">
        ${nowHTML ? `<div class="vr-rw-nows">${nowHTML}<p class="vr-rw-tip">新候选通过后，要换掉的素材自动挪到备选，不会删掉。</p></div>` : ''}
        <label class="vr-rw-ask" for="vrReworkNote">想要什么样的新画面<span>会写进返工单交给 AI</span></label>
        <textarea id="vrReworkNote" data-vr-rw-note rows="2" placeholder="比如：要近景、要彩色的、再补一个工厂外景…">${esc(s.request?.note || '')}</textarea>
        ${others ? `<div class="vr-rw-current"><span>这几句还挂着</span>${others}</div>` : ''}
        <div class="vr-rw-foot"><button class="vr-mini ghost" data-vr-rw-off title="这几句不用再找了；之后再否掉候选，它会重新出现">不用返工了</button><span class="vr-spacer"></span><button class="btn primary" data-vr-rw-doc="${esc(s.key)}" title="只把这一项写成返工单，并复制一句话给找素材的 AI">为这一项生成返工单</button></div>
      </div>
      ${shown.length ? `<div class="vr-line-cands">${groupHTML('新候选', fresh)}${groupHTML('否掉的', rejected)}</div>` : ''}
    </section>`;
  paintLineFocus(state.candidates.find(c => c.id === page.curCand) || null);
  paintStrips(host, open);
  runCommand('assets:load-thumbs');
  retainFrames(open);
}
