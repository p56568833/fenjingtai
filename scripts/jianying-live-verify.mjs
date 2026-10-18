/* 真实剪映验收驱动（live-owner 专用，不接 npm test）：
   1) 用本机 ffmpeg 合成横屏 / 竖屏 / 方形 / 旋转视频、图片、口播与定格源；
   2) 起隐藏的 `electron . --selftest`（FJT_SELFTEST_MODE=e2e，临时 userData、9222 调试端口）；
   3) 通过渲染层公开应用接口 captureExportSnapshot → prepareJianyingExport →
      startPreparedJianyingExport 走真实 IPC 导出到真实剪映草稿库；
   4) 结果写 JSON，供证据文档记录。

   运行前确认剪映主应用已退出（导出后登记索引要求不在运行）。
   用法：
     node scripts/jianying-live-verify.mjs --draft-name "修复验收-20261018-0220" \
       --out /tmp/jianying-live/export-baseline.json [--canvas 1920x1080] [--fps 30] [--no-subtitles] \
       [--project default|freeze|unknown|unknown2|known2]
   --project freeze  = 5fps 源 out=0.51s + fitDone（定格选帧）
   --project unknown = ffprobe 无完整时长的源（单片段）
   --project unknown2 / known2 = 0–1s 片段 + 1–2s 空档 + 2–3s 图片，用于剪映里延长裁剪 A/B

   修复验收2（2026-10-18 第二轮，定格选帧缺陷）：
     node scripts/jianying-live-verify.mjs --project delayed --prepare-only
     node scripts/jianying-live-verify.mjs --project vfr-gap --draft-name "修复验收2-..." \
       --out /tmp/jianying-verify2/export-delayed.json --no-subtitles
   --project delayed  = 120×200 / 5fps / 1s，setpts 整体推迟 2s（format start_time=2，原始帧 PTS 2–2.8）；
                        镜头 3s，clip in=0/out=0.51 + fitDone，正确帧 = 播放时间 0.4s（原始 PTS 2.4）
   --project vfr-gap  = 120×200 / 30fps 输入 10s，首帧 PTS 0、其余帧 +5s（下一帧 5.033s，总长 15s）；
                        镜头 3s，clip in=2/out=3 + fitDone，正确帧 = 第一帧（0–5.033s 一直可见）
   --project bounds   = 10s 视频内容 + 12.5s 容器；clip in=11/out=12，越出视频内容但不越容器，
                        应报 freeze-no-frame 且不产出定格图、不留下草稿
   新项目的素材在 /tmp/jianying-verify2/media，草稿名必须以「修复验收2-」开头且不能与已有草稿重名；
   --prepare-only 只合成素材 + 写 ffprobe 报告，不启动 Electron、不导出。
   注意：不修改生产代码、不跑 npm test，只做本次验收。 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = '/tmp/jianying-live/media';
const VERIFY2_MEDIA = '/tmp/jianying-verify2/media';
const DRAFT_LIBRARY = path.join(os.homedir(), 'Movies/JianyingPro/User Data/Projects/com.lveditor.draft');
const DEBUG_PORT = Number(process.env.FJT_DEBUG_PORT || 9222);
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';

const args = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const flag = name => args.includes(name);
const roundStamp = () => {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};
/* default：12s 全量样例；freeze：5fps 源 out=0.51s + fitDone 选帧；unknown：ffprobe 无完整时长的源 */
const project = argOf('--project', 'default');
const VERIFY2_PROJECTS = new Set(['delayed', 'vfr-gap', 'bounds']);
const verify2 = VERIFY2_PROJECTS.has(project);
const draftName = argOf('--draft-name', `${verify2 ? '修复验收2-' : '修复验收-'}${roundStamp()}`);
const outFile = argOf(
  '--out',
  verify2
    ? `/tmp/jianying-verify2/export-${project}-${roundStamp()}.json`
    : `/tmp/jianying-live/export-${roundStamp()}.json`,
);
const prepareOnly = flag('--prepare-only');
const canvas = argOf('--canvas', '1920x1080');
const [canvasW, canvasH] = canvas.split('x').map(Number);
const fps = Number(argOf('--fps', '30'));
const subtitles = !flag('--no-subtitles');

function run(bin, binArgs, { cwd = ROOT, env = {}, allowFail = false } = {}) {
  const result = spawnSync(bin, binArgs, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 && !allowFail)
    throw new Error(`${path.basename(bin)} ${binArgs.slice(0, 6).join(' ')} 失败：${result.stderr || result.stdout}`);
  return result;
}

/* ── 合成素材 ── */
function buildMedia() {
  fs.mkdirSync(MEDIA, { recursive: true });
  const ff = (...a) => run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...a], { cwd: MEDIA });
  const need = name => !fs.existsSync(path.join(MEDIA, name));
  if (need('land.mp4'))
    ff(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30:duration=4',
      '-vf',
      'drawbox=x=0:y=0:w=40:h=30:color=red@1:t=fill',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      'land.mp4',
    );
  if (need('port.mp4'))
    ff(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=120x200:rate=30:duration=4',
      '-vf',
      'drawbox=x=0:y=0:w=20:h=40:color=blue@1:t=fill',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      'port.mp4',
    );
  if (need('square.mp4'))
    ff(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=180x180:rate=30:duration=4',
      '-vf',
      'drawbox=x=0:y=0:w=30:h=30:color=green@1:t=fill',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      'square.mp4',
    );
  if (need('rot.mp4')) {
    ff(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=200x120:rate=30:duration=4',
      '-vf',
      'drawbox=x=0:y=0:w=40:h=30:color=red@1:t=fill',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      'rot_src.mp4',
    );
    ff('-display_rotation', '90', '-i', 'rot_src.mp4', '-c', 'copy', 'rot.mp4');
    fs.rmSync(path.join(MEDIA, 'rot_src.mp4'), { force: true });
  }
  if (need('img.png'))
    ff(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=240x160:rate=30',
      '-frames:v',
      '1',
      '-vf',
      'drawbox=x=0:y=0:w=30:h=30:color=yellow@1:t=fill',
      'img.png',
    );
  if (need('voice.wav'))
    ff(
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:duration=6',
      '-filter_complex',
      '[0:a][1:a]concat=n=2:v=0:a=1[a]',
      '-map',
      '[a]',
      '-ar',
      '44100',
      '-ac',
      '1',
      'voice.wav',
    );
  if (need('freeze_src.mp4'))
    ff(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30:duration=2',
      '-vf',
      'drawbox=x=0:y=0:w=40:h=30:color=blue@1:t=fill',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      'freeze_src.mp4',
    );
  /* 5fps、每帧时间戳可读：定格应取 out=0.51s 前最后一帧 0.4s，而不是 0.6s */
  if (need('freeze5fps.mp4'))
    ff(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=200x120:rate=5:duration=1.5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      'freeze5fps.mp4',
    );
  if (!fs.existsSync(path.join(MEDIA, 'unknown-duration.mp4')))
    throw new Error('缺少 unknown-duration.mp4（Lead 提供：ffprobe 无完整时长的真实 MP4）');
}
const mediaPath = name => path.join(MEDIA, name);
const mediaPath2 = name => path.join(VERIFY2_MEDIA, name);

/* ── 修复验收2 素材（/tmp/jianying-verify2/media）──
   每帧画面用 geq 色块 + 顶部白色方块条数编码帧序号（第 N 帧画 N+1 个方块），不用纯黑帧，
   这样既能机器比对颜色，也能在剪映窗口截图里肉眼分辨抽到的是第几帧：
   delayed：5 帧，帧 N 颜色 R=40+40N / G=120+30N / B=220-25N，帧 0 蓝、帧 2 青绿；
   vfr-gap：第 0 帧蓝底+左上白块，第 1 帧起橙底+右下黑块（旧实现会取到第 1 帧）。 */
function buildVerify2Media() {
  fs.mkdirSync(VERIFY2_MEDIA, { recursive: true });
  const ff = (...a) => run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...a], { cwd: VERIFY2_MEDIA });
  const need = name => !fs.existsSync(mediaPath2(name));
  const bars = [0, 1, 2, 3, 4]
    .map(n => `drawbox=x=${8 + 22 * n}:y=8:w=16:h=16:color=white:t=fill:enable='gte(n,${n})'`)
    .join(',');
  if (need('delayed-5fps-start2.mp4'))
    ff(
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=120x200:r=5:d=1',
      '-vf',
      `geq=r='mod(40+N*40,256)':g='mod(120+N*30,256)':b='mod(220-N*25,256)',` +
        `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=4,${bars},setpts=PTS+2/TB`,
      '-c:v',
      'libx264',
      '-qp',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-video_track_timescale',
      '1000000',
      '-fps_mode',
      'vfr',
      'delayed-5fps-start2.mp4',
    );
  if (need('vfr-gap-15s.mp4'))
    ff(
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=120x200:r=30:d=10',
      '-vf',
      `geq=r='if(eq(N,0),20,230)':g='if(eq(N,0),110,120)':b='if(eq(N,0),240,30)',` +
        'drawbox=x=0:y=0:w=iw:h=ih:color=white:t=4,' +
        "drawbox=x=8:y=8:w=30:h=30:color=white:t=fill:enable='eq(n,0)'," +
        "drawbox=x=82:y=162:w=30:h=30:color=black:t=fill:enable='gt(n,0)'," +
        "setpts='if(eq(N,0),0,PTS+5/TB)'",
      '-c:v',
      'libx264',
      '-qp',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-video_track_timescale',
      '1000000',
      '-fps_mode',
      'vfr',
      'vfr-gap-15s.mp4',
    );
  if (need('out-of-range-10s-source.mp4')) {
    /* 10s 源 + clip in=11/out=12：真实 exporter 在 probe 阶段按真实源时长拦下
       （source-out-of-range），不会进入定格抽帧、不会留下草稿。 */
    ff(
      '-f',
      'lavfi',
      '-i',
      'color=c=0x404040:s=120x200:r=30:d=10',
      '-vf',
      'drawbox=x=20:y=60:w=80:h=80:color=0xCC0000:t=fill,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=4',
      '-c:v',
      'libx264',
      '-qp',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-video_track_timescale',
      '1000000',
      'out-of-range-10s-source.mp4',
    );
  }
}

/* ── ffprobe 记录：format/stream 起止、帧 PTS 首尾与总数 ── */
function probeVerify2Media() {
  const ffprobeVersion = run(FFPROBE, ['-version']).stdout.split(/\r?\n/)[0].trim();
  const entries = [];
  for (const name of ['delayed-5fps-start2.mp4', 'vfr-gap-15s.mp4', 'out-of-range-10s-source.mp4']) {
    const file = mediaPath2(name);
    const info = JSON.parse(run(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]).stdout);
    const frames = JSON.parse(
      run(FFPROBE, [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'json',
        file,
      ]).stdout,
    );
    const times = (frames.frames || [])
      .map(frame => Number(frame.best_effort_timestamp_time))
      .filter(value => Number.isFinite(value));
    entries.push({
      name,
      file,
      bytes: fs.statSync(file).size,
      format: { startTime: info.format?.start_time ?? null, duration: info.format?.duration ?? null },
      streams: (info.streams || []).map(stream => ({
        codecType: stream.codec_type,
        codecName: stream.codec_name,
        startTime: stream.start_time ?? null,
        duration: stream.duration ?? null,
        avgFrameRate: stream.avg_frame_rate ?? null,
        rFrameRate: stream.r_frame_rate ?? null,
        nbFrames: stream.nb_frames ?? null,
        width: stream.width ?? null,
        height: stream.height ?? null,
      })),
      frameCount: times.length,
      firstPts: times.slice(0, 6),
      lastPts: times.slice(-4),
    });
  }
  const report = {
    generatedAt: new Date().toISOString(),
    ffprobe: ffprobeVersion,
    media: entries,
  };
  fs.writeFileSync(path.join(VERIFY2_MEDIA, 'probe-report.json'), JSON.stringify(report, null, 2));
  return report;
}
const buildDefaultSnapshot = () => {
  const usages = {
    L1: [{ assetId: 'vLand', role: 'main', clip: { in: 1, out: 3 }, at: { start: 0, end: 2, of: 'L1' } }],
    L2: [{ assetId: 'vPort', role: 'main', clip: { in: 0.5, out: 2.5 }, at: { start: 0, end: 2, of: 'L2' } }],
    L3: [{ assetId: 'vSquare', role: 'main', clip: { in: 1, out: 3 }, at: { start: 0, end: 2, of: 'L3' } }],
    L4: [{ assetId: 'vRot', role: 'main', clip: { in: 1, out: 3 }, at: { start: 0, end: 2, of: 'L4' } }],
    L5: [{ assetId: 'img', role: 'main', at: { start: 0, end: 2, of: 'L5' } }],
    L6: [
      {
        assetId: 'vFreeze',
        role: 'main',
        clip: { in: 0, out: 1 },
        at: { start: 0, end: 2, of: 'L6' },
        fitDone: true,
      },
    ],
  };
  const texts = {
    L1: '验收字幕一：横屏画面',
    L2: '验收字幕二：竖屏画面',
    L3: '验收字幕三：方形画面',
    L4: '验收字幕四：旋转画面',
    L5: '验收字幕五：图片画面',
    L6: '验收字幕六：视频与定格',
  };
  const rows = Object.keys(usages).map((id, index) => ({
    id,
    kind: 'line',
    no: index + 1,
    text: texts[id],
    groupId: `g${id}`,
    time: { start: index * 2, end: index * 2 + 2, st: 'ok' },
    assetUsages: usages[id],
  }));
  return {
    id: 'live-verify-project',
    projectId: 'live-verify-project',
    title: '修复验收合成项目',
    rows,
    assets: {
      vLand: { id: 'vLand', path: mediaPath('land.mp4'), name: 'land.mp4', kind: 'video', durationSec: 4 },
      vPort: { id: 'vPort', path: mediaPath('port.mp4'), name: 'port.mp4', kind: 'video', durationSec: 4 },
      vSquare: { id: 'vSquare', path: mediaPath('square.mp4'), name: 'square.mp4', kind: 'video', durationSec: 4 },
      vRot: { id: 'vRot', path: mediaPath('rot.mp4'), name: 'rot.mp4', kind: 'video', durationSec: 4 },
      img: { id: 'img', path: mediaPath('img.png'), name: 'img.png', kind: 'image' },
      vFreeze: {
        id: 'vFreeze',
        path: mediaPath('freeze_src.mp4'),
        name: 'freeze_src.mp4',
        kind: 'video',
        durationSec: 2,
      },
    },
    types: [],
    speechRate: 4.5,
    voice: { path: mediaPath('voice.wav'), name: 'voice.wav', duration: 12 },
    updatedAt: Date.now(),
  };
};

/* 5fps 源、out=0.51s、1s 镜头 + fitDone：定格应取源 0.4s 帧（不是 0.6s） */
const buildFreezeSnapshot = () => ({
  id: 'live-freeze-project',
  projectId: 'live-freeze-project',
  title: '修复验收定格选帧项目',
  rows: [
    {
      id: 'F1',
      kind: 'line',
      no: 1,
      text: '定格源帧测试',
      groupId: 'gF1',
      time: { start: 0, end: 1, st: 'ok' },
      assetUsages: [
        {
          assetId: 'v5',
          role: 'main',
          clip: { in: 0, out: 0.51 },
          at: { start: 0, end: 1, of: 'F1' },
          fitDone: true,
        },
      ],
    },
  ],
  assets: {
    v5: { id: 'v5', path: mediaPath('freeze5fps.mp4'), name: 'freeze5fps.mp4', kind: 'video', durationSec: 1.5 },
  },
  types: [],
  speechRate: 4.5,
  voice: null,
  updatedAt: Date.now(),
});

/* ── 修复验收2：A 延迟起点 ──
   120×200 / 5fps / 1s，容器整体推迟 2s：format start_time=2，帧原始 PTS 2/2.2/2.4/2.6/2.8。
   镜头 3s，clip in=0/out=0.51 + fitDone；定格应取「播放时间 0.4s」= 原始 PTS 2.4（第 3 帧）。 */
const buildDelayedSnapshot = () => ({
  id: 'live-verify2-delayed',
  projectId: 'live-verify2-delayed',
  title: '修复验收2-延迟起点项目',
  rows: [
    {
      id: 'D1',
      kind: 'line',
      no: 1,
      text: '延迟起点定格测试',
      groupId: 'gD1',
      time: { start: 0, end: 3, st: 'ok' },
      assetUsages: [
        {
          assetId: 'vDelayed',
          role: 'main',
          clip: { in: 0, out: 0.51 },
          at: { start: 0, end: 3, of: 'D1' },
          fitDone: true,
        },
      ],
    },
  ],
  assets: {
    vDelayed: {
      id: 'vDelayed',
      path: mediaPath2('delayed-5fps-start2.mp4'),
      name: 'delayed-5fps-start2.mp4',
      kind: 'video',
      durationSec: 1,
    },
  },
  types: [],
  speechRate: 4.5,
  voice: null,
  updatedAt: Date.now(),
});

/* ── 修复验收2：B VFR 长静止 ──
   120×200 / 30fps 输入 10s：首帧 PTS=0，其余帧 PTS+5s（下一帧 5.033333s，总长 15s）。
   镜头 3s，clip in=2/out=3 + fitDone；播放时间 2–3s 落在第一帧 0–5.033s 的可见区间里，
   定格应取第一帧（PTS 0，蓝底左上白块），而不是间隔后的第 1 帧（橙底右下黑块）。 */
const buildVfrGapSnapshot = () => ({
  id: 'live-verify2-vfr-gap',
  projectId: 'live-verify2-vfr-gap',
  title: '修复验收2-VFR长静止项目',
  rows: [
    {
      id: 'V1',
      kind: 'line',
      no: 1,
      text: 'VFR 长静止定格测试',
      groupId: 'gV1',
      time: { start: 0, end: 3, st: 'ok' },
      assetUsages: [
        {
          assetId: 'vGap',
          role: 'main',
          clip: { in: 2, out: 3 },
          at: { start: 0, end: 3, of: 'V1' },
          fitDone: true,
        },
      ],
    },
  ],
  assets: {
    vGap: {
      id: 'vGap',
      path: mediaPath2('vfr-gap-15s.mp4'),
      name: 'vfr-gap-15s.mp4',
      kind: 'video',
      durationSec: 15,
    },
  },
  types: [],
  speechRate: 4.5,
  voice: null,
  updatedAt: Date.now(),
});

/* ── 修复验收2：越界报错 ──
   10s 源、clip in=11/out=12（越界 1s 以上）：真实 exporter 会在 probe 阶段按真实源时长
   报 source-out-of-range 并停止，不产出定格图、不留下草稿目录。 */
const buildBoundsSnapshot = () => ({
  id: 'live-verify2-bounds',
  projectId: 'live-verify2-bounds',
  title: '修复验收2-越界定格报错项目',
  rows: [
    {
      id: 'B1',
      kind: 'line',
      no: 1,
      text: '越界定格报错测试',
      groupId: 'gB1',
      time: { start: 0, end: 3, st: 'ok' },
      assetUsages: [
        {
          assetId: 'vBounds',
          role: 'main',
          clip: { in: 11, out: 12 },
          at: { start: 0, end: 3, of: 'B1' },
          fitDone: true,
        },
      ],
    },
  ],
  assets: {
    vBounds: {
      id: 'vBounds',
      path: mediaPath2('out-of-range-10s-source.mp4'),
      name: 'out-of-range-10s-source.mp4',
      kind: 'video',
      durationSec: 10,
    },
  },
  types: [],
  speechRate: 4.5,
  voice: null,
  updatedAt: Date.now(),
});

/* ffprobe 报不出完整时长的真实 MP4（2s 内容，未给 durationSec）：验证剪映里能否延长 */
const buildUnknownSnapshot = () => ({
  id: 'live-unknown-project',
  projectId: 'live-unknown-project',
  title: '修复验收未知时长项目',
  rows: [
    {
      id: 'U1',
      kind: 'line',
      no: 1,
      text: '未知时长源测试',
      groupId: 'gU1',
      time: { start: 0, end: 1, st: 'ok' },
      assetUsages: [{ assetId: 'vUnknown', role: 'main', clip: { in: 0, out: 1 }, at: { start: 0, end: 1, of: 'U1' } }],
    },
  ],
  assets: {
    vUnknown: {
      id: 'vUnknown',
      path: mediaPath('unknown-duration.mp4'),
      name: 'unknown-duration.mp4',
      kind: 'video',
    },
  },
  types: [],
  speechRate: 4.5,
  voice: null,
  updatedAt: Date.now(),
});

/* 末尾留出一段空隙，便于在剪映里测试右边缘能否延长：unknown2 未知时长源 / known2 已知 4s 源 */
const buildGapSnapshot = ({ id, title, asset }) => ({
  id,
  projectId: id,
  title,
  rows: [
    {
      id: 'G1',
      kind: 'line',
      no: 1,
      text: '延长测试片段',
      groupId: 'gG1',
      time: { start: 0, end: 1, st: 'ok' },
      assetUsages: [{ assetId: 'vTest', role: 'main', clip: { in: 0, out: 1 }, at: { start: 0, end: 1, of: 'G1' } }],
    },
    {
      id: 'G2',
      kind: 'line',
      no: 2,
      text: '尾部占位',
      groupId: 'gG2',
      time: { start: 2, end: 3, st: 'ok' },
      assetUsages: [{ assetId: 'img', role: 'main', at: { start: 0, end: 1, of: 'G2' } }],
    },
  ],
  assets: {
    vTest: asset,
    img: { id: 'img', path: mediaPath('img.png'), name: 'img.png', kind: 'image' },
  },
  types: [],
  speechRate: 4.5,
  voice: null,
  updatedAt: Date.now(),
});

const buildSnapshot = name => {
  if (name === 'freeze') return buildFreezeSnapshot();
  if (name === 'delayed') return buildDelayedSnapshot();
  if (name === 'vfr-gap') return buildVfrGapSnapshot();
  if (name === 'bounds') return buildBoundsSnapshot();
  if (name === 'unknown') return buildUnknownSnapshot();
  if (name === 'unknown2')
    return buildGapSnapshot({
      id: 'live-unknown2-project',
      title: '修复验收未知时长延长项目',
      asset: {
        id: 'vTest',
        path: mediaPath('unknown-duration.mp4'),
        name: 'unknown-duration.mp4',
        kind: 'video',
      },
    });
  if (name === 'known2')
    return buildGapSnapshot({
      id: 'live-known2-project',
      title: '修复验收已知时长延长项目',
      asset: { id: 'vTest', path: mediaPath('land.mp4'), name: 'land.mp4', kind: 'video', durationSec: 4 },
    });
  return buildDefaultSnapshot();
};

const getJson = url =>
  new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let text = '';
      res.on('data', chunk => (text += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });

async function waitForDebugPort(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw new Error(`等不到 ${DEBUG_PORT} 调试端口：${lastError?.message || ''}`);
}

/* ── 修复验收2 保护：草稿名必须以「修复验收2-」开头；不能覆盖/复用已有草稿 ── */
function ensureVerify2Guards() {
  if (!verify2) return;
  if (!draftName.startsWith('修复验收2-'))
    throw new Error(`修复验收2 的草稿名必须以「修复验收2-」开头，实际为「${draftName}」`);
  const target = path.join(DRAFT_LIBRARY, draftName);
  if (fs.existsSync(target)) throw new Error(`草稿目录已存在，拒绝覆盖已有草稿：${target}`);
  const indexPath = path.join(DRAFT_LIBRARY, 'root_meta_info.json');
  const indexText = readTextOrNull(indexPath);
  if (indexText == null) return; // 读不到索引时导出器自己还有 uniqueName 兜底，不阻断
  if (indexText.includes(JSON.stringify(draftName)))
    throw new Error(`剪映草稿索引里已有同名条目，拒绝复用名字（避免覆盖旧草稿）：${draftName}`);
}

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    console.warn(`（提示）没读到 ${path.basename(file)}，跳过对应预检：${error?.message || error}`);
    return null;
  }
}

/* ── 剪映主应用运行检查：tray helper 不算运行 ── */
function ensureJianyingQuit() {
  const result = spawnSync('pgrep', ['-f', '/Applications/VideoFusion-macOS.app/Contents/MacOS/VideoFusion'], {
    encoding: 'utf8',
  });
  const pids = String(result.stdout || '')
    .split(/\s+/)
    .filter(Boolean);
  if (result.status === 0 && pids.length)
    throw new Error(`剪映主应用正在运行（pid ${pids.join(',')}），先退出再导出（tray helper 可留）`);
}

/* ── 导出后读取草稿目录：Resources 清单 + 明文 draft_info 的素材登记（只读） ── */
function inspectDraft(result) {
  const draftDir = result?.draftDir;
  if (!draftDir || !fs.existsSync(draftDir)) return { exists: false, draftDir: draftDir || '' };
  const resourcesDir = path.join(draftDir, 'Resources');
  const resources = fs.existsSync(resourcesDir)
    ? fs
        .readdirSync(resourcesDir)
        .map(name => ({ name, bytes: fs.statSync(path.join(resourcesDir, name)).size }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  let materials = null;
  let draftInfoPlain = false;
  try {
    const info = JSON.parse(fs.readFileSync(path.join(draftDir, 'draft_info.json'), 'utf8'));
    draftInfoPlain = true;
    materials = {};
    for (const list of ['videos', 'audios', 'texts'])
      materials[list] = (info?.materials?.[list] || []).map(item => ({
        type: item.type ?? null,
        materialName: item.material_name ?? null,
        path: item.path ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
        duration: item.duration ?? null,
        hasAudio: item.has_audio ?? null,
      }));
    materials.canvas = info?.canvas_config || info?.canvas || null;
    materials.duration = info?.duration ?? null;
  } catch {
    // 剪映打开过会写成加密二进制，读不出明文属正常
  }
  return { exists: true, draftDir, resources, draftInfoPlain, materials };
}

async function main() {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  let mediaProbe = null;
  if (verify2) {
    buildVerify2Media();
    mediaProbe = probeVerify2Media();
    if (prepareOnly) {
      console.log(JSON.stringify(mediaProbe, null, 2));
      console.log(`素材就绪（未导出）：${VERIFY2_MEDIA}`);
      return;
    }
  } else {
    buildMedia();
  }
  ensureVerify2Guards();
  ensureJianyingQuit();
  const snapshot = buildSnapshot(project);

  const logFile = path.join(path.dirname(outFile), `electron-${path.basename(outFile, '.json')}.log`);
  const logFd = fs.openSync(logFile, 'w');
  const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'electron'), ['.', '--selftest'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      FJT_SELFTEST_MODE: 'e2e',
      FJT_DEBUG_PORT: String(DEBUG_PORT),
    },
    stdio: ['ignore', logFd, logFd],
  });
  let browser = null;
  try {
    await waitForDebugPort();
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null });
    let page = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      page = (await browser.pages()).find(p => p.url().includes('/renderer/index.html'));
      if (page) break;
      await new Promise(r => setTimeout(r, 200));
    }
    if (!page) throw new Error('没找到分镜台界面页');
    await page.waitForFunction(() => document.readyState === 'complete' && !!window.native, { timeout: 30000 });
    await new Promise(r => setTimeout(r, 500));

    const outcome = await page.evaluate(
      async ({ snapshot, options, draftName }) => {
        const editExport = await import('./src/app/edit-export.js');
        const projectLoad = await import('./src/app/project-load.js');
        projectLoad.loadProjectIntoState(snapshot);
        const captured = editExport.captureExportSnapshot();
        if (!captured.ok) return { stage: 'capture', error: captured.error };
        const prepared = await editExport.prepareJianyingExport(captured.snapshot, options);
        if (!prepared.ok) return { stage: 'prepare', error: prepared.error };
        const progress = [];
        const result = await editExport.startPreparedJianyingExport(prepared, {
          mode: 'library',
          draftName,
          onProgress: p => progress.push(p),
        });
        return {
          stage: 'export',
          captureOk: true,
          options: prepared.options,
          plan: {
            fields: Object.keys(prepared.plan),
            durationUs: prepared.plan.durationUs,
            stats: prepared.plan.stats,
            tracks: {
              video: prepared.plan.tracks.video.length,
              audio: (prepared.plan.tracks.audio || []).length,
              text: (prepared.plan.tracks.text || []).length,
            },
            derived: (prepared.plan.derived || []).map(item => ({
              planId: item.planId,
              sourcePath: item.sourcePath,
              atUs: item.atUs,
              sourceInUs: item.sourceInUs,
              sourceOutUs: item.sourceOutUs,
              outputName: item.outputName,
              width: item.width,
              height: item.height,
            })),
            assets: (prepared.plan.assets || []).map(item => ({
              planId: item.planId,
              kind: item.kind,
              width: item.width,
              height: item.height,
              durationUs: item.durationUs,
              path: item.path,
            })),
          },
          issues: prepared.issues,
          volume: prepared.volume,
          progressTail: progress.slice(-3),
          result,
        };
      },
      { snapshot, options: { width: canvasW, height: canvasH, fps, subtitles }, draftName },
    );

    const record = {
      at: new Date().toISOString(),
      project,
      draftName,
      canvas: { width: canvasW, height: canvasH },
      fps,
      subtitles,
      mediaProbe,
      snapshot,
      outcome,
      draft: outcome.stage === 'export' ? inspectDraft(outcome.result) : null,
    };
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
    console.log(`写出结果：${outFile}`);
    console.log(`阶段：${outcome.stage}`);
    if (outcome.stage === 'export') {
      console.log(
        `导出 ok=${outcome.result?.ok} registered=${outcome.result?.registered} needsQuit=${outcome.result?.needsQuit}`,
      );
      console.log(`draftDir=${outcome.result?.draftDir}`);
      console.log(
        `draftName=${outcome.result?.draftName} segments=${outcome.result?.segmentCount} assets=${outcome.result?.assetCount} freezes=${outcome.result?.freezeCount}`,
      );
      console.log(`issues=${JSON.stringify((outcome.issues || []).map(i => `${i.level}:${i.code}:${i.message}`))}`);
      if (outcome.result?.error) console.log(`error=${outcome.result.error}`);
      console.log(`planStats=${JSON.stringify(outcome.plan?.stats?.videoSegments ?? outcome.plan?.stats)}`);
    } else {
      console.log(JSON.stringify(outcome, null, 2));
    }
  } finally {
    try {
      if (browser) await browser.close();
    } catch {}
    try {
      child.kill('SIGTERM');
    } catch {}
    await new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      child.once('exit', finish);
      setTimeout(finish, 8000);
    });
    try {
      fs.closeSync(logFd);
    } catch {}
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
