/* 主窗口：记住位置大小、渲染就绪再显示、导航与权限护栏 */
const { app, BrowserWindow, shell, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

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

function createMainWindow({ indexFile, isAppPage, isSelftest }) {
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
      // macOS 关窗后仍保留界面进程，保存、协作与后台任务的计时照常运行。
      ...(isSelftest || process.platform === 'darwin' ? { backgroundThrottling: false } : {}),
    },
  });
  if (!isSelftest) w.once('ready-to-show', () => w.show());
  // selftest=e2e：只开调试端口、不跑内置自测（局域网协作测试用两个实例互相连）
  w.loadFile(indexFile, isSelftest ? { query: { selftest: process.env.FJT_SELFTEST_MODE || '1' } } : {});

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

  if (!isSelftest) {
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
  return w;
}

module.exports = { createMainWindow };
