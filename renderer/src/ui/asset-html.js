/* 素材的样子：表格素材卡片、右面板素材条目、句子条、够不够提示（纯拼 HTML，不碰 DOM）。
   数据在 core/asset-model.js（素材库 + 使用记录 + 片段）。 */
import { state, timeline } from '../app/state.js';
import { shotLineCoverage } from '../app/line-coverage.js';
import { mainFilled } from '../core/shot-tracks.js';
import { layoutShot, circled } from '../core/shot-layout.js';
import { shotCoverage } from '../core/coverage.js';
import { spanOf } from '../core/timeline.js';
import { fmtTime } from '../core/text.js';
import { shots, shotMembers, spanText, usageSpan, ROLES, ROLE_ORDER } from '../core/shots.js';
import { usageList, usagePath, assetName as baseName, kindOf, KIND_LABEL, clipText } from '../core/asset-model.js';
import { esc } from './base/dom.js';
import { collabSession } from '../app/collab.js';
import { missingPaths } from '../app/asset-status.js';

export { baseName as assetName, shotLineCoverage };

/* 共用画面标签：第 x–y 句共用一个画面 */
export function sharedScenes(rows) {
  const result = new Map();
  let number = 0;
  for (const members of shots(rows)) {
    if (!members[0].groupId) continue;
    const first = members[0],
      last = members[members.length - 1];
    result.set(first.groupId, { number: ++number, members, label: `第 ${first.no}–${last.no} 句共用一个画面` });
  }
  return result;
}

/* 一个镜头（一句 / 一组共用画面）在口播里一共占多少秒：「共 20.8 秒」；不是字幕实测的加「≈」 */
const s1 = x => (Math.round(x * 10) / 10).toFixed(1);
export function shotTotalText(members) {
  const tl = timeline();
  const span = spanOf(
    tl,
    members.map(m => m.id),
  );
  if (!span) return '';
  return `共 ${tl.source === 'srt' ? '' : '≈'}${s1(span.end - span.start)} 秒`;
}

/* 够不够：需要 / 可用 / 文件 三个数 + 结论（数据见 core/coverage.js） */
const COVER_TIP =
  '需要：这个画面在口播里要占的秒数\n可用：标出来的可用片段（在预览里按 I / O 设入点出点）；没标就按整个文件算\n文件：本地文件的实际长度\n够不够只拿「可用」和「需要」比';
/* 差几秒但剪辑里已经补足（放慢、定格…）：勾上就不再报红。row / assetId 给了才画这个勾 */
function fitToggle(cov, ref) {
  if (!ref) return '';
  const on = !!cov.fixed;
  const tip = on
    ? `原本差 ${s1(cov.lack)} 秒，已标为剪辑里补足；点击取消`
    : '剪辑里已经补足了（放慢、定格等）：勾上后不再提示时长不够';
  return `<span class="cover-fit${on ? ' on' : ''}" role="checkbox" tabindex="0" aria-checked="${on}" data-fit-row="${ref.row}" data-fit-asset="${esc(ref.assetId)}" title="${esc(tip)}">剪辑已补足</span>`;
}
export function coverHTML(cov, ref) {
  if (!cov) return '';
  const need = `<span class="cover-need">需要 <b>${s1(cov.need)}</b> 秒</span>`;
  if (cov.verdict === 'still')
    return `<span class="asset-cover cover-still" title="${esc(COVER_TIP)}">${need}<span class="cover-verdict">图片 · 不限时长</span></span>`;
  // 本地文件时长还没读到（刚保存、正在读，或者读不出来）：只写需要多少，不下结论
  if (cov.verdict === 'unknown')
    return `<span class="asset-cover cover-unknown" title="${esc(COVER_TIP)}">${need}<span class="cover-file">文件时长未知（打开预览后会显示）</span></span>`;
  const usable =
    cov.usable == null
      ? '<span class="cover-usable">可用 <b>—</b></span>'
      : `<span class="cover-usable">可用 <b>${s1(cov.usable)}</b> 秒<i>${cov.clip ? `${fmtTime(cov.clip.in)}–${fmtTime(cov.clip.out)}` : cov.online ? '整段' : '整段 · 未标可用段'}</i></span>`;
  const file = cov.online
    ? '<span class="cover-file">在线 · 未保存</span>'
    : cov.file != null
      ? `<span class="cover-file">文件 ${s1(cov.file)} 秒</span>`
      : '<span class="cover-file">文件时长未知</span>';
  const verdict = cov.fixed
    ? `✓ 已补足 · 原差 ${s1(cov.lack)} 秒`
    : cov.verdict === 'ok'
      ? `✓ 够${cov.spare >= 0.05 ? `，余 ${s1(cov.spare)} 秒` : ''}`
      : cov.verdict === 'short'
        ? `✗ 差 ${s1(cov.lack)} 秒`
        : '时长未知';
  const fit = cov.fixed || cov.verdict === 'short' ? fitToggle(cov, ref) : '';
  return `<span class="asset-cover cover-${cov.verdict}${cov.fixed ? ' cover-fixed' : ''}" title="${esc(COVER_TIP)}">${need}${usable}${file}<span class="cover-verdict">${verdict}</span>${fit}</span>`;
}
const coverageFor = members => shotCoverage(layoutShot(state.assets || {}, members, timeline()));

const thumbText = kind => (kind === 'video' ? '▶ 视频' : kind === 'image' ? '图片' : kind === 'link' ? '链接' : '素材');

/* 缩略图容器：data-preview-path 供懒加载与重试定位 */
const thumbHTML = (path, kind) =>
  `<span class="asset-thumb" data-preview-path="${esc(path)}" data-kind="${kind}" data-file-missing="${missingPaths().has(path)}">${thumbText(kind)}</span>`;

/* 按角色排：主画面 → 叠加 → 未分配 → 备选；保留原下标（面板按钮靠它定位） */
export function orderedUsages(r) {
  const rank = u => {
    const i = ROLE_ORDER.indexOf(u.role in ROLES ? u.role : null);
    return i < 0 ? 2 : i;
  };
  return usageList(r)
    .map((u, index) => ({ u, index }))
    .sort((x, y) => rank(x.u) - rank(y.u) || x.index - y.index);
}
const roleClass = role => (role in ROLES ? `role-${role}` : 'role-none');

export function assetCards(r) {
  const registry = state.assets || {};
  const usages = usageList(r);
  if (!usages.length) return '';
  const members = shotMembers(state.rows, r);
  const list = orderedUsages(r);
  const alts = list.filter(x => x.u.role === 'alt');
  const covers = coverageFor(members);
  // 表格里只摆真正要用的（主画面 / 叠加 / 未分配），备选收成一个入口，避免看起来每张都要轮着放
  const cards = list
    .filter(x => x.u.role !== 'alt')
    .map(({ u }) => {
      const a = registry[u.assetId] || u;
      const path = a.path || '';
      const kind = a.kind || kindOf(path) || 'doc';
      const where = spanText(members, u.assetId);
      const cov = covers.get(u.assetId);
      const label = [
        KIND_LABEL[kind] || '素材',
        u.clip && !cov ? `片段 ${clipText(u.clip)}` : '', // 上屏的画面片段写在下面「可用」里
      ]
        .filter(Boolean)
        .join(' · ');
      return `<button class="row-asset ${roleClass(u.role)}" data-asset-id="${esc(u.assetId)}" data-detail="${r.id}" title="${esc(path)}">${thumbHTML(path, kind)}<span class="asset-caption"><span class="role-tag ${roleClass(u.role)}">${esc(where || '上屏')}</span><strong>${esc(a.name || baseName(path))}</strong><small>${esc(label)}</small>${coverHTML(cov, { row: r.id, assetId: u.assetId })}</span></button>`;
    })
    .join('');
  const altBtn = alts.length
    ? `<button class="asset-alts" data-detail="${r.id}" title="${esc(alts.map(x => (registry[x.u.assetId] || x.u).name || '').join('\n'))}">备选 ${alts.length} 个 · 查看</button>`
    : '';
  return cards + altBtn;
}

/* 句子条：点选单句、拖选范围，再点唯一选中的句子转为备选。 */
const secOf = (tl, m) => {
  const t = tl.times.get(m.id);
  return t ? t.end - t.start : 0;
};
function lineControls(u, index, members) {
  const tl = timeline();
  const alt = u.role === 'alt';
  const sp = usageSpan(members, u.assetId);
  const short = members.length > 10; // 句子多、格子窄：只写句号后两位，完整的悬停看
  const cells = members
    .map((m, k) => {
      const on = !alt && !sp.empty && k >= sp.from && k <= sp.to;
      const sec = secOf(tl, m);
      const label = short ? String(m.no).slice(-2) : String(m.no);
      const action = on && sp.from === sp.to ? '再点设为备选' : '点击选单句';
      return `<button class="line-cell${on ? ' on' : ''}" style="flex:${Math.max(0.6, sec).toFixed(2)}" data-line-usage="${index}" data-line="${k}" title="第 ${m.no} 句 · ${(Math.round(sec * 10) / 10).toFixed(1)} 秒 · ${action}；拖动或 Shift＋点击选多句" aria-label="第 ${m.no} 句，${action}" aria-pressed="${on}">${label}</button>`;
    })
    .join('');
  return `<div class="asset-lines${alt ? ' is-alt' : ''}">
    <div class="line-strip" data-line-asset="${esc(u.assetId)}" role="group" aria-label="这个画面配哪几句：点击选单句，拖动选多句，再点唯一选中的句子设为备选">${cells}</div>
  </div>`;
}

const sec1 = x => (Math.round(x * 10) / 10).toFixed(1);
/* 每句的画面条：一句一格（宽度按口播秒数）。绿 = 有画面；橙 = 只盖住一部分（绿色那截是盖住的比例）；红「空」= 没画面，播出来是黑屏 */
export function coverStrip(members, cov) {
  const short = members.length > 10; // 句子多、格子窄：只写句号后两位，完整的悬停看
  const cells = cov
    .map(x => {
      const no = short ? String(x.row.no).slice(-2) : x.row.no;
      const got = x.need ? Math.round((x.got / x.need) * 100) : 100;
      const tip =
        x.state === 'ok'
          ? `第 ${x.row.no} 句 · ${sec1(x.need)} 秒 · 有画面`
          : x.state === 'part'
            ? `第 ${x.row.no} 句 · ${sec1(x.need)} 秒 · 画面只盖住 ${sec1(x.got)} 秒，后面 ${sec1(x.need - x.got)} 秒是空的`
            : `第 ${x.row.no} 句 · ${sec1(x.need)} 秒 · 没有画面（播出来是黑屏）`;
      return `<span class="lo-cell ${x.state}" style="flex:${Math.max(0.6, x.need).toFixed(2)};--got:${got}%" title="${esc(tip)}">${x.state === 'empty' ? '空' : no}</span>`;
    })
    .join('');
  const empty = cov.filter(x => x.state === 'empty').length;
  const part = cov.filter(x => x.state === 'part').length;
  const sum = [empty ? `${empty} 句没画面` : '', part ? `${part} 句画面不够长` : ''].filter(Boolean).join(' · ');
  return { cells: `<div class="lo-strip">${cells}</div>`, sum, bad: !!(empty || part) };
}
/* 面板顶部：组里每句有没有画面 */
function lineOverview(members) {
  if (members.length < 2) return '';
  const cov = shotLineCoverage(members);
  if (!cov) return '';
  const { cells, sum } = coverStrip(members, cov);
  return `<div class="line-overview"><div class="lo-head">每句的画面${sum ? `<b>${sum}</b>` : ''}</div>${cells}</div>`;
}

/* 右侧面板素材卡右边的小按钮：图标 + 文字 */
const ICON_FIND =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>';

const ICON_FETCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-4-4 4 4 4-4M5 19h14"/></svg>';

export function inspectorAssets(r, { missing } = {}) {
  const registry = state.assets || {};
  const usages = usageList(r);
  const members = shotMembers(state.rows, r);
  const ids = new Set(members.map(m => m.id));
  const cands = (state.candidates || []).filter(c => ids.has(c.rowId));
  // 正片轨已经用通过的视频排满了：别的没审的视频算「未采用」，不再提示待审
  const todo = mainFilled(registry, members, timeline(), id => !!registry[id]?.source?.candidate)
    ? 0
    : cands.filter(c => !c.decision).length;
  const vr = cands.length
    ? `<button class="vr-open${todo ? ' has-todo' : ''}" data-vr-open="${r.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/></svg><span class="vr-open-main">视频候选 ${cands.length} 个</span>${todo ? `<b>${todo} 个待审</b>` : ''}<span class="vr-open-go">去审核<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4.5 3 3 3-3 3"/></svg></span></button>`
    : '';
  if (!usages.length) return vr + '<p class="asset-none">尚未关联素材</p>';
  const peer = collabSession(); // 局域网协作中：失联的文件可以从对方电脑取
  // 每个上屏画面的编号和出现秒数（相对这段口播开头）
  const layout = layoutShot(registry, members, timeline());
  const placed = new Map((layout?.items || []).map(it => [it.assetId, it]));
  const covers = shotCoverage(layout);
  const sec = x => (Math.round(x * 10) / 10).toFixed(1);
  return (
    vr +
    lineOverview(members) +
    (usages.some(u => !(u.role in ROLES))
      ? `<button class="asset-mini auto-roles" id="autoRoles">还有素材未分配 · 第一个上屏，其余放备选</button>`
      : '') +
    orderedUsages(r)
      .map(({ u, index }) => {
        const a = registry[u.assetId] || u;
        const path = a.path || '';
        const kind = a.kind || kindOf(path) || 'doc';
        const gone = missing ? missing.has(path) : false;
        const fetchable = gone && peer?.status === 'online' && path.startsWith('/');
        const bits = [KIND_LABEL[kind] || '素材'];
        if (u.role === 'alt') bits.unshift('备选 · 不上屏');
        const cov = gone ? null : covers.get(u.assetId);
        if (u.clip && !cov) bits.push(`片段 ${clipText(u.clip)}`);
        const it = placed.get(u.assetId);
        if (it)
          bits.unshift(
            `${circled(it.n)} 出现 ${sec(it.start)}–${sec(it.end)} 秒${layout.timed ? '' : '（按句子）'}${it.over ? ' · 超出口播' : ''}`,
          );
        let stateLine = bits.join(' · ');
        let stateCls = '';
        if (gone) {
          stateLine = '文件失联 · 原路径保留在下方';
          stateCls = ' missing';
        } else if (u.clip && u.clip.needsAdjust) {
          stateLine += ' · 片段待调整';
          stateCls = ' warn';
        }
        return `<div class="inspector-asset${stateCls} ${roleClass(u.role)}" data-asset-id="${esc(u.assetId)}" data-usage-index="${index}">
      <button class="asset-open" data-preview-usage="${index}" title="${esc(path)}">
        ${thumbHTML(path, kind)}
        <span class="asset-caption"><strong>${esc(a.name || baseName(path))}</strong><small>${esc(stateLine)}</small>${coverHTML(cov, { row: r.id, assetId: u.assetId })}</span>
      </button>
      ${gone ? `<div class="asset-actions">${fetchable ? `<button class="asset-mini" data-fetch-asset="${esc(u.assetId)}" title="这个文件在 ${esc(peer.peer || '对方')} 的电脑上：通过局域网拷一份到你自己的素材文件夹">${ICON_FETCH}<span>从对方电脑取</span></button>` : ''}<button class="asset-mini" data-relocate-usage="${index}" title="文件被移走了：重新选一下它现在的位置">${ICON_FIND}<span>重新定位</span></button></div>` : ''}

      ${lineControls(u, index, members)}
      <button class="rework-btn${u.rework ? ' on' : ''}" data-rework-usage="${index}" title="${u.rework ? '点开修改意见，或者不用换了' : '写下哪里不满意，生成返工单交给 AI 找新的'}">${
        u.rework
          ? `<b>待换</b><span>${esc(u.rework.note || '（没写意见）')}</span><i>修改</i>`
          : '<b>不满意</b><span>写下哪里不满意，交给 AI 换一个</span>'
      }</button>
    </div>`;
      })
      .join('') +
    // 原路径只给失联的文件留着（找回 / 重新定位时要看）；文件好好的就不再列一长串路径
    (() => {
      const lost = usages.map(u => usagePath(state.assets || {}, u)).filter(p => missing?.has(p));
      return lost.length ? `<p class="asset-path-hint">原路径：${lost.map(esc).join('<br>')}</p>` : '';
    })()
  );
}
