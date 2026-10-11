/* 素材的样子：表格素材卡片、右面板素材条目、句子条、够不够提示（纯拼 HTML，不碰 DOM）。
   数据在 core/asset-model.js（素材库 + 使用记录 + 片段）。 */
import { state, timeline } from '../app/state.js';
import { layoutShot, circled, validAt } from '../core/shot-layout.js';
import { shotCoverage } from '../core/coverage.js';
import { spanOf } from '../core/timeline.js';
import { fmtTime } from '../core/text.js';
import { shots, shotMembers, spanText, usageSpan, ROLES, ROLE_ORDER } from '../core/shots.js';
import { usageList, usagePath, assetName as baseName, kindOf, KIND_LABEL, clipText } from '../core/asset-model.js';
import { esc } from './base/dom.js';

export { baseName as assetName };

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
export function coverHTML(cov) {
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
  const verdict =
    cov.verdict === 'ok'
      ? `✓ 够${cov.spare >= 0.05 ? `，余 ${s1(cov.spare)} 秒` : ''}`
      : cov.verdict === 'short'
        ? `✗ 差 ${s1(cov.lack)} 秒`
        : '时长未知';
  return `<span class="asset-cover cover-${cov.verdict}" title="${esc(COVER_TIP)}">${need}${usable}${file}<span class="cover-verdict">${verdict}</span></span>`;
}
const coverageFor = members => shotCoverage(layoutShot(state.assets || {}, members, timeline()));

const thumbText = kind => (kind === 'video' ? '▶ 视频' : kind === 'image' ? '图片' : kind === 'link' ? '链接' : '素材');

/* 缩略图容器：data-preview-path 供懒加载与重试定位 */
const thumbHTML = (path, kind) =>
  `<span class="asset-thumb" data-preview-path="${esc(path)}" data-kind="${kind}">${thumbText(kind)}</span>`;

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
      return `<button class="row-asset ${roleClass(u.role)}" data-detail="${r.id}" title="${esc(path)}">${thumbHTML(path, kind)}<span class="asset-caption"><span class="role-tag ${roleClass(u.role)}">${esc(where || '上屏')}</span><strong>${esc(a.name || baseName(path))}</strong><small>${esc(label)}</small>${coverHTML(cov)}</span></button>`;
    })
    .join('');
  const altBtn = alts.length
    ? `<button class="asset-alts" data-detail="${r.id}" title="${esc(alts.map(x => (registry[x.u.assetId] || x.u).name || '').join('\n'))}">备选 ${alts.length} 个 · 查看</button>`
    : '';
  return cards + altBtn;
}

/* 面板里每条素材的句子条：组里每句一格（宽度按这句口播的秒数），点亮 = 这个画面配这几句；右边「备选」= 先存着不上屏 */
const secOf = (tl, m) => {
  const t = tl.times.get(m.id);
  return t ? t.end - t.start : 0;
};
function lineControls(u, index, members, layout, it) {
  const tl = timeline();
  const alt = u.role === 'alt';
  const sp = usageSpan(members, u.assetId);
  const manual = !alt && !!layout?.timed && validAt(u.at, layout.owner);
  const short = members.length > 10; // 句子多、格子窄：只写句号后两位，完整的悬停看
  const cells = members
    .map((m, k) => {
      const on = !sp.empty && k >= sp.from && k <= sp.to;
      const sec = secOf(tl, m);
      const label = short ? String(m.no).slice(-2) : String(m.no);
      return `<button class="line-cell${on ? ' on' : ''}" style="flex:${Math.max(0.6, sec).toFixed(2)}" data-line-usage="${index}" data-line="${k}" title="第 ${m.no} 句 · ${(Math.round(sec * 10) / 10).toFixed(1)} 秒" aria-pressed="${on}">${label}</button>`;
    })
    .join('');
  const range = sp.empty
    ? '没配句子'
    : sp.from === sp.to
      ? `第 ${members[sp.from].no} 句`
      : `第 ${members[sp.from].no}–${members[sp.to].no} 句`;
  const sum = alt
    ? '备选 · 不上屏'
    : `配${range}${manual ? '<i title="在「对着口播看画面」里拖过时间。点句子条会整组改回按句子平分">· 时间微调过</i>' : ''}`;
  return `<div class="asset-lines${alt ? ' is-alt' : ''}">
    <div class="line-strip" role="group" aria-label="这个画面配哪几句">${cells}</div>
    <div class="asset-row-ctrl"><span class="line-sum">${sum}</span><span class="ctrl-right"><button class="alt-chip${alt ? ' on' : ''}" data-alt-usage="${index}" aria-pressed="${alt}" title="${alt ? '放回上屏，还配原来那几句' : '先存着不上屏'}">备选</button>${orderControls(it, layout)}</span></div>
  </div>`;
}

/* 面板顶部：组里每句配了几个画面，红色 = 这句没画面（播出来是黑屏） */
function lineOverview(members) {
  if (members.length < 2) return '';
  const tl = timeline();
  const cells = members
    .map(m => {
      const n = usageList(m).filter(u => u.role !== 'alt' && u.role !== 'overlay' && !u.off).length;
      const sec = secOf(tl, m);
      return `<span class="lo-cell${n ? '' : ' empty'}" style="flex:${Math.max(0.6, sec).toFixed(2)}" title="第 ${m.no} 句 · ${(Math.round(sec * 10) / 10).toFixed(1)} 秒 · ${n ? `${n} 个画面` : '没有画面'}">${n ? (members.length > 10 ? String(m.no).slice(-2) : m.no) : '空'}</span>`;
    })
    .join('');
  const empty = members.filter(m => !usageList(m).some(u => u.role !== 'alt' && u.role !== 'overlay' && !u.off)).length;
  return `<div class="line-overview"><div class="lo-head">每句的画面${empty ? `<b>${empty} 句没画面</b>` : ''}</div><div class="lo-strip">${cells}</div></div>`;
}

/* 面板里上屏画面的先后：和前一个 / 后一个对调（①② 换位置） */
function orderControls(it, layout) {
  const items = layout?.items || [];
  if (!it || items.length < 2) return '';
  const prev = items[it.n - 2],
    next = items[it.n];
  const btn = (other, dir, label, tip) =>
    `<button class="order-btn" data-swap-a="${esc(it.assetId)}" data-swap-b="${esc(other?.assetId || '')}" ${other ? '' : 'disabled'} title="${tip}" aria-label="${tip}"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="${dir}"/></svg>${label}</button>`;
  return `<div class="asset-order" role="group" aria-label="画面先后">${btn(prev, 'M6 9.5V2.5M3 5.5l3-3 3 3', '往前', '和前一个画面对调位置')}${btn(next, 'M6 2.5v7M3 6.5l3 3 3-3', '往后', '和后一个画面对调位置')}</div>`;
}

/* 右侧面板素材卡右边的小按钮：图标 + 文字 */
const ICON_FIND =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>';

export function inspectorAssets(r, { missing } = {}) {
  const registry = state.assets || {};
  const usages = usageList(r);
  const members = shotMembers(state.rows, r);
  const ids = new Set(members.map(m => m.id));
  const cands = (state.candidates || []).filter(c => ids.has(c.rowId));
  const todo = cands.filter(c => !c.decision).length;
  const vr = cands.length
    ? `<button class="vr-open${todo ? ' has-todo' : ''}" data-vr-open="${r.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/></svg><span class="vr-open-main">视频候选 ${cands.length} 个</span>${todo ? `<b>${todo} 个待审</b>` : ''}<span class="vr-open-go">去审核<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4.5 3 3 3-3 3"/></svg></span></button>`
    : '';
  if (!usages.length) return vr + '<p class="asset-none">尚未关联素材</p>';
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
        const bits = [KIND_LABEL[kind] || '素材'];
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
        return `<div class="inspector-asset${stateCls} ${roleClass(u.role)}" data-usage-index="${index}">
      <button class="asset-open" data-preview-usage="${index}" title="${esc(path)}">
        ${thumbHTML(path, kind)}
        <span class="asset-caption"><strong>${esc(a.name || baseName(path))}</strong><small>${esc(stateLine)}</small>${coverHTML(cov)}</span>
      </button>
      ${gone ? `<div class="asset-actions"><button class="asset-mini" data-relocate-usage="${index}" title="文件被移走了：重新选一下它现在的位置">${ICON_FIND}<span>重新定位</span></button></div>` : ''}

      ${lineControls(u, index, members, layout, it)}
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
