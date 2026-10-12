/* 文件相关的通道：导出 / PDF / 打开稿子、选素材 / 口播、找回失联素材、打开 / 缩略图、写返工单 */
const { app, BrowserWindow, dialog, shell, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { readScriptFile, SCRIPT_EXTS } = require('./script-reader');
const { writeAtomic } = require('./fs-utils');

function registerFileIpc({ handle, win }) {
  /* ── IPC：系统对话框 / 稿子文件 ──
   会写文件的通道统一返回 { ok: true, path } / { ok: false, canceled: true } / { ok: false, error }；
   只是选文件的通道取消时返回 null */
  handle('dialog:export', async (_e, name, content) => {
    const r = await dialog.showSaveDialog(win(), { defaultPath: name });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      writeAtomic(r.filePath, String(content ?? ''));
      return { ok: true, path: r.filePath };
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
      writeAtomic(file, data);
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
  /* 选素材的对话框记住上次所在的文件夹，下次从那里打开（记在数据目录旁边） */
  const LAST_DIR_FILE = () => path.join(app.getPath('userData'), '素材位置.json');
  function lastAssetDir() {
    try {
      const dir = JSON.parse(fs.readFileSync(LAST_DIR_FILE(), 'utf8')).dir;
      if (typeof dir === 'string' && path.isAbsolute(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* 第一次选素材，或上次的文件夹已经不在了：交给系统默认位置 */
    }
    return undefined;
  }
  function rememberAssetDir(dir) {
    try {
      writeAtomic(LAST_DIR_FILE(), JSON.stringify({ dir }));
    } catch {
      /* 记不下来也不影响这次选素材 */
    }
  }
  handle('assets:pick', async () => {
    const r = await dialog.showOpenDialog(win(), {
      defaultPath: lastAssetDir(),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '素材与文档', extensions: ASSET_EXTS }],
    });
    if (r.canceled) return [];
    if (r.filePaths.length) rememberAssetDir(path.dirname(r.filePaths[0]));
    return r.filePaths;
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
    const r = await dialog.showOpenDialog(win(), {
      title: '选择素材所在的文件夹',
      defaultPath: lastAssetDir(),
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    rememberAssetDir(r.filePaths[0]);
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
      defaultPath: lastAssetDir(),
      properties: ['openFile'],
      filters: [
        { name: '素材与文档', extensions: ASSET_EXTS },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return null;
    rememberAssetDir(path.dirname(r.filePaths[0]));
    return r.filePaths[0];
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
  /* 待返工 → 返工单：写到片段保存位置（只写 .json，文件夹必须已存在；先写临时文件再改名） */
  handle('rework:write', (_e, file, content) => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.json$/i.test(file))
      return { ok: false, error: '路径无效' };
    try {
      if (!fs.statSync(path.dirname(file)).isDirectory()) return { ok: false, error: '保存位置不存在' };
      writeAtomic(file, String(content ?? ''));
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
  handle('assets:reveal', (_e, p) => {
    if (typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p)) shell.showItemInFolder(p);
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
}

module.exports = { registerFileIpc };
