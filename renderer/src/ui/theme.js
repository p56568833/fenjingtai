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
   二次方缓出：立即起步、均匀减速；连点在同一份截图上反向播放，保持圆边连续。 */
let targetDark;
let activeTransition = null;

function steerRipple(current) {
  if (!current.animation) return; // 截图准备期间由 ready 回调处理最新目标。
  current.animation.playbackRate = targetDark === current.dark ? 1 : -1;
  current.animation.play();
}

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
  const current = { vt: null, animation: null, dark: null, skipped: false };
  activeTransition = current;
  const cleanup = () => {
    if (activeTransition !== current) return;
    apply(targetDark); // 反播结束时恢复旧主题；截图存续期间不改新画面，避免闪色。
    current.animation?.cancel(); // fill:both 的 WAAPI 动画不会随伪元素销毁自动释放。
    activeTransition = null;
    root.classList.remove('theme-vt');
    root.style.removeProperty('--theme-origin');
  };
  try {
    current.vt = document.startViewTransition(() => {
      current.dark = targetDark;
      apply(current.dark);
    });
    current.vt.ready
      .then(() => {
        if (current.skipped || activeTransition !== current) return;
        current.animation = root.animate(
          { clipPath: [`circle(0% at ${origin})`, `circle(${radius}% at ${origin})`] },
          {
            duration: 380,
            // x(t)≈t，y(t)≈1-(1-t)²；在合成动画中执行，不用逐帧改 DOM。
            easing: 'cubic-bezier(0.333333, 0.666667, 0.666667, 1)',
            fill: 'both',
            pseudoElement: '::view-transition-new(root)',
          },
        );
        steerRipple(current);
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
    if (reduced() || document.hidden) {
      activeTransition.skipped = true;
      activeTransition.vt.skipTransition();
      apply(dark);
    } else steerRipple(activeTransition);
    return;
  }
  if (document.body.classList.contains('dark') === dark) {
    apply(dark); // 跟随系统时仍更新按钮提示。
    return;
  }
  if (typeof document.startViewTransition === 'function' && !reduced() && !document.hidden) ripple();
  else {
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
  const button = document.querySelector('#btnTheme');
  button.onclick = toggleTheme;
  // 整窗快照在部分 Chromium 版本中会把点击命中到 html。
  // 仅接回主题按钮区域的点击，保证动画中仍能反向，不重复触发普通按钮点击。
  document.documentElement.addEventListener('click', e => {
    if (!activeTransition || e.target !== document.documentElement) return;
    const b = button.getBoundingClientRect();
    if (e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom) toggleTheme();
  });
  registerCommand('theme:toggle', toggleTheme);
  registerCommand('theme:system', followSystem);
  registerCommand('view:density', toggleDensity);
}
