/* 渲染层能用的原生能力白名单（contextIsolation 隔离，无 Node 直接暴露） */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  isNative: true,
  loadData: () => ipcRenderer.sendSync('data:load-sync'),   // 必须同步：boot 要立刻拿到数据，invoke 的 Promise 会让启动逻辑误判成「首次启动」
  saveData: library => ipcRenderer.invoke('data:save', library),
  saveDataSync: library => ipcRenderer.sendSync('data:save-sync', library),   // 退出前冲刷用
  listBackups: () => ipcRenderer.invoke('data:backups'),
  restoreBackup: f => ipcRenderer.invoke('data:restore-backup', f),
  exportFile: (name, content) => ipcRenderer.invoke('dialog:export', name, content),
  importFile: () => ipcRenderer.invoke('dialog:import'),
  onMenuAction: cb => ipcRenderer.on('menu-action', (_e, action) => cb(action)),
});
