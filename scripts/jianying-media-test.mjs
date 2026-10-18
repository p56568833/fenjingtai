/* 剪映导出「真实媒体元数据 + 探测失败分类」验收测试。
   真实 ffmpeg 合成横屏 / 竖屏 / 方形 / 带 rotation=90 的视频与真实 PNG/JPEG/GIF/WebP，
   走 buildEditExportPlan + 真实 exporter（createMediaTools，不注入成功替身）导出 folder 模式草稿。
   覆盖：
   1. draft_info 里视频/图片素材宽高是真实值（不是画布 1920×1080）、旋转用显示方向、视频时长是完整源时长
   2. 定格 PNG 真实输出尺寸；视频段与定格段相邻且尺寸一致
   3. 文本伪装 .mp4 当必需视频 → 阻塞并定位到素材与句子
   4. 真实损坏图片 / 纯音频 mp4 当视频 / 无音轨视频当口播 → 分别阻塞
   5. 真实 FIFO + 短超时 → media-probe-timeout
   6. 工具缺失只阻塞真正依赖工具的操作，基础草稿仍可生成
   7. 封面生成失败可回退，但必需视频验证失败不得回退成 ok:true
   另含 media-info 与 schema 的纯逻辑单测（真实 ffprobe JSON / 真实图片文件）。
   本机没有 ffmpeg/ffprobe 时打印 SKIP 并退出（不假装通过）。
   用法：node scripts/jianying-media-test.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEditExportPlan } from '../renderer/src/core/edit-export-plan.js';

const require = createRequire(import.meta.url);
const mediaInfo = require('../electron/jianying/media-info.js');
const schema = require('../electron/jianying/schema.js');

/* exporter 依赖 frame.js（另一位成员）；加载失败时集成用例给出明确原因，不静默跳过 */
let exporter = null;
let exporterLoadError = null;
try {
  exporter = require('../electron/jianying-export.js');
} catch (error) {
  exporterLoadError = error;
}
const requireExporter = () => {
  assert.ok(
    exporter,
    `真实 exporter 加载失败（可能依赖尚未落地的 electron/jianying/frame.js）：${exporterLoadError?.message || ''}`,
  );
  return exporter;
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let passed = 0;
let failed = 0;
const failures = [];

/* ── 工具与临时目录 ── */
function findTool(name) {
  const candidates = [
    process.env.FJT_FFMPEG,
    path.join('/opt/homebrew/bin', name),
    path.join('/usr/local/bin', name),
    path.join('/usr/bin', name),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  try {
    const found = execFileSync('/usr/bin/which', [name], { encoding: 'utf8', timeout: 3000 }).trim();
    if (found && fs.existsSync(found)) return found;
  } catch {}
  return '';
}

const FFMPEG = findTool('ffmpeg');
const FFPROBE = findTool('ffprobe');
const CWEBP = fs.existsSync('/opt/homebrew/bin/cwebp') ? '/opt/homebrew/bin/cwebp' : '';
const root = fs.mkdtempSync(path.join(os.tmpdir(), '分镜台媒体测试-'));
const fixturesDir = path.join(root, 'fixtures');
const FIXED_NOW = 1792254000000;
let fixtures = null;

const runTool = (bin, args, timeout = 30000) =>
  execFileSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

const ffmpegRun = (...args) => runTool(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

const ffprobeJson = file =>
  JSON.parse(runTool(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 15000));

const probeVia = file => mediaInfo.normalizeProbe(ffprobeJson(file));
const ffprobeJsonOrNull = file => {
  try {
    return ffprobeJson(file);
  } catch {
    return null;
  }
};
const ffprobeFrameTimes = file => {
  const raw = JSON.parse(
    runTool(
      FFPROBE,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'json',
        file,
      ],
      30000,
    ),
  );
  return (Array.isArray(raw.frames) ? raw.frames : [])
    .map(item => Math.round(Number(item.best_effort_timestamp_time) * 1e6))
    .filter(Number.isFinite);
};

/* 帧内容 → 1×1 RGB：合成素材每帧一种纯色，比较颜色就能判断定格抽到的是第几帧 */
const frameColor = index => [(index * 13) % 256, (index * 53) % 256, (index * 97) % 256];
const pngColor = file => {
  const out = execFileSync(
    FFMPEG,
    ['-v', 'error', '-i', file, '-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 4096, timeout: 15000 },
  );
  assert.ok(out.length >= 3, `读取定格 PNG 颜色失败：${file}`);
  return [out[0], out[1], out[2]];
};
const colorGap = (left, right) => Math.max(...left.map((value, index) => Math.abs(value - right[index])));
const assertPngFrame = (file, index, label, offset = 0) => {
  const actual = pngColor(file);
  const wanted = frameColor(index + offset);
  assert.ok(
    colorGap(actual, wanted) <= 10,
    `${label}：定格画面 rgb(${actual.join(',')}) 应是第 ${index} 帧 rgb(${wanted.join(',')})`,
  );
};
const assertPngNotFrame = (file, index, label, offset = 0) => {
  const actual = pngColor(file);
  const wanted = frameColor(index + offset);
  assert.ok(
    colorGap(actual, wanted) > 40,
    `${label}：定格画面 rgb(${actual.join(',')}) 不应是第 ${index} 帧 rgb(${wanted.join(',')})`,
  );
};

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const approx = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `${label}：实际 ${actual}，期望 ${expected}（容差 ${tolerance}）`,
  );

/* 把 MP4 的 mvhd/tkhd/mdhd 时长改成 0，模拟「容器没写总时长」的真实文件：
   这种文件仍可正常解码，只是 ffprobe 读不到 duration；用来验证「按视频包推算完整时长」的兜底。 */
function zeroMp4Durations(input, output) {
  const buf = fs.readFileSync(input);
  const walk = (start, end) => {
    let off = start;
    while (off + 8 <= end) {
      let size = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      let header = 8;
      if (size === 1) {
        size = Number(buf.readBigUInt64BE(off + 8));
        header = 16;
      } else if (size === 0) size = end - off;
      if (size < header || off + size > end) break;
      if (['moov', 'trak', 'mdia'].includes(type)) walk(off + header, off + size);
      if (['mvhd', 'tkhd', 'mdhd'].includes(type)) {
        const version = buf[off + header];
        const relative = type === 'tkhd' ? (version === 1 ? 36 : 28) : version === 1 ? 32 : 24;
        const at = off + relative;
        if (version === 1) buf.writeBigUInt64BE(0n, at);
        else buf.writeUInt32BE(0, at);
      }
      off += size;
    }
  };
  walk(0, buf.length);
  fs.writeFileSync(output, buf);
}

/* ── 合成真实媒体（尺寸/时长/旋转都是真值，后面断言直接用这些） ── */
function prepareFixtures() {
  fs.mkdirSync(fixturesDir, { recursive: true });
  const fileOf = name => path.join(fixturesDir, name);

  ffmpegRun(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    fileOf('横屏-320x180.mp4'),
  );
  ffmpegRun(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=120x200:rate=30:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    fileOf('竖屏-120x200.mp4'),
  );
  ffmpegRun(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=180x180:rate=30:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    fileOf('方形-180x180.mp4'),
  );
  ffmpegRun(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=200x120:rate=30:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    fileOf('旋转源-200x120.mp4'),
  );
  /* 真实 Display Matrix 旋转 90 度：源画面 200×120，显示方向 120×200 */
  ffmpegRun(
    '-display_rotation',
    '90',
    '-i',
    fileOf('旋转源-200x120.mp4'),
    '-c',
    'copy',
    fileOf('旋转90-显示120x200.mp4'),
  );
  ffmpegRun(
    '-f',
    'lavfi',
    '-i',
    'color=c=0x3355ff:size=120x200:duration=1',
    '-frames:v',
    '1',
    fileOf('图片-120x200.png'),
  );
  ffmpegRun(
    '-f',
    'lavfi',
    '-i',
    'color=c=0xff5500:size=180x180:duration=1',
    '-frames:v',
    '1',
    fileOf('图片-180x180.jpg'),
  );
  ffmpegRun('-f', 'lavfi', '-i', 'color=c=0x00cc66:size=90x60:duration=1', '-frames:v', '1', fileOf('图片-90x60.gif'));
  ffmpegRun('-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-c:a', 'aac', fileOf('口播-6秒.m4a'));
  ffmpegRun('-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-c:a', 'aac', fileOf('只有声音.mp4'));
  ffmpegRun(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    fileOf('没有音轨.mp4'),
  );
  ffmpegRun(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x120:rate=30:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    fileOf('普通-160x120.mp4'),
  );
  zeroMp4Durations(fileOf('普通-160x120.mp4'), fileOf('无总时长-160x120.mp4'));
  /* 定格时间基准素材（复现真实问题）：
     a) 120×200 / 5fps / 1s，setpts 整体 +2s 且 -fps_mode vfr → 容器起点 2s、时长 1s、原始 PTS 2–2.8s；
        播放时间 0–0.8s，clip in=0/out=0.51 应取播放时间 0.4s（原始 PTS 2.4s）那帧。
     b) 120×200 / 30fps / 10s，首帧 PTS=0、其余整体 +5s → 下一帧约 5.033s、文件总长 15s；
        clip in=2/out=3 落在首帧可见区间里，应取首帧。首帧颜色偏移 1，避免纯黑与失败黑帧混淆。 */
  ffmpegRun(
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=120x200:r=5:d=1',
    '-vf',
    "geq=r='mod(N*13,256)':g='mod(N*53,256)':b='mod(N*97,256)',setpts=PTS+2/TB",
    '-fps_mode',
    'vfr',
    '-c:v',
    'libx264',
    '-qp',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-video_track_timescale',
    '1000000',
    '-an',
    fileOf('定格-延迟起点-5fps.mp4'),
  );
  ffmpegRun(
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=120x200:r=30:d=10',
    '-vf',
    "geq=r='mod((N+1)*13,256)':g='mod((N+1)*53,256)':b='mod((N+1)*97,256)',setpts='if(eq(N,0),0,PTS+5/TB)'",
    '-fps_mode',
    'vfr',
    '-c:v',
    'libx264',
    '-qp',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-video_track_timescale',
    '1000000',
    '-an',
    fileOf('定格-VFR长静止-120x200.mp4'),
  );
  fs.writeFileSync(fileOf('伪装视频.mp4'), '这不是视频，只是一段文本，用来验证探测失败分类。\n', 'utf8');
  fs.writeFileSync(fileOf('损坏图片.png'), 'garbage-not-a-png', 'utf8');

  let webp = '';
  let webpLossless = '';
  if (CWEBP) {
    try {
      webp = fileOf('图片-120x200.webp');
      webpLossless = fileOf('图片-120x200-无损.webp');
      runTool(CWEBP, ['-quiet', fileOf('图片-120x200.png'), '-o', webp]);
      runTool(CWEBP, ['-quiet', '-lossless', fileOf('图片-120x200.png'), '-o', webpLossless]);
    } catch {
      webp = '';
      webpLossless = '';
    }
  }

  const expected = {
    landscape: {
      file: fileOf('横屏-320x180.mp4'),
      width: 320,
      height: 180,
      displayWidth: 320,
      displayHeight: 180,
      durationUs: 2000000,
      hasAudio: true,
    },
    portrait: {
      file: fileOf('竖屏-120x200.mp4'),
      width: 120,
      height: 200,
      displayWidth: 120,
      displayHeight: 200,
      durationUs: 2000000,
      hasAudio: false,
    },
    square: {
      file: fileOf('方形-180x180.mp4'),
      width: 180,
      height: 180,
      displayWidth: 180,
      displayHeight: 180,
      durationUs: 2000000,
      hasAudio: false,
    },
    rotated: {
      file: fileOf('旋转90-显示120x200.mp4'),
      width: 200,
      height: 120,
      rotation: 90,
      displayWidth: 120,
      displayHeight: 200,
      durationUs: 2000000,
      hasAudio: false,
    },
    png: { file: fileOf('图片-120x200.png'), width: 120, height: 200, format: 'png' },
    jpg: { file: fileOf('图片-180x180.jpg'), width: 180, height: 180, format: 'jpeg' },
    gif: { file: fileOf('图片-90x60.gif'), width: 90, height: 60, format: 'gif' },
    webp: webp ? { file: webp, width: 120, height: 200, format: 'webp' } : null,
    webpLossless: webpLossless ? { file: webpLossless, width: 120, height: 200, format: 'webp' } : null,
    voice: { file: fileOf('口播-6秒.m4a'), width: 0, height: 0, durationUs: 6000000 },
    audioOnlyMp4: { file: fileOf('只有声音.mp4'), hasVideo: false, hasAudio: true, durationUs: 2000000 },
    silentVideo: { file: fileOf('没有音轨.mp4'), width: 320, height: 180, hasVideo: true, hasAudio: false },
    unknownDuration: { file: fileOf('无总时长-160x120.mp4'), width: 160, height: 120 },
    freezeDelayed: {
      file: fileOf('定格-延迟起点-5fps.mp4'),
      width: 120,
      height: 200,
      startUs: 2000000,
      durationUs: 1000000,
    },
    freezeVfrGap: {
      file: fileOf('定格-VFR长静止-120x200.mp4'),
      width: 120,
      height: 200,
      durationUs: 15000000,
    },
    fakeMp4: { file: fileOf('伪装视频.mp4') },
    corruptPng: { file: fileOf('损坏图片.png') },
  };

  /* 自检：合成结果符合预期，避免「媒体没造好」被误判成产品失败 */
  const land = probeVia(expected.landscape.file);
  assert.equal(land.ok, true, '横屏视频探测失败');
  assert.equal(land.width, 320);
  assert.equal(land.height, 180);
  assert.equal(land.hasAudio, true);
  const rot = probeVia(expected.rotated.file);
  assert.equal(rot.ok, true, '旋转视频探测失败');
  assert.equal(Math.abs(Math.round(rot.rotation)), 90, `旋转视频 rotation=${rot.rotation}`);
  assert.equal(rot.displayWidth, 120);
  assert.equal(rot.displayHeight, 200);
  const fakeRaw = ffprobeJsonOrNull(expected.fakeMp4.file);
  const fake = fakeRaw ? mediaInfo.normalizeProbe(fakeRaw) : { ok: false };
  assert.equal(fake.ok, false, `文本伪装的 mp4 不应被解析成可用媒体：${JSON.stringify(fake)}`);
  const zeroed = ffprobeJsonOrNull(expected.unknownDuration.file);
  assert.equal(
    Number(zeroed?.format?.duration ?? 0) || Number(zeroed?.streams?.[0]?.duration ?? 0) || 0,
    0,
    '无总时长样片仍应没有 duration',
  );

  /* 定格素材自检：原始时间戳和容器起点必须真的复现了问题，不然断言没有意义 */
  const delayedProbe = ffprobeJson(expected.freezeDelayed.file);
  assert.equal(Number(delayedProbe.format.start_time), 2, '延迟起点素材的容器起点应为 2s');
  assert.equal(Number(delayedProbe.format.duration), 1, '延迟起点素材的容器时长应为 1s');
  const delayedTimes = ffprobeFrameTimes(expected.freezeDelayed.file);
  assert.deepEqual(delayedTimes, [2000000, 2200000, 2400000, 2600000, 2800000], '延迟起点素材原始 PTS 2–2.8s');
  const vfrProbe = ffprobeJson(expected.freezeVfrGap.file);
  assert.equal(Number(vfrProbe.format.start_time), 0, 'VFR 长静止素材容器起点应为 0');
  approx(vfrProbe.format.duration, 15, 0.001, 'VFR 长静止素材总长');
  const vfrTimes = ffprobeFrameTimes(expected.freezeVfrGap.file);
  assert.equal(vfrTimes.length, 300, `VFR 长静止素材应有 300 帧，实际 ${vfrTimes.length}`);
  assert.equal(vfrTimes[0], 0, 'VFR 长静止素材首帧 PTS=0');
  approx(vfrTimes[1], 5033333, 1000, 'VFR 长静止素材第二帧 PTS 应约 5.033s');

  fixtures = expected;
  fixtures.dir = fixturesDir;
  fixtures.ffmpeg = FFMPEG;
  fixtures.ffprobe = FFPROBE;
  fixtures.cwebp = CWEBP;
}

/* ── 项目快照 / 计划 / 导出 ── */
const ids = () => {
  let n = 0;
  return prefix => `${prefix}-${++n}`;
};

/* visuals: [{ assetId, file, name, kind, durationSec?, start, end, clip?, fitDone? }]
   at 是时间线上的绝对秒；line 覆盖整段。 */
function makeProject({ visuals, voice = null, durationSec, title = '真实媒体测试', text = '第一句话。' }) {
  const rows = [
    {
      id: 'L1',
      kind: 'line',
      no: 1,
      text,
      time: { start: 0, end: durationSec, st: 'ok' },
      groupId: 'g-media',
      assetUsages: visuals.map(visual => ({
        assetId: visual.assetId,
        role: 'main',
        ...(visual.clip ? { clip: { in: visual.clip.in, out: visual.clip.out } } : {}),
        ...(visual.fitDone ? { fitDone: true } : {}),
        at: { start: visual.start, end: visual.end, of: 'L1' },
      })),
    },
  ];
  const assets = {};
  for (const visual of visuals)
    assets[visual.assetId] = {
      id: visual.assetId,
      path: visual.file,
      name: visual.name || path.basename(visual.file),
      kind: visual.kind,
      ...(visual.durationSec != null ? { durationSec: visual.durationSec } : {}),
    };
  return {
    projectId: 'media-test',
    title,
    rows,
    assets,
    types: [],
    speechRate: 4.5,
    voice: voice ? { path: voice.file, name: path.basename(voice.file), duration: voice.duration } : null,
    updatedAt: 1,
  };
}

const planOf = project =>
  buildEditExportPlan(project, { width: 1920, height: 1080, fps: 30 }, { idFor: ids(), probes: {} });

function toolWithMedia(media, overrides = {}) {
  return { ...media, ...overrides };
}

async function runExport({ project, plan, media, label, draftName }) {
  const mod = requireExporter();
  const destDir = path.join(root, `导出-${label}`);
  fs.mkdirSync(destDir, { recursive: true });
  const result = await mod.runJianyingExport(
    {
      plan,
      snapshot: project,
      options: { mode: 'folder', destDir, draftName },
      appVersion: '11.6.0',
      nowMs: FIXED_NOW,
    },
    {},
    {
      media,
      idFor: ids(),
      now: () => FIXED_NOW,
      freeBytes: () => 8 * 1024 * 1024 * 1024,
      isRunning: () => false,
    },
  );
  return { result, destDir };
}

const realMedia = () => requireExporter().createMediaTools({ find: () => FFMPEG });

const draftOf = result => readJson(path.join(result.draftDir, 'draft_info.json'));
const videoTrackOf = doc => {
  const track = (doc.tracks || []).find(item => item.type === 'video');
  return track ? track.segments : [];
};
const materialById = (doc, id) => (doc.materials.videos || []).find(item => item.id === id) || null;
const blockIssues = result => (result.issues || []).filter(item => item.level === 'block');
const hasIssueCode = (result, code) => (result.issues || []).some(item => item.code === code);

/* ── 1. media-info：真实 ffprobe JSON 归一化 ── */
test('media-info：真实 ffprobe JSON 归一化（横屏/竖屏/方形/旋转/图片/纯音频）', () => {
  const land = probeVia(fixtures.landscape.file);
  assert.equal(land.ok, true);
  assert.equal(land.width, 320);
  assert.equal(land.height, 180);
  assert.equal(land.displayWidth, 320);
  assert.equal(land.displayHeight, 180);
  approx(land.durationUs, 2000000, 100000, '横屏完整时长');
  assert.equal(land.hasVideo, true);
  assert.equal(land.hasAudio, true);
  assert.deepEqual(land.frameRate, { num: 30, den: 1 });
  assert.equal(land.videoCodec, 'h264');
  assert.equal(land.audioCodec, 'aac');
  assert.match(land.formatName, /mp4|mov/);

  const portrait = probeVia(fixtures.portrait.file);
  assert.deepEqual([portrait.width, portrait.height], [120, 200]);
  assert.deepEqual([portrait.displayWidth, portrait.displayHeight], [120, 200]);
  assert.equal(portrait.hasAudio, false);

  const square = probeVia(fixtures.square.file);
  assert.deepEqual([square.width, square.height], [180, 180]);

  const rotated = probeVia(fixtures.rotated.file);
  assert.equal(rotated.ok, true);
  assert.deepEqual([rotated.width, rotated.height], [200, 120], '旋转视频源尺寸');
  assert.ok(Math.abs(Math.round(rotated.rotation)) === 90, `rotation=${rotated.rotation}`);
  assert.deepEqual([rotated.displayWidth, rotated.displayHeight], [120, 200], '旋转视频显示尺寸');

  const png = probeVia(fixtures.png.file);
  assert.equal(png.ok, true);
  assert.deepEqual([png.width, png.height], [120, 200]);
  assert.equal(png.hasVideo, true);
  assert.equal(png.hasAudio, false);

  const voice = probeVia(fixtures.voice.file);
  assert.equal(voice.ok, true);
  assert.equal(voice.hasVideo, false);
  assert.equal(voice.hasAudio, true);
  approx(voice.durationUs, 6000000, 100000, '纯音频时长');
  assert.equal(voice.width, 0);
  assert.equal(voice.height, 0);
});

test('media-info：durationFromPackets 按首包 PTS 归一化，时间轴不从 0 开始不会高估', () => {
  assert.equal(
    mediaInfo.durationFromPackets({
      packets: [
        { pts_time: '10.000000', duration_time: '0.040000' },
        { pts_time: '11.960000', duration_time: '0.040000' },
      ],
    }),
    2000000,
    '首包从 10s 开始时，总时长应是 end - first，而不是绝对 end',
  );
  assert.equal(
    mediaInfo.durationFromPackets({ packets: [{ duration_time: '0.040000' }, { duration_time: '0.040000' }] }),
    80000,
    '裸流没有 PTS 时用每包时长求和',
  );
  assert.equal(mediaInfo.durationFromPackets({ packets: [] }), 0);
});

test('media-info：tags.rotate、时长回退、帧率 0/0、无流与坏 JSON', () => {
  const tagsRotate = mediaInfo.normalizeProbe({
    format: { format_name: 'mov,mp4' },
    streams: [
      {
        codec_type: 'video',
        width: 200,
        height: 120,
        codec_name: 'h264',
        avg_frame_rate: '0/0',
        tags: { rotate: '90' },
      },
    ],
  });
  assert.equal(tagsRotate.ok, true);
  assert.equal(tagsRotate.rotation, 90);
  assert.deepEqual([tagsRotate.displayWidth, tagsRotate.displayHeight], [120, 200]);
  assert.equal(tagsRotate.frameRate, null);
  assert.equal(tagsRotate.durationUs, 0, '没有 format/stream 时长时写 0');

  const durationFallback = mediaInfo.normalizeProbe({
    format: {},
    streams: [{ codec_type: 'video', width: 320, height: 180, codec_name: 'h264', duration: '1.500000' }],
  });
  assert.equal(durationFallback.durationUs, 1500000, 'format.duration 缺失时回退视频流时长');

  const sideData = mediaInfo.normalizeProbe({
    format: { duration: '2.0', format_name: 'mov,mp4' },
    streams: [
      {
        codec_type: 'video',
        width: 200,
        height: 120,
        avg_frame_rate: '30000/1001',
        side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
      },
    ],
  });
  assert.equal(sideData.rotation, -90);
  assert.deepEqual([sideData.displayWidth, sideData.displayHeight], [120, 200], '负角度同样交换');
  assert.deepEqual(sideData.frameRate, { num: 30000, den: 1001 });

  /* 音频文件带的封面图不是视频画面（attached_pic） */
  const audioWithCover = mediaInfo.normalizeProbe({
    format: { duration: '30.0', format_name: 'mp3' },
    streams: [
      { codec_type: 'audio', codec_name: 'mp3' },
      { codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } },
    ],
  });
  assert.equal(audioWithCover.ok, true);
  assert.equal(audioWithCover.hasVideo, false, '封面图流不算视频画面');
  assert.equal(audioWithCover.hasAudio, true);

  assert.equal(mediaInfo.normalizeProbe(null).ok, false);
  assert.equal(mediaInfo.normalizeProbe({}).code, mediaInfo.CODES.PROBE_FAILED);
  assert.equal(mediaInfo.normalizeProbe({ streams: [] }).ok, false);
  const corruptImage = mediaInfo.normalizeProbe({
    format: { format_name: 'image2' },
    streams: [{ codec_type: 'video', codec_name: 'png', width: 0, height: 0 }],
  });
  assert.equal(corruptImage.ok, false, '宽高为 0 的图片流不算可用素材');
  assert.match(corruptImage.error, /损坏|不可用/);
});

/* ── 2. media-info：探测失败分类 ── */
test('media-info：探测失败分类（工具缺失/超时/损坏/不支持/未知出口码）', () => {
  const toolMissing = mediaInfo.classifyProbeFailure({ toolMissing: true });
  assert.equal(toolMissing.code, mediaInfo.CODES.TOOL_MISSING);
  assert.match(toolMissing.message, /ffmpeg|ffprobe/);

  const timeout = mediaInfo.classifyProbeFailure({ timedOut: true });
  assert.equal(timeout.code, mediaInfo.CODES.PROBE_TIMEOUT);
  assert.match(timeout.message, /超时/);

  for (const stderr of [
    'moov atom not found',
    'file.mp4: Invalid data found when processing input',
    'Could not find codec parameters for stream 0 (Video: h264, none): unspecified size',
  ]) {
    const corrupt = mediaInfo.classifyProbeFailure({ stderr, exitCode: 1 });
    assert.equal(corrupt.code, mediaInfo.CODES.PROBE_FAILED, stderr);
    assert.match(corrupt.message, /损坏|不是可用的媒体文件/, stderr);
  }
  for (const stderr of ["Unknown decoder 'foo'", 'Decoder (codec vp9) not found', 'Unsupported codec with id 0']) {
    const unsupported = mediaInfo.classifyProbeFailure({ stderr, exitCode: 1 });
    assert.equal(unsupported.code, mediaInfo.CODES.UNSUPPORTED, stderr);
    assert.match(unsupported.message, /不支持/);
  }
  const unsupportedFormat = mediaInfo.classifyProbeFailure({ formatName: 'heic' });
  assert.equal(unsupportedFormat.code, mediaInfo.CODES.UNSUPPORTED);
  const knownContainer = mediaInfo.classifyProbeFailure({ formatName: 'mov,mp4,m4a' });
  assert.equal(knownContainer.code, mediaInfo.CODES.PROBE_FAILED);
  const notMedia = mediaInfo.classifyProbeFailure({ formatName: 'tty' });
  assert.equal(notMedia.code, mediaInfo.CODES.PROBE_FAILED);
  assert.match(notMedia.message, /不是可用的媒体文件/);
  const generic = mediaInfo.classifyProbeFailure({ stderr: 'something odd happened', exitCode: 2 });
  assert.equal(generic.code, mediaInfo.CODES.PROBE_FAILED);
  const empty = mediaInfo.classifyProbeFailure({});
  assert.equal(empty.code, mediaInfo.CODES.PROBE_FAILED);
  assert.match(empty.message, /读不出素材信息/);
});

/* ── 3. media-info：imageSizeOf 真实图片文件 ── */
test('media-info：imageSizeOf 读真实 PNG/JPEG/GIF/WebP 与坏文件', () => {
  for (const key of ['png', 'jpg', 'gif']) {
    const expected = fixtures[key];
    const size = mediaInfo.imageSizeOf({ fs, file: expected.file });
    assert.ok(size, `${key} 读不出尺寸`);
    assert.deepEqual([size.width, size.height, size.format], [expected.width, expected.height, expected.format]);
  }
  if (fixtures.webp) {
    for (const key of ['webp', 'webpLossless']) {
      const expected = fixtures[key];
      const size = mediaInfo.imageSizeOf({ fs, file: expected.file });
      assert.ok(size, `${key} 读不出尺寸`);
      assert.deepEqual([size.width, size.height, size.format], [expected.width, expected.height, 'webp']);
    }
  }
  /* VP8X（扩展格式）头：真实 cwebp 不带 alpha 时不生成，用符合格式的最小文件验证解析 */
  const vp8x = path.join(fixtures.dir, '合成-VP8X.webp');
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(22, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(640 - 1, 24, 3);
  buffer.writeUIntLE(360 - 1, 27, 3);
  fs.writeFileSync(vp8x, buffer);
  assert.deepEqual(mediaInfo.imageSizeOf({ fs, file: vp8x }), { width: 640, height: 360, format: 'webp' });

  assert.equal(mediaInfo.imageSizeOf({ fs, file: fixtures.corruptPng.file }), null, '坏图片必须返回 null');
  assert.equal(mediaInfo.imageSizeOf({ fs, file: fixtures.fakeMp4.file }), null, '文本文件必须返回 null');
  assert.equal(mediaInfo.imageSizeOf({ fs, file: path.join(fixtures.dir, '不存在.png') }), null);
  assert.equal(mediaInfo.imageSizeOf({ fs, file: '' }), null);
  assert.equal(mediaInfo.imageSizeOf({ fs }), null);
});

/* ── 4. schema：media 参数 ── */
test('schema：media 写真实尺寸/方向/完整时长，未知绝不回退画布', () => {
  const plan = {
    schemaVersion: 1,
    canvas: { width: 1920, height: 1080 },
    fps: { num: 30, den: 1 },
    durationUs: 6000000,
    assets: [
      { planId: 'v', kind: 'video', path: '/tmp/v.mp4', name: 'v.mp4', width: null, height: null, durationUs: 1000000 },
      { planId: 'r', kind: 'video', path: '/tmp/r.mp4', name: 'r.mp4', width: 200, height: 120, durationUs: null },
      { planId: 'p', kind: 'image', path: '/tmp/p.png', name: 'p.png', width: null, height: null, durationUs: null },
      { planId: 'n', kind: 'video', path: '/tmp/n.mp4', name: 'n.mp4', width: null, height: null, durationUs: 7000000 },
    ],
    derived: [
      {
        planId: 'f',
        type: 'freeze',
        sourceAssetId: 'v',
        sourcePath: '/tmp/v.mp4',
        atUs: 900000,
        width: 1920,
        height: 1080,
        outputName: 'f.png',
      },
    ],
    tracks: {
      video: [
        {
          id: 's1',
          assetId: 'v',
          targetStartUs: 0,
          targetDurationUs: 1000000,
          sourceStartUs: 0,
          sourceDurationUs: 1000000,
          speed: 1,
          volume: 0,
        },
        {
          id: 's2',
          assetId: 'r',
          targetStartUs: 1000000,
          targetDurationUs: 1000000,
          sourceStartUs: 0,
          sourceDurationUs: 1000000,
          speed: 1,
          volume: 0,
        },
        {
          id: 's3',
          assetId: 'p',
          targetStartUs: 2000000,
          targetDurationUs: 1000000,
          sourceStartUs: 0,
          sourceDurationUs: 1000000,
          speed: 1,
          volume: 0,
        },
        {
          id: 's4',
          assetId: 'f',
          targetStartUs: 3000000,
          targetDurationUs: 1000000,
          sourceStartUs: 0,
          sourceDurationUs: 1000000,
          speed: 1,
          volume: 0,
        },
        {
          id: 's5',
          assetId: 'n',
          targetStartUs: 4000000,
          targetDurationUs: 1000000,
          sourceStartUs: 0,
          sourceDurationUs: 1000000,
          speed: 1,
          volume: 0,
        },
      ],
      audio: [],
      text: [],
    },
    issues: [],
  };
  const resources = {
    v: '/tmp/d/Resources/v.mp4',
    r: '/tmp/d/Resources/r.mp4',
    p: '/tmp/d/Resources/p.png',
    f: '/tmp/d/Resources/f.png',
    n: '/tmp/d/Resources/n.mp4',
  };
  const build = media =>
    schema.buildDraftInfo({
      plan,
      draft: { id: 'd', name: 'n', dir: '/tmp/d' },
      resources,
      nowUs: FIXED_NOW * 1000,
      idFor: ids(),
      ...(media ? { media } : {}),
    });
  const media = new Map([
    ['v', { width: 320, height: 180, rotation: 0, durationUs: 2000000, hasVideo: true, hasAudio: true }],
    ['r', { width: 200, height: 120, rotation: 90, durationUs: 2000000, hasVideo: true, hasAudio: false }],
    ['p', { width: 120, height: 200, rotation: 0, durationUs: 0, hasVideo: true, hasAudio: false }],
    ['f', { width: 320, height: 180, rotation: 0, durationUs: 0, hasVideo: true, hasAudio: false }],
    ['n', { width: 640, height: 360, rotation: 0, durationUs: 0, hasVideo: true, hasAudio: true }],
  ]);
  const doc = build(media);
  assert.equal(doc.canvas_config.width, 1920, '画布结构不变');
  assert.equal(doc.canvas_config.height, 1080);
  const byName = name => doc.materials.videos.find(item => item.material_name === name);

  const video = byName('v.mp4');
  assert.deepEqual([video.width, video.height], [320, 180], '视频真实尺寸');
  assert.equal(video.duration, 2000000, '视频用完整源时长，大于使用区间 1s');
  assert.equal(video.has_audio, true);

  const rotated = byName('r.mp4');
  assert.deepEqual([rotated.width, rotated.height], [120, 200], '旋转视频写显示方向');
  assert.equal(rotated.has_audio, false);

  const photo = byName('p.png');
  assert.deepEqual([photo.width, photo.height], [120, 200], '图片真实尺寸');
  assert.equal(photo.type, 'photo');
  assert.equal(photo.duration, schema.PHOTO_DURATION_US, '图片仍用固定可用时长');
  assert.equal(photo.has_audio, false);

  const freeze = byName('f.png');
  assert.equal(freeze.type, 'photo');
  assert.deepEqual([freeze.width, freeze.height], [320, 180], '定格 PNG 真实尺寸，忽略计划里的画布宽高');

  const noDuration = byName('n.mp4');
  assert.equal(noDuration.duration, 7000000, '没有 media.durationUs 时回退 asset.durationUs');
  assert.equal(noDuration.has_audio, true);

  /* 不传 media：没有真实探测值，未知宽高写 0，绝不回退画布；有真实计划值时可回退（media → asset.width） */
  const bare = build(null);
  const bareByName = name => bare.materials.videos.find(item => item.material_name === name);
  for (const name of ['v.mp4', 'p.png', 'f.png', 'n.mp4']) {
    assert.equal(bareByName(name).width, 0, `${name} 未知宽高必须写 0`);
    assert.equal(bareByName(name).height, 0, `${name} 未知宽高必须写 0`);
  }
  assert.deepEqual(
    [bareByName('r.mp4').width, bareByName('r.mp4').height],
    [200, 120],
    'media 缺失时回退计划里的真实探测值',
  );
  for (const item of bare.materials.videos) {
    assert.ok(item.width !== 1920 || item.height !== 1080, `${item.material_name} 不能回退成画布尺寸`);
  }
  assert.equal(bareByName('v.mp4').has_audio, false);
  assert.equal(bareByName('v.mp4').duration, 1000000);

  /* 普通对象形式的 media 也支持；normalizeProbe 结果（带 displayWidth/Height）优先 */
  const objectDoc = build({
    v: {
      ...probeVia(fixtures.rotated.file),
    },
  });
  const objectVideo = objectDoc.materials.videos.find(item => item.material_name === 'v.mp4');
  assert.deepEqual([objectVideo.width, objectVideo.height], [120, 200], 'normalizeProbe 的 display 尺寸优先');
});

/* ── 5. 真实导出：尺寸 / 方向 / 完整时长 ── */
const measurements = () => {
  const { landscape, portrait, square, rotated, png } = fixtures;
  const visuals = [
    {
      assetId: 'vLand',
      file: landscape.file,
      kind: 'video',
      durationSec: 1.5, // 故意和真实 2 秒不一致：draft 必须用真实源时长
      start: 0,
      end: 1,
      clip: { in: 0, out: 1 },
    },
    {
      assetId: 'vPortrait',
      file: portrait.file,
      kind: 'video',
      durationSec: 2,
      start: 1,
      end: 2,
      clip: { in: 0, out: 1 },
    },
    { assetId: 'vSquare', file: square.file, kind: 'video', durationSec: 2, start: 2, end: 3, clip: { in: 0, out: 1 } },
    {
      assetId: 'vRotated',
      file: rotated.file,
      kind: 'video',
      durationSec: 2,
      start: 3,
      end: 4,
      clip: { in: 0, out: 1 },
    },
    { assetId: 'imgPng', file: png.file, kind: 'image', start: 4, end: 5 },
  ];
  return makeProject({ visuals, durationSec: 5, voice: { file: fixtures.voice.file, duration: 5 } });
};

test('导出：真实横屏/竖屏/方形/旋转/图片尺寸、方向与完整源时长', async () => {
  const project = measurements();
  const plan = planOf(project);
  assert.equal(plan.tracks.video.length, 5);
  assert.equal(
    plan.assets.find(item => item.path === fixtures.landscape.file)?.width,
    null,
    '计划里的宽高本来就是空值，真实尺寸必须由主进程探测补上',
  );

  const { result } = await runExport({
    project,
    plan,
    media: realMedia(),
    label: '尺寸方向',
    draftName: '媒体测试-尺寸方向',
  });
  assert.equal(result.ok, true, result.error);
  const doc = draftOf(result);
  const segments = videoTrackOf(doc);
  assert.equal(segments.length, 5);

  const check = (index, expected) => {
    const material = materialById(doc, segments[index].material_id);
    assert.ok(material, `第 ${index + 1} 段没有素材`);
    assert.equal(material.width, expected.width, `${material.material_name} 宽`);
    assert.equal(material.height, expected.height, `${material.material_name} 高`);
  };
  check(0, fixtures.landscape);
  check(1, fixtures.portrait);
  check(2, fixtures.square);
  check(3, { width: fixtures.rotated.displayWidth, height: fixtures.rotated.displayHeight });
  check(4, fixtures.png);
  for (const [index, expected] of [
    [0, fixtures.landscape],
    [1, fixtures.portrait],
    [2, fixtures.square],
    [3, fixtures.rotated],
  ]) {
    const material = materialById(doc, segments[index].material_id);
    assert.equal(material.type, 'video');
    approx(material.duration, expected.durationUs, 100000, `${material.material_name} 完整源时长`);
  }
  assert.equal(materialById(doc, segments[0].material_id).has_audio, true, '横屏视频真实有音轨');
  assert.equal(materialById(doc, segments[1].material_id).has_audio, false, '竖屏视频真实无音轨');
  assert.equal(materialById(doc, segments[4].material_id).type, 'photo');
  assert.equal(materialById(doc, segments[4].material_id).duration, schema.PHOTO_DURATION_US);
  assert.equal(doc.canvas_config.width, 1920, '画布仍是项目画布');
  assert.equal(doc.canvas_config.height, 1080);
});

/* ── 5.5 容器没写总时长：按真实视频包时间戳推算完整源时长 ── */
test('media-info / probe：容器无总时长时按视频包推算，并标记为推算值', async () => {
  const media = realMedia();
  const info = await media.probe({ path: fixtures.unknownDuration.file });
  assert.equal(info.ok, true, '可解码的无时长 MP4 必须探测成功');
  assert.equal(info.hasVideo, true);
  assert.equal(info.durationEstimated, true, '要标记这是推算出来的时长，不能冒充容器元数据');
  approx(info.durationUs, 2000000, 80000, '按视频包推算的完整时长');
});

test('导出：容器无总时长 → 草稿写推算的完整时长，保留进入剪映后延长裁剪的空间', async () => {
  const project = makeProject({
    visuals: [
      {
        assetId: 'vZero',
        file: fixtures.unknownDuration.file,
        kind: 'video',
        start: 0,
        end: 1,
        clip: { in: 0, out: 1 },
      },
    ],
    durationSec: 1,
    text: '无总时长测试。',
  });
  assert.equal(project.assets.vZero.durationSec, undefined, '项目记录故意不提供完整时长');
  const plan = planOf(project);
  const { result } = await runExport({
    project,
    plan,
    media: realMedia(),
    label: '无总时长',
    draftName: '媒体测试-无总时长',
  });
  assert.equal(result.ok, true, result.error);
  const doc = draftOf(result);
  const material = doc.materials.videos.find(item => item.path.endsWith('无总时长-160x120.mp4'));
  assert.ok(material, '草稿里应有该视频素材');
  approx(material.duration, 2000000, 80000, '素材时长应为推算的完整源时长');
  assert.ok(
    hasIssueCode(result, 'media-duration-estimated'),
    `要用提醒说明时长是推算的：${JSON.stringify(result.issues)}`,
  );
  assert.equal(hasIssueCode(result, 'media-duration-unknown'), false, '推算成功后不再报「无法确认时长」');
});

/* ── 6. 真实导出：定格 PNG 尺寸与衔接 ── */
test('导出：定格 PNG 真实输出尺寸，与相邻视频段尺寸一致且首尾相接', async () => {
  const project = makeProject({
    visuals: [
      {
        assetId: 'vFreeze',
        file: fixtures.landscape.file,
        kind: 'video',
        durationSec: 2,
        start: 0,
        end: 2,
        clip: { in: 0, out: 1 },
        fitDone: true,
      },
    ],
    durationSec: 2,
    voice: { file: fixtures.voice.file, duration: 2 },
  });
  const plan = planOf(project);
  assert.equal(plan.derived.length, 1, '计划里应当有 1 个定格派生');
  assert.ok(Array.isArray(plan.tracks.video) && plan.tracks.video.length === 2);

  const { result } = await runExport({
    project,
    plan,
    media: realMedia(),
    label: '定格',
    draftName: '媒体测试-定格',
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.freezeCount, 1);

  const doc = draftOf(result);
  const segments = videoTrackOf(doc);
  assert.equal(segments.length, 2);
  const videoMaterial = materialById(doc, segments[0].material_id);
  const freezeMaterial = materialById(doc, segments[1].material_id);
  assert.ok(videoMaterial && freezeMaterial, '视频段/定格段素材缺失');
  assert.equal(freezeMaterial.type, 'photo');
  assert.ok(fs.existsSync(freezeMaterial.path), `定格 PNG 不在草稿里：${freezeMaterial.path}`);

  const realSize = mediaInfo.imageSizeOf({ fs, file: freezeMaterial.path });
  assert.ok(realSize, '读不出真实定格 PNG 尺寸');
  assert.deepEqual(
    [freezeMaterial.width, freezeMaterial.height],
    [realSize.width, realSize.height],
    '定格素材尺寸 = PNG 实际输出尺寸',
  );
  assert.deepEqual([realSize.width, realSize.height], [320, 180], '定格 PNG 应是源画面尺寸');
  assert.deepEqual(
    [videoMaterial.width, videoMaterial.height],
    [realSize.width, realSize.height],
    '视频段与定格段尺寸一致',
  );

  const videoEnd = segments[0].target_timerange.start + segments[0].target_timerange.duration;
  assert.equal(segments[1].target_timerange.start, videoEnd, '定格段应紧接视频段');
});

/* ── 7. 文本伪装 .mp4 ── */
test('导出：文本伪装 .mp4 当必需视频 → 阻塞并定位素材与句子', async () => {
  const project = makeProject({
    visuals: [
      {
        assetId: 'vFake',
        file: fixtures.fakeMp4.file,
        kind: 'video',
        durationSec: 2,
        start: 0,
        end: 1,
        clip: { in: 0, out: 1 },
      },
    ],
    durationSec: 1,
  });
  const plan = planOf(project);
  const { result, destDir } = await runExport({
    project,
    plan,
    media: realMedia(),
    label: '伪装视频',
    draftName: '媒体测试-伪装视频',
  });
  assert.equal(result.ok, false, '伪装成 mp4 的文本文件不能让导出成功');
  const blocks = blockIssues(result);
  assert.ok(blocks.length, '必须有阻塞问题');
  const block = blocks.find(item => item.assetId === 'vFake' || /伪装视频/.test(item.message));
  assert.ok(block, `阻塞问题应定位到素材：${JSON.stringify(blocks)}`);
  assert.equal(block.assetId, 'vFake', '问题里要带素材 ID');
  assert.ok(block.code === 'media-probe-failed', `问题分类应是探测失败，实际 ${block.code}`);
  assert.match(block.message, /损坏|不可用|无法|不是可用的媒体/);
  assert.ok(
    block.lineNo === 1 || block.rowId === 'L1',
    `问题要定位到句子（rowId/lineNo），实际：${JSON.stringify({ rowId: block.rowId, lineNo: block.lineNo })}`,
  );
  assert.equal(fs.existsSync(path.join(destDir, '媒体测试-伪装视频')), false, '失败时不能留下草稿目录');
});

/* ── 8. 其它必需素材失败：损坏图片 / 纯音频 mp4 / 无音轨口播 ── */
test('导出：损坏图片 / 纯音频 mp4 当视频 / 无音轨视频当口播 → 分别阻塞', async () => {
  /* 8a 损坏图片 */
  const corruptProject = makeProject({
    visuals: [{ assetId: 'vBadImage', file: fixtures.corruptPng.file, kind: 'image', start: 0, end: 1 }],
    durationSec: 1,
  });
  const corruptResult = await runExport({
    project: corruptProject,
    plan: planOf(corruptProject),
    media: realMedia(),
    label: '损坏图片',
    draftName: '媒体测试-损坏图片',
  });
  assert.equal(corruptResult.result.ok, false, '损坏图片不能让导出成功');
  const badImageBlock = blockIssues(corruptResult.result).find(item => item.assetId === 'vBadImage');
  assert.ok(badImageBlock, `损坏图片要定位到素材：${JSON.stringify(blockIssues(corruptResult.result))}`);
  assert.match(badImageBlock.message, /损坏|不可用|图片/);

  /* 8b 纯音频 mp4 当视频（缺所需视频流） */
  const audioOnlyProject = makeProject({
    visuals: [
      {
        assetId: 'vAudioOnly',
        file: fixtures.audioOnlyMp4.file,
        kind: 'video',
        durationSec: 2,
        start: 0,
        end: 1,
        clip: { in: 0, out: 1 },
      },
    ],
    durationSec: 1,
  });
  const audioOnlyResult = await runExport({
    project: audioOnlyProject,
    plan: planOf(audioOnlyProject),
    media: realMedia(),
    label: '纯音频当视频',
    draftName: '媒体测试-纯音频当视频',
  });
  assert.equal(audioOnlyResult.result.ok, false, '纯音频 mp4 当视频必须阻塞');
  const noVideoBlock = blockIssues(audioOnlyResult.result).find(item => item.assetId === 'vAudioOnly');
  assert.ok(noVideoBlock, `缺视频流要定位到素材：${JSON.stringify(blockIssues(audioOnlyResult.result))}`);
  assert.equal(noVideoBlock.code, 'media-no-video-stream');
  assert.match(noVideoBlock.message, /没有视频画面|视频/);

  /* 8c 没有音轨的视频当口播源 */
  const noAudioProject = makeProject({
    visuals: [
      {
        assetId: 'vSilent',
        file: fixtures.silentVideo.file,
        kind: 'video',
        durationSec: 2,
        start: 0,
        end: 1,
        clip: { in: 0, out: 1 },
      },
    ],
    durationSec: 1,
    voice: { file: fixtures.silentVideo.file, duration: 2 },
  });
  const noAudioResult = await runExport({
    project: noAudioProject,
    plan: planOf(noAudioProject),
    media: realMedia(),
    label: '无音轨口播',
    draftName: '媒体测试-无音轨口播',
  });
  assert.equal(noAudioResult.result.ok, false, '没有音轨的视频当口播源必须阻塞');
  const noAudioBlock = blockIssues(noAudioResult.result).find(item => /没有音轨|音轨/.test(item.message));
  assert.ok(noAudioBlock, `无音轨问题要说清楚：${JSON.stringify(blockIssues(noAudioResult.result))}`);
});

/* ── 9. 探测超时：真实 FIFO ── */
test('导出：探测超时（真实 FIFO + 短超时）→ media-probe-timeout', async () => {
  const mod = requireExporter();
  const fifo = path.join(fixtures.dir, '卡住不返回.mp4');
  try {
    fs.rmSync(fifo, { force: true });
    execFileSync('mkfifo', [fifo], { timeout: 5000 });
  } catch (error) {
    assert.fail(`本机无法创建 FIFO：${error?.message || error}`);
  }
  const tools = mod.createMediaTools({ find: () => FFMPEG, probeTimeoutMs: 500 });
  const startedAt = Date.now();
  const info = await tools.probe({ path: fifo });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 8000, `探测超时没有生效（${elapsed}ms）`);
  assert.equal(info?.ok, false, `FIFO 探测应失败，实际 ${JSON.stringify(info)}`);
  assert.equal(info.code, 'media-probe-timeout', `应分类成探测超时，实际 ${info.code}`);
  assert.match(info.error || '', /超时/);
});

/* ── 10. 工具缺失 ── */
test('导出：工具缺失只阻塞真正依赖工具的操作，基础草稿仍可生成', async () => {
  const mod = requireExporter();
  const noTools = mod.createMediaTools({ find: () => null });
  assert.equal(noTools.available(), false, 'find 返回 null 时应当报告工具不可用');

  /* 10a 纯图片项目：不需要 ffmpeg 也能生成基础草稿，图片尺寸走文件头解析 */
  const imageProject = makeProject({
    visuals: [{ assetId: 'imgOnly', file: fixtures.png.file, kind: 'image', start: 0, end: 1 }],
    durationSec: 1,
  });
  const imageResult = await runExport({
    project: imageProject,
    plan: planOf(imageProject),
    media: noTools,
    label: '无工具图片',
    draftName: '媒体测试-无工具图片',
  });
  assert.equal(imageResult.result.ok, true, `纯图片基础草稿应能生成：${imageResult.result.error}`);
  assert.ok(hasIssueCode(imageResult.result, 'media-tool-missing'), '要提示没找到 ffmpeg');
  const imageDoc = draftOf(imageResult.result);
  const imageMaterial = materialById(imageDoc, videoTrackOf(imageDoc)[0].material_id);
  assert.deepEqual([imageMaterial.width, imageMaterial.height], [120, 200], '无 ffmpeg 时图片尺寸也要真实');

  /* 10b 视频项目：插视频本身不依赖 ffmpeg，基础草稿仍要能生成；
     但没探测到尺寸/时长时不能编造（不能回退画布），并且必须明确提醒「没能确认」 */
  const videoProject = measurements();
  const videoResult = await runExport({
    project: videoProject,
    plan: planOf(videoProject),
    media: noTools,
    label: '无工具视频',
    draftName: '媒体测试-无工具视频',
  });
  assert.equal(videoResult.result.ok, true, `基础草稿仍应生成：${videoResult.result.error}`);
  assert.ok(hasIssueCode(videoResult.result, 'media-tool-missing'), '要提示没找到 ffmpeg');
  assert.ok(hasIssueCode(videoResult.result, 'media-meta-missing'), '没能确认的尺寸要提醒，不能静默编造');
  const videoDoc = draftOf(videoResult.result);
  const videoSegments = videoTrackOf(videoDoc);
  for (let index = 0; index < 4; index++) {
    const material = materialById(videoDoc, videoSegments[index].material_id);
    assert.deepEqual(
      [material.width, material.height],
      [0, 0],
      `${material.material_name} 未知尺寸必须写 0，不能回退画布`,
    );
    assert.equal(material.has_audio, false, '没探测到音轨时不能假称有声音');
  }
  /* 图片仍能靠文件头解析出真实尺寸（不需要 ffmpeg） */
  const noToolImage = materialById(videoDoc, videoSegments[4].material_id);
  assert.deepEqual([noToolImage.width, noToolImage.height], [120, 200]);

  /* 10c 需要定格：必须拦下（定格依赖 ffmpeg） */
  const freezeProject = makeProject({
    visuals: [
      {
        assetId: 'vFreeze',
        file: fixtures.landscape.file,
        kind: 'video',
        durationSec: 2,
        start: 0,
        end: 2,
        clip: { in: 0, out: 1 },
        fitDone: true,
      },
    ],
    durationSec: 2,
  });
  const freezeResult = await runExport({
    project: freezeProject,
    plan: planOf(freezeProject),
    media: noTools,
    label: '无工具定格',
    draftName: '媒体测试-无工具定格',
  });
  assert.equal(freezeResult.result.ok, false, '没有 ffmpeg 不能生成定格画面');
});

test('导出：工具缺失时也不能把损坏图片当成功', async () => {
  const mod = requireExporter();
  const noTools = mod.createMediaTools({ find: () => null });
  const corruptProject = makeProject({
    visuals: [{ assetId: 'vBadImage', file: fixtures.corruptPng.file, kind: 'image', start: 0, end: 1 }],
    durationSec: 1,
  });
  const { result } = await runExport({
    project: corruptProject,
    plan: planOf(corruptProject),
    media: noTools,
    label: '无工具损坏图片',
    draftName: '媒体测试-无工具损坏图片',
  });
  assert.equal(result.ok, false, '没有 ffmpeg 也能按文件头判断图片已损坏，不能生成一个坏图片草稿当成功');
  assert.ok(
    (result.issues || []).some(
      item => item.level === 'block' && (item.assetId === 'vBadImage' || /图片|损坏|不是/.test(item.message)),
    ),
    `损坏图片要阻塞并说明原因：${JSON.stringify(result.issues)}`,
  );
});

/* ── 11. 封面回退不得掩盖必需视频失败 ── */
test('导出：封面生成失败可回退，但必需视频验证失败不得回退成 ok:true', async () => {
  const real = realMedia();
  const coverBroken = toolWithMedia(real, {
    cover: async () => {
      throw new Error('模拟封面生成失败');
    },
  });

  /* 11a 合法视频 + 封面失败：基础草稿仍成功，封面用内置兜底图并给出提醒 */
  const okProject = measurements();
  const okResult = await runExport({
    project: okProject,
    plan: planOf(okProject),
    media: coverBroken,
    label: '封面回退',
    draftName: '媒体测试-封面回退',
  });
  assert.equal(okResult.result.ok, true, `封面失败不应让整个导出失败：${okResult.result.error}`);
  assert.ok(hasIssueCode(okResult.result, 'cover-fallback'), '要提示封面用了默认图');
  const coverFile = path.join(okResult.result.draftDir, 'draft_cover.jpg');
  assert.ok(fs.existsSync(coverFile), '草稿里要有封面文件');
  assert.equal(fs.statSync(coverFile).size, requireExporter().FALLBACK_COVER.length, '封面应是内置兜底图');

  /* 11b 封面同样失败 + 必需视频损坏：必须阻塞，不能被封面回退掩盖 */
  const badProject = makeProject({
    visuals: [
      {
        assetId: 'vFake',
        file: fixtures.fakeMp4.file,
        kind: 'video',
        durationSec: 2,
        start: 0,
        end: 1,
        clip: { in: 0, out: 1 },
      },
    ],
    durationSec: 1,
  });
  const badResult = await runExport({
    project: badProject,
    plan: planOf(badProject),
    media: coverBroken,
    label: '封面回退不掩盖',
    draftName: '媒体测试-封面回退不掩盖',
  });
  assert.equal(badResult.result.ok, false, '必需视频探测失败必须阻塞，不能因封面回退变成功');
  assert.ok(
    blockIssues(badResult.result).some(item => /损坏|不可用|无法|不是可用的媒体/.test(item.message)),
    `阻塞原因要说清楚：${JSON.stringify(blockIssues(badResult.result))}`,
  );
});

/* ── 12. 定格时间基准：容器起点 2s 的素材 ── */
test('导出：容器起点 2s 的 5fps 素材，folder 导出的定格图是播放时间 0.4s 帧', async () => {
  const project = makeProject({
    visuals: [
      {
        assetId: 'vDelayed',
        file: fixtures.freezeDelayed.file,
        kind: 'video',
        start: 0,
        end: 3,
        clip: { in: 0, out: 0.51 },
        fitDone: true,
      },
    ],
    durationSec: 3,
    title: '延迟起点定格',
  });
  const plan = planOf(project);
  assert.equal(plan.derived.length, 1, '计划里应生成 1 个定格派生');
  assert.equal(plan.derived[0].sourceInUs, 0, '计划源入点应是播放时间 0');
  assert.equal(plan.derived[0].sourceOutUs, 510000, '计划源出点应是播放时间 0.51s（不是原始 PTS 2.51s）');

  const { result } = await runExport({
    project,
    plan,
    media: realMedia(),
    label: '延迟起点定格',
    draftName: '媒体测试-延迟起点定格',
  });
  assert.equal(result.ok, true, `延迟起点素材应能真实导出：${result.error}`);
  assert.equal(result.freezeCount, 1);
  assert.equal(hasIssueCode(result, 'freeze-failed'), false, `不应出现定格失败：${JSON.stringify(result.issues)}`);

  const doc = draftOf(result);
  const segments = videoTrackOf(doc);
  assert.equal(segments.length, 2, '视频段 + 定格段');
  const freezeMaterial = segments
    .map(segment => materialById(doc, segment.material_id))
    .find(item => item?.type === 'photo');
  assert.ok(freezeMaterial?.path, `草稿里应有定格 PNG：${JSON.stringify(segments)}`);
  assert.ok(fs.existsSync(freezeMaterial.path), `定格 PNG 不在草稿里：${freezeMaterial.path}`);
  assert.deepEqual([freezeMaterial.width, freezeMaterial.height], [120, 200], '定格 PNG 应是 120×200');
  assertPngFrame(freezeMaterial.path, 2, '容器起点 2s / 播放时间 0.4s');
  assertPngNotFrame(freezeMaterial.path, 3, '容器起点 2s / 播放时间 0.4s');
});

/* ── 13. VFR 长静止区间：完整导出 ── */
test('导出：VFR 首帧后静止 5s，clip in=2/out=3 的真实 folder 导出取到首帧', async () => {
  const project = makeProject({
    visuals: [
      {
        assetId: 'vVfrGap',
        file: fixtures.freezeVfrGap.file,
        kind: 'video',
        durationSec: 15,
        start: 0,
        end: 3,
        clip: { in: 2, out: 3 },
        fitDone: true,
      },
    ],
    durationSec: 3,
    title: 'VFR 长静止定格',
  });
  const plan = planOf(project);
  assert.equal(plan.derived.length, 1);
  assert.equal(plan.derived[0].sourceInUs, 2000000);
  assert.equal(plan.derived[0].sourceOutUs, 3000000);

  const { result } = await runExport({
    project,
    plan,
    media: realMedia(),
    label: 'VFR长静止定格',
    draftName: '媒体测试-VFR长静止定格',
  });
  assert.equal(result.ok, true, `VFR 长静止素材应能真实导出：${result.error}`);
  assert.equal(result.freezeCount, 1);
  assert.equal(
    hasIssueCode(result, 'freeze-failed'),
    false,
    `不应出现 freeze-no-frame：${JSON.stringify(result.issues)}`,
  );

  const doc = draftOf(result);
  const segments = videoTrackOf(doc);
  const freezeMaterial = segments
    .map(segment => materialById(doc, segment.material_id))
    .find(item => item?.type === 'photo');
  assert.ok(freezeMaterial?.path, `草稿里应有定格 PNG：${JSON.stringify(segments)}`);
  assert.ok(fs.existsSync(freezeMaterial.path), `定格 PNG 不在草稿里：${freezeMaterial.path}`);
  assert.deepEqual([freezeMaterial.width, freezeMaterial.height], [120, 200]);
  /* 素材首帧颜色偏移 1：第 0 帧内容 = frameColor(1)，第 1 帧内容 = frameColor(2) */
  assertPngFrame(freezeMaterial.path, 0, 'VFR 长静止 in=2/out=3', 1);
  assertPngNotFrame(freezeMaterial.path, 1, 'VFR 长静止 in=2/out=3', 1);
});

/* ── 14. 源文件结束后的真正越界：完整导出必须失败且不留草稿 ── */
test('导出：越界到源文件结束之后仍报错，不留下草稿', async () => {
  const project = makeProject({
    visuals: [
      {
        assetId: 'vBeyond',
        file: fixtures.freezeVfrGap.file,
        kind: 'video',
        start: 0,
        end: 3,
        clip: { in: 16, out: 17 },
        fitDone: true,
      },
    ],
    durationSec: 3,
    title: '越界定格',
  });
  const plan = planOf(project);
  assert.equal(plan.derived.length, 1, '计划仍会生成定格派生，越界由媒体层的真实时长判定');
  assert.equal(plan.derived[0].sourceInUs, 16000000);
  assert.equal(plan.derived[0].sourceOutUs, 17000000);

  const { result, destDir } = await runExport({
    project,
    plan,
    media: realMedia(),
    label: '越界定格',
    draftName: '媒体测试-越界定格',
  });
  assert.equal(result.ok, false, '源文件只有 15s，从 16s 开始的素材必须失败');
  assert.ok(['probe', 'freeze'].includes(result.phase), `越界应在探测/定格阶段被拦下，实际停在 ${result.phase}`);
  assert.ok(
    (result.issues || []).some(
      item => item.level === 'block' && ['source-out-of-range', 'freeze-failed'].includes(item.code),
    ),
    `越界要有明确阻塞原因：${JSON.stringify(result.issues)}`,
  );
  assert.equal(result.draftDir, undefined, '失败时不能留下草稿目录');
  assert.deepEqual(fs.readdirSync(destDir), [], '失败后目标目录里不应残留暂存草稿');
});

/* ── 入口 ── */
async function main() {
  if (!FFMPEG || !FFPROBE) {
    console.log(
      `SKIP 剪映媒体测试：本机没有可用的 ffmpeg/ffprobe（ffmpeg=${FFMPEG || '无'}，ffprobe=${FFPROBE || '无'}），未做真实媒体验证`,
    );
    return;
  }
  try {
    try {
      prepareFixtures();
    } catch (error) {
      console.error(`✗ 合成测试媒体失败（测试环境问题，不是产品结论）：${error?.message || error}`);
      process.exitCode = 1;
      return;
    }
    for (const item of tests) {
      try {
        await item.fn();
        passed++;
        console.log(`✓ ${item.name}`);
      } catch (error) {
        failed++;
        failures.push({ name: item.name, error });
        const message = String(error?.message || error)
          .split('\n')
          .slice(0, 12)
          .join('\n    ');
        console.error(`✗ ${item.name}\n    ${message}`);
      }
    }
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  console.log(`\n剪映媒体测试：${passed} 通过，${failed} 失败`);
  if (failed) {
    console.log('失败用例：');
    for (const item of failures) console.log(`- ${item.name}`);
    process.exitCode = 1;
  }
}

await main();
