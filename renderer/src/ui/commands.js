/* 命令表：菜单（原生 / 弹出）、快捷键、按钮都只说「执行哪个命令」，由实现的模块自己登记。
   调用方不需要 import 实现模块，模块之间不互相引用。 */
const registry = new Map();

export function registerCommand(name, fn) {
  registry.set(name, fn);
}
export function runCommand(name, ...args) {
  const fn = registry.get(name);
  if (!fn) return false;
  fn(...args);
  return true;
}
export const hasCommand = name => registry.has(name);
