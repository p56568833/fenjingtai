/* ⌘Z / ⇧⌘Z 的分流：键盘和原生菜单都会发来撤销 / 重做
   - 同一次按键两边各来一遍时只执行一次
   - 焦点在输入框 / 可编辑文字里时，撤销的是文字输入本身（交给浏览器），不是整个项目 */
import { undo, redo } from '../app/undo.js';

let last = { kind: null, source: null, at: 0 };
export function historyCommand(kind, source = 'key') {
  const now = performance.now();
  if (last.kind === kind && last.source !== source && now - last.at < 120) return;
  last = { kind, source, at: now };
  const ae = document.activeElement;
  const editing = ae && (ae.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(ae.tagName) && !ae.matches('.row-select')));
  if (editing) {
    document.execCommand(kind);
    return;
  }
  if (kind === 'redo') redo();
  else undo();
}
