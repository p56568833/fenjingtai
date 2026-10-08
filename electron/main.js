/* 分镜台 · 主进程：窗口 / 原生菜单 / 数据落盘（原子写 + 分层自动备份 + 损坏自救）/ 稿子文件读取 */
const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeImage, screen, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createStore } = require('./data-store');
const { readScriptFile, SCRIPT_EXTS } = require('./script-reader');
const videoTools = require('./video-tools');
const updater = require('./updater');

/* 自测 / 预览只在开发环境（未打包）可用：发布版不接受 --selftest，不会开远程调试端口 */
const IS_SELFTEST = !app.isPackaged && process.argv.includes('--selftest');
if (!app.isPackaged && process.argv.includes('--preview'))
  app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), '分镜台预览-')));
if (IS_SELFTEST) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
  // 自测跑在一次性沙箱数据目录里：不碰真实数据，也不和正在运行的正式实例抢单实例锁
  // （必须在 requestSingleInstanceLock 之前设置，锁就是按 userData 路径算的）
  app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), '分镜台自测-')));
}

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
const win = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0]);

function buildMenu() {
  const send = type => () => win()?.webContents.send('menu-action', { type });
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建项目', accelerator: 'CmdOrCtrl+N', click: send('new-project') },
        { label: '导入稿子…', accelerator: 'CmdOrCtrl+O', click: send('import') },
        { label: '对齐剪映字幕（SRT）…', accelerator: 'Shift+CmdOrCtrl+O', click: send('import-srt') },
        { label: '导入口播音频…', accelerator: 'Alt+CmdOrCtrl+O', click: send('import-voice') },
        { type: 'separator' },
        {
          label: '导出',
          submenu: [
            { label: 'PDF 分镜脚本…', accelerator: 'CmdOrCtrl+Shift+E', click: send('export:pdf') },
            { type: 'separator' },
            { label: '带批注的 MD', click: send('export:md') },
            { label: '素材清单 MD', click: send('export:list') },
            { label: 'CSV 表格', click: send('export:csv') },
            { label: '项目 JSON', click: send('export:json') },
          ],
        },
        { type: 'separator' },
        { label: '本项目的标注类型…', click: send('edit-types') },
        { label: '打开数据文件夹', click: () => shell.openPath(DATA_DIR()) },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: '重做', accelerator: 'Shift+CmdOrCtrl+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '搜索句子', accelerator: 'CmdOrCtrl+F', click: send('search') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '切换视图（审核 / 表格）', accelerator: 'CmdOrCtrl+T', click: send('toggle-view') },
        { label: '专注标注', accelerator: 'CmdOrCtrl+E', click: send('focus-mode') },
        { label: '连播预览（从选中的句子开始）', click: send('playthrough') },
        { type: 'separator' },
        { label: '浅色 / 深色主题', accelerator: 'CmdOrCtrl+L', click: send('toggle-theme') },
        { label: '主题跟随系统', click: send('theme-system') },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '实际大小' },
        { type: 'separator' },
        { label: '紧凑行距', accelerator: 'Shift+CmdOrCtrl+D', click: send('toggle-density') },
        // 刷新会打断正在截取的片段、丢掉审核窗口的位置：只在开发时提供
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload', label: '刷新（开发）' }]),
      ],
    },
    { label: '窗口', role: 'windowMenu' },
    {
      label: '帮助',
      role: 'help',
      submenu: [
        { label: '快捷键与帮助', accelerator: 'CmdOrCtrl+/', click: send('help') },
        { label: '交稿检查…', click: send('review') },
        { type: 'separator' },
        { label: '检查更新…', click: send('check-update') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* 窗口位置 / 大小记在数据目录旁边，下次按原样打开 */
const BOUNDS_FILE = () => path.join(app.getPath('userData'), '窗口.json');
function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(BOUNDS_FILE(), 'utf8'));
    if ([b.width, b.height].every(n => Number.isFinite(n) && n > 400)) {
      // 外接屏拔掉后旧坐标可能落在屏幕外：看不见就只保留尺寸，让系统居中
      const visible = screen
        .getAllDisplays()
        .some(
          ({ workArea: a }) =>
            b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80,
        );
      return visible ? b : { width: b.width, height: b.height };
    }
  } catch {
    /* 第一次打开没有记录 */
  }
  return { width: 1440, height: 940 };
}

function createWindow() {
  const bounds = savedBounds();
  const w = new BrowserWindow({
    ...bounds,
    minWidth: 980,
    minHeight: 620,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 22 },
    backgroundColor: '#f3f5f9',
    show: false, // 渲染就绪（含主题类）后才显示，启动不闪白；自测窗口保持隐藏不弹到用户面前
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      ...(IS_SELFTEST ? { backgroundThrottling: false } : {}), // 隐藏窗口里 JS 计时不被节流，自测的 sleep 才准
    },
  });
  mainWindow = w;
  if (!IS_SELFTEST) w.once('ready-to-show', () => w.show());
  w.loadFile(INDEX_FILE, IS_SELFTEST ? { query: { selftest: '1' } } : {});

  // 导航护栏：界面只允许停在自己的 index.html；外链交给系统浏览器，任何新窗口都不开
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!isAppPage(url)) e.preventDefault();
  });
  w.webContents.on('will-attach-webview', e => e.preventDefault());
  // 界面不需要摄像头、麦克风、定位、通知这些权限：除了视频全屏和复制，一律拒绝
  const ALLOWED_PERMS = new Set(['fullscreen', 'clipboard-sanitized-write']);
  w.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED_PERMS.has(perm)));

  if (!IS_SELFTEST) {
    let t = null;
    const remember = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        try {
          if (!w.isDestroyed() && !w.isMinimized() && !w.isFullScreen())
            fs.writeFileSync(BOUNDS_FILE(), JSON.stringify(w.getBounds()));
        } catch {
          /* 记不住窗口位置不影响使用 */
        }
      }, 400);
    };
    w.on('resize', remember);
    w.on('move', remember);
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  const w = win();
  if (w) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});

app.whenReady().then(() => {
  buildMenu();
  cleanStaleUpdates();
  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});
app.on('window-all-closed', () => app.quit());

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
  } catch {
    e.returnValue = false;
  }
});
handle('data:backups', () => store.listBackups());
handle('data:restore-backup', (_e, f) => store.readBackup(f));
handle('data:open-folder', () => shell.openPath(DATA_DIR()));

/* ── IPC：系统对话框 / 稿子文件 ── */
handle('dialog:export', async (_e, name, content) => {
  const r = await dialog.showSaveDialog(win(), { defaultPath: name });
  if (r.canceled || !r.filePath) return false;
  try {
    const tmp = r.filePath + '.tmp';
    fs.writeFileSync(tmp, String(content ?? ''), 'utf8');
    fs.renameSync(tmp, r.filePath);
    return true;
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});
/* PDF 分镜脚本：渲染层排好整页 HTML，这里用隐藏窗口加载后交给 Chromium 打印成矢量 PDF。
   排版窗口禁用脚本、拦截跳转，只渲染这一份本地生成的页面。 */
const inch = mm => mm / 25.4;
handle('pdf:export', async (_e, name, doc) => {
  if (!doc || typeof doc.html !== 'string' || !doc.html) return { ok: false, error: '没有可导出的内容' };
  const r = await dialog.showSaveDialog(win(), {
    defaultPath: name,
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  const file = /\.pdf$/i.test(r.filePath) ? r.filePath : r.filePath + '.pdf';
  const dir = fs.mkdtempSync(path.join(app.getPath('temp'), '分镜台PDF-'));
  let w = null;
  try {
    const page = path.join(dir, 'print.html');
    fs.writeFileSync(page, doc.html, 'utf8');
    w = new BrowserWindow({
      show: false,
      width: 1240,
      height: 1754,
      webPreferences: {
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    w.webContents.on('will-navigate', e => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await w.loadFile(page);
    const data = await w.webContents.printToPDF({
      pageSize: 'A4',
      landscape: !!doc.landscape,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: typeof doc.header === 'string' ? doc.header : '<span></span>',
      footerTemplate: typeof doc.footer === 'string' ? doc.footer : '<span></span>',
      margins: { top: inch(12), bottom: inch(14), left: inch(12), right: inch(12) },
      generateDocumentOutline: true, // 章节 → PDF 书签
      generateTaggedPDF: true,
    });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    if (w && !w.isDestroyed()) w.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

handle('dialog:import', async (_e, kind) => {
  const filters =
    kind === 'srt'
      ? [{ name: '剪映 / 字幕文件', extensions: ['srt', 'vtt'] }]
      : [{ name: '稿子 / 项目 / 字幕文件', extensions: SCRIPT_EXTS }];
  const r = await dialog.showOpenDialog(win(), { properties: ['openFile'], filters });
  if (r.canceled || !r.filePaths.length) return null;
  return readScriptFile(r.filePaths[0]);
});
/* 拖进窗口的稿子文件：渲染层拿到本地路径后请主进程读（docx 需要解压，渲染层做不了） */
handle('file:read-script', (_e, file) => readScriptFile(file));

/* Local references are opened only by explicit user clicks. Image previews never fetch remote URLs. */
const ASSET_EXTS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'mp4',
  'mov',
  'mkv',
  'webm',
  'm4v',
  'avi',
  'mp3',
  'wav',
  'm4a',
  'aac',
  'flac',
  'ogg',
  'opus',
  'pdf',
  'txt',
  'md',
  'csv',
  'pptx',
  'docx',
];
handle('assets:pick', async () => {
  const r = await dialog.showOpenDialog(win(), {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '素材与文档', extensions: ASSET_EXTS }],
  });
  return r.canceled ? [] : r.filePaths;
});
/* 口播音频：音频或视频（录屏 / 相机直出）都行 */
const VOICE_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'm4v', 'webm', 'mkv'];
handle('voice:pick', async () => {
  const r = await dialog.showOpenDialog(win(), {
    title: '选择口播音频',
    properties: ['openFile'],
    filters: [{ name: '口播音频 / 视频', extensions: VOICE_EXTS }],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
/* 按文件夹找回失联素材：选一个文件夹，列出里面（含子文件夹，最多 4 层 / 2 万个）的素材文件 */
handle('assets:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win(), { title: '选择素材所在的文件夹', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return listFilesDeep(r.filePaths[0], ASSET_EXTS);
});
/* 异步遍历：大文件夹也不卡住主进程（界面照常响应） */
async function listFilesDeep(root, exts, depth = 4, out = []) {
  const re = new RegExp(`\\.(${exts.join('|')})$`, 'i');
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of entries) {
    if (out.length >= 20000) break;
    if (d.name.startsWith('.')) continue;
    const p = path.join(root, d.name);
    if (d.isDirectory() && depth > 0) await listFilesDeep(p, exts, depth - 1, out);
    else if (d.isFile() && re.test(d.name)) out.push(p);
  }
  return out;
}
/* 重新定位失联文件：单选 */
handle('assets:pick-one', async () => {
  const r = await dialog.showOpenDialog(win(), {
    properties: ['openFile'],
    filters: [
      { name: '素材与文档', extensions: ASSET_EXTS },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
/* 批量探测本地文件是否还在（文件失联检测） */
handle('assets:probe', (_e, paths) => {
  const out = {};
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || !p) continue;
    try {
      out[p] = { exists: path.isAbsolute(p) && fs.existsSync(p) && fs.statSync(p).isFile() };
    } catch {
      out[p] = { exists: false };
    }
  }
  return out;
});
/* ── 视频审核（1.5）── */
/* 视频片段 / 原片的保存位置：选一个文件夹 */
handle('dialog:pick-folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win(), {
    title: '选择视频片段的保存位置',
    defaultPath: typeof current === 'string' && path.isAbsolute(current) ? current : app.getPath('desktop'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
handle('video:has-ffmpeg', () => !!videoTools.findFfmpeg());
/* 只保存入点到出点那几秒（ffmpeg 按需读取在线视频，不下整片） */
handle('video:save-segment', (e, req) =>
  videoTools.saveSegment(req || {}, {
    // 截取进度（0–1）：界面上的「正在截取… 37%」和进度条
    onProgress: p => {
      if (!e.sender.isDestroyed()) e.sender.send('video:segment-progress', { token: req?.token, p });
    },
  }),
);
/* 下载完整原片：只在用户明确点了「下载完整原片」并确认后调用；同一个地址同时只下一份，可以取消 */
const downloads = new Map(); // url → AbortController
handle('video:download-original', async (e, req) => {
  const url = req?.url;
  if (downloads.has(url)) return { ok: false, error: '这部原片正在下载' };
  const ctl = new AbortController();
  downloads.set(url, ctl);
  try {
    return await videoTools.downloadOriginal(req || {}, {
      signal: ctl.signal,
      onProgress: (got, total) => {
        if (!e.sender.isDestroyed()) e.sender.send('video:download-progress', { url, got, total });
      },
    });
  } finally {
    downloads.delete(url);
  }
});
handle('video:cancel-download', (_e, url) => {
  downloads.get(url)?.abort();
  return downloads.has(url);
});
/* 旧版本保存的片段：文件名补上对应的句号 */
handle('video:tag-saved', (_e, p, tag) => videoTools.renameWithLineTag(p, tag));
/* 审核结果写回候选清单（只认 type = fenjingtai-candidates 的 JSON） */
handle('candidates:write-back', (_e, file, results) => videoTools.writeReview(file, results));
handle('assets:reveal', (_e, p) => {
  if (typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p)) shell.showItemInFolder(p);
});

/* ── 应用内更新：查 GitHub 最新版 → 下载并校验 → 退出时换上新版、自动重新打开（见 updater.js） ── */
const update = { info: null, ctl: null, prepared: null, installing: false };
const sendUpdate = (e, payload) => {
  if (!e.sender.isDestroyed()) e.sender.send('update:progress', payload);
};
const whereInstalled = () => updater.installTarget(app.getPath('exe'), { isPackaged: app.isPackaged });
/* 上次没装完留下的临时文件夹（下载好了但没重启就关了应用）：启动时清掉 */
function cleanStaleUpdates() {
  const where = whereInstalled();
  if (!where.ok) return;
  try {
    for (const f of fs.readdirSync(where.parent))
      if (f.startsWith('.分镜台-更新-') || f.startsWith('.分镜台-替换下来-'))
        fs.rmSync(path.join(where.parent, f), { recursive: true, force: true });
  } catch {}
}
handle('update:check', async (_e, { auto = false } = {}) => {
  const current = app.getVersion();
  // 开发版 / 自测不在启动时自动联网检查（手动「检查更新…」照常可以看）
  if (auto && (!app.isPackaged || IS_SELFTEST)) return { ok: true, available: false, skipped: true, current };
  const r = await updater.checkForUpdate({ current, arch: process.arch, fetchImpl: net.fetch });
  if (r.ok && r.available) update.info = r;
  const where = whereInstalled();
  return {
    ...r,
    current,
    canInstall: where.ok && !!r.url,
    reason: where.ok ? (r.available && !r.url ? '这一版没有适合这台电脑的更新包，请到下载页面下载' : '') : where.reason,
    ready: !!update.prepared && update.prepared.version === r.version,
  };
});
handle('update:download', async e => {
  const info = update.info;
  if (!info?.url) return { ok: false, error: '没有可下载的更新包' };
  const where = whereInstalled();
  if (!where.ok) return { ok: false, error: where.reason };
  if (update.ctl) return { ok: false, error: '正在下载更新' };
  if (update.prepared?.version === info.version) return { ok: true, version: info.version };
  const ctl = new AbortController();
  update.ctl = ctl;
  const dir = fs.mkdtempSync(path.join(app.getPath('temp'), '分镜台更新-'));
  try {
    const d = await updater.downloadUpdate(info, path.join(dir, updater.assetName(process.arch)), {
      fetchImpl: net.fetch,
      signal: ctl.signal,
      onProgress: (got, total) => sendUpdate(e, { phase: 'download', got, total }),
    });
    if (!d.ok) return d;
    sendUpdate(e, { phase: 'verify' });
    const p = updater.prepareUpdate(d.path, { parent: where.parent, version: info.version });
    if (!p.ok) return p;
    update.prepared = { ...p, target: where.app, version: info.version };
    return { ok: true, version: info.version, verified: d.verified };
  } finally {
    update.ctl = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
handle('update:cancel', () => {
  update.ctl?.abort();
  return true;
});
handle('update:install', () => {
  const p = update.prepared;
  if (!p || !fs.existsSync(p.app)) return { ok: false, error: '更新包不见了，请重新下载' };
  update.installing = true;
  updater.scheduleSwap({
    pid: process.pid,
    newApp: p.app,
    target: p.target,
    stage: p.stage,
    tmpDir: app.getPath('temp'),
  });
  // 先回话再退出：窗口关闭前界面会把没存完的改动同步存盘（beforeunload）
  setTimeout(() => app.quit(), 150);
  return { ok: true };
});
/* 下载好了但没点「重启更新」就退出：清掉放在「应用程序」里的临时新版 */
app.on('will-quit', () => {
  if (update.prepared && !update.installing) fs.rmSync(update.prepared.stage, { recursive: true, force: true });
});

/* 自测专用：测试素材目录与能力标记（正式运行返回 null） */
onSync('selftest:fixtures', e => {
  const dir = IS_SELFTEST ? process.env.FJT_FIXTURE_DIR || null : null;
  e.returnValue = dir
    ? { dir, hasVideo: fs.existsSync(path.join(dir, '样片.mp4')), hasVoice: fs.existsSync(path.join(dir, '口播.wav')) }
    : null;
});
handle('assets:open', async (_e, value) => {
  if (typeof value !== 'string') return '无法打开这个引用';
  try {
    if (/^https?:\/\//i.test(value)) {
      await shell.openExternal(new URL(value).href);
      return '';
    }
    if (!path.isAbsolute(value) || !fs.existsSync(value)) return '文件不存在，请更新素材路径';
    if (!new RegExp(`\\.(${ASSET_EXTS.join('|')})$`, 'i').test(value)) return '请从访达打开这个文件类型';
    return await shell.openPath(value);
  } catch {
    return '无法打开这个素材';
  }
});
/* 缩略图：一律缩成小图（最长边 480）再交给界面，大照片也不会把几 MB 的原图塞进内存 */
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
const VIDEO_RE = /\.(mp4|mov|mkv|webm|m4v|avi)$/i;
async function thumbnail(file) {
  const size = { width: 480, height: 480 };
  try {
    const t = await nativeImage.createThumbnailFromPath(file, size); // macOS / Windows：系统缩略图（快）
    if (!t.isEmpty()) return t;
  } catch {
    /* 这个平台没有系统缩略图，或系统不认这个格式：下面自己缩 */
  }
  if (!IMAGE_RE.test(file) || (await fs.promises.stat(file)).size > 60 * 1024 * 1024) return null;
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const k = Math.min(1, 480 / Math.max(width, height));
  return k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' }) : img;
}
handle('assets:preview', async (_e, value) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  if (!IMAGE_RE.test(value) && !VIDEO_RE.test(value)) return null;
  try {
    if (!(await fs.promises.stat(value)).isFile()) return null;
    const img = await thumbnail(value);
    if (!img || img.isEmpty()) return null;
    return /\.png$/i.test(value) ? img.toDataURL() : `data:image/jpeg;base64,${img.toJPEG(82).toString('base64')}`;
  } catch {
    return null;
  }
});
