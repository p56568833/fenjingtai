/* 主题：浅色 / 深色 / 跟随系统。按钮和 ⌘L 在浅色深色间切换；「跟随系统」在 视图 菜单里 */
import { registerCommand } from './commands.js';
import { reduced } from './motion.js';

const media = matchMedia('(prefers-color-scheme: dark)');
const getPref = () => {
  try {
    return localStorage.getItem('fjz:theme') || 'system';
  } catch {
    return 'system';
  }
};
const setPref = v => {
  try {
    localStorage.setItem('fjz:theme', v);
  } catch {}
};
export const themePref = getPref;

/* 深浅色切换：以太阳 / 月亮按钮为圆心，新颜色像水波一样一圈圈扩散铺满窗口（View Transitions）。
   不支持或开了「减少动态效果」时，退回到全界面统一淡变。 */
function ripple(dark) {
  const b = document.querySelector('#btnTheme')?.getBoundingClientRect();
  const x = b ? b.left + b.width / 2 : innerWidth - 40;
  const y = b ? b.top + b.height / 2 : 30;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const vt = document.startViewTransition(() => apply(dark));
  vt.ready
    .then(() =>
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 620, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
      ),
    )
    .catch(() => {});
}
function switchTo(dark) {
  if (typeof document.startViewTransition === 'function' && !reduced()) ripple(dark);
  else apply(dark, true);
}

function apply(dark, animate = false) {
  if (animate) {
    // 切换时挂 theming 类让全 UI 统一过渡，切完撤掉，避免各元素时长不一「一部分先亮」
    document.body.classList.add('theming');
    clearTimeout(apply._t);
    apply._t = setTimeout(() => document.body.classList.remove('theming'), 360);
  }
  document.body.classList.toggle('dark', dark);
  document.querySelector('#iconSun').style.display = dark ? 'none' : '';
  document.querySelector('#iconMoon').style.display = dark ? '' : 'none';
  const pref = getPref();
  document.querySelector('#btnTheme').title = `浅色 / 深色切换 (⌘L)${pref === 'system' ? ' · 当前跟随系统' : ''}`;
}

export function toggleTheme() {
  const dark = !document.body.classList.contains('dark');
  setPref(dark ? 'dark' : 'light');
  switchTo(dark);
}
export function followSystem() {
  setPref('system');
  switchTo(media.matches);
}

/* 行距：舒适（默认）/ 紧凑。只影响这台电脑上的显示，不进项目数据 */
const getDensity = () => {
  try {
    return localStorage.getItem('fjz:density') === 'compact';
  } catch {
    return false;
  }
};
export function toggleDensity() {
  const on = !document.body.classList.contains('compact');
  document.body.classList.toggle('compact', on);
  try {
    localStorage.setItem('fjz:density', on ? 'compact' : 'comfortable');
  } catch {}
  return on;
}

export function initTheme() {
  document.body.classList.toggle('compact', getDensity());
  const pref = getPref();
  apply(pref === 'dark' || (pref === 'system' && media.matches));
  media.addEventListener('change', e => getPref() === 'system' && apply(e.matches, true));
  document.querySelector('#btnTheme').onclick = toggleTheme;
  registerCommand('theme:toggle', toggleTheme);
  registerCommand('theme:system', followSystem);
  registerCommand('view:density', toggleDensity);
}
