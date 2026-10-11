/* 表格行徽标：片段待调整 / 待返工 + 素材卡片（只在内容变了时重画，换了的卡片带动效）。
   卡片 HTML 在 asset-html.js，缩略图在 asset-thumbs.js，文件失联 / 时长在 asset-files.js。 */
import { state, rowById } from '../app/state.js';
import { usageList } from '../core/asset-model.js';
import { pop } from './base/motion.js';
import { assetCards } from './asset-html.js';
import { hydrateAssetCards } from './asset-thumbs.js';
import { probeDurations } from './asset-files.js';

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
      assets.innerHTML = html;
      cardHtml.set(assets, html);
      animateCards(r.id, assets);
    }
  }
}

/* ids 给了就只刷这几句所在的行 / 共用画面；不给就全部 */
export function rowBadges(ids) {
  if (ids) {
    for (const id of ids) {
      const row = document.querySelector(`.row[data-id="${id}"]`);
      const el = row?.closest('.shared-scene') || row;
      if (el) badgeOne(el);
    }
  } else document.querySelectorAll('.row:not(.shared-scene-row),.shared-scene').forEach(badgeOne);
  hydrateAssetCards();
  probeDurations(rowBadges);
}
