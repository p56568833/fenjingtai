# 分镜台 1.3.1：供后续开发接手

当前仓库包含已发布 1.3.1 的完整源码。这个版本在本机 1.3.0 的基础上合入 PDF 分镜脚本导出与删除提示条撤销按钮修复，保留专注标注、剪映字幕对齐、重做、素材库、视频片段、分层备份和 Word 导入。GitHub 上此前发布的版本是 1.0.0，本次更新同时带上这些中间版本的功能。

## PDF 导出

「导出 → PDF 分镜脚本」或 ⇧⌘E 打开导出设置。支持横竖版 A4、封面概览、制作状态、素材缩略图和链接。共用画面按镜头汇总，口播原文逐句保留；素材库中的视频片段和字幕对齐时间会写入文档。本地素材仅显示文件名。

`renderer/src/pdf-export.js` 负责设置和素材准备；`renderer/src/print-doc.js` 生成打印文档；`electron/main.js` 中的 `pdf:export` 处理保存和原生 PDF 打印；`electron/preload.js` 暴露接口。

PDF 弹窗接入统一弹窗管理。⇧⌘E 导出 PDF，⌘E 进入专注标注，两者分开处理。`renderer/src/util.js` 修复提示条操作回调。

## 验证

- 222 项界面自测、41 项数据回归、8 项主进程回归通过，ESLint 检查通过。
- macOS / Electron 44.4.5 上实测横竖版 PDF 原生导出，并检查页面排版。
- Apple Silicon 和 Intel 安装包均经过本机 ad-hoc 签名及严格签名校验。
- 本机安装后确认两个项目内容、标注和素材保留，并验证 PDF 快捷键。

## 开发和打包

需要 Node.js 22 或更新版本。先 `npm ci`，再 `npm start`。

- `npm test`：数据、主进程与隔离的 Electron 界面自测。
- `npm run test:data`：41 项数据与 8 项主进程回归，可在 Linux CI 运行。
- `npm run lint`：静态检查。
- `node_modules/.bin/electron scripts/pdf-smoke.cjs`：使用自动生成的测试项目验证 PDF 导出，产物在 `dist/validation`。
- `npm run package`：在 Mac 上创建双架构应用和 DMG / ZIP，产物在 `dist/release`。
- `npm run repack -- --archives`：已有 `dist/分镜台-darwin-arm64/分镜台.app` 和 x64 应用时，更新源码、签名并重新生成安装包。

运行入口为 `electron/main.js` 和 `renderer/index.html`。根目录的 `分镜台.html` 是早期单文件版本，当前桌面应用使用模块化的 `renderer` 源码。

GitHub 仓库只包含应用源码和测试。项目数据、素材、个人备份及本地验证导出物不随仓库发布。
