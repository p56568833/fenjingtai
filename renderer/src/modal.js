/* 弹窗栈：所有遮罩弹窗（.modal-mask）统一登记，键盘只交给最上面那一层。
   以前每个弹窗各挂一个 capture 键盘监听，谁先注册谁先吃，顺序一变就串台；
   现在由这里统一处理：Esc 关闭最上层、Enter 触发它的确认动作，其余按键不漏到底下的全局快捷键。
   弹窗照旧用 classList 的 show 显隐，这里用 MutationObserver 跟踪开合顺序，调用方不用改。 */

const registry = new Map(); // id → { el, close, enter, onKey, allowMenu }
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
  if (isShown(id) && i < 0) stack.push(id);
  if (!isShown(id) && i >= 0) stack.splice(i, 1);
}
/* 同步校正：观察回调是微任务，刚开 / 刚关的那一瞬间以 DOM 实际状态为准 */
function settle() {
  for (let i = stack.length - 1; i >= 0; i--) if (!isShown(stack[i])) stack.splice(i, 1);
  for (const id of registry.keys()) if (isShown(id) && !stack.includes(id)) stack.push(id);
}

export function registerModal(id, { close, enter, onKey, allowMenu = [] } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  registry.set(id, { el, close, enter, onKey, allowMenu });
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

const typing = t => t && t.matches && t.matches('textarea, [contenteditable="true"]');

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
      if (e.key === 'Escape' && m.close) {
        e.preventDefault();
        m.close();
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
