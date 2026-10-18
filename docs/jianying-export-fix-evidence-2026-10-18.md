# 真实剪映 11.6.0 验收证据（2026-10-18 修复轮原始记录）

> 本文件是现场操作记录，配合 `docs/jianying-export-acceptance.md` §0 阅读。截图在 `docs/images/jianying-export-fix-2026-10-18/`；操作由 Hammerspoon 发送真实鼠标/键盘事件，未使用合成 DOM 拖拽。

环境与工具：

- macOS 27.0.1 (26A434)，Apple 芯片；主屏 1470×956 pt，Retina 2×（`screencapture` 输出 2940×1912 px）。
- 剪映专业版 11.6.0，bundle `com.lemon.lvpro`，`/Applications/VideoFusion-macOS.app`；草稿库 `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`。
- GUI：Hammerspoon（`hs.eventtap` / `hs.mouse`，accessibilityState=true，AppleScript 由 Lead 开启）。鼠标点击前先用真实点击把剪映窗口激活（DeepSeek Harness 窗口会重新浮到前面，需要时先点剪映窗口露出的区域）。
- 剪映窗口坐标（pt，来自 CGWindowList）：首页 `151,106,1168,780`；编辑器 `19,33,1450,903`。截窗口图后再用 `sips -z` 缩到 1×（1px = 1pt）。
- 启动/退出：`open /Applications/VideoFusion-macOS.app`；退出用主进程 `kill -TERM`（1 秒内退出，tray helper 残留不算运行），从未 pkill -9。
- 焦点干扰（重要）：DeepSeek Harness 窗口会不定时浮到最前，抢走后续键盘事件。做法：每段自动化开始先判断最前台 bundleID，不是 `com.lemon.lvpro` 就用真实点击剪映露出的底部空白 (700,870) 把它抬到最前再操作；需要键盘输入（Cmd+A / Cmd+V）的步骤单独短脚本执行，控制在 Hammerspoon `hs -c` 5 秒超时内。
- 导出：隐藏实例 `electron . --selftest`（`FJT_SELFTEST_MODE=e2e`，`FJT_DEBUG_PORT=9223`，临时 userData），puppeteer 连 renderer，通过公开应用接口 `captureExportSnapshot → prepareJianyingExport → startPreparedJianyingExport` 走真实 IPC 导出到真实草稿库。脚本 `scripts/jianying-live-verify.mjs`。
- 合成素材（ffmpeg 8.1.2）：`/tmp/jianying-live/media/`
  - `land.mp4` 320×180 4.0s；`port.mp4` 120×200 4.0s；`square.mp4` 180×180 4.0s；`rot.mp4` 编码 200×120、`side_data rotation=90`（显示 120×200）4.0s；`img.png` 240×160；`freeze_src.mp4` 320×180 2.0s；`voice.wav` 12s（440Hz×6s + 880Hz×6s）；`raw.h264` 320×180、ffprobe 无 duration（未知时长候选）。

---

## 阶段 A · 基线草稿「修复验收-20261018-0220」

### A0. 代码状态（如实记录）

- 基线提交 0944660，但导出发生在 02:09:20，工作区当时已被各成员改动（schema / jianying-export / register / ipc-jianying / edit-export-plan 已修改，新增 clock/frame/media-info）。因此**这份草稿不是 0944660 纯旧代码生成**；`draft_info.json` 里素材宽高已是真实探测值。02:09:20 时工作区 diff 未留快照；02:17:44 的 `git diff | shasum` 前 16 位为 `91f9df242c03fdfa`（之后代码继续变化）。issue 6 的「保存→重开是否回退」与导出代码这一差异无关，但仍按实际记录，不用它冒充旧版基线。

### A1. 导出结果

- 项目：12s，6 个镜头；0–2 land(源1–3s) / 2–4 port(源0.5–2.5s) / 4–6 square(源1–3s) / 6–8 rot(源1–3s) / 8–10 img / 10–11 freeze_src(源0–1s 视频) + 11–12 定格 PNG；口播 0–12s；6 条字幕。
- 设置：1920×1080、30fps、生成字幕；草稿名 `修复验收-20261018-0220`。
- 结果：`ok=true registered=true needsQuit=false`；14 段 / 7 素材 / 1 定格；plan issues 空；导出时间 02:09:20。
- 草稿目录：`~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/修复验收-20261018-0220/`
- 初始明文 `draft_info.json` 80245B：videos 素材宽高 = land 320×180、port 120×200、square 180×180、rot 200×120、img 240×160、freeze_src 320×180、定格 PNG 320×180；视频 duration = 完整源 4s/2s；voice.wav 12s。画布 1920×1080。
- 索引（root_meta_info.json）：新条目置顶，`tm_draft_create = 1792260560343000`（µs = 2026-10-18 02:09:20），`tm_draft_modified` 同在 10/18；旧草稿条目名称未变。

### A2. 打开后文件形态

- 02:12:19–20 剪映打开草稿后重写：`draft_info.json` 变为加密二进制 32744B；生成 `draft_info.json.bak`、`template-2.tmp`、`Timelines/`、`.backup/`（load.bak / save.bak / projectBackUp / timeline_backup_manifest）、`.locked`、`key_value.json`、`agent_adoption_ledger.db`、`deepagent/` 等。属于剪映打开明文草稿后的自身升级。
- 打开后未编辑时：draft_info.json mtime 02:12:20 32744B。

### A3. 画幅 / 方向 / 定格（截图见 `docs/images/jianying-export-fix-2026-10-18/`）

| 时间   | 素材                           | 剪映实测                                                                                                                                                                                                                                                                                 | 截图                               |
| ------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 0–2s   | land 320×180                   | 16:9 填满画布，左上红块；字幕一                                                                                                                                                                                                                                                          | 02-baseline-0213-editor-opened.png |
| 2–4s   | port 120×200                   | 竖向 120:200 居中，左右黑边，画面正向                                                                                                                                                                                                                                                    | 03-baseline-0213-portrait-3s.png   |
| 4–6s   | square 180×180                 | 方形居中，左右黑边，比例正确                                                                                                                                                                                                                                                             | 04-baseline-0214-square-5s.png     |
| 6–8s   | rot 编码 200×120 + rotation=90 | 剪映显示 120×200 竖向；时间戳旋转 90°，红块在左下；与 ffmpeg 自动旋转解码结果（120×200、红块左下）一致 → 方向正确                                                                                                                                                                        | 05-baseline-0214-rotation-7s.png   |
| 8–10s  | img 240×160                    | 3:2 居中，左右黑边                                                                                                                                                                                                                                                                       | 06-baseline-0214-image-9s.png      |
| 10–11s | freeze_src 视频                | 画面在动                                                                                                                                                                                                                                                                                 | —                                  |
| 11–12s | 定格 PNG                       | 11.2s 与 11.8s 画布裁剪图 `shasum -a 256` 完全相同（`e74554e65e11ea21fe631d79e5a33dcd247e78bc33846ce32f24f0bc9a3c6274`，raw 文件 `/tmp/jianying-live/screens/21-freeze11a-canvas.png`、`22-freeze11b-canvas.png`），10.3s 不同 → 定格静止；定格源帧时间戳 00:00.967（< 1.0s 的最后一帧） | 07-baseline-0214-freeze-11s.png    |

- 素材面板 6 个视觉素材 + voice.wav 全部「已添加」，无「媒体丢失」；时间线总长 00:00:12:00；6 条字幕可读、口播音轨独立存在。

### A4. issue 6 基线：真实鼠标改片段 + 改字幕

真实鼠标坐标（屏幕 pt）：

- 时间线标尺 y=585；1s ≈ 94.08pt，0:00 起点 x=181（窗口坐标，加编辑器窗口原点 19,33）。
- 片段与字幕点在编辑器窗口内坐标 + 窗口原点。

改前：

- img.png 段：8–10s，标签 `img.png 00:00:02:00`。
- 字幕 1：`验收字幕一：横屏画面`。

操作与改后：

1. 裁剪：鼠标移到 img.png 段右边缘 (1137,773)，按下左键拖到 (1046,773)（约 91pt ≈ 0.97s）后松开。
   - 时间线：img.png 段变为 8–9s，标签 `img.png 00:00:01:0…`，9–10s 出现空隙；其余片段/字幕未动。
   - 顶部出现 `02:14:30 自动保存本地`。截图 08-baseline-0214-trim-img-clip.png。
2. 改字幕：点击字幕 1 片段 (300,698) → 右侧「字幕·文本」面板可编辑；
   - 点击文本输入框 (1169,215)，`Cmd+A` 全选，剪贴板写入 `基线改写字幕-0215-ABC` 后 `Cmd+V`；
   - 点击时间线空白 (500,640) 提交。
   - 画布在 0:00:00:17 显示 `基线改写字幕-0215-ABC`，字幕轨第 1 段标签同步变化；顶部 `02:14:48 自动保存本地`。截图 09/10/10c。
3. 保存：剪映「文件」菜单只有 关于/全局设置/返回首页/布局设置/更多/退出，**没有保存项**，保存依赖自动保存（截图 14 为排序菜单，文件菜单未留影；已实测确认）。`draft_info.json` mtime 更新为 02:14:48 32740B。
4. 关闭草稿：文件→返回首页；出现气泡「已保存至剪辑草稿」。首页本地草稿仍置顶，大小 1.4M→1.6M。
5. 关闭后重开：同名草稿重新打开，**裁剪与字幕改动都还在**（字幕显示 `基线改写字幕-0215-ABC`，img.png 仍为 8–9s 且 9–10s 有空隙）。截图 11-baseline-0215-reopen-after-close-persisted.png。
6. 完全退出再重启：`kill -TERM` 主进程 65076（1 秒退出；tray helper 残留，判定为未运行）→ 索引 mtime 02:15:53（剪映退出时更新自家条目）→ `open` 重启 → 首页双击重开草稿：**字幕与裁剪仍在**。截图 12-baseline-0217-restart-persisted.png。

结论（如实）：**本次没有复现 issue 6 的「重开回退」**。真实鼠标的裁剪和字幕改写都提交了自动保存（`自动保存本地` + `已保存至剪辑草稿`），关闭重开、完全退出重启再开都保留。此前验收记录的「重开后回到原时长」更可能与当时合成拖拽事件没有真正提交有关；本次真实鼠标链路不支持“保存后重开必回退”的说法。该草稿仍是 WIP 代码生成，最终还要用修复版重导一份复核。

### A5. issue 5 基线：列表位置与日期

- 首页切列表视图：列 `名称/大小/时长/类型/最后修改时间 ↓`；`修复验收-20261018-0220` 在**第一行**，大小 1.6M、时长 00:12、最后修改时间 **10/18**。截图 13-baseline-0218-listview-date.png。
- 索引值证实：`tm_draft_create/tm_draft_modified` 为 2026-10-18（微秒正确，不是 1970）。
- 注：剪映首页默认网格视图不显示日期，列表视图才显示「最后修改时间」；排序菜单有 修改时间/创建时间/文件名称/文件大小 + 升/降序（截图 14）。

---

## 阶段 B · 修复版重新导出与复核

### B0. 代码状态

- Lead 通知：1–5 代码修复全部接线，lint / test:data 全绿（plan 50、files 30、freeze 8、media 13、index-ipc 13），test:ui 已跑过。
- 阶段 B 导出发生在 02:18–02:31，工作区 `git status --porcelain` 20 项改动/新增；02:23:18 的 `git diff | shasum` 前 16 位 `0904c3fb751e2bdf`。
- 导出脚本固定 `FJT_DEBUG_PORT=9223`（不与 Lead 的 test:ui 争 9222）；每次导出前确认剪映主进程已退出、退出后确认 tray helper 残留不算运行。

### B1. 修复版 FIX 草稿（issue 2/3/5 结构证据）

- 导出：02:18:11，草稿名 `修复验收-20261018-FIX`，`ok=true registered=true`，14 段 / 7 素材 / 1 定格；导出无 plan issues、无 result issues（基线时 voice 的 media-meta-missing 警告也消失）。
- 目录：`~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/修复验收-20261018-FIX/`
- 明文 `draft_info.json` 与基线对比：

| 素材                                      | 基线 0220     | 修复版 FIX                  |
| ----------------------------------------- | ------------- | --------------------------- |
| land.mp4                                  | 320×180，4.0s | 320×180，4.0s               |
| port.mp4                                  | 120×200，4.0s | 120×200，4.0s               |
| square.mp4                                | 180×180，4.0s | 180×180，4.0s               |
| rot.mp4（文件 rotation=90，编码 200×120） | **200×120**   | **120×200（display 方向）** |
| img.png                                   | 240×160       | 240×160                     |
| freeze_src.mp4                            | 320×180，2.0s | 320×180，2.0s               |
| 定格 PNG                                  | 320×180       | 320×180                     |
| voice.wav                                 | 12s           | 12s                         |

- 视频 duration 全部 = 完整源时长（4s/2s，而不是使用区间 2s/1s）；画布 1920×1080；定格素材尺寸 = PNG 真实输出 320×180。
- 索引：新条目置顶，`tm_draft_create = 1792261091382000`（µs = 2026-10-18 02:18:11）；列表见 B4。

### B2. 修复版画幅 / 方向 / 定格复核（重点：旋转是否二次旋转）

| 时间            | 素材                                | 剪映实测                                                                                                                                                                                                                                                                                                                                                                                                      | 截图                                                           |
| --------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 0–2s            | land 320×180                        | 16:9 填满，左上红块；字幕一                                                                                                                                                                                                                                                                                                                                                                                   | 29-fix-editor-opened.png                                       |
| 2–4s            | port 120×200                        | 竖向居中，左右黑边，正向                                                                                                                                                                                                                                                                                                                                                                                      | —                                                              |
| 4–6s            | square 180×180                      | 方形居中，左右黑边                                                                                                                                                                                                                                                                                                                                                                                            | —                                                              |
| **6–8s**        | rot 显示 120×200 + 文件 rotation=90 | 剪映显示 **120×200 竖向，红块在左下，时间戳为旋转方向**；`shasum -a 256`：修复版裁剪图 `28-fix-rotation-canvas-7s-no-double-rotate.png` 与基线 `05-baseline-0214-rotation-7s.png` **完全相同**（均为 `b834722d71bb0588ae9f982cc79e62d6d82fabdda6047f963174d671576a1129`）→ **没有二次旋转、方向与基线一致**；原始 raw 截图 `/tmp/jianying-live/screens/49-fix-rot-canvas.png`、`18-rot-canvas.png` 字节亦相同 | 28-fix-rotation-canvas-7s-no-double-rotate.png                 |
| 8–10s           | img 240×160                         | 3:2 居中，左右黑边                                                                                                                                                                                                                                                                                                                                                                                            | —                                                              |
| 10–11s / 11–12s | freeze_src 视频 + 定格 PNG          | 11.2s 与 11.8s 两帧画布裁剪图 `shasum -a 256` 相同（`e74554e65e11ea21fe631d79e5a33dcd247e78bc33846ce32f24f0bc9a3c6274`），10.3s 不同；基线草稿同一对定格帧哈希也相同（`e74554e6…`）→ 视频在动、定格静止；定格源帧时间戳 00:00.967                                                                                                                                                                             | 30-fix-freeze-11s-full.png（另 30a/30b 为 11.2s/11.8s 裁剪图） |
| 全片            | 素材面板                            | 6 个视觉素材 + voice.wav 全部已添加，无媒体丢失；时间线 00:00:12:00；6 条字幕可编辑                                                                                                                                                                                                                                                                                                                           | 29-fix-editor-opened.png                                       |

结论：修复版把 rot 素材写成显示方向 120×200 后，剪映**没有**按文件 rotation 再转一次；最终画面与基线（写 200×120 时）逐像素一致，方向正确。

### B3. issue 6 修复版：真实鼠标改片段 + 改字幕 → 保存 → 关闭重开 → 退出重启

改前：

- img.png 段 8–10s，标签 `img.png 00:00:02:00`；字幕 1 `验收字幕一：横屏画面`。

操作（真实鼠标，屏幕 pt；编辑器窗口 19,33，时间线标尺 y=585，约 94.08 pt/s）：

1. 裁剪：img.png 右边缘 (1137,773) → 拖动到 (1046,773)。时间线变为 img.png 8–9s（标签 `00:00:01:0…`），9–10s 出现空隙；顶部 `02:20:20 自动保存本地`。
2. 改字幕：点击字幕 1 (300,698) → 右侧「字幕·文本」面板 → 点击文本框 (1169,215) → `Cmd+A` → 粘贴 `修复版改写字幕-0220-XYZ` → 点击时间线空白提交；顶部 `02:21:28 自动保存本地`；画布 0s 显示新文本、字幕轨标签同步。
3. 文件：`draft_info.json` mtime 02:21:28 32744B（剪映加密重写）。
4. 关闭草稿：文件→返回首页 → 气泡「已保存至剪辑草稿」。
5. 关闭后重开：改名后的字幕与裁剪都保留（截图 20-fix-subtitle-trim-reopen-persisted.png，02:21:50 剪映重写 draft_info）。
6. 完全退出重启：`kill -TERM` 主进程 69750（1 秒退出；tray helper 残留不算运行）→ `draft_info.json` mtime 02:22:53，索引里 FIX 条目 `tm_draft_modified` = 02:22:54 → `open` 重启 → 首页重开 FIX：字幕 `修复版改写字幕-0220-XYZ`、img.png 仍 8–9s 且 9–10s 空档，全部保留（截图 21-fix-restart-persisted.png；`shasum -a 256` 与关闭重开后的 `20-fix-subtitle-trim-reopen-persisted.png` 完全相同，均为 `4d78dd52a6d5e6867083b7245c40b99120b9e14718ba82194bd7e01a936d6067`）。

结论：修复版草稿上，真实鼠标裁剪 + 字幕改写提交自动保存，关闭重开与完全退出重启都保留；**修复版同样没有出现回退**，与阶段 A 基线结论一致。

### B4. issue 5 列表日期 / 排序（修复版）

- 首页切列表视图（列 名称/大小/时长/类型/最后修改时间 ↓）：**`修复验收-20261018-FIX` 第一行，1.6M，00:12，最后修改时间 10/18**；其后 0220；再后是用户旧草稿。截图 19-fix-four-drafts-list-dates.png。
- 最终首页列表（六个测试草稿）：KNOWN2 / UNK2 / FREEZE / UNKNOWN / FIX / 0220，全部最后修改时间 10/18，顺序按修改时间倒序。截图 27-final-list-six-test-drafts-1018.png 首屏可见其中四份，其余在滚动区外；六份草稿均在草稿目录和索引里逐一核对。
- 索引值：FIX create 02:18:11（µs），旧草稿条目名称/时间未变；用户旧草稿目录 mtime 保持 01:18 / 01:06，未改动。

### B5. issue 1 补充：5fps、out=0.51s、fitDone 的定格选帧（真实剪映）

- 草稿 `修复验收-20261018-FREEZE`（独立）：5fps 200×120 源，clip in=0/out=0.51s，镜头 1s + fitDone。
- 导出后 `Resources/freeze5fps-freeze-1.png` 画面时间戳为 **00:00:00.400 / 帧号 2**（源第 2 帧，5fps 下最后一帧 PTS < 0.51 就是 0.4s，正确；旧行为会取到 0.6s）。
- 在剪映 11.6.0 打开，把播放头放到定格段（约 0.7s），播放器显示同一帧 **00:00:00.400 / 2**。截图 17-fix-freeze-shows-source-400ms-frame.png。
- 另：该草稿视频段标签 00:00:00:15、定格段 00:00:00:15，总长 00:00:01:00；素材面板两个素材都在线。

### B6. 未知完整源时长：旧代码不能延长；加 packet 推算兜底后可延长到 2s（真实剪映）

源：`/tmp/jianying-live/media/unknown-duration.mp4`（160×120，h264，60 帧/30fps = 2.0s 真实内容；`ffprobe` format 无 duration、stream duration=0，可正常解码）。

旧代码（加兜底前，02:24–02:31 的 UNKNOWN / UNK2 草稿）：

- 导出成功但有 warn `media-duration-unknown`「没能确认完整源时长，进入剪映后可能无法在源范围内继续延长裁剪」；`draft_info` 里素材 duration=1000000（=使用区间 1s），宽高 160×120；剪映素材面板不显示该素材时长。
- 真实鼠标拖右边缘：UNKNOWN (1327,773)→(1420,773)、UNK2 (575,773)→(700,773)，片段都**仍为 00:00:01:00，不能延长**（截图 24-unk2-extend-failed-still-1s.png）。
- 对照 KNOWN2（同布局、land.mp4 已知源 4s）：同样拖动 00:00:01:00 → **00:00:01:10 成功**（截图 26-known2-extend-success-1s-to-1s10.png），证明拖动操作本身有效。

新兜底（ffprobe packet pts/duration_time 推算，本工作区 diff `e5831ee0811e4c43`）：

- 02:34:28 用同一真实入口导出独立新草稿 `修复验收-20261018-0234-EST`（`--project unknown2`，未覆盖 UNK2/KNOWN2），`ok=true registered=true`。
- 明文 `draft_info.json`：该视频素材 **duration = 2000000（≈2s，不是 1s）**，宽高 160×120；时间线使用区间仍 0–1s、1–2s 空档、2–3s 图片（总长 3s）。
- 导出 result issues 新增 info：`media-duration-estimated`「“unknown-duration.mp4”的容器没写总时长，已按视频包时间戳推算为 2.0 秒；进入剪映后仍可在源范围内继续延长裁剪（第 1 句）」；**无** `media-duration-unknown`（导出结果 `/tmp/jianying-live/export-unknown2-est.json`）。
- 剪映 11.6.0 打开新草稿：片段初始 00:00:01:00；真实鼠标拖右边缘 (575,773)→(980,773) 后，片段标签变为 **00:00:02:00（1s → 完整 2s）**，顶部 `02:35:30 自动保存本地`；1–2s 空档仍在，2–3s 图片未被覆盖。截图 31-fix-unknown-duration-extended-to-2s.png（改后）/ 32-fix-unknown-duration-before-extend-1s.png（改前）。
- 结论：packet 时间戳兜底生效——容器没写总时长但可解码的源，导出素材 duration 写为推算的 2.0s，剪映里可在真实 2 秒源范围内拖拽延长到 2s；旧代码只能停在 1s。已知源时长的素材（KNOWN2）同样可延长，操作面一致。

### B7. 测试草稿清单（全部为「修复验收-」新建，未覆盖/删除任何用户草稿）

- `修复验收-20261018-0220`（阶段 A 基线，编辑持久化测试，已改）
- `修复验收-20261018-FIX`（阶段 B 主验收，已改并复核）
- `修复验收-20261018-FREEZE`（5fps 定格选帧）
- `修复验收-20261018-UNKNOWN`（未知时长，1s 单片段）
- `修复验收-20261018-UNK2` / `修复验收-20261018-KNOWN2`（未知时长延长 A/B 对照，旧代码）
- `修复验收-20261018-0234-EST`（packet 推算兜底后的未知时长延长验证；导出结果 `/tmp/jianying-live/export-unknown2-est.json`）
- 用户旧草稿 `分镜台导出验收-产品流程`、`分镜台导出验收-最小样例` 等未打开、未修改、未删除。

### B8. 截图索引（docs/images/jianying-export-fix-2026-10-18/）

01–14 阶段 A 基线；15 修复版列表置顶 10/18；16–17 5fps 定格草稿与 0.4s 帧；18–19 四份测试草稿列表；20–21 修复版编辑持久化（关闭重开 / 退出重启）；22–24 UNK2 未知时长延长失败；25–26 KNOWN2 对照延长成功；27 六份测试草稿最终列表；28–30 修复版编辑器 / 旋转画面 / 定格画面（30a/30b 为 11.2s/11.8s 裁剪图）；31–32 EST 草稿未知时长延长改后/改前。
