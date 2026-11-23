/* 播放画面字幕显示偏好（CC）：在连播预览、审核内嵌播放器、候选片段播放器之间共享。
   仅双语 / 英配中字项目启用；默认仅显示中文字幕，支持 C 快捷键或按钮循环切换。 */
const CC_KEY = 'fjz:ccMode';
const CC_MODES = ['zh', 'both', 'en', 'off'];
const CC_LABELS = {
  zh: '中字',
  both: '双语',
  en: '英字',
  off: '关字幕',
};
const CC_TITLES = {
  zh: '画面字幕：仅中文字幕（点按或按 C 切换）',
  both: '画面字幕：中英双语字幕（点按或按 C 切换）',
  en: '画面字幕：仅英文字幕（点按或按 C 切换）',
  off: '画面字幕：已关闭（点按或按 C 开启）',
};

const listeners = new Set();
let fallbackMode = 'zh';

export function getCcMode() {
  try {
    const saved = localStorage.getItem(CC_KEY);
    return CC_MODES.includes(saved) ? saved : 'zh';
  } catch {
    return CC_MODES.includes(fallbackMode) ? fallbackMode : 'zh';
  }
}

export function setCcMode(mode) {
  const next = CC_MODES.includes(mode) ? mode : 'zh';
  fallbackMode = next;
  try {
    localStorage.setItem(CC_KEY, next);
  } catch {}
  for (const fn of [...listeners]) {
    try {
      fn(next);
    } catch {}
  }
  return next;
}

export function cycleCcMode() {
  const cur = getCcMode();
  const idx = CC_MODES.indexOf(cur);
  const next = CC_MODES[(idx + 1) % CC_MODES.length];
  return setCcMode(next);
}

export function ccModeLabel(mode = getCcMode()) {
  return CC_LABELS[mode] || CC_LABELS.zh;
}

export function ccModeTitle(mode = getCcMode()) {
  return CC_TITLES[mode] || CC_TITLES.zh;
}

export function onCcModeChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
