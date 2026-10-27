/* 剪映版本状态：主进程的探测结果 → 界面可见状态（纯函数，不碰 DOM，node 测试可直接 import）。
   事实：只在 Mac 剪映专业版 11.6.0 / 11.6.13345 上实测过；11.6.1 / 11.6.99 / 11.7.0 等一律未验证，
   不生成草稿、不登记草稿库。detect() 的 supported 由主进程按完全一致的版本号判定；
   这里再按版本号核对一次，旧主进程 / 缓存把 11.6.x 误报成 supported 时界面也不会显示「已适配」。
   名单与 electron/jianying/platform.js 的 VERIFIED_VERSIONS 保持一致。 */
export const VERIFIED_VERSIONS = Object.freeze(['11.6.0', '11.6.13345']);
const VERIFIED_TEXT = VERIFIED_VERSIONS.join(' / ');

export function isVerifiedVersion(version) {
  return VERIFIED_VERSIONS.includes(String(version ?? ''));
}

/* 版本是否可用于导出：主进程标记 supported，且版本号在实测名单里。
   renderTarget / goBlocker / tryQuickStart 共用这一条判断，保证提示文案与放行条件同源。 */
export function isVersionSupported(detection) {
  return !!detection?.supported && isVerifiedVersion(detection?.version);
}

/* 目标剪映的可见状态：{ level: 'pending' | 'ok' | 'warn', title, text }。
   title 是加粗的主提示（「已适配」只可能出现在实测名单里的版本），text 是补充说明。 */
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
      title: `${version} · 未验证版本`,
      text: `仅验证过 Mac 剪映专业版 ${VERIFIED_TEXT}；这个版本不生成草稿、不登记草稿库，避免做出来的草稿打不开`,
    };
  }
  if (!detection.ok) {
    return { level: 'warn', title: `${version} · 剪映草稿库暂时不可用`, text: '可以改用「保存草稿文件夹」生成草稿' };
  }
  return {
    level: 'ok',
    title: `${version} · 已适配`,
    text: detection.running ? '剪映正在运行' : '草稿会出现在剪映「本地草稿」',
  };
}
