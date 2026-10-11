/* 项目打包（ZIP）的通道：导出、检查、选位置、解压、取消 */
const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const projectPack = require('./project-pack');
const { safeFileName } = require('./fs-utils');

function registerPackIpc({ handle, win }) {
  /* ── 项目打包（ZIP）：导出时把项目和用到的本地素材装进一个压缩包；导入时解到选定的文件夹 ──
   同一时间只做一件（导出或导入），可以取消；进度按字节发给界面 */
  let packJob = null; // AbortController
  const packFolderName = s => safeFileName(s, '分镜台项目');
  const packProgress = (e, op) => (done, total) => {
    if (!e.sender.isDestroyed()) e.sender.send('pack:progress', { op, done, total });
  };
  const packError = err =>
    err?.canceled ? { ok: false, canceled: true } : { ok: false, error: String(err?.message || err) };
  handle('pack:sizes', (_e, paths) => projectPack.fileSizes(Array.isArray(paths) ? paths : []));
  handle('pack:cancel', () => {
    packJob?.abort();
    return !!packJob;
  });
  handle('pack:export', async (e, req) => {
    if (packJob) return { ok: false, error: '正在打包或解压，等这一个做完' };
    const files = Array.isArray(req?.files) ? req.files : [];
    const r = await dialog.showSaveDialog(win(), {
      defaultPath: String(req?.name || '分镜台项目') + '.zip',
      filters: [{ name: '分镜台项目包', extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const zip = /\.zip$/i.test(r.filePath) ? r.filePath : r.filePath + '.zip';
    const root = packFolderName(path.basename(zip, path.extname(zip))) + '/';
    const sizes = await projectPack.fileSizes(files.map(f => f?.src));
    const need = files.reduce((s, f) => s + (sizes[f?.src]?.size || 0), 0);
    const free = projectPack.freeBytes(path.dirname(zip));
    if (free != null && free < need + 50 * 1024 * 1024) return { ok: false, error: '保存位置所在的磁盘空间不够' };
    packJob = new AbortController();
    try {
      const entries = [
        { name: root + projectPack.PROJECT_ENTRY, data: String(req?.project || '') },
        ...files.filter(f => sizes[f?.src]?.exists).map(f => ({ name: root + f.rel, file: f.src })),
      ];
      const out = await projectPack.writeZip(zip, entries, {
        signal: packJob.signal,
        onProgress: packProgress(e, 'export'),
      });
      return { ...out, skipped: files.length - (entries.length - 1) };
    } catch (err) {
      return packError(err);
    } finally {
      packJob = null;
    }
  });
  handle('pack:inspect', async (_e, zip) => {
    try {
      const info = await projectPack.inspectPack(zip);
      let title = '';
      try {
        title = String(JSON.parse(info.project)?.title || '');
      } catch {
        return { ok: false, error: '压缩包里的项目文件不是有效的 JSON' };
      }
      return {
        ok: true,
        title,
        files: info.files.length - 1,
        bytes: info.bytes,
        parent: path.join(app.getPath('videos'), '分镜台素材'),
      };
    } catch (err) {
      return packError(err);
    }
  });
  handle('pack:pick-dest', async (_e, current) => {
    const r = await dialog.showOpenDialog(win(), {
      title: '选择素材解压到哪里',
      defaultPath: typeof current === 'string' && path.isAbsolute(current) ? current : app.getPath('videos'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  handle('pack:extract', async (e, req) => {
    if (packJob) return { ok: false, error: '正在打包或解压，等这一个做完' };
    const zip = req?.zip,
      parent = req?.parent;
    if (typeof zip !== 'string' || !path.isAbsolute(zip) || typeof parent !== 'string' || !path.isAbsolute(parent))
      return { ok: false, error: '路径无效' };
    let dest = null;
    packJob = new AbortController();
    try {
      const info = await projectPack.inspectPack(zip);
      fs.mkdirSync(parent, { recursive: true });
      const free = projectPack.freeBytes(parent);
      if (free != null && free < info.bytes + 50 * 1024 * 1024)
        return { ok: false, error: '这个位置所在的磁盘空间不够' };
      dest = projectPack.uniqueDir(parent, packFolderName(req?.name));
      fs.mkdirSync(dest);
      return await projectPack.extractPack(zip, dest, {
        signal: packJob.signal,
        onProgress: packProgress(e, 'import'),
      });
    } catch (err) {
      if (dest) fs.rmSync(dest, { recursive: true, force: true }); // 取消或出错：不留解了一半的文件夹
      return packError(err);
    } finally {
      packJob = null;
    }
  });
}

module.exports = { registerPackIpc };
