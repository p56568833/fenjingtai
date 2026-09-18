/* 分镜台 · 主进程：窗口 / 原生菜单 / 数据落盘（原子写 + 自动备份） */
const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const IS_SELFTEST = process.argv.includes('--selftest');
if (IS_SELFTEST) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
  // 自测跑在一次性沙箱数据目录里：不碰真实数据，也不和正在运行的正式实例抢单实例锁
  // （必须在 requestSingleInstanceLock 之前设置，锁就是按 userData 路径算的）
  app.setPath('userData', path.join(app.getPath('temp'), '分镜台自测'));
}

const DATA_DIR = () => path.join(app.getPath('userData'), '数据');
const LIB_FILE = () => path.join(DATA_DIR(), '分镜台数据.json');
const BACKUP_DIR = () => path.join(DATA_DIR(), '自动备份');
const BACKUP_INTERVAL = 30 * 60 * 1000; // 距上次备份超过 30 分钟，写盘时顺带滚一份
let lastBackupAt = 0;

/* 原子写：先写临时文件再改名，断电也不会写坏数据文件 */
function writeAtomic(file, content){
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}
function maybeBackup(){
  const now = Date.now();
  if (now - lastBackupAt < BACKUP_INTERVAL) return;
  lastBackupAt = now;
  try{
    if (!fs.existsSync(LIB_FILE())) return;
    fs.mkdirSync(BACKUP_DIR(), { recursive: true });
    const stamp = new Date(now).toLocaleString('zh-CN', { hour12: false }).replace(/[/:]/g, '-');
    fs.copyFileSync(LIB_FILE(), path.join(BACKUP_DIR(), `备份-${stamp}.json`));
    const keep = fs.readdirSync(BACKUP_DIR())
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR(), f)).mtimeMs }))
      .sort((a, b) => b.t - a.t).slice(0, 10);
    for (const { f } of fs.readdirSync(BACKUP_DIR()).map(f => ({ f })).filter(x => !keep.some(k => k.f === x.f)))
      fs.unlinkSync(path.join(BACKUP_DIR(), f));
  }catch(e){ /* 备份失败不阻塞保存 */ }
}

const win = () => BrowserWindow.getAllWindows()[0];

function buildMenu(){
  const send = type => () => win()?.webContents.send('menu-action', { type });
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '文件', submenu: [
      { label: '新建项目', accelerator: 'CmdOrCtrl+N', click: send('new-project') },
      { label: '导入稿子…', accelerator: 'CmdOrCtrl+O', click: send('import') },
      { type: 'separator' },
      { label: '导出', submenu: [
        { label: '带批注的 MD', click: send('export:md') },
        { label: '素材清单 MD', click: send('export:list') },
        { label: 'CSV 表格', click: send('export:csv') },
        { label: '项目 JSON', click: send('export:json') },
      ]},
      { type: 'separator' },
      { label: '打开数据文件夹', click: () => shell.openPath(DATA_DIR()) },
    ]},
    { label: '编辑', submenu: [
      { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
      { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
    ]},
    { label: '视图', submenu: [
      { label: '切换视图（表格 / 勾选）', accelerator: 'CmdOrCtrl+T', click: send('toggle-view') },
      { label: '浅色 / 深色主题', accelerator: 'CmdOrCtrl+L', click: send('toggle-theme') },
      { role: 'reload', label: '刷新' },
    ]},
    { label: '窗口', role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(){
  const w = new BrowserWindow({
    width: 1440, height: 940, minWidth: 980, minHeight: 620,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 22 },
    backgroundColor: '#f3f5f9',
    show: false,                        // 渲染就绪（含主题类）后才显示，启动不闪白；自测窗口保持隐藏不弹到用户面前
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, spellcheck: false,
      ...(IS_SELFTEST ? { backgroundThrottling: false } : {}),   // 隐藏窗口里 JS 计时不被节流，自测的 sleep 才准
    },
  });
  if(!IS_SELFTEST) w.once('ready-to-show', () => w.show());
  w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), IS_SELFTEST ? { query: { selftest: '1' } } : {});
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { const w = win(); if (w) { w.isMinimized() && w.restore(); w.focus(); } });

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => app.quit());

/* ── IPC：数据 ── */
const readLibrary = () => {
  try{
    if (fs.existsSync(LIB_FILE())) return JSON.parse(fs.readFileSync(LIB_FILE(), 'utf8'));
  }catch(e){}
  return null;
};
ipcMain.on('data:load-sync', e => { e.returnValue = readLibrary(); });   // 同步版给启动用，见 preload
ipcMain.handle('data:load', () => readLibrary());
ipcMain.handle('data:save', (_e, library) => {
  fs.mkdirSync(DATA_DIR(), { recursive: true });
  maybeBackup();
  writeAtomic(LIB_FILE(), JSON.stringify(library));
  return true;
});
/* 渲染进程 beforeunload 时的同步冲刷：invoke 是异步的，进程退出前来不及完成 */
ipcMain.on('data:save-sync', (e, library) => {
  try{
    fs.mkdirSync(DATA_DIR(), { recursive: true });
    maybeBackup();
    writeAtomic(LIB_FILE(), JSON.stringify(library));
    e.returnValue = true;
  }catch(err){ e.returnValue = false; }
});
ipcMain.handle('data:backups', () => {
  try{
    return fs.readdirSync(BACKUP_DIR())
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR(), f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  }catch(e){ return []; }
});
ipcMain.handle('data:restore-backup', (_e, f) => {
  try{
    return { ok: true, data: JSON.parse(fs.readFileSync(path.join(BACKUP_DIR(), f), 'utf8')) };
  }catch(e){ return { ok: false }; }
});

/* ── IPC：系统对话框 ── */
ipcMain.handle('dialog:export', async (_e, name, content) => {
  const r = await dialog.showSaveDialog(win(), { defaultPath: name });
  if (r.canceled || !r.filePath) return false;
  writeAtomic(r.filePath, content);
  return true;
});
ipcMain.handle('dialog:import', async () => {
  const r = await dialog.showOpenDialog(win(), {
    properties: ['openFile'],
    filters: [{ name: '稿子 / 项目文件', extensions: ['md', 'markdown', 'txt', 'json'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return { name: path.basename(r.filePaths[0]), content: fs.readFileSync(r.filePaths[0], 'utf8') };
});
