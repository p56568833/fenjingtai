/* 审核页左栏：待审 / 待返工切换、当前批次卡片、这一批（或待返工）的画面列表。只拼 HTML 和滑块动效。 */
import { state } from '../app/state.js';
import { reworkShots } from '../core/rework.js';
import { esc } from '../ui/base/dom.js';
import { glide } from '../ui/base/motion.js';
import { fmtDay, batchDetail } from '../core/review-format.js';
import { page, pendingCount, isPending, batchLabel, rangeText, sectionOf } from './review-model.js';

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
  const shotsHTML = shots
    .map(g => {
      const head = g.section !== sec ? `<div class="vr-nav-sec">${esc(g.section || '（没有章节）')}</div>` : '';
      sec = g.section;
      const status = g.pending
        ? `<span class="vr-nav-n">${g.pending} 待审</span>`
        : g.ok
          ? '<span class="vr-nav-done ok">✓ 已通过</span>'
          : g.re
            ? '<span class="vr-nav-done re">等新候选</span>'
            : '<span class="vr-nav-done">已审完</span>';
      const label = g.cands[0]?.label ? `<small>${esc(g.cands[0].label)}</small>` : '';
      return `${head}<button class="vr-nav-shot${g.key === page.curShot ? ' on' : ''}${g.pending ? '' : ' done'}" data-vr-goto="${esc(String(g.key))}"><span>${rangeText(g.lead)}${label}</span>${status}</button>`;
    })
    .join('');
  const b = all.find(x => x.id === page.curBatch);
  if (!b)
    return `${tabsHTML()}<button class="vr-batch-add" id="vrImport" title="把 Claude 找好的候选清单（.json）导进来；也可以直接拖进窗口">＋ 导入候选清单…</button>
      <button class="vr-batch-add ghost" id="vrCopySpec" title="候选清单必须按这份规范写才能导入">复制格式规范（发给找素材的 AI）</button>`;
  const n = b.cands.length;
  const pending = b.cands.filter(isPending).length;
  const reviewed = n - pending;
  const reviewedPct = n ? (reviewed / n) * 100 : 0;
  const status = pending ? `<span class="vr-nav-n">${pending} 待审</span>` : '<span class="vr-bdone">✓ 已审完</span>';
  const name = batchDetail(b);
  const others = all.filter(x => x !== b);
  const otherPending = others.reduce((s, x) => s + x.cands.filter(isPending).length, 0);
  const tip = `${batchLabel(b)}${b.at ? ` · ${fmtDay(b.at)}` : ''}\n点击切换批次（共 ${all.length} 批）`;
  return `${tabsHTML()}<div class="vr-picker">
      <div class="vr-bh${pending ? '' : ' complete'}">
        <div class="vr-bheader">
          <button class="vr-batch-head" id="vrBatchPick" data-vr-batch="${esc(b.id)}" title="${esc(tip)}" aria-label="${esc(batchLabel(b))}，切换批次，共 ${all.length} 批" aria-haspopup="menu">
            <b>${esc(batchLabel(b))}</b><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
          </button>
          <span class="vr-bdate">${fmtDay(b.at)}</span>
          <button class="vr-batch-more" id="vrBatchMore" title="这一批的操作：保存位置、删除批次" aria-label="批次操作" aria-haspopup="menu">⋯</button>
        </div>
        ${name ? `<div class="vr-bname" title="${esc(name)}">${esc(name)}</div>` : ''}
        <div class="vr-bprogress">${status}<span class="vr-bcount">已审 ${reviewed}/${n}</span></div>
        <div class="vr-bbar" role="progressbar" aria-label="本批审核进度" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${reviewed}"><i style="width:${reviewedPct.toFixed(1)}%"></i></div>
        ${otherPending ? `<div class="vr-bother">其他批次还有 ${otherPending} 个待审</div>` : ''}
      </div>
    </div>
    <div class="vr-shots">${shotsHTML}</div>`;
}

export function reworkNavHTML(list) {
  let sec = null;
  const items = list
    .map(s => {
      const section = sectionOf(s.lead.id);
      const head = section !== sec ? `<div class="vr-nav-sec">${esc(section || '（没有章节）')}</div>` : '';
      sec = section;
      const label = s.cands[0]?.label || s.request?.note || s.replaces[0]?.note || '';
      const status = s.replaces.length
        ? `<span class="vr-nav-done re">换 ${s.replaces.length} 个</span>`
        : s.request
          ? '<span class="vr-nav-done re">要补</span>'
          : `<span class="vr-nav-done re">否掉 ${s.rejected.length}</span>`;
      return `${head}<button class="vr-nav-shot${s.lead.id === page.curRework ? ' on' : ''}" data-vr-rw="${s.lead.id}"><span>${rangeText(s.lead)}${label ? `<small>${esc(label)}</small>` : ''}</span>${status}</button>`;
    })
    .join('');
  return `${tabsHTML()}<div class="vr-picker"><div class="vr-bh vr-rw-card">
      <div class="vr-bheader"><b>待返工</b><span class="vr-bdate">${list.length} 个画面</span></div>
      <p class="vr-rw-hint">审核时否掉、还没有通过的画面，和你在右侧面板对素材点了「不满意」或要 AI 再找的画面。里面任何一个候选通过，它就离开这一页。</p>
      <button class="btn primary vr-rw-doc" id="vrReworkDoc"${list.length ? '' : ' disabled'} title="把这一页写成返工单，放在片段保存位置，并复制一句话给找素材的 AI">生成返工单</button>
      ${page.reworkDocAt ? `<div class="vr-bother">已生成 · ${fmtDay(page.reworkDocAt)}</div>` : ''}
    </div></div>
    <div class="vr-shots">${items}</div>`;
}
