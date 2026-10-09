/* 动效工具箱：全软件的「滑过去、弹一下」都从这里出，手感统一。
   - glide：滑块跟着选中项走（筛选条、章节目录、菜单悬停、审核页）
   - flipCapture / flipPlay：列表重画时，留下来的句子从原位置滑到新位置，新出现的淡入，消失的淡出
   - roll：数字变化时像计数器一样滚过去
   - growModal：弹窗从点它的按钮里长出来，关的时候缩回去
   系统开了「减少动态效果」，或自动化自测在跑（html[data-motion="off"]），全部直接跳到结果。 */

export const SPRING = 'cubic-bezier(0.34, 1.45, 0.5, 1)'; // 带回弹：滑块、弹出
export const SOFT_SPRING = 'cubic-bezier(0.3, 1.18, 0.5, 1)'; // 轻回弹：整行移动
export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

export const reduced = () =>
  document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;

const canAnimate = el => !!el && typeof el.animate === 'function' && !reduced();

/* ── 滑块 ──
   container 里放一个绝对定位的滑块（cls 决定样式），每次调用滑到 target 底下。
   容器内容整个重画（innerHTML）后滑块会被冲掉：重新放一个，先摆在上一次的位置再滑过去，看不出断档。
   target 为空：滑块淡出，但记住最后的位置，下次从那里滑出来。 */
export function glide(container, target, cls, { pop = false, from = null } = {}) {
  if (!container) return null;
  let pill = container.querySelector(`:scope > .${cls}`);
  const fresh = !pill;
  if (fresh) {
    pill = document.createElement('span');
    pill.className = `mo-glide ${cls}`;
    pill.setAttribute('aria-hidden', 'true');
    container.prepend(pill);
  }
  container.classList.add('has-glide');
  if (!target || !target.isConnected || !target.getClientRects().length) {
    pill.style.opacity = '0';
    pill._hidden = true;
    return pill;
  }
  const geo = { x: target.offsetLeft, y: target.offsetTop, w: target.offsetWidth, h: target.offsetHeight };
  const prev = container._glide || from;
  container._glide = geo;
  const place = g => {
    pill.style.width = `${g.w}px`;
    pill.style.height = `${g.h}px`;
    pill.style.transform = `translate(${g.x}px, ${g.y}px)`;
  };
  if (fresh || pill._hidden || reduced()) {
    // 新放的（或刚才藏起来的）滑块：先不带过渡摆到起点——上一次的位置，没有就直接终点
    pill.style.transition = 'none';
    place(reduced() || !prev ? geo : prev);
    void pill.offsetWidth;
    pill.style.transition = '';
  }
  pill._hidden = false;
  pill.style.opacity = '1';
  place(geo);
  if (!prev && pop && canAnimate(pill))
    pill.animate(
      [
        { opacity: 0, transform: `translate(${geo.x}px, ${geo.y}px) scale(0.7)` },
        { opacity: 1, transform: `translate(${geo.x}px, ${geo.y}px)` },
      ],
      { duration: 380, easing: SPRING },
    );
  return pill;
}

/* ── 列表换位置（FLIP） ── */
const ROW_KEYS = '.row[data-id], .section-row[data-sid]';
const keyOf = el => (el.dataset.id ? `r${el.dataset.id}` : `s${el.dataset.sid}`);
const sceneKey = el => `g${el.dataset.owner}`;

function viewBox() {
  const wrap = document.querySelector('#tableWrap');
  return wrap ? wrap.getBoundingClientRect() : null;
}
const inView = (r, box) => r.bottom > box.top - 40 && r.top < box.bottom + 40 && r.height > 0;

export function flipCapture(root) {
  if (!root || reduced()) return null;
  const box = viewBox();
  if (!box) return null;
  const items = new Map();
  for (const el of root.querySelectorAll(ROW_KEYS)) {
    const r = el.getBoundingClientRect();
    if (r.top > box.bottom + 40) break; // 按文档顺序排：已经过了视口底部，后面不用看
    if (inView(r, box)) items.set(keyOf(el), { el, rect: r });
  }
  const scenes = new Set([...root.querySelectorAll('.shared-scene[data-owner]')].map(sceneKey));
  return { items, scenes, box };
}

let ghostLayer = null;
function ghosts(box) {
  if (!ghostLayer || !ghostLayer.isConnected) {
    ghostLayer = document.createElement('div');
    ghostLayer.className = 'mo-ghosts rows';
    ghostLayer.setAttribute('aria-hidden', 'true');
    document.body.append(ghostLayer);
  }
  Object.assign(ghostLayer.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  });
  return ghostLayer;
}

export function flipPlay(root, before) {
  if (!before || !before.items.size || !root || reduced()) return;
  const box = viewBox();
  if (!box) return;
  const after = new Map();
  for (const el of root.querySelectorAll(ROW_KEYS)) {
    const r = el.getBoundingClientRect();
    if (r.top > box.bottom + 40) break;
    if (inView(r, box)) after.set(keyOf(el), { el, rect: r });
  }
  let moved = 0;
  let entered = 0;
  for (const [k, a] of after) {
    const b = before.items.get(k);
    // 挪得太远（比如跳到很远的地方）就当新出现处理，不拖一条长尾巴
    if (b && Math.abs(b.rect.top - a.rect.top) < box.height * 0.8) {
      const dx = b.rect.left - a.rect.left;
      const dy = b.rect.top - a.rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      if (++moved > 60) break;
      a.el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: 440,
        delay: 40,
        easing: SOFT_SPRING,
        fill: 'backwards',
      });
    } else {
      a.el.animate(
        [
          { opacity: 0, transform: 'translateY(10px) scale(0.985)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 340, delay: 140 + Math.min(entered++ * 18, 180), easing: EASE_OUT, fill: 'backwards' },
      );
    }
  }
  // 新组成的共用画面：标签、类型、画面描述依次淡入（里面的句子各自从原位置滑进来）
  for (const sc of root.querySelectorAll('.shared-scene[data-owner]')) {
    if (before.scenes.has(sceneKey(sc))) continue;
    const r = sc.getBoundingClientRect();
    if (!inView(r, box)) continue;
    const parts = sc.querySelectorAll(
      ':scope > .shared-scene-header, :scope > .shared-scene-body > :not(.shared-scene-lines)',
    );
    parts.forEach((p, i) =>
      p.animate(
        [
          { opacity: 0, transform: 'translateX(-8px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 380, delay: 120 + i * 40, easing: SOFT_SPRING, fill: 'backwards' },
      ),
    );
  }
  // 消失的句子：在原位置留个影子淡出（删除、筛掉、合并）
  const gone = [...before.items].filter(([k]) => !after.has(k) && !root.querySelector(sel(k)));
  if (!gone.length || gone.length > 24) return;
  const layer = ghosts(box);
  for (const [, b] of gone) {
    const g = b.el.cloneNode(true);
    g.classList.add('mo-ghost');
    g.removeAttribute('id');
    Object.assign(g.style, {
      left: `${b.rect.left - box.left}px`,
      top: `${b.rect.top - box.top}px`,
      width: `${b.rect.width}px`,
      height: `${b.rect.height}px`,
    });
    layer.append(g);
    g.animate(
      [
        { opacity: 0.9, transform: 'none' },
        { opacity: 0, transform: 'scale(0.98)' },
      ],
      { duration: 150, easing: 'ease-out', fill: 'forwards' },
    ).onfinish = () => g.remove();
  }
}
const sel = k => (k[0] === 'r' ? `.row[data-id="${k.slice(1)}"]` : `.section-row[data-sid="${k.slice(1)}"]`);

/* ── 换句：选中条从上一句滑到这一句 ──
   在 .table 里放一块和选中样式一样的影子，从旧句子的位置滑到新句子；新句子在影子到达前先不显示选中底色。
   位置都按 .table 的坐标算，键盘导航顺带滚动也不会错位。 */
let selGhost = null;
export function glideSelection(from, to) {
  if (selGhost) {
    selGhost.anim?.cancel();
    selGhost.el.remove();
    selGhost.target?.classList.remove('sel-arriving');
    selGhost = null;
  }
  if (!from || !to || from === to || !from.isConnected || !to.isConnected || !canAnimate(to)) return;
  const host = to.closest('.table');
  if (!host || !host.contains(from)) return;
  const hb = host.getBoundingClientRect();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (Math.abs(a.top - b.top) > Math.max(900, innerHeight * 1.2)) return; // 跳得太远就别滑了
  const rel = r => ({
    left: `${r.left - hb.left}px`,
    top: `${r.top - hb.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  const el = document.createElement('div');
  el.className = 'mo-sel-ghost';
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, rel(b));
  host.append(el);
  to.classList.add('sel-arriving');
  const anim = el.animate([rel(a), rel(b)], { duration: 300, easing: SOFT_SPRING });
  selGhost = { el, anim, target: to };
  anim.onfinish = () => {
    to.classList.remove('sel-arriving');
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }).onfinish = () => el.remove();
    if (selGhost?.el === el) selGhost = null;
  };
}

/* ── 数字滚动：旧数字往上滚走，新数字从下面滚上来（变小就反过来） ── */
export function roll(el, text) {
  if (!el) return;
  text = String(text);
  const old = el.dataset.moRoll ?? el.textContent;
  if (old === text) return;
  el.dataset.moRoll = text;
  if (!canAnimate(el) || !el.isConnected || old === '') {
    el.textContent = text;
    return;
  }
  const up = (parseFloat(text.replace(/[^\d.-]/g, '')) || 0) >= (parseFloat(old.replace(/[^\d.-]/g, '')) || 0);
  const box = document.createElement('span');
  box.className = 'mo-roll';
  const inn = document.createElement('span');
  inn.textContent = text;
  const out = document.createElement('span');
  out.textContent = old;
  out.setAttribute('aria-hidden', 'true');
  box.append(inn, out);
  el.replaceChildren(box);
  const d = up ? 1 : -1;
  const o = { duration: 380, easing: SPRING };
  inn.animate(
    [
      { transform: `translateY(${d * 100}%)`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ],
    o,
  );
  out.animate(
    [
      { transform: 'none', opacity: 1 },
      { transform: `translateY(${-d * 100}%)`, opacity: 0 },
    ],
    {
      ...o,
      fill: 'forwards',
    },
  ).onfinish = () => {
    if (el.dataset.moRoll === text && el.firstChild === box) el.textContent = text;
  };
}

/* ── 一次性的小动作 ── */
export function pop(el, { scale = 0.82, duration = 420 } = {}) {
  if (!canAnimate(el)) return;
  el.animate(
    [
      { transform: `scale(${scale})`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ],
    {
      duration,
      easing: SPRING,
    },
  );
}
/* 跳到某句：那一句外圈荡开一圈光，告诉你「是这句」 */
export function flash(el) {
  if (!canAnimate(el)) return;
  const c = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#3b74e8';
  el.animate(
    [
      { boxShadow: `0 0 0 0 color-mix(in srgb, ${c} 45%, transparent)` },
      { boxShadow: `0 0 0 10px color-mix(in srgb, ${c} 0%, transparent)` },
    ],
    { duration: 720, easing: 'ease-out' },
  );
  const bg = getComputedStyle(el).backgroundColor;
  el.animate([{ backgroundColor: `color-mix(in srgb, ${c} 18%, ${bg})` }, { backgroundColor: bg }], {
    duration: 900,
    easing: 'ease-out',
  });
}

/* 元素先播完离场动画再真正收起（done 里做 hidden / 去 class）；不能动画就立刻收 */
export function leave(el, keyframes, opts, done) {
  if (!canAnimate(el) || !el.isConnected || !el.getClientRects().length) return done();
  el.getAnimations().forEach(a => a._moLeave && a.cancel());
  const a = el.animate(keyframes, { fill: 'forwards', ...opts });
  a._moLeave = true;
  a.onfinish = () => {
    done();
    a.cancel();
  };
  return a;
}
export function cancelLeave(el) {
  el?.getAnimations?.().forEach(a => a._moLeave && a.cancel());
}

/* ── 弹窗从按钮里长出来 ──
   记下最近一次点的按钮 / 菜单项；800ms 内打开的弹窗就从它的位置放大出来，关的时候缩回那里。
   没有来源（快捷键打开）时照常用 CSS 的轻微放大。 */
let lastSource = null;
const FULLSCREEN = new Set(['ptMask', 'focusMask', 'previewMask', 'envMask']);

function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}
function morph(from, to) {
  const sx = Math.max(from.width / to.width, 0.12);
  const sy = Math.max(from.height / to.height, 0.12);
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
}

function onModalOpen(mask) {
  const modal = mask.querySelector(':scope > .modal');
  if (!modal) return;
  if (mask.classList.contains('mo-closing')) {
    // 关的动画还没播完就又打开：收掉关的动画
    mask.getAnimations({ subtree: true }).forEach(a => a._moClose && a.cancel());
    mask.classList.remove('mo-closing');
    mask.inert = false;
  }
  const src = lastSource && Date.now() - lastSource.t < 800 ? lastSource.rect : null;
  lastSource = null;
  mask._moSrc = src;
  requestAnimationFrame(() => {
    if (!mask.classList.contains('show')) return;
    const to = rectOf(modal);
    mask._moRect = to;
    if (!src || !canAnimate(modal) || !to.width) return;
    modal.animate(
      [
        { transform: morph(src, to), opacity: 0 },
        { opacity: 1, offset: 0.35 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 460, easing: SOFT_SPRING },
    );
  });
}

/* 关弹窗：先别真藏，挂 mo-closing 让它多留一会儿（不能点、不能聚焦），缩回打开它的按钮（或原地缩小淡出）再藏 */
function onModalClose(mask) {
  const modal = mask.querySelector(':scope > .modal');
  const from = mask._moRect;
  if (!modal || !from || !from.width || reduced()) return;
  mask.classList.add('mo-closing');
  mask.inert = true;
  const now = rectOf(modal);
  const src = mask._moSrc;
  const end = src && now.width ? morph(src, now) : 'scale(0.95) translateY(6px)';
  const a = modal.animate(
    [
      { transform: 'none', opacity: 1 },
      { transform: end, opacity: 0 },
    ],
    { duration: src ? 300 : 200, easing: 'cubic-bezier(0.4, 0, 0.7, 0.2)', fill: 'forwards' },
  );
  const m = mask.animate([{ opacity: 1 }, { opacity: 0 }], { duration: src ? 300 : 200, fill: 'forwards' });
  a._moClose = m._moClose = true;
  a.onfinish = () => {
    if (mask.classList.contains('show')) return;
    mask.classList.remove('mo-closing');
    mask.inert = false;
    a.cancel();
    m.cancel();
  };
}

export function initMotion() {
  document.addEventListener(
    'pointerdown',
    e => {
      const b = e.target.closest?.('button, .pop-item, [role="button"]');
      if (b) lastSource = { rect: rectOf(b), t: Date.now() };
    },
    true,
  );
  const watch = mask => {
    if (FULLSCREEN.has(mask.id) || !mask.querySelector(':scope > .modal')) return;
    let open = mask.classList.contains('show');
    new MutationObserver(() => {
      const now = mask.classList.contains('show');
      if (now === open) return;
      open = now;
      if (now) onModalOpen(mask);
      else onModalClose(mask);
    }).observe(mask, { attributes: true, attributeFilter: ['class'] });
  };
  document.querySelectorAll('.modal-mask').forEach(watch);
}
