/* 待返工页的右边：只做一件事——写清这一项要什么，交给找素材的 AI。
   原文 → 现在的画面（要换掉的素材和不满意的地方、哪几句没画面）→ 想要什么样的新画面 → 生成返工单；
   否掉的候选排成一行小卡片当参考（点开预览，不在这里改判）。新候选到了去待审页审，这里只给一个入口。左栏在 review-nav.js。 */
import { state } from '../app/state.js';
import { ROLES as ROLE_NAMES } from '../core/shots.js';
import { assetName, usageList } from '../core/asset-model.js';
import { reworkText, followRework } from '../core/rework.js';
import { sentenceScope } from '../core/candidate-scope.js';
import { usableSeconds } from '../core/candidate-values.js';
import { secText, fmtDay } from '../core/review-format.js';
import { esc } from '../ui/base/dom.js';
import { glide } from '../ui/base/motion.js';
import { runCommand } from '../ui/base/commands.js';
import { stopClip } from './clip-player.js';
import { retainFrames, paintStrips, stripHTML } from './review-frames.js';
import { page, reworkList, reworkLabel, reworkState, isPending, candName } from './review-model.js';
import { reworkNavHTML, paintTabs } from './review-nav.js';

/* 上次画在右边的那一项：它的 key（句子范围）变了、或者它离开了列表，用它找接上的那一项，不跳回第一项 */
let lastShown = null;

/* 这几句里哪几句正片上没有画面（主画面或旧项目里未分配的素材都算有画面） */
const blankLines = target =>
  target.filter(m => !usageList(m).some(u => !u.off && (u.role === 'main' || u.role == null))).map(m => m.no);

/* 否掉的候选：一张小卡片，封面一帧 + 名字 + 当时否掉的理由；「预览」在下面的预览区播 */
const refHTML = c =>
  `<div class="vr-rw-ref" data-vr-id="${c.id}">${stripHTML(c, 1)}<div class="vr-rw-ref-body"><b title="${esc(c.title || '')}">${esc(candName(c))}</b><span class="vr-rw-ref-why${c.note ? '' : ' none'}">${esc(c.note || '没写理由')}</span><span class="vr-rw-ref-foot">${secText(usableSeconds(c))} 秒<button class="vr-link" data-vr-play="${c.id}">▶ 预览</button></span></div></div>`;

export function renderRework(host, nav) {
  const list = reworkList();
  if (!list.some(s => s.key === page.curRework))
    page.curRework = followRework(list, lastShown?.key === page.curRework ? lastShown : null)?.key ?? null;
  const s = list.find(x => x.key === page.curRework);
  nav.innerHTML = reworkNavHTML(list);
  paintTabs(nav);
  nav.querySelector('.vr-nav-shot.on')?.scrollIntoView({ block: 'nearest' });
  glide(nav, nav.querySelector('.vr-nav-shot.on'), 'vrnav-glide');
  if (!s) {
    stopClip();
    host.innerHTML =
      '<p class="vr-empty">没有待返工的画面。审核时点了「不要」、又没有别的候选通过的画面，或者在右侧面板对某个素材点了「不满意」、点了「让 AI 再找一个」的画面，都会列在这里。</p>';
    return;
  }
  lastShown = { key: s.key, leadId: s.lead.id, from: s.from, to: s.to, index: list.indexOf(s) };
  const reg = state.assets || {};
  const out = new Set(s.replaces.map(x => x.assetId));
  const nameOf = id => reg[id]?.name || assetName(reg[id]?.path || '') || '素材';
  const seen = new Set();
  // 只列这几句上挂着的素材（共用画面里配别的句子的不相干）
  const current = s.target
    .flatMap(m => usageList(m).filter(u => !u.off))
    .filter(u => reg[u.assetId] && !seen.has(u.assetId) && seen.add(u.assetId));
  const roleOf = id => ROLE_NAMES[current.find(u => u.assetId === id)?.role] || '未分配';
  // 要换掉的素材，一个一行：缩略图、名字、在画面里的位置，右边直接改不满意的地方
  const nowHTML = s.replaces
    .map(x => {
      const a = reg[x.assetId];
      const thumb = a?.path
        ? `<span class="asset-thumb vr-rw-thumb" data-preview-path="${esc(a.path)}" data-kind="${esc(a.kind || '')}">${a.kind === 'image' ? '图片' : '视频'}</span>`
        : '<span class="asset-thumb vr-rw-thumb">素材</span>';
      return `<div class="vr-rw-now">${thumb}<div class="vr-rw-now-body">
          <div class="vr-rw-now-head"><b>${esc(nameOf(x.assetId))}</b><small>${esc(roleOf(x.assetId))} · 要换掉</small></div>
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
  const blank = blankLines(s.target);
  // 没画面的句子上挂着已通过、只放在备选的视频：拖上正片轨就有画面了，不一定要再找
  const altPassed = blank.length
    ? current.filter(u => u.role === 'alt' && s.approved.some(c => c.assetId === u.assetId))
    : [];
  const st = reworkState(s);
  const waiting = s.cands.filter(isPending).length;
  // 否掉的候选只当参考：最近否掉的在前
  const refs = [...s.rejected].sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0));
  // 这次打开软件后生成过返工单：写上时间，能在访达里找到那份文件
  const sent = page.reworkDocAt
    ? `<span class="vr-rw-sent">已生成 · ${fmtDay(page.reworkDocAt)}${page.reworkDocPath.startsWith('/') ? '<button class="vr-link" data-vr-rw-reveal>在访达中显示</button>' : ''}</span>`
    : '';
  stopClip();
  host.innerHTML = `<section class="vr-shot vr-rw" data-vr-shot="${esc(s.key)}">
      <div class="vr-shot-head"><h4><span class="vr-shot-range">${reworkLabel(s)}</span>${s.cands[0]?.label ? `<span class="vr-shot-label">${esc(s.cands[0].label)}</span>` : ''}</h4><span class="vr-spacer"></span>${waiting ? '' : `<span class="vr-rw-state s-${st.key}">${st.text}</span>`}</div>
      ${waiting ? `<div class="vr-rw-go"><span>AI 送来的新候选已经到了（${waiting} 个待审），在待审页里审</span><button class="btn primary" data-vr-rw-review="${esc(String(s.lead.id))}">去待审审核</button></div>` : ''}
      <div class="vr-rw-main">
        <div class="vr-brief-sec"><h5>这几句</h5><div class="vr-lines">${s.target.map(m => `<div class="vr-line" data-vo-no="${m.no}"><div class="vr-line-text"><span class="vr-line-no">${m.no}</span><p>${esc(m.text)}</p></div></div>`).join('')}</div></div>
        <div class="vr-brief-sec"><h5>现在的画面</h5>
          ${nowHTML}
          ${others || blank.length ? `<div class="vr-rw-current">${others}${blank.length ? `<span class="vr-rw-blank">${sentenceScope(blank).text.replace(/^第(.+)句$/, '第 $1 句')}没有画面</span>` : ''}</div>` : ''}
          ${altPassed.length ? `<p class="vr-rw-tip">备选里有已通过的「${esc(nameOf(altPassed[0].assetId))}」，拖上正片轨就有画面了，不一定要再找。<button class="vr-link" data-vr-rw-review>去待审页拖上去</button></p>` : ''}
          ${nowHTML ? '<p class="vr-rw-tip">新候选通过后，要换掉的素材自动挪到备选，不会删掉。</p>' : ''}
        </div>
        <div class="vr-brief-sec">
          <label class="vr-rw-ask" for="vrReworkNote"><h5>想要什么样的新画面</h5><span>会写进返工单交给 AI</span></label>
          <textarea id="vrReworkNote" data-vr-rw-note rows="3" placeholder="比如：要近景、要彩色的、再补一个工厂外景…">${esc(s.request?.note || '')}</textarea>
          <div class="vr-rw-foot"><button class="vr-link" data-vr-rw-off title="这几句不用再找了；之后再否掉候选，它会重新出现">不用返工了</button><span class="vr-spacer"></span>${sent}<button class="btn${waiting ? '' : ' primary'}" id="vrReworkDoc" title="把待返工的${list.length > 1 ? `全部 ${list.length} 项` : '这一项'}写成一份返工单，自动保存，并复制一句话给找素材的 AI">生成返工单${list.length > 1 ? `（共 ${list.length} 项）` : ''}</button></div>
        </div>
        ${
          refs.length
            ? `<div class="vr-brief-sec"><h5>否掉的 ${refs.length} 个<span>理由会一起写进返工单；想改判去待审页</span></h5>
          <div class="vr-rw-refs">${refs.map(refHTML).join('')}</div>
          <div class="vr-preview vr-rw-pv" id="vrPreview" aria-label="候选预览" hidden></div></div>`
            : ''
        }
      </div>
    </section>`;
  paintStrips(host, refs);
  runCommand('assets:load-thumbs');
  retainFrames(refs);
}
