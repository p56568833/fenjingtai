/* 只供隔离崩溃回归使用，不进入安装应用；异常来自应用同源脚本。 */
export function triggerErrors() {
  setTimeout(() => {
    throw new Error('界面异常真实测试');
  }, 0);
  setTimeout(() => {
    Promise.reject(new Error('界面任务真实测试'));
  }, 10);
}
