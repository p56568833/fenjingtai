/* 打包白名单（package.mjs 用；单独成文件方便测试） */
/* packager 传入以 / 开头、相对项目根的路径；返回 true = 不打包 */
export function shouldIgnore(p) {
  if (!p) return false;
  if (p === '/package.json') return false;
  if (!/^\/(electron|renderer)(\/|$)/.test(p)) return true;
  // 自测代码（renderer/src/test/）只在开发环境用，发布版不接受 --selftest，不进安装包
  return /(^|\/)\.DS_Store$/.test(p) || /selftest\.js$/.test(p) || /^\/renderer\/src\/test(\/|$)/.test(p);
}
