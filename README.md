# 分镜台

口播稿逐句分镜标注工具（macOS 桌面应用，基于 Electron）。

把逐字口播稿按句拆开，逐句标 **A roll / B roll**（B roll 分四个子类）、写批注，最后导出带批注的 MD、素材清单或 CSV，直接交给剪辑。

## 下载安装

按你的芯片选一个包（不确定就点  菜单 → 关于本机 看「芯片」：Apple M 系列选 arm64，Intel 选 x64）：

| 芯片 | 安装包（dmg） |
| --- | --- |
| Apple M 系列（M1/M2/M3/M4…） | [FenJingTai-mac-arm64.dmg](https://github.com/p56568833/fenjingtai/releases/latest/download/FenJingTai-mac-arm64.dmg) |
| Intel | [FenJingTai-mac-x64.dmg](https://github.com/p56568833/fenjingtai/releases/latest/download/FenJingTai-mac-x64.dmg) |

上面的链接永远指向最新版。也可以去 [Releases 页面](https://github.com/p56568833/fenjingtai/releases) 看历史版本；每个版本同时提供 `.zip`（解压即用，适合脚本下载）。

**首次打开**：应用没有苹果开发者签名，第一次打开如果提示「无法验证开发者」，在应用图标上**右键 → 打开 → 再点打开**（只需一次，之后正常双击启动）。若 dmg 里的 app 拖进「应用程序」后仍打不开，在「系统设置 → 隐私与安全性」底部点「仍要打开」。

数据全部存本机（`~/Library/Application Support/fenjingtai/数据/`），每 30 分钟自动滚动备份，不联网上传任何内容。

## 给 AI 助手 / 脚本

固定直链（永远最新版），curl 加 `-L` 跟随重定向即可：

```bash
# Apple Silicon
curl -L -o FenJingTai-mac-arm64.dmg https://github.com/p56568833/fenjingtai/releases/latest/download/FenJingTai-mac-arm64.dmg
# Intel
curl -L -o FenJingTai-mac-x64.dmg https://github.com/p56568833/fenjingtai/releases/latest/download/FenJingTai-mac-x64.dmg
```

dmg 挂载：`hdiutil attach FenJingTai-mac-arm64.dmg`，然后把 `分镜台.app` 拷到 `/Applications`。压缩包版本把上面 URL 里的 `.dmg` 换成 `.zip`。

## 从源码运行 / 打包

```bash
npm install
npm start        # 直接跑
npm test         # 自测
npm run package  # 出 arm64 + x64 双架构安装包到 dist/release/
```

## 功能

- 粘贴 / 导入口播稿（MD、TXT），自动按句拆分，支持章节标题
- 逐句或拖选批量标注 A roll / B roll（B roll 四个子类），快捷键 1/2/3/4
- 勾选视图与表格视图一键切换（⌘T），浅色 / 深色主题（⌘L）
- 批注写备注，导出带批注 MD / 素材清单 MD / CSV / 项目 JSON
- 数据自动落盘 + 每 30 分钟滚动备份（保留最近 10 份），可从备份恢复
