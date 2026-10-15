/* 分镜台 · 主进程入口：单实例、窗口与菜单、IPC 安全护栏、数据落盘通道；其余通道按功能分在 ipc-*.js */
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createCrashLog, monitorCrashes } = require('./crash-log');

/* 自测 / 预览只在开发环境（未打包）可用：发布版不接受 --selftest，不会开远程调试端口 */
const IS_SELFTEST = !app.isPackaged && process.argv.includes('--selftest');
if (!app.isPackaged && process.argv.includes('--preview'))
  app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), '分镜台预览-')));
if (IS_SELFTEST) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.FJT_DEBUG_PORT || '9222'); // 协作测试同时起两个实例，各用一个端口
  // 自测跑在一次性沙箱数据目录里：不碰真实数据，也不和正在运行的正式实例抢单实例锁
  // （必须在 requestSingleInstanceLock 之前设置，锁就是按 userData 路径算的）
  app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), '分镜台自测-')));
}

// 只有取得单实例锁的进程才能读写运行标记，重复打开不会误记崩溃。
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
const crashLog = createCrashLog({ dir: path.join(app.getPath('userData'), '崩溃记录'), version: app.getVersion() });
if (ownsInstance) {
  crashLog.start();
  monitorCrashes({ app, log: crashLog });
}
const { createStore } = require('./data-store');
const { buildMenu } = require('./menu');
const { createMainWindow } = require('./window');
const { registerFileIpc } = require('./ipc-files');
const { registerVideoIpc } = require('./ipc-video');
const { registerPackIpc } = require('./ipc-pack');
const { registerUpdateIpc } = require('./ipc-update');
const { registerCollabIpc } = require('./ipc-collab');

const DATA_DIR = () => path.join(app.getPath('userData'), '数据');
const INDEX_FILE = path.join(__dirname, '..', 'renderer', 'index.html');
/* 这个地址是不是应用自己的界面页（精确比对文件路径，不是「包含某段字符串」） */
function isAppPage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && path.resolve(fileURLToPath(u)) === path.resolve(INDEX_FILE);
  } catch {
    return false;
  }
}
const store = createStore(DATA_DIR);

let mainWindow = null;
let quitting = false;
const win = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0]);

function makeMainWindow() {
  const w = createMainWindow({ indexFile: INDEX_FILE, isAppPage, isSelftest: IS_SELFTEST });
  w.on('close', e => {
    if (process.platform !== 'darwin' || quitting) return;
    // 红色关闭按钮只收起界面：保留当前项目、编辑位置、协作连接和后台任务。
    e.preventDefault();
    w.hide();
  });
  w.webContents.on('will-prevent-unload', () => {
    // 保存失败会取消退出；恢复普通关窗行为，并显示窗口里的错误提示。
    quitting = false;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });
  return w;
}

function showMainWindow() {
  if (!app.isReady() || quitting) return;
  const w = win();
  if (w) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  } else mainWindow = makeMainWindow();
}

app.on('second-instance', showMainWindow);
app.on('before-quit', () => {
  quitting = true;
});

/* ── IPC：只接受应用自己界面页发来的请求 ── */
const trusted = e => isAppPage(e.senderFrame?.url || '');
const handle = (channel, fn) =>
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('拒绝来自未知页面的请求');
    return fn(e, ...args);
  });
const onSync = (channel, fn) =>
  ipcMain.on(channel, (e, ...args) => {
    if (!trusted(e)) {
      e.returnValue = null;
      return;
    }
    fn(e, ...args);
  });

/* ── IPC：数据 ── */
onSync('data:load-sync', e => {
  e.returnValue = store.load();
}); // 同步版给启动用，见 preload
onSync('data:status-sync', e => {
  store.load();
  e.returnValue = store.info();
});
handle('data:load', () => store.load());
handle('data:save', (_e, patch) => store.savePatch(patch));
/* 渲染进程 beforeunload 时的同步冲刷：invoke 是异步的，进程退出前来不及完成 */
onSync('data:save-sync', (e, patch) => {
  try {
    e.returnValue = store.savePatch(patch);
  } catch (error) {
    console.error('关闭前保存失败', error); // 渲染进程据 false 拦下关闭并提示
    e.returnValue = false;
  }
});
handle('data:backups', () => store.listBackups());
handle('data:restore-backup', (_e, f) => store.readBackup(f));
handle('data:open-folder', () => shell.openPath(DATA_DIR()));
handle('crash:list', () => crashLog.list());
handle('crash:clear', () => crashLog.clear());
handle('crash:open-folder', () => shell.openPath(path.join(app.getPath('userData'), '崩溃记录')));
onSync('crash:report', (e, report) => {
  // 字段与大小在主进程再限定；不记录项目内容或整个页面。
  if (report && ['renderer-error', 'renderer-rejection'].includes(report.kind))
    crashLog.record(report.kind, {
      message: typeof report.message === 'string' ? report.message : '',
      stack: typeof report.stack === 'string' ? report.stack : '',
    });
  e.returnValue = true;
});

const deps = { handle, win };
registerFileIpc(deps);
registerVideoIpc(deps);
registerPackIpc(deps);
registerCollabIpc({ ...deps, app });
const { cleanStaleUpdates } = registerUpdateIpc({ handle, isSelftest: IS_SELFTEST });

app.whenReady().then(() => {
  buildMenu({ win, dataDir: DATA_DIR });
  cleanStaleUpdates();
  mainWindow = makeMainWindow();
  app.on('activate', showMainWindow);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* 自测专用：测试素材目录与能力标记（正式运行返回 null） */
onSync('selftest:fixtures', e => {
  const dir = IS_SELFTEST ? process.env.FJT_FIXTURE_DIR || null : null;
  e.returnValue = dir
    ? { dir, hasVideo: fs.existsSync(path.join(dir, '样片.mp4')), hasVoice: fs.existsSync(path.join(dir, '口播.wav')) }
    : null;
});
