/* 分镜台 · 主进程：窗口 / 原生菜单 / 数据落盘（原子写 + 分层自动备份 + 损坏自救）/ 稿子文件读取 */
const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeImage, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('./data-store');
const { readScriptFile, SCRIPT_EXTS } = require('./script-reader');
const videoTools = require('./video-tools');

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
        { label: '切换视图（原文 / 表格）', accelerator: 'CmdOrCtrl+T', click: send('toggle-view') },
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
        { role: 'reload', label: '刷新' },
      ],
    },
    { label: '窗口', role: 'windowMenu' },
    {
      label: '帮助',
      role: 'help',
      submenu: [{ label: '快捷键与帮助', accelerator: 'CmdOrCtrl+/', click: send('help') }],
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
  const indexUrl = path.join(__dirname, '..', 'renderer', 'index.html');
  w.loadFile(indexUrl, IS_SELFTEST ? { query: { selftest: '1' } } : {});

  // 导航护栏：界面只允许停在自己的 index.html；外链交给系统浏览器，任何新窗口都不开
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') || !decodeURIComponent(url).includes('/renderer/index.html')) e.preventDefault();
  });

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
  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});
app.on('window-all-closed', () => app.quit());

/* ── IPC：数据 ── */
ipcMain.on('data:load-sync', e => {
  e.returnValue = store.load();
}); // 同步版给启动用，见 preload
ipcMain.on('data:status-sync', e => {
  store.load();
  e.returnValue = store.info();
});
ipcMain.handle('data:load', () => store.load());
ipcMain.handle('data:save', (_e, patch) => store.savePatch(patch));
/* 渲染进程 beforeunload 时的同步冲刷：invoke 是异步的，进程退出前来不及完成 */
ipcMain.on('data:save-sync', (e, patch) => {
  try {
    e.returnValue = store.savePatch(patch);
  } catch {
    e.returnValue = false;
  }
});
ipcMain.handle('data:backups', () => store.listBackups());
ipcMain.handle('data:restore-backup', (_e, f) => store.readBackup(f));
ipcMain.handle('data:open-folder', () => shell.openPath(DATA_DIR()));

/* ── IPC：系统对话框 / 稿子文件 ── */
ipcMain.handle('dialog:export', async (_e, name, content) => {
  const r = await dialog.showSaveDialog(win(), { defaultPath: name });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, content, 'utf8');
  return true;
});
/* PDF 分镜脚本：渲染层排好整页 HTML，这里用隐藏窗口加载后交给 Chromium 打印成矢量 PDF。
   排版窗口禁用脚本、拦截跳转，只渲染这一份本地生成的页面。 */
const inch = mm => mm / 25.4;
ipcMain.handle('pdf:export', async (_e, name, doc) => {
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

ipcMain.handle('dialog:import', async (_e, kind) => {
  const filters =
    kind === 'srt'
      ? [{ name: '剪映 / 字幕文件', extensions: ['srt', 'vtt'] }]
      : [{ name: '稿子 / 项目 / 字幕文件', extensions: SCRIPT_EXTS }];
  const r = await dialog.showOpenDialog(win(), { properties: ['openFile'], filters });
  if (r.canceled || !r.filePaths.length) return null;
  return readScriptFile(r.filePaths[0]);
});
/* 拖进窗口的稿子文件：渲染层拿到本地路径后请主进程读（docx 需要解压，渲染层做不了） */
ipcMain.handle('file:read-script', (_e, file) => readScriptFile(file));

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
ipcMain.handle('assets:pick', async () => {
  const r = await dialog.showOpenDialog(win(), {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '素材与文档', extensions: ASSET_EXTS }],
  });
  return r.canceled ? [] : r.filePaths;
});
/* 口播音频：音频或视频（录屏 / 相机直出）都行 */
const VOICE_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'm4v', 'webm', 'mkv'];
ipcMain.handle('voice:pick', async () => {
  const r = await dialog.showOpenDialog(win(), {
    title: '选择口播音频',
    properties: ['openFile'],
    filters: [{ name: '口播音频 / 视频', extensions: VOICE_EXTS }],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
/* 按文件夹找回失联素材：选一个文件夹，列出里面（含子文件夹，最多 4 层 / 2 万个）的素材文件 */
ipcMain.handle('assets:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win(), { title: '选择素材所在的文件夹', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return listFilesDeep(r.filePaths[0], ASSET_EXTS);
});
function listFilesDeep(root, exts, depth = 4, out = []) {
  const re = new RegExp(`\\.(${exts.join('|')})$`, 'i');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of entries) {
    if (out.length >= 20000) break;
    if (d.name.startsWith('.')) continue;
    const p = path.join(root, d.name);
    if (d.isDirectory() && depth > 0) listFilesDeep(p, exts, depth - 1, out);
    else if (d.isFile() && re.test(d.name)) out.push(p);
  }
  return out;
}
/* 重新定位失联文件：单选 */
ipcMain.handle('assets:pick-one', async () => {
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
ipcMain.handle('assets:probe', (_e, paths) => {
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
ipcMain.handle('dialog:pick-folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win(), {
    title: '选择视频片段的保存位置',
    defaultPath: typeof current === 'string' && path.isAbsolute(current) ? current : app.getPath('desktop'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
ipcMain.handle('video:has-ffmpeg', () => !!videoTools.findFfmpeg());
/* 只保存入点到出点那几秒（ffmpeg 按需读取在线视频，不下整片） */
ipcMain.handle('video:save-segment', (_e, req) => videoTools.saveSegment(req || {}));
/* 下载完整原片：只在用户明确点了「下载完整原片」并确认后调用 */
ipcMain.handle('video:download-original', (e, req) =>
  videoTools.downloadOriginal(req || {}, {
    onProgress: (got, total) => {
      if (!e.sender.isDestroyed()) e.sender.send('video:download-progress', { url: req?.url, got, total });
    },
  }),
);
/* 旧版本保存的片段：文件名补上对应的句号 */
ipcMain.handle('video:tag-saved', (_e, p, tag) => videoTools.renameWithLineTag(p, tag));
/* 审核结果写回候选清单（只认 type = fenjingtai-candidates 的 JSON） */
ipcMain.handle('candidates:write-back', (_e, file, results) => videoTools.writeReview(file, results));
ipcMain.handle('assets:reveal', (_e, p) => {
  if (typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p)) shell.showItemInFolder(p);
});

/* 自测专用：测试素材目录与能力标记（正式运行返回 null） */
ipcMain.on('selftest:fixtures', e => {
  const dir = IS_SELFTEST ? process.env.FJT_FIXTURE_DIR || null : null;
  e.returnValue = dir
    ? { dir, hasVideo: fs.existsSync(path.join(dir, '样片.mp4')), hasVoice: fs.existsSync(path.join(dir, '口播.wav')) }
    : null;
});
ipcMain.handle('assets:open', async (_e, value) => {
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
  if (!IMAGE_RE.test(file) || fs.statSync(file).size > 60 * 1024 * 1024) return null;
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const k = Math.min(1, 480 / Math.max(width, height));
  return k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' }) : img;
}
ipcMain.handle('assets:preview', async (_e, value) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  if (!IMAGE_RE.test(value) && !VIDEO_RE.test(value)) return null;
  try {
    if (!fs.statSync(value).isFile()) return null;
    const img = await thumbnail(value);
    if (!img || img.isEmpty()) return null;
    return /\.png$/i.test(value) ? img.toDataURL() : `data:image/jpeg;base64,${img.toJPEG(82).toString('base64')}`;
  } catch {
    return null;
  }
});
