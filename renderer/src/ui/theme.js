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

/* 比例坐标避开高分屏 / 界面缩放下 View Transition 的像素裁剪坐标偏移。
   新画面从 CSS 的零半径开始，ready 后直接启动，不再暂停后等两帧。
   连续点击只更新最终目标并结束当前动画，避免反复截取整窗和旧回调覆盖新主题。 */
let targetDark;
let activeTransition = null;
let rippleFinishedAt = -Infinity;

function ripple() {
  const b = document.querySelector('#btnTheme')?.getBoundingClientRect();
  const x = b ? b.left + b.width / 2 : innerWidth - 40;
  const y = b ? b.top + b.height / 2 : 30;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  // circle 的百分比半径以视口对角线 / √2 为基准，留少量余量覆盖边角。
  const radius = (r / (Math.hypot(innerWidth, innerHeight) / Math.SQRT2)) * 100 + 1;
  const origin = `${(x / innerWidth) * 100}% ${(y / innerHeight) * 100}%`;
  const root = document.documentElement;
  root.style.setProperty('--theme-origin', origin);
  root.classList.add('theme-vt');
  const current = { vt: null, animation: null, skipped: false };
  activeTransition = current;
  const cleanup = () => {
    if (activeTransition !== current) return;
    current.animation?.cancel(); // fill:both 的 WAAPI 动画不会随伪元素销毁自动释放。
    activeTransition = null;
    rippleFinishedAt = performance.now();
    root.classList.remove('theme-vt');
    root.style.removeProperty('--theme-origin');
  };
  try {
    current.vt = document.startViewTransition(() => apply(targetDark));
    current.vt.ready
      .then(() => {
        if (current.skipped || activeTransition !== current) return;
        current.animation = root.animate(
          { clipPath: [`circle(0% at ${origin})`, `circle(${radius}% at ${origin})`] },
          {
            duration: 420,
            easing: 'cubic-bezier(0.25, 0, 0.2, 1)',
            fill: 'both',
            pseudoElement: '::view-transition-new(root)',
          },
        );
      })
      .catch(() => current.vt.skipTransition());
    current.vt.finished.then(cleanup, cleanup);
  } catch {
    apply(targetDark);
    cleanup();
  }
}
function switchTo(dark) {
  targetDark = dark;
  if (activeTransition) {
    activeTransition.skipped = true;
    activeTransition.vt.skipTransition();
    apply(dark);
    return;
  }
  if (document.body.classList.contains('dark') === dark) {
    apply(dark); // 跟随系统时仍更新按钮提示。
    return;
  }
  if (
    typeof document.startViewTransition === 'function' &&
    !reduced() &&
    !document.hidden &&
    performance.now() - rippleFinishedAt >= 200
  )
    ripple();
  else {
    // 动画刚结束的快速连点也直接响应，给整窗截图资源留出释放时间。
    const root = document.documentElement;
    root.classList.add('theme-vt');
    apply(dark);
    // 无动画 / 减少动态效果时也不让各元素自行慢慢变色。
    requestAnimationFrame(() => {
      if (!activeTransition) root.classList.remove('theme-vt');
    });
  }
}

function apply(dark) {
  document.body.classList.toggle('dark', dark);
  document.querySelector('#iconSun').style.display = dark ? 'none' : '';
  document.querySelector('#iconMoon').style.display = dark ? '' : 'none';
  const pref = getPref();
  document.querySelector('#btnTheme').title = `浅色 / 深色切换 (⌘L)${pref === 'system' ? ' · 当前跟随系统' : ''}`;
}

export function toggleTheme() {
  const dark = !(targetDark ?? document.body.classList.contains('dark'));
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
  targetDark = pref === 'dark' || (pref === 'system' && media.matches);
  apply(targetDark);
  media.addEventListener('change', e => getPref() === 'system' && switchTo(e.matches));
  document.querySelector('#btnTheme').onclick = toggleTheme;
  registerCommand('theme:toggle', toggleTheme);
  registerCommand('theme:system', followSystem);
  registerCommand('view:density', toggleDensity);
}
