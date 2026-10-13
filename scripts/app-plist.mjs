/* Info.plist 里分镜台自己要的几项（打包、本地安装、重打包共用） */
import { execFileSync } from 'node:child_process';

/* 局域网协作（2.0）要在局域网里广播、接受同事连接：macOS 15 起第一次会问「允许查找本地网络上的设备」，
   这里写清楚为什么要这个权限 */
export const LOCAL_NETWORK_USAGE =
  '分镜台用局域网和同事一起改同一个项目：查找同一网络里正在共享的项目，并同步你们的改动。';

export function applyAppPlist(plist) {
  execFileSync('/usr/bin/plutil', [
    '-replace',
    'NSLocalNetworkUsageDescription',
    '-string',
    LOCAL_NETWORK_USAGE,
    plist,
  ]);
}
