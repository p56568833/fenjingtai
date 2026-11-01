/* 剪映版本状态：主进程的探测结果 → 界面可见状态（纯函数，不碰 DOM，node 测试可直接 import）。
   规则与 electron/jianying/platform.js 一致：11.6.0 及以上都能导出（草稿按 11.6.0 格式生成，新版剪映能打开），
   更旧或版本号认不出的不生成、不登记。VERIFIED_VERSIONS 是真机实测过的版本，只决定显示「已适配」还是「可以导出」。
   detect() 的 supported 由主进程判定；这里再按版本号核对一次，旧主进程 / 缓存误报 supported 时界面也不会放行。 */
export const MIN_VERSION = '11.6.0';
export const VERIFIED_VERSIONS = Object.freeze(['11.6.0', '11.6.13345', '11.6.13370']);

export function isVerifiedVersion(version) {
  return VERIFIED_VERSIONS.includes(String(version ?? ''));
}

const versionParts = version =>
  /^\d+(\.\d+){2,}$/.test(String(version ?? '')) ? String(version).split('.').map(Number) : null;

/* 版本号能否用于导出：纯数字点分版本且不低于 MIN_VERSION */
export function isSupportedVersion(version) {
  const parts = versionParts(version);
  if (!parts) return false;
  const min = versionParts(MIN_VERSION);
  for (let i = 0; i < Math.max(parts.length, min.length); i++) {
    const diff = (parts[i] || 0) - (min[i] || 0);
    if (diff) return diff > 0;
  }
  return true;
}

/* 不能导出时给用户看的原因：版本太旧 / 版本号认不出 */
export function unsupportedVersionText(version) {
  return versionParts(version)
    ? `需要 Mac 剪映专业版 ${MIN_VERSION} 或更新版本，请先更新剪映`
    : '没能识别剪映的版本号，无法确认能打开草稿，暂不生成草稿';
}

/* 版本是否可用于导出：主进程标记 supported，且版本号在实测名单里。
   renderTarget / goBlocker 共用这一条判断，保证提示文案与放行条件同源。 */
export function isVersionSupported(detection) {
  return !!detection?.supported && isSupportedVersion(detection?.version);
}

/* 目标剪映的可见状态：{ level: 'pending' | 'ok' | 'warn', title, text }。
   title 是加粗的主提示（「已适配」只给实测名单里的版本，其余能导出的显示「可以导出」），text 是补充说明。 */
export function targetStatusOf(detection) {
  if (!detection) return { level: 'pending', title: '正在检测本机剪映…', text: '' };
  const version = detection.version ? `剪映 ${detection.version}` : 'Mac 版剪映专业版';
  if (detection.unavailable) {
    return { level: 'warn', title: '暂不可用', text: detection.error || '这个版本还不支持导出到剪映' };
  }
  const appFound = detection.ok || !!detection.version || !!detection.appPath;
  if (!appFound) {
    return { level: 'warn', title: '没找到 Mac 版剪映专业版', text: detection.error || '请先安装剪映再试' };
  }
  if (!isVersionSupported(detection)) {
    return {
      level: 'warn',
      title: versionParts(detection.version) ? `${version} · 版本太旧` : `${version} · 版本号无法识别`,
      text: unsupportedVersionText(detection.version),
    };
  }
  if (!detection.ok) {
    return { level: 'warn', title: `${version} · 剪映草稿库暂时不可用`, text: '可以改用「保存草稿文件夹」生成草稿' };
  }
  const title = `${version} · ${isVerifiedVersion(detection.version) ? '已适配' : '可以导出'}`;
  /* 剪映运行时导出不改草稿列表：事先讲清后果，免得导出后在剪映里找不到 */
  if (detection.running)
    return { level: 'warn', title, text: '剪映正在运行：先退出剪映再导出，草稿才会直接出现在「本地草稿」' };
  return { level: 'ok', title, text: '草稿会出现在剪映「本地草稿」' };
}
