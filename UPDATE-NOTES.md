# 分镜台 1.9.3

- 打开或关闭「画面与素材」时，保持当前正在看的句子在屏幕上的位置，减少正文重新换行引起的跳动。
- 表格、共用画面组和原文视图使用同一规则；已选句在屏幕外时，继续保持当前阅读位置。
- 章节目录高亮跟随正文浏览位置。
- 视频审核预览显示片段进度、对应口播字幕和句子分界；候选可指定配哪几句，批量保存进度更清楚。
- 截取空片段时检查结果并尝试顺序读取，避免把无画面的视频当成保存成功。

---

# 分镜台 1.9.2

- 视频审核通过的候选都设为主画面；原来的占位素材让位为备选，其他已通过视频保持主画面。
- 表格中的长画面描述收起为四行，点击编辑时展开全文。
- 「播放这段」一次点击即可加载播放，按钮显示加载和播放失败状态。
- 截取视频片段显示百分比，批量保存显示当前片段序号和进度。

---

# 分镜台 1.9.1

- 新保存的视频片段和下载的完整原片，文件名前加当前画面的句号范围。
- 打开旧项目时，给已保存、尚无句号的片段在原文件夹内补上句号，并同步更新素材路径及候选清单；缺失文件跳过，重名不覆盖。
- 表格重渲染后保持当前可见句子的位置，减少长稿视口跳动。
- 回归测试覆盖命名、旧片段改名和界面交互。

---

# 分镜台 1.9.0

视频审核改成收件箱（说明见 README 的「1.9」一节），数据格式向前兼容：候选多了 `batchId / batchName / batchAt / decidedAt` 几个可选字段，旧候选没有批次时归为「之前导入的」。

- features/video-review.js：界面部分重写——批次下拉、进度、左侧画面目录 `#vrNav`（按章节）、右侧只渲染选中画面 `#vrList`；审过的收成一行 `.vr-done`（撤回）；去掉 `#vrFilter` / `#vrClear`；关窗口时 `purgeRejected`（先 flushWriteBack 再清「不要」）；截图队列只保留右侧候选；`videoReviewKey` 键盘快审；审完一个画面 600ms 后自动跳到下一个有待审的画面（中途撤销则留下）。
- core/candidates.js：`planImport` 跳过清单里 `review.decision === "no"` 的新候选。
- main.js：`vrMask` 注册 `onKey: videoReviewKey`。
- styles.css：末尾「1.9 视频审核」一节。
- 自测：video-review-selftest 按新界面改写（左右分栏、进度、换一个后自动跳画面、键盘 2 = 不要、← 回看收起的一行、关窗口清「不要」、再导入不回来、面板入口选中画面），全部 `npm test` 通过；lint、prettier 通过。

---

# 分镜台 1.8.2

- features/playthrough.js：`seek` 不再清空 `shownKey`（以前每次拖动都重建 `<video>`，所以发黑）；新画面用 `swapIn` 叠在旧画面下面加载，出帧后再撤旧的；有镜头轨时隐藏 `.pt-progress`；去掉 `#pttEdit` 输入行，提醒放进 `#pttWarn`。
- ui/badges.js：本地视频缩略图用 `<video>` 解一帧（最多 3 个并发、按路径缓存），解不出来才用 `nativeImage.createThumbnailFromPath`（macOS 对视频常给默认 App 图标）。
- styles.css：末尾 1.8.2 几节——表头隐藏、章节吸顶 top 0、备注列 `minmax(200px, 1fr)`、行尾按钮竖排（右侧留 40px）、项目删除按钮样式、换画面不闪黑。
- ui/projects.js：删除按钮换成垃圾桶图标。
- 自测：镜头轨改用刻度尺 + I / O 测；新增「有镜头轨时不显示总进度条」「没有开始 / 结束输入框」。`npm test` 全部通过。

---

# 分镜台 1.8.1

- ui/badges.js：角色按钮 + 出现位置挪到素材卡下面（styles.css 补间距）。
- features/playthrough.js：镜头轨上方加可点可拖的刻度尺 `#pttRuler`，顶部进度条可点可拖；单镜头预览播到镜头末尾自动把范围换成下一个镜头接着播（口播不再在镜头末尾停），停在末尾按播放从下一个镜头开始，← → 同时移动范围（修 1.8.0 里单镜头预览按 ← → 被限制在原镜头的问题）。
- 自测新增 2 项（播完接着播下一个镜头、单镜头预览里 ← 切镜头）。`npm test` 全部通过，lint / prettier 通过。

---

# 分镜台 1.8.0（待打包）

一段（单句或共用画面）可以有多个主画面，并且能在「对着口播看画面」里按秒调每个主画面出现的时间。说明见 README 的「1.8」一节。数据格式向前兼容：使用记录多一个可选字段 `at = {start, end, of}`，1.7 打开 1.8 的项目会忽略它（按句子排）。

## 改动的文件

- renderer/src/core/shot-layout.js（新增）：镜头排布纯函数 `layoutShot`（按句子 / 手动两种排法、平分、末尾补位、over 标记）、`itemAt`、`clampSpan`（不出口播、不重叠、最短 0.2 秒）、`circled`。
- core/shots.js：`applyRole` 不再把同一句上的其他主画面降为备选（返回值保留为空数组）；去掉 `dedupeMains`；`resolveMainConflicts` 只留给视频审核。
- core/candidates.js：通过的视频当主画面时显式调用 `resolveMainConflicts`，行为不变。
- core/asset-model.js：`extraOf` / `cloneUsage` 带上 `at`，载入时清洗不合法的值。
- app/asset-actions.js：新增 `setShotTimes`（整段画面的秒数一次写入，一次撤销）、`clearShotTimes`。
- features/playthrough.js：画面按排布切换，空白处黑屏；新增镜头轨（拖动 / 吸附 / 填秒数 / I O 打点 / 恢复按句子 / 被挡提示），数据变化（含撤销）后自动重排。
- ui/badges.js、ui/inspector.js：面板写出每个主画面的编号和秒数；手动模式下主画面不显示句子范围；视频片段按各自出现时间比对。
- main.js：预览窗口开着时允许 ⌘Z / ⇧⌘Z。
- styles.css：末尾新增「1.8 镜头轨」一节。
- 测试：production-test 新增 8 项（排布、约束、保存），2 项按新规则改；roles-selftest 1 项按新规则改；iteration-selftest 新增 7 项（镜头轨、填秒数、撤销、恢复按句子、面板秒数）。

## 已经做过的验证（Linux + Electron 44.4.5，xvfb）

- `npm test`：数据回归 66 项、主进程回归 13 项、界面自测全部通过；lint、prettier 通过。
- 实际操作截图核对：拖开始边、填结束秒数被后一个画面挡住的提示、按 I 打点、点轨道空白处跳转、空白处黑屏、面板秒数。

---

# 分镜台 1.7.1（待打包）

1.7.0 上手后的小问题修正，数据格式不变。

- 悬停行高跳动：`.asset-empty` 从「悬停才 display」改成行尾绝对定位的 `.row-act` 小按钮（badges.js / styles.css）。用 puppeteer 逐类悬停（单句、句子文字、备注、类型标签、共用组、组内句子、章节行、工具条、色条）和点选比对布局，1.7.0 能复现跳动，1.7.1 无跳动（1000 / 1440 宽，面板开 / 关）。
- 勾选语义：新增 `checkedIds()`；`toggleLineSelection` 只在勾选集合里增删，不再把光标单选那句并进去（state.js）；勾选框 checked 只看勾选集合、勾一句就保持显示（render.js / render-table.js）。
- 去掉 `#btnMultiMode`；操作条在有勾选 / 选了两句以上时出现，多了「取消」`#btnClearSel`；Esc 同时退出逐句点选模式（toolbar.js / keyboard.js / index.html）。`state.multiMode` 保留给原文视图键盘勾选和自测。
- 表格里 Shift 点选阻止原生文字选区（edit.js，正在编辑的格子除外）；选中句不再画左侧竖线；操作条出现时表格底部留 72px。
- 自测：workspace-selftest 改用 `setMultiMode` 切模式，新增 5 项勾选语义断言。`npm test` 346 项、数据 58 项、主进程 13 项全部通过；lint、prettier 通过。

---

# 分镜台 1.7.0（待打包）

在 1.6.0 基础上只改界面（说明见 README 的「1.7」一节），数据格式不变，主进程和预加载脚本没动。

## 改动的文件

- renderer/index.html：「统计 / 筛选」和「工具条」两层合成一行（`.work-tools`：目录开关 + 筛选 + 标注工具 `#markTools` + 右侧一组 `.work-right`）；节奏色条单独一根细条；选区按钮移进 `.workspace` 里的浮动操作条 `#selectTools`。元素 id 都没变。
- renderer/src/ui/render-stats.js：「未标注」为 0 时不出筛选；全部标完后进度只写已挂素材、`#markTools` 收起。
- renderer/src/ui/toolbar.js：浮动操作条只在选了两句以上 / 多选模式时出现。
- renderer/src/ui/type-view.js：表格类型标签写短名 `label`，全名放 title。
- renderer/src/ui/render-table.js：共用画面标题去掉「查看画面与素材 ↗」，范围只写「第 a–b 句」。
- renderer/src/ui/inspector.js：去掉三段说明文字（收进 ⓘ 提示和按钮 title）；描述标签旁写「N 句共用 · 改一处全同步」。
- renderer/styles.css：文件末尾新增「1.7 界面精简」一节（细色条、一行工具条、浮动操作条、竖线不上色、悬停才出现的「＋ 尚未关联素材」、细线式共用画面、面板按钮并排、描述框 `field-sizing: content` 自动长高）。
- renderer/src/test/workspace-selftest.js、iteration-selftest.js：按新界面更新 2 项断言，新增 2 项（只选一句不弹操作条 / 选两句浮出「共用一个画面」）。
- package.json：版本号 1.7.0。

## 已经做过的验证（Linux + Electron 44.4.5，xvfb）

- `npm test`：数据回归 58 项、主进程回归 13 项、界面自测 341 项全部通过。
- `npm run lint`、prettier 检查通过。没有新增依赖。
- 截图核对了 1000 / 1280 宽、浅色 / 深色、全部标完 / 还有未标注、多选、原文视图。

## 打包前请做

1. 在 macOS 上运行 `npm test`。
2. `npm run package`，或离线 `npm run repack -- --archives`。
3. 安装到 `/Applications/分镜台.app` 并确认正常运行后，清理构建产物。只保留最新版本，不自动创建软件备份。

---

# 分镜台 1.6.0（已安装）

在 **1.5.0** 基础上合入另一条开发线（「新软件」文件夹里的 1.3.2）的全部改动。1.3.1 的 PDF 分镜脚本、1.4 的素材角色与出现位置、1.4.1 的「设角色后视口不跳」、1.5 的视频审核和「去掉制作状态」全部保留。说明见 README 的「1.6」一节。

## 新增 / 改进

- 标注类型可自定义（每个项目一套，名字 / 颜色 / 图标 / 快捷键 1–9 / 是否需要配画面），旧项目自动沿用默认五类；PDF、素材清单、CSV、交稿检查、统计都按类型表走。
- 口播音频：导入后逐句播放、底部口播条、时间码点哪播哪；没对字幕时按音频总长、按字数比例推算每句时间；面板里显示这个画面对应的口播时间段，能听这段、能对着口播看画面。
- 连播预览：口播接着播，画面按句子的主画面自动切换（按出现位置切，备选和叠加不上屏）。
- 修复：编辑素材路径时每打一个字就多一条垃圾素材（旧数据里的残留自动清理）；表格备注换行被吞；导出文件名带 / 或 : 出错；CSV「共用画面」列是内部编号、以 = 开头的内容被 Excel 当公式。
- 最近删除（30 天找回）、自动备份可只取回一个项目、主题跟随系统、快捷键面板（⌘/）、工具条精简。
- 性能：存盘只发改动过的项目（主进程合并后原子写，文件格式不变）；按句查找改成索引；缩略图缩成小图再给界面；打字时侧栏刷新合并。

## 代码结构有变化（打包流程不受影响）

`renderer/src/` 分成 `core/`（纯数据规则）、`app/`（状态与数据操作）、`ui/`（界面）、`features/`（独立功能）、`platform/`（原生能力）、`test/`（自测，不进安装包）。`npm run lint` 会检查分层。入口仍是 `electron/main.js` 和 `renderer/index.html`；打包白名单、`npm run package`、`npm run repack -- --archives` 都照旧。`scripts/package.mjs` 现在打成 app.asar。

## 已经做过的验证（Linux + 真 Electron 44.4.5，xvfb）

- `npm test`：数据回归 56 项、主进程回归 13 项、界面自测 339 项，全部通过（含 1.4 素材角色 21 项、1.5 视频审核套件、PDF 套件、1.6 新功能套件）。
- `npm run lint`、prettier 检查通过。
- 没有新增依赖。

## 打包前请做

1. 在 macOS 上运行 `npm test`（`scripts/test.mjs` 的等待时间已放宽到 90 秒，测试项变多了）。
2. `npm run package`，或离线 `npm run repack -- --archives`。
3. 安装到 `/Applications/分镜台.app` 并确认正常运行后，清理重复应用与构建产物。用户要求只保留最新版本，不自动创建软件备份。

数据兼容：1.5 的项目直接打开，没有类型表的按默认五类；1.6 存出的项目在 1.5 里也能打开，会忽略类型表（自定义类型的句子显示为未知）、口播音频等新字段。

---

# 分镜台 1.5.0（待打包）

在 1.4.1 基础上（已合入 1.4.1 的「设角色后视口不跳」修复）新增「视频审核」，并按要求去掉「制作状态」。说明见 README 的「1.5」一节。这次主进程和预加载脚本有改动（新增 IPC），打包白名单不用改（新文件都在 electron/ 和 renderer/ 里）。

## 改动的文件

- electron/video-tools.js（新增）：只保存那几秒（调用本机 ffmpeg，`-ss` 放在 `-i` 前，只读取需要的那一段，重新编码成 H.264 mp4，先写 `.part.mp4` 再改名，失败不留半截文件）、下载完整原片（跟随跳转，`.part` 再改名）、审核结果写回候选清单（只认 `type: fenjingtai-candidates` 的 .json，原子写入）、安全文件名和重名加 (2)。
- electron/main.js：新增 IPC `dialog:pick-folder`、`video:has-ffmpeg`、`video:save-segment`、`video:download-original`（带进度事件 `video:download-progress`）、`candidates:write-back`、`assets:reveal`。
- electron/preload.js：对应暴露 pickFolder、hasFfmpeg、saveVideoSegment、downloadOriginalVideo、onDownloadProgress、writeCandidateReview、revealAsset。
- electron/script-reader.js：读文件结果多返回 `path`（候选清单写回要用）。
- renderer/index.html：CSP 放开 `img-src` / `media-src` / `connect-src` 到任意 http(s)；工具栏加「视频审核」按钮（有候选时才显示）。
- renderer/src/video-review.js（新增）：候选导入、审核窗口、截图、片段播放、通过 / 不要 / 换一个、挂主画面、画面描述来源行、写回、保存片段、下载原片。
- renderer/src/import-export.js：导入的 JSON 如果是候选清单，进视频审核，不新建项目。
- renderer/src/state.js / storage.js / undo.js：项目多两个字段 `candidates`、`mediaDir`，跟着保存和撤销。
- renderer/src/assets.js：在线视频地址（.mp4 / .webm 等）识别为视频。
- renderer/src/preview.js：在线视频可以在应用内播放和设片段。
- renderer/src/visuals.js：在线视频缩略图直接从网上取入点那一帧；画面面板加「视频候选 · 去审核」入口。
- renderer/src/workspace.js：面板入口的点击；去掉制作状态下拉框和角标。
- renderer/src/main.js：初始化视频审核，登记弹窗（Esc 关闭，⌘Z 可用）。
- 去掉制作状态：production.js（交稿检查不再有「素材未就绪」，改稿对比不再列制作状态）、export-doc.js、print-doc.js、pdf-export.js（去掉「制作状态」勾选）、render-stats.js（统计改为已挂素材）、shot-menu.js、check.js 的文案。
- renderer/styles.css：视频审核窗口、截图条、按钮、面板入口、在线缩略图。
- renderer/src/video-review-selftest.js（新增，43 项），在 selftest.js 接入「1.5 视频审核」套件；workspace-selftest.js 改成检查面板里没有制作状态。
- scripts/main-test.mjs：新增 4 项（文件名、保存片段、下载原片、写回）。scripts/production-test.mjs：交稿检查和 PDF 的用例去掉制作状态。
- package.json：版本号改为 1.5.0。

## 已经做过的验证

- `node scripts/production-test.mjs`：47 项全部通过。
- `node scripts/main-test.mjs`：12 项全部通过（新增 4 项）。
- 用真 ffmpeg 6.1 + 一个支持断点续传的本地 HTTP 服务测了 `saveSegment`：从 20 秒的测试视频截 5–9 秒，得到正好 4.0 秒的 mp4；`downloadOriginal` 完整下载字节数一致。
- eslint 无报错；改动的文件已按 .prettierrc 格式化。
- 界面自测：Linux 无头 Chromium 加载 renderer，window.native 用内存桩，跑 selftest.js 全部套件，250/251（含 1.4.1 新增的 4 项长稿定位）。唯一未过的仍是「测试素材目录可用」（桩里没有测试素材目录）。

## 打包前请做

1. 在 macOS 上运行 `npm test`。
2. 打包流程同 1.4：`npm run package`，或离线 `npm run repack -- --archives`。
3. 安装前备份 /Applications/分镜台.app 和数据目录。
4. 「保存这几秒」需要本机有 ffmpeg（`brew install ffmpeg`）。没有也能用审核、播放和通过，只是保存时会提示安装。

数据兼容：1.4.x 的项目直接打开；旧的制作状态字段留在数据里但不再显示。1.5 存出的项目在 1.4 里也能打开，会忽略 `candidates` 和 `mediaDir`，已通过并挂上的在线视频在 1.4 里显示为链接。

---

# 分镜台 1.4.1

修复长稿中设置主画面、叠加、备选、素材出现位置及一键整理后，视口跳到其他画面的问题。现在原地刷新素材卡和面板，保留当前句子与滚动位置。

原因：这些操作原先重建整张表，导致浏览器丢失离屏画面的实际高度缓存。新增四项长稿位置回归，分别覆盖主画面、叠加、出现位置和一键整理。

# 分镜台 1.4.0

在 1.3.1 源码基础上新增「素材角色与出现位置」，说明见 README 的「1.4」一节。改动只在渲染层，主进程、预加载脚本和打包脚本都没有改。

## 改动的文件

- renderer/src/production.js：角色和位置的数据层（ROLES、usageSpan、spanText、applySpan、applyRole、resolveMainConflicts、mainCoverage、normalizeUsageSpans）。合并、加入下一句、移出、拆分时保留位置；交稿检查新增两条提醒。
- renderer/src/assets.js：载入、编辑路径、设片段、重新定位时不丢角色和位置。新增 setUsageRole、setUsageSpan、autoAssignRoles，添加素材时给默认角色。
- renderer/src/visuals.js：表格卡片按角色排序，带角色标签和位置，备选收成一个入口。面板里加角色按钮、出现位置下拉和一键整理。
- renderer/src/workspace.js：面板里角色、位置、整段、一键整理的交互；解除共用后整理位置。
- renderer/src/actions.js：并句时合并位置；解除共用后整理位置。
- renderer/src/export-doc.js：素材清单不列备选，CSV 逐句只列这句出现的素材，带批注 MD 内嵌角色和位置。
- renderer/src/print-doc.js：PDF 不排备选，标注角色和出现在哪几句。
- renderer/styles.css：角色按钮、标签、位置下拉、备选入口（浅色和深色主题都用现有变量）。
- renderer/src/roles-selftest.js（新增），并在 selftest.js 里接入「1.4 素材角色」套件，共 17 项界面自测。
- scripts/production-test.mjs：新增 6 项数据回归。
- package.json：版本号改为 1.4.0。

## 已经做过的验证

- `node scripts/production-test.mjs`：47 项全部通过，其中新增 6 项。
- `node scripts/main-test.mjs`：8 项全部通过。
- eslint 无报错；改动的文件已按 .prettierrc 格式化。
- 界面自测：用 Linux 无头 Chromium 加载 renderer，window.native 用内存桩代替，跑了 selftest.js 全部套件，结果 202/203。唯一未过的是「测试素材目录可用」，因为桩里没有传测试素材目录。1.3.1 原版在同样条件下是 185/186，没有引入回归。

## 打包前请做

1. 在 macOS 上运行 `npm test`，用真 Electron 和测试素材跑一遍。
2. 用 1.3.1 打包流程出 arm64 和 x64 包：`npm run package`，或者离线运行 `npm run repack -- --archives`。
3. 安装前按惯例备份 /Applications/分镜台.app 和数据目录。

数据兼容：1.3.1 的项目直接打开即可，素材显示为「未分配」，内容不会被改动。1.4 存出的项目在 1.3.1 里也能打开，只是会忽略角色和位置两个字段。

---

# 分镜台 1.3.1

以当前已安装的 1.3.0 为基础，合入 fenjingtai-upgrade 中的 PDF 分镜脚本导出和删除提示条撤销按钮修复。
保留专注标注、剪映字幕对齐、重做、素材库、视频片段、分层备份、Word 导入与原有打包白名单。
PDF 接入当前素材库、视频片段与字幕时间，横竖版 A4、封面概览、制作状态、素材缩略图和链接均可选择。

验证：222 项界面自测、41 项数据回归、8 项主进程回归通过；静态检查通过。
使用隔离的项目数据副本在 macOS / Electron 44.4.5 中，通过真实 UI 与原生 IPC 导出了横版和竖版 PDF，检查了页面排版。
Apple Silicon 与 Intel 应用均经过本机 ad-hoc 签名与严格签名验证；安装包在 dist/release。

升级前软件和用户数据备份：../_备份与存档/分镜台/1.3.1更新前-20261001/。
本次合并后的完整源码与构建脚本保存在此目录；fenjingtai-upgrade 保留为原始输入。

运行：npm start
测试：npm test
离线重新打包：npm run repack -- --archives

PDF 快捷键 ⇧⌘E；专注标注仍为 ⌘E，已验证二者不会互相触发。

2026-10-02 已将最终修正版安装到 /Applications/分镜台.app 并启动。
在实际安装的软件中验证了 ⇧⌘E 打开 PDF 导出选项，启动后两个项目的正文、标注和素材内容与安装前一致。
最终替换前备份：../_备份与存档/分镜台/1.3.1最终安装前-20261002-174454/。
安装验证记录：dist/validation/final-install.json。
