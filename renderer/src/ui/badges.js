/* 表格行徽标：片段待调整 / 待返工 + 素材卡片（只在内容变了时重画，换了的卡片带动效）。
   卡片 HTML 在 asset-html.js，缩略图在 asset-thumbs.js，文件失联 / 时长在 asset-files.js。 */
import { state, rowById } from '../app/state.js';
import { shotMembers } from '../core/shots.js';
import { usageList } from '../core/asset-model.js';
import { pop } from './base/motion.js';
import { assetCards, shotLineCoverage, coverStrip } from './asset-html.js';
import { hydrateAssetCards } from './asset-thumbs.js';
import { probeDurations } from './asset-files.js';
import { esc } from './base/dom.js';
import { paintSearch } from './base/search-paint.js';
import { charRangesForTimes } from '../core/text.js';
import { patchHTML } from './base/html-patch.js';

function statusText(r) {
  const clipTodo = usageList(r).some(u => u.clip && u.clip.needsAdjust);
  const rework = r.rework || usageList(r).some(u => u.rework);
  return [clipTodo ? '片段待调整' : '', rework ? '待返工' : ''].filter(Boolean).join(' · ');
}

/* 素材卡片变化的动效：新挂上的素材弹进来；主画面 / 备选换了角色的轻轻跳一下。
   按句子记住上一次有哪些卡片（整表重画后也认得出哪些是新的）；换项目时清空。 */
const cardMemo = new Map();
let cardMemoPid = null;
function animateCards(id, assets) {
  if (cardMemoPid !== state.projectId) {
    cardMemo.clear();
    cardMemoPid = state.projectId;
  }
  const now = new Map(
    [...assets.querySelectorAll('.row-asset')].map(b => [b.title, b.className.match(/role-[\w-]+/)?.[0] || '']),
  );
  const before = cardMemo.get(id);
  cardMemo.set(id, now);
  if (!before) return;
  assets.querySelectorAll('.row-asset').forEach((b, i) => {
    if (!before.has(b.title)) setTimeout(() => pop(b, { scale: 0.6, duration: 520 }), i * 60);
    else if (before.get(b.title) !== now.get(b.title)) pop(b, { scale: 0.9 });
  });
}

/* 每句有没有画面：已经放了画面的镜头里，没画面的句子整句字标红，只盖住一部分的把没盖住的那几个字标红
   （句内按字数估算位置）；共用画面的标题旁边放一条「每句的画面」，一眼看出哪几句是空的 */
function sentHtml(text, ranges) {
  if (!ranges.length) return esc(text);
  // 搜索高亮不写在这里：paintSearch 在写好的文字上原地包 <mark>，可以跨过红字边界
  const cuts = new Set([0, text.length]);
  for (const r of ranges) cuts.add(r.from).add(r.to);
  const pts = [...cuts].sort((a, b) => a - b);
  let html = '';
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k],
      b = pts[k + 1];
    let part = esc(text.slice(a, b));
    const r = ranges.find(x => a >= x.from && b <= x.to);
    if (r) {
      const tip = r.from === 0 && r.to === text.length ? '这句没有画面' : '这里没有画面';
      part = `<span class="gap-txt" title="${tip}，约 ${(Math.round(r.sec * 10) / 10).toFixed(1)} 秒">${part}</span>`;
    }
    html += part;
  }
  return html;
}
function paintSent(sent, text, ranges) {
  if (!sent || sent.isContentEditable) return; // 正在改这句：不标，免得光标乱跳
  const html = ranges.length ? sentHtml(text, ranges) : null;
  const marked = !!sent.querySelector('.gap-txt');
  if (!html && !marked) return;
  if (html && marked && sent._gapHtml === html) return;
  sent.innerHTML = html ?? sentHtml(text, []);
  sent._gapHtml = html;
  paintSearch(sent.closest('.row'));
}
function paintGaps(el, r) {
  const members = shotMembers(state.rows, r);
  let cov = shotLineCoverage(members);
  // 一个画面都还没放的镜头（还在找素材）不标：满屏红色反而看不出真正漏掉的那几句
  if (cov?.every(x => x.state === 'empty' && !x.missingGaps.length)) cov = null;
  for (const x of cov || members.map(row => ({ row, state: 'ok', gaps: [] }))) {
    const row = el.matches('.row') ? el : el.querySelector(`.row[data-id="${x.row.id}"]`);
    const text = x.row.text || '';
    paintSent(row?.querySelector('.sent'), text, charRangesForTimes(text, x.need, x.gaps));
  }
  const head = el.matches('.shared-scene') ? el.querySelector('.shared-scene-header') : null;
  if (!head) return;
  let box = head.querySelector('.scene-cover');
  if (!cov) return box?.remove();
  const { cells, sum, bad } = coverStrip(members, cov);
  const html = cells; // 只放格子，几句没画面 / 差几秒看格子和悬停说明
  if (!box) {
    box = document.createElement('button');
    box.className = 'scene-cover';
    box.dataset.detail = String(r.id);
    head.querySelector('.shared-scene-title').after(box);
  }
  box.classList.toggle('bad', bad);
  box.title = bad ? `${sum}：点开在右边给这几句加画面` : '这几句都有画面';
  if (box._coverHtml !== html) {
    patchHTML(box, html);
    box._coverHtml = html;
  }
}

const cardHtml = new WeakMap(); // .row-assets → 上次画进去的 HTML
function badgeOne(el) {
  const r = rowById(+(el.dataset.owner || el.dataset.id));
  if (!r) return;
  let badge = el.querySelector('.production-badge');
  if (!badge) {
    badge = document.createElement('button');
    badge.className = 'production-badge';
    badge.dataset.detail = String(r.id);
    el.querySelector('.typebox')?.append(badge);
  }
  const text = statusText(r);
  if (badge.textContent !== text) badge.textContent = text;
  badge.hidden = !text;
  const assets = el.querySelector('.row-assets');
  if (assets) {
    // 卡片内容（含够不够：取决于整组的使用记录、口播时间、文件时长）变了才重画，缩略图不闪
    const html = assetCards(r);
    if (cardHtml.get(assets) !== html) {
      patchHTML(assets, html);
      cardHtml.set(assets, html);
      animateCards(r.id, assets);
    }
  }
  paintGaps(el, r);
}

/* ids 给了就只刷这几句所在的行 / 共用画面；不给就全部 */
export function rowBadges(ids) {
  if (ids) {
    const seen = new Set();
    for (const id of ids) {
      const row = document.querySelector(`.row[data-id="${id}"]`);
      const el = row?.closest('.shared-scene') || row;
      if (el && !seen.has(el)) {
        seen.add(el);
        badgeOne(el);
      }
    }
  } else document.querySelectorAll('.row:not(.shared-scene-row),.shared-scene').forEach(badgeOne);
  hydrateAssetCards();
  probeDurations(rowBadges);
}
