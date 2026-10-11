/* 弹窗栈：所有遮罩弹窗（.modal-mask）统一登记，键盘只交给最上面那一层。
   以前每个弹窗各挂一个 capture 键盘监听，谁先注册谁先吃，顺序一变就串台；
   现在由这里统一处理：Esc 关闭最上层、Enter 触发它的确认动作，其余按键不漏到底下的全局快捷键。
   弹窗照旧用 classList 的 show 显隐，这里用 MutationObserver 跟踪开合顺序，调用方不用改。
   1.10 起再管焦点（WAI-ARIA 模态对话框的做法）：
   · 打开时把焦点放进弹窗（危险确认框放在「取消」上，避免顺手一按回车就删掉东西），关掉后焦点回到打开前的地方；
   · Tab / Shift+Tab 只在弹窗里转，不跑到底下的页面；
   · 回车：焦点在某个按钮上就按那个按钮，否则才触发弹窗的确认动作。 */

const registry = new Map(); // id → { el, close, enter, onKey, allowMenu, autoFocus }
const returnFocus = new Map(); // id → 打开前的焦点元素
const FOCUSABLE =
  'button:not([disabled]):not([hidden]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
const focusablesIn = el => [...el.querySelectorAll(FOCUSABLE)].filter(visible);
function onOpen(id) {
  const m = registry.get(id);
  const ae = document.activeElement;
  if (ae && ae !== document.body && !m.el.contains(ae)) returnFocus.set(id, ae);
  if (!m.autoFocus) return;
  // 用 setTimeout 而不是 requestAnimationFrame：窗口在后台（不重绘）时也照样把焦点放好
  setTimeout(() => {
    if (!isShown(id) || m.el.contains(document.activeElement)) return;
    const box = m.el.querySelector('.modal') || m.el;
    const pick =
      box.querySelector('[data-autofocus]') ||
      (box.querySelector('.btn.danger') && box.querySelector('.m-btns .btn:not(.danger):not(.primary)')) ||
      box.querySelector('input:not([type="checkbox"]):not([type="hidden"]), textarea, select') ||
      box.querySelector('.m-btns .btn.primary') ||
      focusablesIn(box)[0];
    pick?.focus({ preventScroll: true });
  }, 0);
}
function onClose(id) {
  const el = returnFocus.get(id);
  returnFocus.delete(id);
  const m = registry.get(id);
  const ae = document.activeElement;
  const inside = ae && m.el.contains(ae);
  if (inside) ae.blur(); // 弹窗藏起来了，焦点不能还留在里面的按钮上（下次打开会被当成「已经在弹窗里」）
  if (el && el.isConnected && (!ae || ae === document.body || inside)) el.focus({ preventScroll: true });
}
const stack = []; // 打开顺序，最后一个在最上层
const isShown = id => {
  const el = registry.get(id)?.el;
  return !!el && el.isConnected && el.classList.contains('show') && el.style.display !== 'none';
};
/* 一个 MutationObserver 管所有弹窗：回调按变化发生的顺序给记录，谁后打开谁在上面 */
const observer = new MutationObserver(records => {
  for (const rec of records) if (registry.has(rec.target.id)) track(rec.target.id);
});
function track(id) {
  const i = stack.indexOf(id);
  if (isShown(id) && i < 0) {
    stack.push(id);
    onOpen(id);
  }
  if (!isShown(id) && i >= 0) {
    stack.splice(i, 1);
    onClose(id);
  }
}
/* 同步校正：观察回调是微任务，刚开 / 刚关的那一瞬间以 DOM 实际状态为准 */
function settle() {
  for (let i = stack.length - 1; i >= 0; i--) if (!isShown(stack[i])) stack.splice(i, 1);
  for (const id of registry.keys()) if (isShown(id) && !stack.includes(id)) stack.push(id);
}

/* autoFocus：打开时自动把焦点放进弹窗（自己处理全部按键的全屏窗口——专注标注、预览、视频审核——关掉这项） */
export function registerModal(id, { close, enter, onKey, allowMenu = [], autoFocus = true } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  registry.set(id, { el, close, enter, onKey, allowMenu, autoFocus });
  const box = el.querySelector('.modal') || el.firstElementChild;
  if (box && !box.hasAttribute('role')) box.setAttribute('role', 'dialog');
  if (box) box.setAttribute('aria-modal', 'true');
  const title = box?.querySelector('h3');
  if (title && !box.hasAttribute('aria-labelledby') && !box.hasAttribute('aria-label')) {
    title.id ||= `${id}-title`;
    box.setAttribute('aria-labelledby', title.id);
  }
  observer.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
  track(id);
}

export const topModal = () => {
  settle();
  return stack[stack.length - 1] || null;
};
export const anyModalOpen = () => !!topModal();
/* 原生菜单动作在弹窗开着时一般不执行（免得在弹窗底下改数据），弹窗可以声明放行哪些 */
export const menuAllowed = type => {
  const id = topModal();
  return !id || type === 'toggle-theme' || registry.get(id).allowMenu.includes(type);
};

const typing = t =>
  t && t.matches && t.matches('textarea, [contenteditable="true"], [contenteditable="plaintext-only"]');

export function initModalKeys() {
  document.addEventListener(
    'keydown',
    e => {
      const id = topModal();
      if (!id) return;
      const m = registry.get(id);
      if (m.onKey && m.onKey(e) === true) {
        e.stopImmediatePropagation();
        return;
      }
      if (e.key === 'Tab') {
        // 焦点只在弹窗里循环
        const box = m.el.querySelector('.modal') || m.el;
        const list = focusablesIn(box);
        if (list.length) {
          const i = list.indexOf(document.activeElement);
          const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : i < 0 || i === list.length - 1 ? 0 : i + 1;
          e.preventDefault();
          list[next].focus();
        }
      } else if (e.key === 'Escape' && m.close) {
        e.preventDefault();
        m.close();
      } else if (
        e.key === 'Enter' &&
        e.target?.tagName === 'BUTTON' &&
        m.el.contains(e.target) &&
        !e.isComposing &&
        e.keyCode !== 229
      ) {
        // 焦点在按钮上：回车就是按这个按钮（焦点在「取消」上不会变成「确认」）
        e.preventDefault();
        e.target.click();
      } else if (e.key === 'Enter' && m.enter && !e.isComposing && e.keyCode !== 229 && !typing(e.target)) {
        e.preventDefault();
        m.enter();
      }
      // 焦点在弹窗里的输入框照常打字（默认行为不拦），只是不再冒泡到全局快捷键
      e.stopImmediatePropagation();
    },
    true,
  );
}
