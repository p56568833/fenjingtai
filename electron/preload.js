/* 渲染层能用的原生能力白名单（contextIsolation 隔离，无 Node 直接暴露） */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  isNative: true,
  pickAssets: () => ipcRenderer.invoke('assets:pick'),
  pickOneAsset: () => ipcRenderer.invoke('assets:pick-one'),
  pickVoice: () => ipcRenderer.invoke('voice:pick'),
  pickFolderFiles: () => ipcRenderer.invoke('assets:pick-folder'),
  openAsset: value => ipcRenderer.invoke('assets:open', value),
  previewImage: value => ipcRenderer.invoke('assets:preview', value),
  probeAssets: paths => ipcRenderer.invoke('assets:probe', paths),
  fixtureInfo: () => ipcRenderer.sendSync('selftest:fixtures'), // 自测专用：测试素材目录（非自测返回 null）
  getPathForFile: file => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  }, // 拖入的 File 对象 → 本地路径（Electron 32+ 只有这条通道）
  loadData: () => ipcRenderer.sendSync('data:load-sync'), // 必须同步：boot 要立刻拿到数据，invoke 的 Promise 会让启动逻辑误判成「首次启动」
  dataStatus: () => ipcRenderer.sendSync('data:status-sync'), // 启动时数据文件的情况：ok / missing / recovered / corrupt
  saveData: patch => ipcRenderer.invoke('data:save', patch), // 增量：只带改动过的项目
  saveDataSync: patch => ipcRenderer.sendSync('data:save-sync', patch), // 退出前冲刷用
  listBackups: () => ipcRenderer.invoke('data:backups'),
  restoreBackup: f => ipcRenderer.invoke('data:restore-backup', f),
  openDataFolder: () => ipcRenderer.invoke('data:open-folder'),
  exportPdf: (name, doc) => ipcRenderer.invoke('pdf:export', name, doc),
  exportFile: (name, content) => ipcRenderer.invoke('dialog:export', name, content),
  importFile: kind => ipcRenderer.invoke('dialog:import', kind), // kind='srt' 时只列字幕文件；返回 {name, ext, content} | {error} | null
  readScriptFile: file => ipcRenderer.invoke('file:read-script', file), // 拖入的稿子 / 字幕 / docx
  onMenuAction: cb => ipcRenderer.on('menu-action', (_e, action) => cb(action)),
  // 视频审核（1.5）
  pickFolder: current => ipcRenderer.invoke('dialog:pick-folder', current),
  hasFfmpeg: () => ipcRenderer.invoke('video:has-ffmpeg'),
  saveVideoSegment: req => ipcRenderer.invoke('video:save-segment', req),
  downloadOriginalVideo: req => ipcRenderer.invoke('video:download-original', req),
  tagSavedClip: (p, tag) => ipcRenderer.invoke('video:tag-saved', p, tag),
  onSegmentProgress: cb => ipcRenderer.on('video:segment-progress', (_e, p) => cb(p)),
  onDownloadProgress: cb => ipcRenderer.on('video:download-progress', (_e, p) => cb(p)),
  writeCandidateReview: (file, results) => ipcRenderer.invoke('candidates:write-back', file, results),
  revealAsset: p => ipcRenderer.invoke('assets:reveal', p),
});
