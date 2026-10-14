/* 原生菜单：菜单项只把动作名发给界面（menu-action），具体做什么由界面的命令表决定 */
const { app, Menu, shell } = require('electron');

function buildMenu({ win, dataDir }) {
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
        { label: '打开数据文件夹', click: () => shell.openPath(dataDir()) },
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
        { label: '崩溃记录…', click: send('crash-logs') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
