/* 主题：浅色 / 深色 / 跟随系统。按钮和 ⌘L 在浅色深色间切换；「跟随系统」在 视图 菜单里 */
import { registerCommand } from './commands.js';

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
  apply(dark, true);
}
export function followSystem() {
  setPref('system');
  apply(media.matches, true);
}

export function initTheme() {
  const pref = getPref();
  apply(pref === 'dark' || (pref === 'system' && media.matches));
  media.addEventListener('change', e => getPref() === 'system' && apply(e.matches, true));
  document.querySelector('#btnTheme').onclick = toggleTheme;
  registerCommand('theme:toggle', toggleTheme);
  registerCommand('theme:system', followSystem);
}
