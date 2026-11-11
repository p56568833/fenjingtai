/* 审核页左栏：待审 / 待返工切换、当前批次卡片、这一批（或待返工）的画面列表。只拼 HTML 和滑块动效。 */
import { state } from '../app/state.js';
import { reworkShots, reworkText } from '../core/rework.js';
import { esc } from '../ui/base/dom.js';
import { glide } from '../ui/base/motion.js';
import { fmtDay, batchDetail } from '../core/review-format.js';
import {
  page,
  pendingCount,
  isPending,
  batchLabel,
  rangeText,
  sectionOf,
  reworkLabel,
  reworkState,
} from './review-model.js';

/* 左栏：当前批次标题打开切换菜单，进度独立显示；下面是这一批的全部画面（按章节） */
/* 待审 / 待返工切换的白色滑块：和顶栏「审核 / 表格」一样滑过去。
   左栏每次重画都会换掉这排按钮，所以上一次的位置记在这里，新滑块从那儿出发 */
let tabGeo = null;
export function paintTabs(nav) {
  const box = nav.querySelector('.vr-tabs');
  const on = box?.querySelector('.vr-tab.on');
  if (!box || !on) return;
  glide(box, on, 'vr-tab-pill', { from: tabGeo });
  tabGeo = box._glide || tabGeo;
}
/* 审核页顶上的切换：待审（按批次）/ 待返工（所有批次没过关的画面） */
function tabsHTML() {
  const p = pendingCount();
  const r = reworkShots(state.rows, state.candidates).length;
  const tab = (id, label, n, tip) =>
    `<button class="vr-tab${page.mode === id ? ' on' : ''}" role="tab" aria-selected="${page.mode === id}" data-vr-tab="${id}" title="${tip}">${label}${n ? `<b>${n}</b>` : ''}</button>`;
  return `<div class="vr-tabs" role="tablist">${tab('review', '待审', p, '按批次审核导入的视频候选')}${tab('rework', '待返工', r, '所有批次里没过关、或者你写了要求的画面')}</div>`;
}
export function navHTML(all, shots) {
  let sec = null;
  // 一个都没通过、还在待返工页里的画面：这里也叫「待返工」，和待返工页说法一致
  const rework = new Set(reworkShots(state.rows, state.candidates).map(s => s.lead.id));
  const shotsHTML = shots
    .map(g => {
      const head = g.section !== sec ? `<div class="vr-nav-sec">${esc(g.section || '（没有章节）')}</div>` : '';
      sec = g.section;
      const status = g.pending
        ? `<span class="vr-nav-n">${g.pending} 待审</span>`
        : g.ok
          ? '<span class="vr-nav-done ok">✓ 已通过</span>'
          : rework.has(g.key)
            ? '<span class="vr-nav-done re">待返工</span>'
            : '<span class="vr-nav-done">已审完</span>';
      const label = g.cands[0]?.label ? `<small>${esc(g.cands[0].label)}</small>` : '';
      return `${head}<button class="vr-nav-shot${g.key === page.curShot ? ' on' : ''}${g.pending ? '' : ' done'}" data-vr-goto="${esc(String(g.key))}"><span>${rangeText(g.lead)}${label}</span>${status}</button>`;
    })
    .join('');
  const b = all.find(x => x.id === page.curBatch);
  // 一个候选都没有：右边的空状态里已经有「复制格式规范 / 导入候选清单」，左栏不再重复放一遍
  if (!b && !state.candidates.length) return tabsHTML();
  if (!b)
    return `${tabsHTML()}<button class="vr-batch-add" id="vrImport" title="把 Claude 找好的候选清单（.json）导进来；也可以直接拖进窗口">＋ 导入候选清单…</button>
      <button class="vr-batch-add ghost" id="vrCopySpec" title="候选清单必须按这份规范写才能导入">复制格式规范（发给找素材的 AI）</button>`;
  const n = b.cands.length;
  const pending = b.cands.filter(isPending).length;
  const reviewed = n - pending;
  const reviewedPct = n ? (reviewed / n) * 100 : 0;
  const ok = b.cands.filter(c => c.decision === 'ok').length;
  const status = pending
    ? `<span class="vr-nav-n">${pending} 待审</span>`
    : '<span class="vr-batch-reviewed">已审完</span>';
  const name = batchDetail(b);
  const others = all.filter(x => x !== b);
  const otherPending = others.reduce((s, x) => s + x.cands.filter(isPending).length, 0);
  // 还有待审的别的批次（新的在前）：提示可以直接点过去，不用在一长串批次里翻
  const nextPending = others.find(x => x.cands.some(isPending));
  const tip = `${batchLabel(b)}${b.at ? ` · ${fmtDay(b.at)}` : ''}\n点击切换批次（共 ${all.length} 批）`;
  return `${tabsHTML()}<div class="vr-picker">
      <div class="vr-bh${pending ? '' : ' complete'}">
        <div class="vr-bheader">
          <button class="vr-batch-head" id="vrBatchPick" data-vr-batch="${esc(b.id)}" title="${esc(tip)}" aria-label="${esc(batchLabel(b))}，切换批次，共 ${all.length} 批" aria-haspopup="menu">
            <b>${esc(batchLabel(b))}</b><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
          </button>
          <button class="vr-batch-more" id="vrBatchMore" title="这一批的操作：重命名、返工单、保存位置、删除" aria-label="批次操作" aria-haspopup="menu">⋯</button>
        </div>
        ${name ? `<div class="vr-bname" title="${esc(name)}">${esc(name)}</div>` : ''}
        <div class="vr-bprogress">${status}<span class="vr-bcount">已审 ${reviewed}/${n} · 通过 ${ok}/${n}</span></div>
        ${b.at ? `<div class="vr-batch-date">${fmtDay(b.at)}</div>` : ''}
        <div class="vr-bbar" role="progressbar" aria-label="本批审核进度" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${reviewed}"><i style="width:${reviewedPct.toFixed(1)}%"></i></div>
        ${otherPending ? `<button class="vr-bother" data-vr-next-batch="${esc(nextPending.id)}" title="去${esc(batchLabel(nextPending))}">其他批次还有 ${otherPending} 个待审<span>去审 ›</span></button>` : ''}
      </div>
    </div>
    <div class="vr-shots">${shotsHTML}</div>`;
}

/* 待返工一项的说明：要做什么 + 为什么（不满意的地方 / 你的要求 / 否掉的意见），都没写就用这几句的口播 */
function reworkReason(s) {
  const why = x => reworkText(x);
  if (s.replaces.length) {
    const note = s.replaces.map(x => why(x.note)).find(Boolean);
    return `换素材${note ? `：${note}` : ''}`;
  }
  if (s.request) return `要补${why(s.request.note) ? `：${why(s.request.note)}` : ''}`;
  const note = s.rejected.map(c => why(c.note)).find(Boolean);
  return `否掉 ${s.rejected.length} 个${note ? `：${note}` : ''}`;
}
const REWORK_HELP =
  '这里列出要重新找画面的句子：审核时否掉、还没有通过的；在右侧面板对素材点了「不满意」的；要 AI 再找一个的。\n生成返工单交给找素材的 AI，新候选导入后在这里审；任何一个候选通过，这一项就离开这一页。';

export function reworkNavHTML(list) {
  let sec = null;
  const states = list.map(reworkState);
  const items = list
    .map((s, i) => {
      const section = sectionOf(s.lead.id);
      const head = section !== sec ? `<div class="vr-nav-sec">${esc(section || '（没有章节）')}</div>` : '';
      sec = section;
      const st = states[i];
      return `${head}<button class="vr-nav-shot${s.key === page.curRework ? ' on' : ''}" data-vr-rw="${esc(s.key)}" title="${esc(s.target.map(m => m.text).join(''))}"><span>${reworkLabel(s)}<small>${esc(reworkReason(s))}</small></span><span class="vr-nav-done vr-rw-st s-${st.key}">${st.short}</span></button>`;
    })
    .join('');
  // 每一项走到哪一步写在下面各自那一行上；这里只写总数。返工单在右边一次生成全部
  return `${tabsHTML()}<div class="vr-picker"><div class="vr-bh vr-rw-card">
      <div class="vr-bheader"><b>${list.length ? `${list.length} 项要重新找画面` : '没有要返工的画面'}</b><span class="vr-rw-help" title="${esc(REWORK_HELP)}" aria-label="${esc(REWORK_HELP)}">?</span></div>
    </div></div>
    <div class="vr-shots">${items}</div>`;
}
