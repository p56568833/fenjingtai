/* 定格帧选取专项测试：真实 ffmpeg 合成视频 + 真实抽帧 + 画面内容比对。
   覆盖契约 1.3 的 8 类用例：
     1. 5fps / 120×200 / 出点 0.51s：计划源区间正确，抽到 0.4s 帧（不是旧实现会拿到的 0.6s 帧）
     2. 120fps + 非整帧出点 0.375s：按真实帧 PTS 取帧，不用项目帧率
     3. VFR：帧间隔不均时按真实 PTS / 可见区间选帧
     4. 短片段：2 帧、in > 0、出点在帧中间、区间不足一帧
     5. 容器起点偏移 ≠ 无画面：延迟 2s 的视频仍按播放时间选帧；真正的无画面区间才报错
     6. 输出 PNG 尺寸 = 源帧尺寸
     7. 错误分类与工具缺失
     8. VFR 长静止区间：下一帧在 5 秒后，固定小窗口找不到也要向后扩大并取到首帧
   另外覆盖错误分类与 pickFreezeFrame 纯函数边界。画面比较用「PNG 缩成 1×1 rgb24 取 RGB」，
   合成视频每帧颜色按公式生成，所以能直接判断抽到的是第几帧。
   本机 /opt/homebrew/bin 有 ffmpeg 8.1.2 / ffprobe；找不到工具时打印 SKIP，不假装通过。
   运行：node scripts/jianying-freeze-test.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildEditExportPlan } from '../renderer/src/core/edit-export-plan.js';

const require = createRequire(import.meta.url);
const frame = require('../electron/jianying/frame.js');

/* ── 工具定位 ── */
const findTool = name => {
  const explicit = name === 'ffmpeg' ? process.env.FJT_FFMPEG : '';
  const candidates = [explicit || '', `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`];
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const candidate = dir ? path.join(dir, name) : '';
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
};
const ffmpeg = findTool('ffmpeg');
const ffprobe = findTool('ffprobe');
const hasTools = !!(ffmpeg && ffprobe);

/* ── 用例框架 / 临时目录 ── */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const roots = [];
const tmpRoot = label => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `分镜台定格-${label}-`));
  roots.push(dir);
  return dir;
};

const run = (bin, args, label) => {
  try {
    return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    throw new Error(`${label} 失败${stderr ? `：${stderr}` : `：${error?.message || error}`}`, { cause: error });
  }
};

/* ── 合成视频：每帧颜色由帧序号决定 ──
   R = N*13%256, G = N*53%256, B = N*97%256。120×200 以内 256 帧不重复。 */
const COLOR_FILTER = "geq=r='mod(N*13,256)':g='mod(N*53,256)':b='mod(N*97,256)'";
/* colorOffset 让第一帧也有可辨认的颜色（否则第 0 帧纯黑，和失败时的黑帧不好区分） */
const colorFilter = (offset = 0) =>
  offset === 0
    ? COLOR_FILTER
    : `geq=r='mod((N+${offset})*13,256)':g='mod((N+${offset})*53,256)':b='mod((N+${offset})*97,256)'`;

/* firstFrameHoldSec：第一帧 PTS=0，其余帧整体后移 N 秒，复现 VFR 长静止区间。
   audioDurationSec：音轨从 0 开始，视频整体后移时可制造「容器起点 0、视频流起点 2s」的素材。 */
function synthVideo({
  dir,
  name = 'src.mp4',
  fps,
  durationSec,
  width,
  height,
  vfrTimes = null,
  startOffsetSec = null,
  firstFrameHoldSec = null,
  audioDurationSec = null,
  colorOffset = 0,
}) {
  const file = path.join(dir, name);
  let filter = colorFilter(colorOffset);
  if (vfrTimes) {
    const expr = vfrTimes.reduceRight(
      (rest, value, index) => `if(eq(N,${index}),${Number(value).toFixed(6)},${rest})`,
      '0',
    );
    filter = `${filter},setpts='(${expr})/TB'`;
  } else if (firstFrameHoldSec != null) {
    filter = `${filter},setpts='if(eq(N,0),0,PTS+${Number(firstFrameHoldSec).toFixed(6)}/TB)'`;
  } else if (startOffsetSec != null) {
    filter = `${filter},setpts=PTS+${Number(startOffsetSec).toFixed(6)}/TB`;
  }
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${width}x${height}:r=${fps}:d=${durationSec}`,
  ];
  if (audioDurationSec != null) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${audioDurationSec}`);
  args.push('-vf', filter, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-video_track_timescale', '1000000');
  if (audioDurationSec != null) args.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac');
  if (vfrTimes || firstFrameHoldSec != null) args.push('-fps_mode', 'vfr');
  args.push(file);
  run(ffmpeg, args, `合成 ${name}`);
  return file;
}

const readFrameTimes = file => {
  const output = run(
    ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file],
    '读取帧时间',
  );
  const data = JSON.parse(output.toString());
  return (Array.isArray(data.frames) ? data.frames : [])
    .map(item => Math.round(Number(item.best_effort_timestamp_time) * 1e6))
    .filter(value => Number.isFinite(value));
};

const lastIndexBefore = (times, boundUs) => {
  let hit = -1;
  for (let index = 0; index < times.length; index++) if (times[index] < boundUs) hit = index;
  return hit;
};

/* ── 画面颜色：PNG → 1×1 rgb24 ── */
const pngRgb = file => {
  const output = run(
    ffmpeg,
    ['-v', 'error', '-i', file, '-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    '读取 PNG 颜色',
  );
  assert.ok(output.length >= 3, `读取 PNG 颜色：输出不足 3 字节（${file}）`);
  return [output[0], output[1], output[2]];
};
const pngSize = file => {
  const buffer = fs.readFileSync(file);
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', '输出必须是 PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

const colorOfFrame = index => [(index * 13) % 256, (index * 53) % 256, (index * 97) % 256];
const rgbText = color => `rgb(${color.join(',')})`;
const colorGap = (left, right) => Math.max(...left.map((value, index) => Math.abs(value - right[index])));
const assertFrameColor = (color, index, label, offset = 0) => {
  const wanted = colorOfFrame(index + offset);
  const gap = colorGap(color, wanted);
  assert.ok(
    gap <= 8,
    `${label}：抽出的画面 ${rgbText(color)} 应是第 ${index} 帧 ${rgbText(wanted)}（最大通道差 ${gap}）`,
  );
};
const assertNotFrameColor = (color, index, label, offset = 0) => {
  const wanted = colorOfFrame(index + offset);
  const gap = colorGap(color, wanted);
  assert.ok(
    gap > 40,
    `${label}：抽出的画面 ${rgbText(color)} 不应是第 ${index} 帧 ${rgbText(wanted)}（最大通道差 ${gap}）`,
  );
};

/* ── 用剪辑计划生成定格派生条目：0–3 秒镜头、片段比镜头短、fitDone 补定格 ── */
function planForFreeze({ file, inUs, outUs, shotEndSec = 3 }) {
  const row = {
    id: 'L1',
    kind: 'line',
    no: 1,
    text: '一句用来占时间的话',
    time: { start: 0, end: shotEndSec, st: 'ok' },
    assetUsages: [
      {
        assetId: 'V',
        role: 'main',
        clip: { in: inUs / 1e6, out: outUs / 1e6 },
        fitDone: true,
      },
    ],
  };
  const project = {
    projectId: 'freeze-test',
    title: '定格测试',
    rows: [row],
    assets: { V: { id: 'V', path: file, name: 'src.mp4', kind: 'video', durationSec: 10 } },
    types: [],
    speechRate: 4.5,
    voice: null,
    updatedAt: 1,
  };
  return buildEditExportPlan(project, { width: 1920, height: 1080, fps: 30 }, { probes: {} });
}

/* 计划里 derived 的源区间必须与请求一致，宽高必须是 0（真实尺寸由媒体层决定） */
function assertDerivedRange(plan, inUs, outUs) {
  assert.equal(plan.derived.length, 1, '必须生成一个定格派生条目');
  const derived = plan.derived[0];
  assert.equal(derived.type, 'freeze');
  assert.equal(derived.sourceInUs, inUs, 'sourceInUs = 源入点微秒');
  assert.equal(derived.sourceOutUs, outUs, 'sourceOutUs = 源出点微秒（排他）');
  assert.equal(derived.width, 0, '定格宽不再写画布尺寸');
  assert.equal(derived.height, 0, '定格高不再写画布尺寸');
  assert.ok(derived.atUs > 0, 'atUs 仍保留给旧计划兼容提示');
  return derived;
}

/* 真实抽帧：用计划里的 sourceInUs/sourceOutUs 定位，返回抽出的 PNG 与颜色 */
async function extractFromPlan({ dir, file, inUs, outUs, name = 'freeze.png' }) {
  const plan = planForFreeze({ file, inUs, outUs });
  const derived = assertDerivedRange(plan, inUs, outUs);
  const outPath = path.join(dir, name);
  const result = await frame.extractFreezeFrame({
    ffmpeg,
    ffprobe,
    file,
    inUs: derived.sourceInUs,
    outUs: derived.sourceOutUs,
    atUs: derived.atUs,
    outPath,
  });
  return { plan, derived, result, outPath, color: pngRgb(outPath) };
}

/* ── 纯函数：选帧规则（不需要真实 ffmpeg） ── */
test('pickFreezeFrame：只取 PTS < 出点、可见区间与 [入点,出点) 相交的最后一帧', () => {
  const times = [0, 200000, 400000, 600000, 800000];
  assert.deepEqual(
    frame.pickFreezeFrame(times, { inUs: 0, outUs: 510000, nominalFrameUs: 200000 }),
    { frameUs: 400000, prevUs: 200000, nextUs: 600000 },
    '5fps 出点 0.51s：最后可见帧是 0.4s',
  );
  assert.equal(
    frame.pickFreezeFrame(times, { inUs: 0, outUs: 600000, nominalFrameUs: 200000 }).frameUs,
    400000,
    '出点排他',
  );
  assert.equal(
    frame.pickFreezeFrame(times, { inUs: 350000, outUs: 450000, nominalFrameUs: 200000 }).frameUs,
    400000,
    '入点落在帧可见区间内也算可见',
  );
  assert.equal(
    frame.pickFreezeFrame(times, { inUs: 610000, outUs: 620000, nominalFrameUs: 200000 }).frameUs,
    600000,
    '区间在帧之后、下一帧之前：前一帧仍可见',
  );
  assert.equal(
    frame.pickFreezeFrame([0, 200000, 400000, 600000, 800000, 1000000], {
      inUs: 1300000,
      outUs: 1400000,
      nominalFrameUs: 200000,
    }),
    null,
    '最后一帧的可见区间已结束（PTS + nominal <= 入点）时不算候选',
  );
  assert.equal(frame.pickFreezeFrame([2000000], { inUs: 500000, outUs: 600000, nominalFrameUs: 100000 }), null);
  assert.equal(frame.pickFreezeFrame(times, { inUs: 500000, outUs: 500000, nominalFrameUs: 200000 }), null, '空区间');
  assert.equal(frame.pickFreezeFrame([], { inUs: 0, outUs: 1000000, nominalFrameUs: 33333 }), null);
  assert.equal(
    frame.pickFreezeFrame([800000, 0, 400000, 200000], { inUs: 0, outUs: 510000, nominalFrameUs: 200000 }).frameUs,
    400000,
    '乱序输入按升序处理',
  );

  /* VFR 长静止：下一帧在 5s 后，不能用平均帧时长判「没有画面」。
     coverageEndUs 表示扫描已经完整覆盖到这里，列表里没有下一帧说明下一帧更晚。 */
  assert.equal(
    frame.pickFreezeFrame([0], { inUs: 2000000, outUs: 3000000, nominalFrameUs: 50000 }),
    null,
    '只给 nominal 时，长静止区间会被误判为没有可用帧（旧行为）',
  );
  assert.equal(
    frame.pickFreezeFrame([0], {
      inUs: 2000000,
      outUs: 3000000,
      nominalFrameUs: 50000,
      coverageEndUs: 3800000,
    }).frameUs,
    0,
    'coverageEndUs 证明下一帧在扫描窗口之后，首帧仍然可见',
  );
});

/* ── 真实媒体用例 ── */
if (!hasTools) {
  console.log('SKIP 真实媒体用例：未找到 ffmpeg / ffprobe（只运行了纯函数用例）');
} else {
  test('1. 5fps / 120×200 / 出点 0.51s：计划给源区间，真实抽到 0.4s 帧而不是 0.6s', async () => {
    const dir = tmpRoot('5fps');
    const file = synthVideo({ dir, fps: 5, durationSec: 1.2, width: 120, height: 200 });
    const times = readFrameTimes(file);
    assert.deepEqual(times, [0, 200000, 400000, 600000, 800000, 1000000], '5fps 合成帧时间应为 0–1s 每 0.2s');

    const inUs = 0;
    const outUs = 510000;
    const { plan, derived, result, outPath, color } = await extractFromPlan({ dir, file, inUs, outUs });
    assert.equal(plan.fps.num / plan.fps.den, 30, '项目帧率 30fps 不应参与源帧定位');
    assert.equal(derived.atUs, 476667, 'atUs 仍是旧算法「源出点 - 1/项目帧率」');
    assert.equal(result.frameUs, 400000, '新逻辑取最后一个 PTS < 出点的源帧');
    assert.ok(Math.abs(result.seekSec - 0.3) < 1e-6, 'seek 到 0.4s 帧与 0.2s 帧的中点');
    assertFrameColor(color, 2, '5fps 出点 0.51s');
    assertNotFrameColor(color, 3, '5fps 出点 0.51s');
    assert.equal(fs.realpathSync(result.outPath), fs.realpathSync(outPath));

    /* 旧实现对照：旧计划 atUs=0.476667 + 旧 extractFrame 的输出 seek，会抽到 0.6s 帧。
       这里直接复现旧 seek，证明本用例在旧实现上必然失败（得到的颜色是第 3 帧）。 */
    const legacyPath = path.join(dir, 'legacy.png');
    run(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        file,
        '-ss',
        (derived.atUs / 1e6).toFixed(6),
        '-frames:v',
        '1',
        '-an',
        '-update',
        '1',
        legacyPath,
      ],
      '旧实现 seek 对照',
    );
    const legacyColor = pngRgb(legacyPath);
    assertFrameColor(legacyColor, 3, '旧实现对照（atUs 输出 seek）');
    assertNotFrameColor(legacyColor, 2, '旧实现对照（atUs 输出 seek）');
    assert.notDeepEqual(legacyColor, color, '旧实现与新实现抽到的不是同一帧');

    /* 旧计划只给 atUs 时也按「atUs 当排他上界」处理，仍取 0.4s 帧 */
    const fallbackPath = path.join(dir, 'at-fallback.png');
    const fallback = await frame.extractFreezeFrame({
      ffmpeg,
      ffprobe,
      file,
      atUs: derived.atUs,
      outPath: fallbackPath,
    });
    assert.equal(fallback.frameUs, 400000, '只有 atUs 的旧计划也取 0.4s 帧');
    assertFrameColor(pngRgb(fallbackPath), 2, '旧计划 atUs 兼容');
  });

  test('2. 120fps + 非整帧出点 0.375s：按真实帧 PTS 取帧，不用项目帧率', async () => {
    const dir = tmpRoot('120fps');
    const file = synthVideo({ dir, fps: 120, durationSec: 0.55, width: 64, height: 64 });
    const times = readFrameTimes(file);
    assert.ok(times.length >= 60, `120fps 视频应有足够帧数，实际 ${times.length}`);
    const expectedIndex = lastIndexBefore(times, 375000);
    assert.equal(times[expectedIndex], 366667, '出点 0.375s 前最后一帧 PTS = 366667µs');
    assert.equal(times[expectedIndex + 1], 375000, '下一帧 PTS 正好等于出点，必须排除');

    const inUs = 0;
    const outUs = 375000;
    const { derived, result, color } = await extractFromPlan({ dir, file, inUs, outUs });
    assert.equal(derived.atUs, 341667, '旧 atUs = 出点 - 1/30 落在 0.341667s');
    assert.equal(result.frameUs, 366667, '取真实 PTS 366667µs，而不是项目帧率推出的位置');
    assertFrameColor(color, expectedIndex, '120fps 出点 0.375s');
    assertNotFrameColor(color, expectedIndex - 1, '120fps 出点 0.375s');
    assertNotFrameColor(color, expectedIndex + 1, '120fps 出点 0.375s');

    const legacyPath = path.join(dir, 'legacy.png');
    run(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        file,
        '-ss',
        (derived.atUs / 1e6).toFixed(6),
        '-frames:v',
        '1',
        '-an',
        '-update',
        '1',
        legacyPath,
      ],
      '旧实现 seek 对照（120fps）',
    );
    assertNotFrameColor(pngRgb(legacyPath), expectedIndex, '旧实现对照（120fps atUs 输出 seek）');
  });

  test('3. VFR：帧间隔不均时按真实 PTS 与可见区间选帧', async () => {
    const dir = tmpRoot('vfr');
    const file = synthVideo({
      dir,
      fps: 30,
      durationSec: 0.2,
      width: 64,
      height: 64,
      vfrTimes: [0, 0.05, 0.2, 0.32, 0.52, 0.6],
    });
    const times = readFrameTimes(file);
    assert.equal(times.length, 6, `VFR 合成应有 6 帧，实际 ${times.length}`);
    const gaps = times.slice(1).map((value, index) => value - times[index]);
    assert.ok(Math.max(...gaps) - Math.min(...gaps) > 20000, `帧间隔必须不均，实际 ${gaps.join('/')}`);

    /* 出点 0.51s：最后一个 PTS < 出点的是 0.5s 帧（下一帧 0.6s 在出点之后） */
    const first = await extractFromPlan({ dir, file, inUs: 0, outUs: 510000, name: 'vfr-a.png' });
    const indexA = lastIndexBefore(times, 510000);
    assert.equal(times[indexA], 500000);
    assert.equal(first.result.frameUs, 500000, 'VFR 出点 0.51s 应取 0.5s 帧');
    assertFrameColor(first.color, indexA, 'VFR 出点 0.51s');
    assertNotFrameColor(first.color, indexA + 1, 'VFR 出点 0.51s');

    /* 入点 0.31s、出点 0.4s：区间落在 0.3s 帧的可见区间里（PTS < 入点但仍可见） */
    const second = await extractFromPlan({ dir, file, inUs: 310000, outUs: 400000, name: 'vfr-b.png' });
    assert.equal(second.result.frameUs, 300000, 'VFR 入点落在帧可见区间内时仍取该帧');
    assertFrameColor(second.color, 3, 'VFR 入点 0.31s');
  });

  test('4. 短片段：2 帧、in > 0、出点在帧中间、区间不足一帧', async () => {
    const dir = tmpRoot('短片段');
    const file = synthVideo({ dir, fps: 5, durationSec: 0.3, width: 60, height: 100 });
    const times = readFrameTimes(file);
    assert.equal(times.length, 2, `0.3s / 5fps 应只有 2 帧，实际 ${times.length}: ${times.join('/')}`);
    assert.deepEqual(times, [0, 200000]);

    /* in > 0、出点 0.25s 落在两帧之间：取 0.2s 帧 */
    const first = await extractFromPlan({ dir, file, inUs: 150000, outUs: 250000, name: 'short-a.png' });
    assert.equal(first.plan.derived[0].sourceInUs, 150000);
    assert.equal(first.result.frameUs, 200000, '短片段取最后一个 PTS < 出点的帧');
    assertFrameColor(first.color, 1, '短片段 in=0.15s out=0.25s');
    assertNotFrameColor(first.color, 0, '短片段 in=0.15s out=0.25s');

    /* 区间 0.08s 不足一帧（nominal 0.2s），且整段落在 0.2s 帧的可见区间里：仍取该帧 */
    assert.ok(290000 - 210000 < 200000, '用例区间必须小于一帧');
    const second = await extractFromPlan({ dir, file, inUs: 210000, outUs: 290000, name: 'short-b.png' });
    assert.equal(second.result.frameUs, 200000, '不足一帧的区间取所在帧');
    assertFrameColor(second.color, 1, '短片段不足一帧');
  });

  test('5. 容器起点偏移不是无画面：延迟 2s 的素材仍按播放时间取帧，真正空档才报错', async () => {
    const dir = tmpRoot('容器偏移');

    /* (a) 120×200 / 5fps / 1s，setpts 整体 +2s：容器起点=2s，播放时间仍是 0–0.8s。
       计划 in=0 / out=0.51 / fitDone → 应取播放时间 0.4s（原始 PTS 2.4s）那帧，不能报「无候选」。 */
    const delayed = synthVideo({
      dir,
      name: 'delayed.mp4',
      fps: 5,
      durationSec: 1,
      width: 120,
      height: 200,
      startOffsetSec: 2,
    });
    const delayedTimes = readFrameTimes(delayed);
    assert.deepEqual(delayedTimes, [2000000, 2200000, 2400000, 2600000, 2800000], '原始 PTS 应从 2s 开始');
    const delayedProbe = JSON.parse(
      run(
        ffprobe,
        ['-v', 'error', '-show_entries', 'format=start_time,duration', '-of', 'json', delayed],
        '读取容器起点',
      ).toString(),
    );
    assert.equal(Number(delayedProbe.format.start_time), 2, 'ffprobe 容器起点应为 2s');
    assert.equal(Number(delayedProbe.format.duration), 1, 'ffprobe 容器时长为 1s');

    const offset = await extractFromPlan({ dir, file: delayed, inUs: 0, outUs: 510000, name: 'delayed-a.png' });
    assert.equal(offset.result.frameUs, 400000, '延迟起点素材的播放时间 0.4s 帧');
    assert.ok(Math.abs(offset.result.seekSec - 0.3) < 1e-6, 'seek 也用播放时间（0.2s 与 0.4s 中点）');
    assertFrameColor(offset.color, 2, '延迟起点 in=0/out=0.51');
    assertNotFrameColor(offset.color, 3, '延迟起点 in=0/out=0.51');

    /* (b) 真正的无画面区间：音轨从 0 开始、视频从 2s 开始，容器起点=0；
       播放时间 0.5–0.6s 确实没有视频帧，必须报错而不是把视频首帧当成 0s。 */
    const mixed = synthVideo({
      dir,
      name: 'audio-first.mp4',
      fps: 5,
      durationSec: 0.6,
      width: 64,
      height: 64,
      startOffsetSec: 2,
      audioDurationSec: 3,
    });
    const mixedProbe = JSON.parse(
      run(
        ffprobe,
        ['-v', 'error', '-show_entries', 'format=start_time:stream=codec_type,start_time', '-of', 'json', mixed],
        '读取音视频起点',
      ).toString(),
    );
    assert.equal(Number(mixedProbe.format.start_time), 0, '音轨从 0 开始，容器起点必须是 0');
    const videoStream = mixedProbe.streams.find(item => item.codec_type === 'video');
    assert.equal(Number(videoStream.start_time), 2, '视频流从 2s 开始（晚于容器起点）');
    const outPathA = path.join(dir, 'no-frame-a.png');
    await assert.rejects(
      frame.extractFreezeFrame({ ffmpeg, ffprobe, file: mixed, inUs: 500000, outUs: 600000, outPath: outPathA }),
      error => {
        assert.equal(error?.code, 'freeze-no-frame', '真正的无画面区间应报 freeze-no-frame');
        assert.ok(!fs.existsSync(outPathA), '失败时不能产出图片文件');
        return true;
      },
    );
    /* 同一个文件，播放时间 2.4s 落在视频帧上：仍应取第 2 帧（不能整体平移成 0s） */
    const mixedFrame = await extractFromPlan({ dir, file: mixed, inUs: 2400000, outUs: 2600000, name: 'mixed-b.png' });
    assert.equal(mixedFrame.result.frameUs, 2400000, '音视频起点不同时，视频帧的播放时间 = 原始 PTS - 容器起点');
    assertFrameColor(mixedFrame.color, 2, '音视频起点不同 in=2.4/out=2.6');

    /* (c) 片段整体落在源视频最后一帧的可见区间之后：PTS < 出点但帧已经不可见 */
    const normal = synthVideo({ dir, name: 'normal.mp4', fps: 5, durationSec: 1.2, width: 64, height: 64 });
    const normalTimes = readFrameTimes(normal);
    assert.ok(normalTimes[normalTimes.length - 1] < 1400000, '源视频最后一帧在出点 1.4s 之前');
    const outPathB = path.join(dir, 'no-frame-b.png');
    await assert.rejects(
      frame.extractFreezeFrame({ ffmpeg, ffprobe, file: normal, inUs: 1300000, outUs: 1400000, outPath: outPathB }),
      error => {
        assert.equal(error?.code, 'freeze-no-frame', '源已播完也应报 freeze-no-frame');
        assert.ok(!fs.existsSync(outPathB), '失败时不能产出图片文件');
        return true;
      },
    );
  });

  test('6. 输出 PNG 尺寸等于源帧尺寸', async () => {
    const dir = tmpRoot('尺寸');
    const file = synthVideo({ dir, fps: 5, durationSec: 1.2, width: 120, height: 200 });
    const probe = JSON.parse(
      run(
        ffprobe,
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file],
        '读取源尺寸',
      ).toString(),
    );
    assert.deepEqual([probe.streams[0].width, probe.streams[0].height], [120, 200], '合成源画面应为 120×200');
    const { outPath } = await extractFromPlan({ dir, file, inUs: 0, outUs: 510000 });
    assert.deepEqual(pngSize(outPath), { width: 120, height: 200 }, '定格 PNG 必须与源帧同尺寸');
  });

  test('7. 错误分类：media-tool-missing / media-no-video-stream / freeze-range-missing / frame-extract-failed', async () => {
    const dir = tmpRoot('错误');
    const file = synthVideo({ dir, fps: 5, durationSec: 1.2, width: 64, height: 64 });
    const outPath = path.join(dir, 'out.png');

    /* 没有 ffmpeg / ffprobe */
    await assert.rejects(
      frame.extractFreezeFrame({
        file,
        inUs: 0,
        outUs: 510000,
        outPath,
        ffmpeg: path.join(dir, '不存在的-ffmpeg'),
        ffprobe: path.join(dir, '不存在的-ffprobe'),
      }),
      error => {
        assert.equal(error?.code, 'media-tool-missing');
        return true;
      },
    );

    /* 音频文件当视频源：没有视频流 */
    const audioOnly = path.join(dir, 'audio-only.m4a');
    run(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=0.2',
        '-c:a',
        'aac',
        audioOnly,
      ],
      '合成纯音频文件',
    );
    await assert.rejects(
      frame.extractFreezeFrame({ ffmpeg, ffprobe, file: audioOnly, inUs: 0, outUs: 100000, outPath }),
      error => {
        assert.equal(error?.code, 'media-no-video-stream');
        return true;
      },
    );

    /* 既没有 in/out 也没有 atUs */
    await assert.rejects(frame.extractFreezeFrame({ ffmpeg, ffprobe, file, outPath }), error => {
      assert.equal(error?.code, 'freeze-range-missing');
      return true;
    });
    await assert.rejects(
      frame.extractFreezeFrame({ ffmpeg, ffprobe, file, inUs: 500000, outUs: 500000, outPath }),
      error => {
        assert.equal(error?.code, 'freeze-range-missing');
        return true;
      },
    );

    /* 定位成功但 ffmpeg 抽帧失败：报 frame-extract-failed 并保留 stderr 尾行（注入替身，不依赖真实失败） */
    const fakeRunCapture = async (bin, args) => {
      const text = args.join(' ');
      if (text.includes('avg_frame_rate'))
        return {
          code: 0,
          stdout: JSON.stringify({ streams: [{ avg_frame_rate: '5/1', r_frame_rate: '5/1', width: 64, height: 64 }] }),
          stderr: '',
        };
      if (text.includes('best_effort_timestamp_time'))
        return {
          code: 0,
          stdout: JSON.stringify({
            frames: [
              { best_effort_timestamp_time: '0.000000' },
              { best_effort_timestamp_time: '0.200000' },
              { best_effort_timestamp_time: '0.400000' },
            ],
          }),
          stderr: '',
        };
      return { code: 1, stdout: '', stderr: 'fake extraction failed' };
    };
    await assert.rejects(
      frame.extractFreezeFrame({
        file,
        inUs: 0,
        outUs: 510000,
        outPath,
        ffmpeg: 'ffmpeg',
        ffprobe: 'ffprobe',
        runCapture: fakeRunCapture,
      }),
      error => {
        assert.equal(error?.code, 'frame-extract-failed');
        assert.match(String(error?.message), /fake extraction failed/, '错误信息保留 ffmpeg stderr 尾行');
        return true;
      },
    );
  });

  test('8. VFR 长静止区间：下一帧约 5.03s 后才出现，仍能取到一直可见的首帧', async () => {
    const dir = tmpRoot('VFR长静止');
    const file = synthVideo({
      dir,
      name: 'vfr-gap.mp4',
      fps: 30,
      durationSec: 10,
      width: 120,
      height: 200,
      firstFrameHoldSec: 5,
      colorOffset: 1,
    });
    const times = readFrameTimes(file);
    assert.equal(times.length, 300, `10s / 30fps 应有 300 帧，实际 ${times.length}`);
    assert.equal(times[0], 0, '首帧 PTS 必须是 0');
    assert.ok(Math.abs(times[1] - 5033333) <= 1000, `第二帧应约在 5.033s，实际 ${times[1]}`);
    const probe = JSON.parse(
      run(
        ffprobe,
        ['-v', 'error', '-show_entries', 'format=start_time,duration', '-of', 'json', file],
        '读取 VFR 时长',
      ).toString(),
    );
    assert.equal(Number(probe.format.start_time), 0);
    assert.ok(Math.abs(Number(probe.format.duration) - 15) < 0.001, `文件总长应约 15s，实际 ${probe.format.duration}`);

    /* in=2 / out=3 整段落在首帧的可见区间 [0, 5.033s) 里；旧实现只在出点附近 1s 内扫，
       expected 会报 freeze-no-frame。这里必须拿到首帧，而不是窗口外的下一帧。 */
    const gap = await extractFromPlan({ dir, file, inUs: 2000000, outUs: 3000000, name: 'vfr-gap.png' });
    assert.equal(gap.result.frameUs, 0, '长静止区间应取一直可见的首帧');
    assert.equal(gap.result.seekSec, 0, '首帧没有前一帧，seek 到 0');
    assertFrameColor(gap.color, 0, 'VFR 长静止 in=2/out=3', 1);
    assertNotFrameColor(gap.color, 1, 'VFR 长静止 in=2/out=3', 1);
    assert.deepEqual(pngSize(gap.outPath), { width: 120, height: 200 }, '定格 PNG 必须与源帧同尺寸');

    /* 源文件结束后的真正越界区间：文件 15s，in=16 / out=17 必须报错 */
    const outPath = path.join(dir, 'beyond-eof.png');
    await assert.rejects(
      frame.extractFreezeFrame({ ffmpeg, ffprobe, file, inUs: 16000000, outUs: 17000000, outPath }),
      error => {
        assert.equal(error?.code, 'freeze-no-frame');
        assert.ok(!fs.existsSync(outPath), '越界失败时不能产出图片文件');
        return true;
      },
    );
  });
}

/* ── 运行 ── */
let passed = 0;
const failures = [];
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log('✓', name);
  } catch (error) {
    failures.push({ name, error });
    console.error('✗', name);
    console.error(error?.stack || error);
  } finally {
    for (const dir of roots.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

if (!hasTools) console.log('\nSKIP 真实媒体用例：本机没有找到 ffmpeg / ffprobe（纯函数用例已运行）');
if (failures.length) {
  console.error(`\n定格帧选取测试失败：${failures.length} 项未通过（通过 ${passed} 项）`);
  process.exitCode = 1;
} else {
  console.log(`\n定格帧选取测试通过：${passed} 项${hasTools ? '' : '（媒体用例已 SKIP）'}`);
}
