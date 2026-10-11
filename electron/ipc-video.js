/* 视频审核的通道：保存位置、截取片段、下载原片、片段改名、审核结果写回清单 */
const { app, dialog } = require('electron');
const path = require('node:path');
const videoTools = require('./video-tools');

function registerVideoIpc({ handle, win }) {
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
  /* 只保存入点到出点那几秒（ffmpeg 按需读取在线视频，不下整片） */
  handle('video:save-segment', async (e, req) => {
    // ffmpeg 不读系统代理：按这条地址问一下 Electron 该走哪个代理（和界面预览走同一条路），再交给 ffmpeg
    let proxy = null;
    try {
      if (req?.url) proxy = videoTools.proxyFromRule(await e.sender.session.resolveProxy(String(req.url)));
    } catch {}
    return videoTools.saveSegment(req || {}, {
      proxy,
      // 截取进度（0–1）：界面上的「正在截取… 37%」和进度条
      onProgress: p => {
        if (!e.sender.isDestroyed()) e.sender.send('video:segment-progress', { token: req?.token, p });
      },
    });
  });
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
  handle('asset:retag-line', (_e, p, tag) => videoTools.retagLineFile(p, tag));
  /* 审核结果写回候选清单（只认 type = fenjingtai-candidates 的 JSON） */
  handle('candidates:write-back', (_e, file, results) => videoTools.writeReview(file, results));
}

module.exports = { registerVideoIpc };
