# 真实剪映 11.6.0 验收证据（2026-10-18 第二轮：延迟起点 / VFR 长静止定格选帧）

> 本文件是第二轮定格选帧缺陷的现场记录，配合 `docs/jianying-export-acceptance.md` §0 阅读。
> 截图在 `docs/images/jianying-export-fix2-2026-10-18/`。草稿、导出 JSON、素材、参考帧、裁剪图和原始 2× 截图留在 `/tmp/jianying-verify2/`（临时目录，不随仓库提交）。
> 只记录本轮真实做过的事：自动化测试通过、真实导出、剪映 11.6.0 实机打开分别写明，不把自动化当实机。

## 0. 结论摘要

- 第二轮被复现的两个定格选帧缺陷（延迟起点素材、VFR 长静止素材）在修复后的真实导出入口上都已正确：两份草稿 `ok=true`、`freezeCount=1`、无 `freeze-failed`。
- 生成的定格 PNG 与 ffmpeg 按「播放时间 0.4s」（A）/「第一帧 0s」（B）直接抽出的参考帧**逐字节相同**（PNG 文件 sha256 相同，raw rgb24 也相同）；与错误候选帧不同。
- 在真实剪映 11.6.0 里打开两份草稿：A 的定格段显示青绿底 + 3 个白块（第 3 帧 = 播放时间 0.4s），B 的定格段显示蓝底 + 左上白块（第一帧）；定格段内两个播放头位置的画布裁剪图 **sha256 完全相同**，证明真机上是静止画面。
- 越界素材（10s 源、clip in=11/out=12）在真实导出入口里被计划阶段拦下（`block:source-range`），`ok=false`、没有留下草稿目录；`freeze` 层另用真实 ffmpeg 直接验证了 `freeze-no-frame` 且不产出 PNG。详见 §5。
- 导出面板在 11.6.0 上显示 **「剪映 11.6.0 · 已适配」**，`supported=true`、生成按钮可用；版本收窄没有误伤 11.6.0。
- 两个新草稿名：`修复验收2-20261018-DELAYED`、`修复验收2-20261018-VFRGAP`；全程没有修改、覆盖、删除任何用户现有草稿（§10）。
- 本轮只改了 `scripts/jianying-live-verify.mjs` 和新增本文件与截图目录；没有改生产代码、没有提交/推送/发布/安装/覆盖 `/Applications/分镜台.app`、没有创建软件备份。

## 1. 环境与工具

### 1.1 机器 / 剪映 / ffmpeg

- macOS 27.0.1（26A434），Apple 芯片；主屏 1470×956 pt，Retina 2×（窗口截图原始 2×，处理后 1×）。
- Mac 剪映专业版 **11.6.0**，bundle `com.lemon.lvpro`，`/Applications/VideoFusion-macOS.app`（`CFBundleShortVersionString=11.6.0`）。
- 草稿库：`~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`；索引 `root_meta_info.json`。
- ffmpeg / ffprobe **8.1.2**（`/opt/homebrew/bin/ffmpeg`、`/opt/homebrew/bin/ffprobe`）。
- 分镜台开发版本 2.0.9（未安装、未提交、未发布）；验收时 `electron/jianying/frame.js` mtime 为 2026-10-18 09:14:19（Lead 修复完成后）。

### 1.2 GUI 自动化（实际可用方式与上一轮不同）

- Hammerspoon 1.1.1 正在运行，`hs.accessibilityState()=true`。
- **本机 `hs` 命令行不在 PATH 中**：`/opt/homebrew/bin/hs`、`/usr/local/bin/hs` 都不存在；Hammerspoon 包内的 `/Applications/Hammerspoon.app/Contents/Frameworks/hs/hs` 因未加载 `hs.ipc` 报 `can't access Hammerspoon message port Hammerspoon`。
- 因此实机操作的调用方式是 AppleScript（`HSAppleScriptEnabledKey=1`）：

  ```sh
  osascript -e 'tell application "Hammerspoon" to execute lua code "return dofile(\"/tmp/jianying-verify2/lua/jy-seek-xy.lua\")"'
  ```

  lua 脚本通过 `hs.eventtap.leftClick` / `hs.mouse.absolutePosition` 发送真实鼠标事件；所有点击都是屏幕坐标（pt）。
- 焦点干扰：DeepSeek Harness 窗口会浮到最前。每段剪映操作前先判断 `hs.application.frontmostApplication()` 的 bundleID，不是 `com.lemon.lvpro` 就点击剪映窗口底部空白 (700,870) 把它抬到前面；「返回首页」需要在剪映前台点菜单（见 §6）。
- 剪映窗口坐标（CGWindowList / `hs.window:frame()`，屏幕 pt）：首页 `151,106,1168,780`；编辑器 `19,33,1450,903`。截窗口图：`screencapture -x -o -l <windowID> raw.png`，再 `sips -z` 缩到 1×（编辑器 1450×903，首页 1168×780）。
- 时间线标尺（3s 项目，编辑器窗口内坐标）：`0:00` 约 x=191.5，`1s` 约 +388pt；标尺 y≈549（窗口坐标，屏幕 y≈582）。点击屏幕坐标 = 窗口内坐标 + (19,33)。

### 1.3 分镜台导出面板截图方式

- 用 dev 实例（**不是**安装版本、**不是**用户数据）起一个可见窗口：

  ```sh
  node_modules/.bin/electron --remote-debugging-port=9224 . --preview   # --preview 用临时 userData
  ```

- 通过 Chromium 调试端口连 renderer，用公开应用接口把一个 3s 测试项目装进状态，再调用应用内「导出到剪映」入口（`openJianyingExport()`），等待真实 IPC 检测完成。
- 面板截图是 **Chromium 页面元素截图**（`.modal.jy-modal`），不是桌面窗口截图；内容就是应用真实渲染的面板与真实检测结果。截图后实例被结束（`SIGTERM`）。

## 2. 素材合成与参考帧

素材目录：`/tmp/jianying-verify2/media/`，由 `scripts/jianying-live-verify.mjs` 的 `buildVerify2Media()` 生成（`--prepare-only` 只生成素材和 ffprobe 报告，不启动 Electron）。每帧画面刻意做成可区分：geq 色块 + 顶部白色方块条数编码帧序号（第 N 帧画 N+1 个白块），第 0 帧不是纯黑，失败黑帧一眼可辨。

### 2.1 A：延迟起点素材 `delayed-5fps-start2.mp4`

- 120×200，5fps，输入 1s；`setpts=PTS+2/TB`、`-fps_mode vfr`、`-video_track_timescale 1000000`，无损 H.264。
- 帧色：R=40+40N、G=120+30N、B=220-25N；第 0 帧蓝，第 2 帧青绿（正确帧），第 3 帧浅绿（旧实现可能取到的 0.6s 帧）。

```sh
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=black:s=120x200:r=5:d=1" \
  -vf "geq=r='mod(40+N*40,256)':g='mod(120+N*30,256)':b='mod(220-N*25,256)',\
drawbox=x=0:y=0:w=iw:h=ih:color=white:t=4,\
drawbox=x=8:y=8:w=16:h=16:color=white:t=fill:enable='gte(n,0)',\
drawbox=x=30:y=8:w=16:h=16:color=white:t=fill:enable='gte(n,1)',\
drawbox=x=52:y=8:w=16:h=16:color=white:t=fill:enable='gte(n,2)',\
drawbox=x=74:y=8:w=16:h=16:color=white:t=fill:enable='gte(n,3)',\
drawbox=x=96:y=8:w=16:h=16:color=white:t=fill:enable='gte(n,4)',\
setpts=PTS+2/TB" \
  -c:v libx264 -qp 0 -pix_fmt yuv420p -video_track_timescale 1000000 -fps_mode vfr \
  delayed-5fps-start2.mp4
```

### 2.2 B：VFR 长静止素材 `vfr-gap-15s.mp4`

- 120×200，输入 30fps / 10s；`setpts='if(eq(N,0),0,PTS+5/TB)'`、`-fps_mode vfr`。
- 第 0 帧 PTS=0，下一帧 5.033333s，之后每 1/30s 一帧，最后一帧 14.966667s，文件总长 15s。
- 帧画面：第 0 帧蓝底 + 左上 30×30 白块；第 1 帧起橙底 + 右下 30×30 黑块。错误实现若取 5.033s 后一帧会看到橙/黑块。

```sh
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=black:s=120x200:r=30:d=10" \
  -vf "geq=r='if(eq(N,0),20,230)':g='if(eq(N,0),110,120)':b='if(eq(N,0),240,30)',\
drawbox=x=0:y=0:w=iw:h=ih:color=white:t=4,\
drawbox=x=8:y=8:w=30:h=30:color=white:t=fill:enable='eq(n,0)',\
drawbox=x=82:y=162:w=30:h=30:color=black:t=fill:enable='gt(n,0)',\
setpts='if(eq(N,0),0,PTS+5/TB)'" \
  -c:v libx264 -qp 0 -pix_fmt yuv420p -video_track_timescale 1000000 -fps_mode vfr \
  vfr-gap-15s.mp4
```

### 2.3 越界素材 `out-of-range-10s-source.mp4`

- 120×200、30fps、10s 纯视频（灰底 + 红块 + 白框），用于 clip in=11/out=12 的报错验证。

```sh
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x404040:s=120x200:r=30:d=10" \
  -vf "drawbox=x=20:y=60:w=80:h=80:color=0xCC0000:t=fill,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=4" \
  -c:v libx264 -qp 0 -pix_fmt yuv420p -video_track_timescale 1000000 \
  out-of-range-10s-source.mp4
```

### 2.4 ffprobe 记录（`/tmp/jianying-verify2/media/probe-report.json`）

| 素材                       | format.start_time | format.duration | 视频流 start/duration | avg / r fps | 帧数 | 帧 PTS 开头                   | 帧 PTS 末尾              |
| -------------------------- | ----------------- | --------------- | --------------------- | ----------- | ---- | ----------------------------- | ------------------------ |
| delayed-5fps-start2.mp4    | 2.000000          | 1.000000        | 2.000000 / 1.000000   | 5/1 / 5/1   | 5    | 2.0, 2.2, 2.4, 2.6, 2.8      | 2.8                      |
| vfr-gap-15s.mp4            | 0.000000          | 15.000000       | 0.000000 / 15.000000  | 20/1 / 30/1 | 300  | 0, 5.033333, 5.066667, 5.1   | 14.933333, 14.966667     |
| out-of-range-10s-source.mp4| 0.000000          | 10.000000       | 0.000000 / 10.000000  | 30/1 / 30/1 | 300  | 0, 0.033333, 0.066667, 0.1    | 9.933333, 9.966667       |

A 的 format.start_time=2、duration=1、帧原始 PTS 2/2.2/2.4/2.6/2.8；B 第一帧 0、下一帧 5.033333、总长 15s —— 与任务要求一致。

### 2.5 参考帧（用 ffmpeg 直接按帧序号抽取，不经过产品代码）

```sh
# A：第 3 帧（索引 2）= 播放时间 0.4s，原始 PTS 2.4
ffmpeg -y -i media/delayed-5fps-start2.mp4 -vf "select=eq(n\,2)" -fps_mode passthrough -frames:v 1 ref/ref-A-frame2-0.4s.png
# B：第 1 帧（索引 0）= PTS 0，它在 0–5.033s 一直可见
ffmpeg -y -i media/vfr-gap-15s.mp4 -vf "select=eq(n\,0)" -fps_mode passthrough -frames:v 1 ref/ref-B-frame0.png
# 反例：B 第 2 帧（索引 1，PTS 5.033s，错误实现可能取到）
ffmpeg -y -i media/vfr-gap-15s.mp4 -vf "select=eq(n\,1)" -fps_mode passthrough -frames:v 1 ref/B-frame1-wrong.png
```

| 参考帧                       | 尺寸    | PNG sha256                                                       | raw rgb24 sha256                                                 | 1×1 RGB       | 画面                     |
| ---------------------------- | ------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------------- | ------------------------ |
| ref-A-frame2-0.4s.png        | 120×200 | 512b74b03293cd0d91490d39387de309f807dc4239994b5b17c637ea4e567991 | d8467acc82ff7ec0f8ef933a99aafc5ba7cdb83a1b4ba26235bb7cb4c83a552e | 132,188,179   | 青绿底 + 3 个白块（第 3 帧） |
| ref-B-frame0.png             | 120×200 | 8a00dd5df20c5d1d0fa8dd5bf956fdf4a0460ea8fd5bf4484b73921aca33c54b | 87e1743520b1c93483dc10442c7a903265ce4858b48c27bc9bbfd191f0a569fc | 45,126,242    | 蓝底 + 左上 1 个白块（第 1 帧） |
| B-frame1-wrong.png（反例）   | 120×200 | d92debdf9f31746231f7028cf15e65947513d93ea48620c568d16a05dba04ba3 | a7705f7d97627d5592a12775efd115366ca5ff72f90e95c0d3666f0f7686e68b | 222,124,42    | 橙底 + 右下黑块（5.033s 后一帧） |

raw 哈希算法：`ffmpeg -v error -i <png> -f rawvideo -pix_fmt rgb24 - | shasum -a 256`（只比像素，不受 PNG 编码器差异影响）。

## 3. 修复后的真实导出

### 3.0 旧行为与新行为（如实标注来源）

- 旧行为（本轮**没有**重新运行旧实现，仅作背景）：旧选帧不统一播放时间基准——延迟起点素材（`format.start_time=2`）的原始 PTS 2.0–2.8 被当成播放时间 0–0.8s 使用，在 0–0.51s 区间扫不到正确帧或取错帧；VFR 长间隔素材按出点附近 seek 时，会落到 5.033s 之后的那一帧而不是第一帧。旧 `electron/jianying/frame.js` 是未跟踪的新文件、09:14:19 起已是修复版，工作区没有旧实现快照；旧行为依据 Lead 的复现和自动化测试，本文件不把它写成自己的实测。
- 新行为（本轮实测）：`frame.js` 用「播放时间 = 原始 PTS − format.start_time」统一基准；扫描窗口找不到帧时向源文件开头成倍扩大；最后一帧可见到媒体结束。真实导出结果见 §3.2–§4，实机复核见 §6。

### 3.1 代码状态（Lead 修复，本轮未改生产代码）

- `electron/jianying/frame.js`（mtime 09:14:19）：统一播放时间基准（播放时间 = 原始 PTS − format.start_time）；扫描窗口找不到帧时向源文件开头成倍扩大；最后一帧可见到媒体结束。
- `electron/jianying/platform.js`（mtime 08:42:25）：可用版本收窄到 `11.6.0`。
- 本轮验收成员只改了 `scripts/jianying-live-verify.mjs`（新增 `--project delayed|vfr-gap|bounds`、`--prepare-only`、草稿名/重名/剪映运行检查、导出后草稿只读清单）；没有改生产代码。
- 本次导出发生在 Lead 通知「修复已完成，可以开始阶段 2」之后；工作区 `git diff | shasum` 前 16 位 `39c4a13d376c3ed2`（09:24 记录），`git status --porcelain` 与文件清单见 §10。

### 3.2 真实导出命令与结果

导出前确认剪映主应用未运行（只剩 tray helper）。走真实链路：隐藏 Electron `--selftest`（临时 userData、`FJT_DEBUG_PORT=9223`）→ `captureExportSnapshot → prepareJianyingExport → startPreparedJianyingExport` → 真实 IPC → library 模式写入真实剪映草稿库并登记索引。

```sh
env -u ELECTRON_RUN_AS_NODE FJT_DEBUG_PORT=9223 \
  node scripts/jianying-live-verify.mjs --project delayed \
  --draft-name "修复验收2-20261018-DELAYED" \
  --out /tmp/jianying-verify2/export-delayed.json --no-subtitles

env -u ELECTRON_RUN_AS_NODE FJT_DEBUG_PORT=9223 \
  node scripts/jianying-live-verify.mjs --project vfr-gap \
  --draft-name "修复验收2-20261018-VFRGAP" \
  --out /tmp/jianying-verify2/export-vfr-gap.json --no-subtitles
```

| 草稿                          | 导出时间（+08）        | ok  | registered | freezeCount | segments / assets | issues                                   |
| ----------------------------- | ---------------------- | --- | ---------- | ----------- | ----------------- | ---------------------------------------- |
| 修复验收2-20261018-DELAYED    | 2026-10-18 09:17:33.73 | 是  | 是         | **1**       | 2 / 1             | 仅 info `no-voice`（项目没有口播）        |
| 修复验收2-20261018-VFRGAP     | 2026-10-18 09:17:48.89 | 是  | 是         | **1**       | 2 / 1             | 仅 info `no-voice`（项目没有口播）        |

- 两份结果都没有 `freeze-failed` / `source-out-of-range` / `media-*` 问题；草稿里各 1 张定格图。
- 计划里的定格派生（JSON 可查）：
  - DELAYED：`sourceInUs=0`、`sourceOutUs=510000`、`atUs=476667`、`outputName=delayed-5fps-start2-freeze-1.png`
  - VFRGAP：`sourceInUs=2000000`、`sourceOutUs=3000000`、`atUs=2966667`、`outputName=vfr-gap-15s-freeze-1.png`
- 导出报告 `fenjingtai-export.json` 的 `target.version` 均为 `11.6.0`；`stats.freezeFrames=1`；`registered=true`。

### 3.3 草稿结构与素材登记（明文 `draft_info.json`，打开前）

| 草稿                       | 草稿目录                                                                                   | Resources                                                     | 视频素材登记                            | 定格 PNG 登记                  | 画布 / 总长        |
| -------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------- | ------------------------------ | ------------------ |
| 修复验收2-20261018-DELAYED | `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/修复验收2-20261018-DELAYED` | `delayed-5fps-start2.mp4`（3386B）+ `delayed-5fps-start2-freeze-1.png`（590B） | 120×200，duration=1000000µs，has_audio=false | 120×200，photo，duration=1080000000µs | 1920×1080 / 3000000µs |
| 修复验收2-20261018-VFRGAP  | `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/修复验收2-20261018-VFRGAP`  | `vfr-gap-15s.mp4`（10958B）+ `vfr-gap-15s-freeze-1.png`（582B）             | 120×200，duration=15000000µs，has_audio=false | 120×200，photo，duration=1080000000µs | 1920×1080 / 3000000µs |

- 视频 duration 写的是完整源时长（A=1s、B=15s），不是本次使用区间（A=0.51s、B=1s），保留了进剪映后继续延长裁剪的空间。
- 时间线都是 2 段：视频段 + 定格 PNG 段；A 视频 0–0.51s、定格 0.51–3s；B 视频 0–1s（源 2–3s）、定格 1–3s。
- 剪映打开草稿后会把 `draft_info.json` 写成加密 ASCII（A 6884B / B 6864B），并生成 `.backup/`、`Timelines/` 等；**Resources 里的定格 PNG 与源 MP4 没有被改写**（mtime 仍是 09:17，大小 590/582B，哈希见 §4）。

### 3.4 索引登记（`root_meta_info.json`，只读）

| 草稿                       | tm_draft_create（µs） | 对应本地时间（+08）    | 打开后 tm_draft_modified（µs） | 对应本地时间（+08）    |
| -------------------------- | --------------------- | ---------------------- | ------------------------------ | ---------------------- |
| 修复验收2-20261018-DELAYED | 1792286253711000      | 2026-10-18 09:17:33.711 | 1792286390196313               | 2026-10-18 09:19:50.196 |
| 修复验收2-20261018-VFRGAP  | 1792286268873000      | 2026-10-18 09:17:48.873 | 1792286445296424               | 2026-10-18 09:20:45.296 |

首页列表视图实测：两份草稿在**第一、二行**，大小 108.0K / 98.6K，时长 00:03，类型「草稿」，最后修改时间 **10/18**（截图 02）。

## 4. 定格 PNG 与参考帧比对

### 4.1 A（延迟起点）：预期播放时间 0.4s 帧

- 导出结果：`Resources/delayed-5fps-start2-freeze-1.png`，590B。
- 与 `ref/ref-A-frame2-0.4s.png` **文件 sha256 完全相同**：`512b74b0…4e567991`；raw rgb24 也相同：`d8467acc…c83a552e`；1×1 RGB 均为 `(132,188,179)`；120×200。
- 与错误候选第 4 帧（0.6s，`A-frame3.png`，sha `f2f7c0cd6ad5109f4dbbaae18b7a162fd5c5b909c8b4417d89065a932cc2fe2b`）不同。
- 结论：真实导出的定格图就是「素材播放时间 0.4 秒 / 原始 PTS 2.4」那一帧，不是 0.6s 帧。

![左：A 参考帧（播放时间 0.4s）；右：剪映定格段的画布显示](images/jianying-export-fix2-2026-10-18/14-delayed-reference-vs-jianying.png)

### 4.2 B（VFR 长静止）：预期第一帧

- 导出结果：`Resources/vfr-gap-15s-freeze-1.png`，582B。
- 与 `ref/ref-B-frame0.png` **文件 sha256 完全相同**：`8a00dd5d…aca33c54b`；raw rgb24 也相同：`87e17435…f0a569fc`；1×1 RGB 均为 `(45,126,242)`；120×200。
- 与错误候选（5.033s 后一帧，橙底黑块，`B-frame1-wrong.png`，raw sha `a7705f7d…7686e68b`）不同。
- 结论：真实导出的定格图是第一帧（0–5.033s 一直可见），不是间隔后的 5.033s 帧。

![左：B 参考帧（第一帧）；右：剪映定格段的画布显示](images/jianying-export-fix2-2026-10-18/15-vfrgap-reference-vs-jianying.png)

## 5. 越界素材的报错实测

### 5.1 真实导出入口（结果：计划阶段拦下，无草稿）

命令（同样走真实导出入口；草稿名仍以「修复验收2-」开头，脚本预检名字不与已有草稿重复）：

```sh
env -u ELECTRON_RUN_AS_NODE FJT_DEBUG_PORT=9223 \
  node scripts/jianying-live-verify.mjs --project bounds \
  --draft-name "修复验收2-20261018-BOUNDS" \
  --out /tmp/jianying-verify2/export-bounds.json --no-subtitles
```

实测（`/tmp/jianying-verify2/export-bounds.json`，09:18:02）：

- `ok=false`，`error=有 1 项阻塞问题，先在分镜台里处理后再导出`；没有 `draftDir/draftName`，`inspectDraft` 为 `exists:false`。
- 阻塞问题：`block:source-range`，`rowId=B1`、`lineNo=1`、`assetId=vBounds`，文案「`out-of-range-10s-source.mp4` 的片段超出文件时长，导出只取文件里有的部分」；另有一条 info `no-voice`。
- 草稿库里没有 `修复验收2-20261018-BOUNDS` 目录，索引里也没有该条目 → **没有留下草稿、没有产出定格图**。
- 如实说明：这次是计划层（渲染层）先发现 `clip.out=12s > 源时长 10s` 并拦下，还没有走到主进程的定格抽帧；原因是我没有给这个素材伪造更长的时长元数据。它验证的是「越界请求不会生成草稿」这一最终用户可见结果。

### 5.2 `freeze` 层直接实测（真实 ffmpeg，但不经过 exporter）

对同一个真实文件直接调用 `electron/jianying/frame.js` 的 `extractFreezeFrame`：

| 请求区间（播放时间）  | 结果             | 错误码 / 信息                                                                 | 是否产出 PNG |
| --------------------- | ---------------- | ----------------------------------------------------------------------------- | ------------ |
| in=10.5s, out=11s     | 抛错             | `freeze-no-frame`：源视频播放时间只有 10.000 秒，入点 10.500 秒 已经在源文件结束之后 | 否           |
| in=11s, out=12s       | 抛错             | `freeze-no-frame`：源视频播放时间只有 10.000 秒，入点 11.000 秒 已经在源文件结束之后 | 否           |

- 说明：这是模块级真实抽帧调用，用于确认 `freeze-no-frame` 的最终防线仍会报错且不写文件；它**不是**一次成功的「exporter 走到 freeze 阶段后报错」的实机记录。exporter 侧的 `freeze-no-frame` 由 Lead 的自动化测试覆盖（未在本轮实机重放）。

## 6. 剪映 11.6.0 实机复核

### 6.1 打开方式

- 启动：`open /Applications/VideoFusion-macOS.app`，等待约 9s；首页窗口 `151,106,1168,780`，首页「本地草稿」第一行即 `修复验收2-…RGAP` / `…AYED`（截图 01）。
- 双击草稿卡片打开（卡片中心屏幕坐标约 (558,675)，实际是第二张卡片，打开后等 5.5s），编辑器窗口 `19,33,1450,903`。
- 播放头：点击时间线标尺。3s 项目，`0:00` 在窗口 x≈191.5，1s≈388pt；点击屏幕 x = 19 + 191.5 + t×388，屏幕 y=582。点击后先看播放器时间码确认落点，再截图。
- 每段操作前先把剪映抬到前台；「返回首页」用菜单：点屏幕 (89,10) 打开「文件」，再点 (70,97)「返回首页」，等约 2.2s。若前台不是剪映，菜单点击会失败（本轮遇到过 1 次，重新激活后成功）。
- 截图原始 2×，缩到 1× 后存 `docs/images/jianying-export-fix2-2026-10-18/`。

### 6.2 A（DELAYED）实机显示

- 打开时播放头在 0s：画布显示蓝底 + 左上 1 个白块（视频段第一帧，正确），时间线两段：`delayed-5fps-start2.mp4 00:00:00:15`、`delayed-5fps-start2-freeze-1.png 00:00:02:15`，总长 00:00:03:00（截图 03）。
- 播放头 00:00:01:08（≈1.27s，位于定格段）：画布显示**青绿底 + 顶部 3 个白块**，与参考帧（第 3 帧 = 播放时间 0.4s）一致（截图 04）。
- 播放头 00:00:02:18（2.6s，仍在定格段）：画面与上一张相同（截图 05）。
- 静止证明：两张原始截图按同一区域（原始 2× 像素 `crop=416:708:1248:160`，即 120×200 定格画面显示区）裁剪，PNG sha256 **完全相同**：`5abeb3e09e75edcf7c3be140b58b5d393fcbf19765ac07f76f7c0ea3bb63f199`（截图 06、07）；0s 的视频帧裁剪图不同（`c01d6e225af326231454a725e1639bbd28a15991e281cb09399968c5beb32efa`）。
- 显示颜色：定格段画布裁剪图 1×1 平均 RGB=(145,188,180)，与定格 PNG 的 (132,188,179) 同色系，差异来自剪映显示缩放/色彩处理；白块数量与位置一致。

![DELAYED 在剪映 11.6.0 定格段（播放头 00:00:01:08）：青绿底 + 3 个白块](images/jianying-export-fix2-2026-10-18/04-delayed-freeze-1p27s.png)

### 6.3 B（VFRGAP）实机显示

- 打开时播放头 0s：画布显示蓝底 + 左上 1 个白块（第一帧），时间线：`vfr-gap-15s.mp4 00:00:01:00`、`vfr-gap-15s-freeze-1.png 00:00:02:00`，总长 3s（截图 08）。
- 播放头 00:00:01:17（≈1.57s，定格段内）：画布显示 **蓝底 + 左上 1 个白块**，与参考帧（第一帧）一致（截图 09）。
- 播放头 00:00:02:18（2.6s）：画面相同（截图 10）。
- 静止证明：同一显示区（裁剪 `crop=416:708:1248:160`）两张裁剪图 sha256 完全相同：`19da3087e0f75874c14be4911d55ec25afbbe5ddedc8417f9490581b7fdf6eb7`（截图 11、12）；0s 的视频帧裁剪图不同（`4088a331a042914ac172c4f373b989d8c25c5b97bf708680594d3450d7869253`）。
- 观察（不是缺陷结论）：剪映时间线上 `vfr-gap-15s.mp4` 片段缩略图显示的是橙底 + 右下黑块（5.033s 后一帧），而播放器在 0s 和定格段显示的是蓝底第一帧。该不一致来自剪映自己的缩略图取帧；定格 PNG 与播放器画面均正确。

![VFRGAP 在剪映 11.6.0 定格段（播放头 00:00:01:17）：蓝底 + 左上白块](images/jianying-export-fix2-2026-10-18/09-vfrgap-freeze-1p57s.png)

### 6.4 退出

- 打开两份草稿并截图后，用主进程 `kill -TERM 84137` 退出剪映（约 09:21，索引最后修改 09:20:45 之后）；1–2s 内主进程退出，只剩 `VideoFusion-macOSTrayHelper`（pid 68595，不算运行）。没有用 `pkill -9`。
- 之后又用分镜台 dev 实例截导出面板（§7），结束时剪映主应用保持退出状态。

## 7. 分镜台导出面板：11.6.0 · 已适配

- 截图 13：`13-app-export-panel-11.6.0-adapted.png`。面板显示：
  - 标题「导出到剪映」；状态条 **「剪映 11.6.0 · 已适配」**，补充「草稿会出现在剪映『本地草稿』」；
  - 草稿名 `修复验收2-面板截图项目`；保存方式默认「加入本机剪映草稿」；
  - 素材复制行「约 0.1 MB · 另生成 1 张定格图」；画面摘要「1 个镜头 · 2 个片段 · 含 1 段定格；总时长 00:03.0」；
  - 「生成剪映草稿」按钮可用（`disabled=false`）。
- 真实 IPC 检测结果（`/tmp/jianying-verify2/panel-state.json`）：`ok=true`、`version="11.6.0"`、`supported=true`、`running=false`、`canRegister=true`、`appPath=/Applications/VideoFusion-macOS.app`、`draftRoot=~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft`、`issues=[]`。指纹来源 `subdraft`、`platform.app_version=11.6.0`。
- 结论：`platform.js` 版本收窄到 11.6.0 后，本机 11.6.0 仍被判定为已适配，面板与生成入口正常，没有被误伤。

![分镜台导出面板：剪映 11.6.0 · 已适配](images/jianying-export-fix2-2026-10-18/13-app-export-panel-11.6.0-adapted.png)

## 8. 截图索引（`docs/images/jianying-export-fix2-2026-10-18/`）

| 文件                                          | 内容                                                                 | sha256（前 16 位） |
| --------------------------------------------- | -------------------------------------------------------------------- | ------------------ |
| [01-jianying-home-grid-two-new-drafts.png](images/jianying-export-fix2-2026-10-18/01-jianying-home-grid-two-new-drafts.png)      | 剪映首页网格：两份「修复验收2-」草稿在第一行                       | c9888839268c2ef3   |
| [02-jianying-home-list-names-dates.png](images/jianying-export-fix2-2026-10-18/02-jianying-home-list-names-dates.png)         | 首页列表视图：完整草稿名、大小 108.0K/98.6K、00:03、最后修改 10/18 | 654c10d3e6a4679f   |
| [03-delayed-editor-opened-0s.png](images/jianying-export-fix2-2026-10-18/03-delayed-editor-opened-0s.png)               | DELAYED 打开时（0s）：视频第一帧 + 两段时间线                       | 337a69cc734432d9   |
| [04-delayed-freeze-1p27s.png](images/jianying-export-fix2-2026-10-18/04-delayed-freeze-1p27s.png)                   | DELAYED 播放头 00:00:01:08，定格段画面（青绿 + 3 白块）             | f47fe4ea569ee93e   |
| [05-delayed-freeze-2p6s.png](images/jianying-export-fix2-2026-10-18/05-delayed-freeze-2p6s.png)                    | DELAYED 播放头 00:00:02:18，同一画面                                | 8b91901ea5c35cc2   |
| [06-delayed-freeze-canvas-1p27s.png](images/jianying-export-fix2-2026-10-18/06-delayed-freeze-canvas-1p27s.png)            | 04 的画布显示区裁剪图                                               | 5abeb3e09e75edcf   |
| [07-delayed-freeze-canvas-2p6s.png](images/jianying-export-fix2-2026-10-18/07-delayed-freeze-canvas-2p6s.png)             | 05 的同一显示区裁剪图（与 06 完全相同）                             | 5abeb3e09e75edcf   |
| [08-vfrgap-editor-opened-0s.png](images/jianying-export-fix2-2026-10-18/08-vfrgap-editor-opened-0s.png)                | VFRGAP 打开时（0s）：第一帧 + 两段时间线                            | f610f9de565f2555   |
| [09-vfrgap-freeze-1p57s.png](images/jianying-export-fix2-2026-10-18/09-vfrgap-freeze-1p57s.png)                    | VFRGAP 播放头 00:00:01:17，定格段画面（蓝 + 左上白块）              | ffde58a1a14a0898   |
| [10-vfrgap-freeze-2p6s.png](images/jianying-export-fix2-2026-10-18/10-vfrgap-freeze-2p6s.png)                     | VFRGAP 播放头 00:00:02:18，同一画面                                 | 4da27c384d298987   |
| [11-vfrgap-freeze-canvas-1p57s.png](images/jianying-export-fix2-2026-10-18/11-vfrgap-freeze-canvas-1p57s.png)             | 09 的画布显示区裁剪图                                               | 19da3087e0f75874   |
| [12-vfrgap-freeze-canvas-2p6s.png](images/jianying-export-fix2-2026-10-18/12-vfrgap-freeze-canvas-2p6s.png)              | 10 的同一显示区裁剪图（与 11 完全相同）                             | 19da3087e0f75874   |
| [13-app-export-panel-11.6.0-adapted.png](images/jianying-export-fix2-2026-10-18/13-app-export-panel-11.6.0-adapted.png)        | 分镜台导出面板「剪映 11.6.0 · 已适配」                              | b9f6b0fb9b253112   |
| [14-delayed-reference-vs-jianying.png](images/jianying-export-fix2-2026-10-18/14-delayed-reference-vs-jianying.png)          | 左：A 参考帧；右：剪映定格段画布裁剪（并排）                        | 6ae5979005477bf9   |
| [15-vfrgap-reference-vs-jianying.png](images/jianying-export-fix2-2026-10-18/15-vfrgap-reference-vs-jianying.png)           | 左：B 参考帧；右：剪映定格段画布裁剪（并排）                        | f6e11f2fdc637577   |
| [16-delayed-freeze-png-resource.png](images/jianying-export-fix2-2026-10-18/16-delayed-freeze-png-resource.png)            | 草稿 Resources 里的 A 定格 PNG（与参考帧字节相同）                  | 512b74b03293cd0d   |
| [17-vfrgap-freeze-png-resource.png](images/jianying-export-fix2-2026-10-18/17-vfrgap-freeze-png-resource.png)             | 草稿 Resources 里的 B 定格 PNG（与参考帧字节相同）                  | 8a00dd5df20c5d1d   |

完整 sha256 可用 `cd docs/images/jianying-export-fix2-2026-10-18 && shasum -a 256 *.png` 复核；原始 2× 窗口截图、画布裁剪原图、参考帧与导出 JSON 在 `/tmp/jianying-verify2/`。

## 9. 自动化 / 实机 / 未覆盖

**本机实机做过的：**

- 真实导出入口（真实 IPC、真实草稿库、library 登记）生成两份新草稿，结果 JSON 与剪映明文 `draft_info` 均核对。
- ffmpeg 参考帧 vs 草稿内定格 PNG 的字节/像素比对。
- 剪映 11.6.0 打开两份草稿，播放头定位、截图、两时间点裁剪图哈希对比。
- 分镜台导出面板在 11.6.0 上的真实 IPC 检测状态与面板截图。
- 越界素材的真实导出请求被拦下（计划阶段），无草稿残留。
- 直接调用 `frame.extractFreezeFrame`（真实 ffmpeg）验证 `freeze-no-frame` 且不写文件。

**自动化（本轮未亲自重跑，由 Lead 报告）：**

- `freeze` 9 项、`media` 19 项（含这两类素材 `buildEditExportPlan → runJianyingExport` folder 全链路）、`files` 33 项通过。
- 本轮实机前最后改动为 `frame.js`（09:14:19）与 `platform.js`（08:42:25）；之后未再改生产代码。
- 验收成员自己跑了 `env -u ELECTRON_RUN_AS_NODE npm run lint`：通过（架构检查 151 个模块无循环依赖 + eslint 无报错）；未运行 `npm test`/`test:data`。

**未覆盖 / 限制：**

- 只实测剪映 **11.6.0**；11.6.1、11.6.99、11.7.x 等未验证，不能推断兼容。
- 画布固定 1920×1080 / 30fps；素材为 120×200 合成视频；无口播、无字幕、无备选素材；每个项目只有 1 句 3s 镜头。
- 越界素材是计划阶段拦下的；没有构造「容器时长足够长、视频内容越界」的变体去强制 exporter 进入 freeze 阶段（`freeze-no-frame` 的 exporter 路径由自动化覆盖）。
- 打开草稿后剪映会把 `draft_info` 加密重写；本轮没有验证在剪映里继续编辑/保存后再由分镜台覆盖的往返流程（与本轮缺陷无关）。
- GUI 操作用 Hammerspoon 合成鼠标/键盘事件（真实应用、真实坐标），不是人手逐步操作；截图经 `sips` 缩到 1×，颜色比较受缩放/色彩处理影响，最终内容一致性以 PNG 字节/raw 哈希为准。
- 导出面板截图是 dev 实例（`--preview`，临时 userData）的 Chromium 页面截图，不是桌面窗口截图；未使用安装版 `/Applications/分镜台.app`。
- 本轮没有做 Release、没有打包、没有安装、没有改 `/Applications/分镜台.app`。

## 10. 用户草稿与仓库保护

- 只新建了两个名字以「修复验收2-」开头的独立测试草稿：`修复验收2-20261018-DELAYED`、`修复验收2-20261018-VFRGAP`；越界请求没有生成草稿。
- 导出脚本对本轮项目强制：草稿名必须以「修复验收2-」开头；目标目录或索引里已有同名条目就拒绝导出（不会覆盖同名草稿）。`--project delayed|vfr-gap` 的默认名字也带该前缀。
- 用户草稿只读未动：`分镜台导出验收-产品流程`（目录 mtime 10/18 01:18:15）、`分镜台导出验收-最小样例`（01:06:00）、`10月16日`（00:07:27）、`10月15日`（10/15 21:27:49）、`9月5日`（10/18 01:08:53）等目录 mtime 均早于本次 09:17 导出，未打开、未修改、未删除；索引里这些条目的名称和创建/修改时间（最近一条 01:16）都早于本次验收，未出现 09:17 之后的新时间。
- 本轮没有备份、提交、推送、打包、安装或覆盖应用，也没有删除旧版本/旧目录。
- 新建草稿是验收工作数据，保留在剪映草稿库；本轮结束后剪映主应用已退出（tray helper 可留）。

## 11. 复现与落盘位置

```sh
# 只合成素材 + 记录 ffprobe（不启动 Electron、不导出）
node scripts/jianying-live-verify.mjs --project delayed --prepare-only
node scripts/jianying-live-verify.mjs --project vfr-gap --prepare-only
node scripts/jianying-live-verify.mjs --project bounds --prepare-only

# 真实导出（先退出剪映主应用；脚本会拒绝重名草稿）
env -u ELECTRON_RUN_AS_NODE FJT_DEBUG_PORT=9223 \
  node scripts/jianying-live-verify.mjs --project delayed \
  --draft-name "修复验收2-20261018-DELAYED" \
  --out /tmp/jianying-verify2/export-delayed.json --no-subtitles
```

- 素材 / 参考帧 / 导出 JSON / 面板状态：`/tmp/jianying-verify2/media/`、`ref/`、`export-delayed.json`、`export-vfr-gap.json`、`export-bounds.json`、`panel-state.json`。
- 原始 2× 窗口截图与画布裁剪：`/tmp/jianying-verify2/screens/`；整理后的 1× 截图：`docs/images/jianying-export-fix2-2026-10-18/`。
- 实机操作的 Hammerspoon lua 与包装脚本：`/tmp/jianying-verify2/lua/`、`/tmp/jianying-verify2/hs.sh`（通过 AppleScript `dofile` 调 Hammerspoon；不属于仓库文件）。
- 本文件：`docs/jianying-export-fix2-evidence-2026-10-18.md`。
- 脚本改动：`scripts/jianying-live-verify.mjs`（新增 `--project delayed|vfr-gap|bounds`、`--prepare-only`、草稿名前缀/重名/剪映运行检查、导出后草稿资源清单；不接入 npm test）。
