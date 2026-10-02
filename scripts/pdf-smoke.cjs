/* global __dirname, console, setTimeout */
/* Exercise the actual PDF UI, preload IPC and printing using generated test data. */
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(app.getPath('temp'), 'fenjingtai-pdf-smoke-'));
app.setPath('userData', temp);
const dataDir = path.join(temp, '数据');
fs.mkdirSync(dataDir, { recursive: true });
const rows = [];
for (let section = 0; section < 4; section++) {
  rows.push({ id: rows.length + 1, kind: 'section', text: `验证章节 ${section + 1}` });
  for (let line = 0; line < 18; line++)
    rows.push({
      id: rows.length + 1,
      kind: 'line',
      text: `这是 PDF 导出测试的第 ${section * 18 + line + 1} 句，用来检查分页、中文排版与镜头信息。`,
      type: ['a', 'real', 'stock', 'ai', 'fx'][line % 5],
      note: '测试画面描述，检查横版和竖版布局。',
    });
}
fs.writeFileSync(
  path.join(dataDir, '分镜台数据.json'),
  JSON.stringify({
    v: 2,
    currentId: 'pdf_test',
    projects: { pdf_test: { id: 'pdf_test', title: 'PDF 导出验证', rows, assets: {}, updatedAt: Date.now() } },
  }),
);
BrowserWindow.prototype.show = function () {};
let phase = 0;
const out = path.join(root, 'dist', 'validation');
fs.mkdirSync(out, { recursive: true });
dialog.showSaveDialog = async () => ({
  canceled: false,
  filePath: path.join(out, `分镜台1.3.1验证-${phase === 0 ? '竖版' : '横版'}.pdf`),
});
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) =>
  handle(
    channel,
    channel !== 'pdf:export'
      ? fn
      : async (...args) => {
          const result = await fn(...args);
          console.log('PDF_RESULT', JSON.stringify(result));
          if (!result.ok) {
            app.exit(1);
            return result;
          }
          const data = fs.readFileSync(result.path);
          if (data.subarray(0, 5).toString() !== '%PDF-') {
            app.exit(1);
            return result;
          }
          console.log('PDF_BYTES', data.length);
          phase++;
          if (phase === 1)
            setTimeout(async () => {
              const w = BrowserWindow.getAllWindows()[0];
              await w.webContents.executeJavaScript(
                `import('./src/pdf-export.js').then(m=>{m.openPdfExport();document.querySelector('#pdfMask input[value="landscape"]').checked=true;document.querySelector('#pdfOk').click();})`,
              );
            }, 500);
          else setTimeout(() => app.quit(), 500);
          return result;
        },
  );
app.on('browser-window-created', (_e, w) => {
  w.webContents.on('did-finish-load', async () => {
    if (!w.webContents.getURL().includes('renderer/index.html')) return;
    try {
      await w.webContents.executeJavaScript(
        `new Promise(resolve=>{const poll=()=>{if(!document.querySelector('#pdfMask'))return setTimeout(poll,100);document.querySelector('#btnExport').click();document.querySelector('[data-x="pdf"]').click();document.querySelector('#pdfMask input[value="portrait"]').checked=true;console.log('PDF_UI_READY');document.querySelector('#pdfOk').click();resolve();};poll();})`,
      );
      console.log('PDF_UI_STARTED');
    } catch (e) {
      console.error(e);
      app.exit(1);
    }
  });
});
require(path.join(root, 'electron/main.js'));
setTimeout(() => {
  console.error('PDF_SMOKE_TIMEOUT');
  app.exit(1);
}, 90000).unref();
