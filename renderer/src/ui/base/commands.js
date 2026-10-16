/* 命令表：菜单（原生 / 弹出）、快捷键、按钮都只说「执行哪个命令」，由实现的模块自己登记。
   调用方不需要 import 实现模块，模块之间不互相引用。 */
const registry = new Map();

export function registerCommand(name, fn) {
  if (registry.has(name)) throw new Error(`命令重复登记：${name}`);
  if (typeof fn !== 'function') throw new TypeError(`命令缺少实现：${name}`);
  registry.set(name, fn);
}
export function runCommand(name, ...args) {
  const fn = registry.get(name);
  if (!fn) throw new Error(`命令未登记：${name}`);
  fn(...args);
  return true;
}
