/* 隔离 Electron 实例：验证窗口隐藏 / 恢复 / 退出，以及真实异常与崩溃记录。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const child = spawn(path.join(root, 'node_modules/.bin/electron'), ['--inspect=127.0.0.1:9241', '.', '--selftest'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, FJT_DEBUG_PORT: '9240', FJT_SELFTEST_MODE: 'e2e' },
});
let browser, socket, dataDir;
let output = '';
child.stderr.on('data', data => {
  output = (output + data).slice(-12000);
});
async function json(url) {
  for (let i = 0; i < 80; i++) {
    try {
      return await (await fetch(url)).json();
    } catch {
      await sleep(150);
    }
  }
  throw new Error('测试实例未能启动');
}
let sequence = 0;
const pending = new Map();
function evaluate(expression) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('主进程检查超时'));
    }, 10000);
    pending.set(id, reply => {
      clearTimeout(timeout);
      if (reply.error || reply.result?.exceptionDetails) reject(new Error(JSON.stringify(reply)));
      else resolve(reply.result.result.value);
    });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
}
try {
  const inspect = await json('http://127.0.0.1:9241/json/list');
  socket = new WebSocket(inspect[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.onmessage = event => {
    const reply = JSON.parse(event.data);
    if (pending.has(reply.id)) {
      pending.get(reply.id)(reply);
      pending.delete(reply.id);
    }
  };
  dataDir = await evaluate("process.mainModule.require('electron').app.getPath('userData')");
  await json('http://127.0.0.1:9240/json/version');
  browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9240', defaultViewport: null });
  let page = (await browser.pages()).find(page => page.url().includes('renderer/index.html'));
  await page.waitForSelector('#crashLogMask');
  if (process.platform === 'darwin') {
    const windowInfo = () =>
      evaluate(`(() => {
        const w = process.mainModule.require('electron').BrowserWindow.getAllWindows()[0];
        return w ? { id: w.id, visible: w.isVisible(), minimized: w.isMinimized() } : null;
      })()`);
    const windowId = (await windowInfo()).id;
    const host = await page.evaluate(() =>
      window.native.collabHostStart({ hostId: 'window-lifecycle-test', name: '窗口驻留自测', shares: [] }),
    );
    assert.equal(host.ok, true);
    const checkHost = () =>
      new Promise((resolve, reject) => {
        const client = net.connect({ host: '127.0.0.1', port: host.port });
        client.setTimeout(2000, () => client.destroy(new Error('协作连接检查超时')));
        client.once('error', reject);
        client.once('connect', () => {
          client.destroy();
          resolve();
        });
      });
    const fixture = await page.evaluate(async () => {
      const storage = await import('./src/app/storage.js');
      const { parseAny } = await import('./src/core/parse.js');
      const { state } = await import('./src/app/state.js');
      const { runCommand } = await import('./src/ui/base/commands.js');
      storage.createProject('后台驻留回归', parseAny('保留第一句。保留第二句。'));
      const line = state.rows.filter(row => row.kind === 'line')[1];
      runCommand('nav:jump', line.id);
      window.__windowFixture = { beforeUnload: 0, backgroundDone: false, blockQuit: false };
      window.addEventListener('beforeunload', event => {
        window.__windowFixture.beforeUnload++;
        if (window.__windowFixture.blockQuit) {
          event.preventDefault();
          event.returnValue = '';
        }
      });
      return { projectId: state.projectId, lineId: line.id };
    });
    await evaluate("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close(); true");
    assert.deepEqual(await windowInfo(), { id: windowId, visible: false, minimized: false });
    assert.equal(await page.evaluate(() => window.__windowFixture.beforeUnload), 0, '点叉不卸载当前页面');
    // 窗口隐藏后，界面进程仍能接收后台结果、保存数据。
    await page.evaluate(() => {
      setTimeout(async () => {
        const { viewState } = await import('./src/app/view-state.js');
        const { setSentenceText } = await import('./src/app/actions.js');
        setSentenceText(viewState.sel, '隐藏窗口后完成的改动。');
        window.__windowFixture.backgroundDone = true;
      }, 100);
    });
    await page.waitForFunction(() => window.__windowFixture.backgroundDone);
    await page.waitForFunction(
      ({ projectId, lineId }) =>
        window.native.loadData().projects[projectId].rows.find(row => row.id === lineId).text ===
        '隐藏窗口后完成的改动。',
      {},
      fixture,
    );
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, '数据', '分镜台数据.json'), 'utf8'));
    assert.equal(
      saved.projects[fixture.projectId].rows.find(row => row.id === fixture.lineId).text,
      '隐藏窗口后完成的改动。',
    );
    await checkHost();
    await evaluate("process.mainModule.require('electron').app.emit('activate'); true");
    assert.equal((await windowInfo()).visible, true, 'Dock 激活恢复窗口');
    assert.equal((await windowInfo()).id, windowId, '恢复使用同一个窗口');
    assert.deepEqual(
      await page.evaluate(async () => {
        const { state } = await import('./src/app/state.js');
        const { viewState } = await import('./src/app/view-state.js');
        return { projectId: state.projectId, lineId: viewState.sel };
      }),
      fixture,
      '恢复后保持项目和选中句子',
    );
    await evaluate("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close(); true");
    await evaluate("process.mainModule.require('electron').app.emit('second-instance'); true");
    assert.equal((await windowInfo()).visible, true, '重复打开应用也恢复窗口');
    // 页面拒绝退出时仍保留窗口，下一次点叉继续正常隐藏。
    await page.evaluate(() => (window.__windowFixture.blockQuit = true));
    await evaluate("setTimeout(()=>process.mainModule.require('electron').app.quit(),100); true");
    await page.waitForFunction(() => window.__windowFixture.beforeUnload > 0);
    await sleep(150);
    assert.equal((await windowInfo()).visible, true, '取消退出后显示窗口');
    await checkHost();
    await page.evaluate(() => (window.__windowFixture.blockQuit = false));
    await evaluate("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close(); true");
    assert.equal((await windowInfo()).visible, false, '取消退出后点叉仍只隐藏');
    assert.equal(await page.evaluate(() => window.__windowFixture.beforeUnload), 1);
    assert.ok(fs.existsSync(path.join(dataDir, '崩溃记录/运行状态.json')), '后台驻留或取消退出不清运行标记');
    await evaluate("process.mainModule.require('electron').app.emit('activate'); true");
    await page.evaluate(() => window.native.collabHostStop());
    console.log(
      '窗口驻留检查通过：点叉隐藏、后台改动保存、Dock 恢复、重复打开恢复、保留项目与句子、取消退出后正常隐藏',
    );
  }
  await page.evaluate(() => window.native.clearCrashLogs());
  await page.evaluate(async () => {
    const { triggerErrors } = await import('./src/test/crash-fixture.js');
    triggerErrors();
  });
  await sleep(300);
  let info = await page.evaluate(() => window.native.crashLogs());
  assert.ok(
    info.records.some(r => r.kind === 'renderer-error' && r.message.includes('界面异常真实测试')),
    '页面脚本异常应经预加载监听落盘: ' + JSON.stringify(info) + output,
  );
  assert.ok(
    info.records.some(r => r.kind === 'renderer-rejection' && r.message.includes('界面任务真实测试')),
    '页面未处理任务异常应落盘',
  );
  await evaluate(
    "process.mainModule.require('electron').Menu.getApplicationMenu().items.find(i=>i.label==='帮助').submenu.items.find(i=>i.label==='崩溃记录…').click()",
  );
  await page.waitForSelector('#crashLogMask.show .crash-log-entry');
  assert.equal((await page.$$('.crash-log-entry')).length, 2);
  await page.click('.crash-log-entry summary');
  assert.ok(await page.$eval('.crash-log-entry pre', el => el.textContent.includes('真实测试')));
  await sleep(350); // 等弹窗动效结束，再检查稳定的窗口画面。
  await page.screenshot({ path: '/private/tmp/fenjingtai-203-crash-window.png' });
  await page.click('#crashLogClear');
  await page.waitForFunction(() => document.querySelector('#crashLogList').textContent.includes('暂无'));
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#crashLogMask', el => el.classList.contains('show')), false);
  // 只崩溃隔离实例的界面进程，主进程留下退出原因后重新加载。
  await evaluate(
    "{ const wc=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents; wc.once('render-process-gone',()=>setTimeout(()=>wc.reload(),200)); wc.forcefullyCrashRenderer(); }",
  );
  await sleep(1000);
  page = (await browser.pages()).find(page => page.url().includes('renderer/index.html'));
  await page.waitForSelector('#crashLogMask');
  info = await page.evaluate(() => window.native.crashLogs());
  assert.ok(
    info.records.some(r => r.kind === 'renderer-crash'),
    '真实界面进程崩溃应有记录',
  );
  const logFile = path.join(dataDir, '崩溃记录/崩溃记录.json');
  assert.ok(fs.statSync(logFile).size <= 256 * 1024);
  const exitFixture = await page.evaluate(async () => {
    const { state } = await import('./src/app/state.js');
    const { setSentenceText } = await import('./src/app/actions.js');
    const line = state.rows.find(row => row.kind === 'line');
    setSentenceText(line.id, '彻底退出前保存的改动。');
    return { projectId: state.projectId, lineId: line.id };
  });
  if (process.platform === 'darwin')
    await evaluate("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close(); true");
  await browser.disconnect();
  browser = null;
  await evaluate("setTimeout(()=>process.mainModule.require('electron').app.quit(),100); true");
  socket.close(); // 主进程调试器保持连接会阻止 Node 完成退出。
  const marker = path.join(dataDir, '崩溃记录/运行状态.json');
  for (let i = 0; i < 50 && fs.existsSync(marker); i++) await sleep(100);
  assert.equal(fs.existsSync(path.join(dataDir, '崩溃记录/运行状态.json')), false, '真正关闭后清掉运行标记');
  const savedOnExit = JSON.parse(fs.readFileSync(path.join(dataDir, '数据', '分镜台数据.json'), 'utf8'));
  assert.equal(
    savedOnExit.projects[exitFixture.projectId].rows.find(row => row.id === exitFixture.lineId).text,
    '彻底退出前保存的改动。',
    '窗口隐藏时主动退出也会保存待落盘改动',
  );
  console.log('崩溃记录端到端通过：脚本异常、任务异常、菜单查看、展开、清空、Esc、真实界面崩溃、正常退出');
} finally {
  if (browser) await browser.disconnect();
  socket?.close();
  try {
    process.kill(-child.pid, 'SIGKILL'); // 清掉仅供本次检查的隔离调试运行时。
  } catch {}
  if (dataDir && path.basename(dataDir).startsWith('分镜台自测-')) fs.rmSync(dataDir, { recursive: true, force: true });
}
