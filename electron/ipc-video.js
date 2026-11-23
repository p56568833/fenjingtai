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
  /* 只保存入点到出点那几秒（ffmpeg 按需读取在线视频，不下整片；最多 2 个并发保护 4K/HEVC 内存） */
  const MAX_SEGMENT_CONCURRENCY = 2;
  let activeSegments = 0;
  const segmentQueue = [];
  const activeControllers = new Set();
  let quitting = false;
  function acquireSegmentSlot(ctl) {
    if (quitting || ctl.signal.aborted)
      return Promise.reject(Object.assign(new Error('已取消截取'), { canceled: true }));
    if (activeSegments < MAX_SEGMENT_CONCURRENCY) {
      activeSegments++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, ctl, onAbort: null };
      entry.onAbort = () => {
        const i = segmentQueue.indexOf(entry);
        if (i >= 0) segmentQueue.splice(i, 1);
        reject(Object.assign(new Error('已取消截取'), { canceled: true }));
      };
      ctl.signal.addEventListener('abort', entry.onAbort, { once: true });
      segmentQueue.push(entry);
    });
  }
  function releaseSegmentSlot() {
    activeSegments = Math.max(0, activeSegments - 1);
    while (activeSegments < MAX_SEGMENT_CONCURRENCY && segmentQueue.length) {
      const next = segmentQueue.shift();
      next.ctl.signal.removeEventListener('abort', next.onAbort);
      if (quitting || next.ctl.signal.aborted) {
        next.reject(Object.assign(new Error('已取消截取'), { canceled: true }));
        continue;
      }
      activeSegments++;
      next.resolve();
    }
  }
  handle('video:save-segment', async (e, req) => {
    if (quitting) return { ok: false, canceled: true, error: '应用正在退出' };
    const ctl = new AbortController();
    activeControllers.add(ctl);
    try {
      await acquireSegmentSlot(ctl);
    } catch (err) {
      activeControllers.delete(ctl);
      return { ok: false, canceled: true, error: String(err?.message || '已取消截取') };
    }
    try {
      // ffmpeg 不读系统代理：按这条地址问一下 Electron 该走哪个代理（和界面预览走同一条路），再交给 ffmpeg
      let proxy = null;
      try {
        if (req?.url) proxy = videoTools.proxyFromRule(await e.sender.session.resolveProxy(String(req.url)));
      } catch {}
      return await videoTools.saveSegment(req || {}, {
        proxy,
        signal: ctl.signal,
        // 截取进度（0–1）：界面上的「正在截取… 37%」和进度条
        onProgress: p => {
          if (!e.sender.isDestroyed()) e.sender.send('video:segment-progress', { token: req?.token, p });
        },
      });
    } finally {
      activeControllers.delete(ctl);
      releaseSegmentSlot();
    }
  });
  /* 下载完整原片：只在用户明确点了「下载完整原片」并确认后调用；同一个地址同时只下一份，可以取消 */
  const downloads = new Map(); // normalizedUrl → AbortController
  const downloadKey = url => String(url || '').split('#')[0];
  handle('video:download-original', async (e, req) => {
    const url = req?.url;
    const key = downloadKey(url);
    if (!key) return { ok: false, error: '只支持在线视频链接' };
    if (downloads.has(key)) return { ok: false, error: '这部原片正在下载' };
    const ctl = new AbortController();
    downloads.set(key, ctl);
    try {
      let proxy = null;
      try {
        proxy = videoTools.proxyFromRule(await e.sender.session.resolveProxy(key));
      } catch {}
      return await videoTools.downloadOriginal(req || {}, {
        proxy,
        signal: ctl.signal,
        onProgress: (got, total) => {
          if (!e.sender.isDestroyed()) e.sender.send('video:download-progress', { url, got, total });
        },
      });
    } finally {
      if (downloads.get(key) === ctl) downloads.delete(key);
    }
  });
  handle('video:cancel-download', (_e, url) => {
    const key = downloadKey(url);
    const ctl = downloads.get(key);
    if (!ctl) return false;
    ctl.abort();
    return true;
  });
  app.on('will-quit', () => {
    quitting = true;
    for (const ctl of [...activeControllers]) ctl.abort();
    activeControllers.clear();
    for (const ctl of [...downloads.values()]) ctl.abort();
    downloads.clear();
  });
  /* 旧版本保存的片段：文件名补上对应的句号 */
  handle('video:tag-saved', (_e, p, tag) => videoTools.renameWithLineTag(p, tag));
  handle('asset:retag-line', (_e, p, tag) => videoTools.retagLineFile(p, tag));
  /* 审核结果写回候选清单（只认 type = fenjingtai-candidates 的 JSON） */
  handle('candidates:write-back', (_e, file, results) => videoTools.writeReview(file, results));
}

module.exports = { registerVideoIpc };
