/* 帮助菜单里的本机异常记录。 */
import * as native from '../platform/native.js';
import { esc, toast } from '../ui/base/dom.js';
import { registerCommand } from '../ui/base/commands.js';
import { registerModal } from '../ui/base/modal.js';

const $ = s => document.querySelector(s);
const kinds = {
  'abnormal-exit': '上次未正常退出',
  'main-exception': '应用异常',
  'main-rejection': '应用任务异常',
  'renderer-crash': '界面进程退出',
  'child-crash': '辅助进程退出',
  'renderer-error': '界面脚本异常',
  'renderer-rejection': '界面任务异常',
};
async function refresh() {
  try {
    const info = await native.crashLogs();
    $('#crashLogList').innerHTML = info.error
      ? `<p>记录暂时无法读写：${esc(info.error)}</p>`
      : info.records.length
        ? info.records
            .map(
              r =>
                `<details class="crash-log-entry"><summary>${esc(new Date(r.time).toLocaleString('zh-CN', { hour12: false }))} · ${esc(kinds[r.kind] || '异常记录')} · ${esc(r.version)}</summary><pre>${esc(r.message)}${r.stack ? '\n\n' + esc(r.stack) : ''}\n\n${esc(r.platform)} / ${esc(r.arch)}</pre></details>`,
            )
            .join('')
        : '<p>暂无崩溃或未处理的异常记录。</p>';
    $('#crashLogClear').disabled = !info.records.length;
  } catch (e) {
    $('#crashLogList').textContent = `无法读取记录：${e.message}`;
  }
}
export function initCrashLogs() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="crashLogMask"><div class="modal wide"><h3>崩溃记录</h3><p>仅保存在本机，最多保留 20 条、256 KB，超出后自动移除最早记录。同一异常一分钟只记一次，连续异常也会限制记录频率。突然退出会在下次启动时补记，强制退出或断电也可能留下这类记录。</p><div id="crashLogList" class="crash-log-list" aria-live="polite"></div><div class="m-btns"><button class="btn" id="crashLogFolder">打开文件夹</button><button class="btn" id="crashLogClear">清空记录</button><button class="btn primary" id="crashLogClose">关闭</button></div></div></div>`,
  );
  const close = () => $('#crashLogMask').classList.remove('show');
  registerModal('crashLogMask', { close });
  registerCommand('crash:open', () => {
    $('#crashLogList').textContent = '读取中…';
    $('#crashLogMask').classList.add('show');
    refresh();
  });
  $('#crashLogClose').onclick = close;
  $('#crashLogMask').onclick = e => {
    if (e.target.id === 'crashLogMask') close();
  };
  $('#crashLogFolder').onclick = async () => {
    try {
      const error = await native.openCrashFolder();
      if (error) toast(`无法打开文件夹：${error}`, null, 'error');
    } catch (e) {
      toast(e.message, null, 'error');
    }
  };
  $('#crashLogClear').onclick = async () => {
    try {
      const result = await native.clearCrashLogs();
      if (!result.ok) toast(`清空失败：${result.error}`, null, 'error');
      await refresh();
    } catch (e) {
      toast(e.message, null, 'error');
    }
  };
}
