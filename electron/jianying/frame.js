/* 定格帧选取与抽取（CommonJS 纯 Node 模块，不依赖 Electron）。

   时间基准契约（与分镜台预览的 <video>.currentTime 一致）：
     · 计划里的 sourceInUs / sourceOutUs 是「素材播放时间」，0 = 容器呈现起点
       （ffprobe 的 format.start_time），不是 ffprobe 的原始帧 PTS；
     · 视频帧的播放时间 = 原始 PTS - format.start_time。视频流起点可能晚于容器起点
       （例如音轨从 0 开始、视频从 2 秒开始），此时不能减「视频第一帧 PTS」，
       否则会把 2 秒才出现的画面错当成播放时间 0；
     · ffmpeg 输入端 -ss 也按播放时间解释（ffmpeg 自行加上容器起点），
       所以选帧、可见区间判断和 seek 全部使用同一基准，不再混用原始 PTS。

   选帧规则：
     · 只考虑播放时间 PTS < 出点（排他）；
     · 帧的真实显示区间是 [PTS, 下一帧 PTS)，最后一帧看到媒体结束；
     · 取「可见区间与 [入点, 出点) 相交」的最后一帧；
     · VFR 里相邻帧可能相隔数秒，扫描窗口内没有帧不等于没有画面：
       窗口从出点附近开始，找不到就向后成倍扩大，直到源文件开头；
     · 找到目标帧后 seek 到它与前一帧 PTS 的中点，用 ffmpeg 输出一张 PNG。
   不使用项目帧率，也不做 0.2s / 1s 盲退。 */
'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const { spawn } = require('node:child_process');

const TOOL_TIMEOUT_MS = 120000;
const CANCELED = 'canceled';
const SCAN_ATTEMPTS = 32;

const freezeError = (code, message) => Object.assign(new Error(message), { code });
const canceledError = () => Object.assign(new Error('已取消'), { code: CANCELED, canceled: true });
const aborted = signal => !!signal?.aborted;

/* 工具缺失：默认实现会带 missing 标记；注入的 runCapture（exporter 的）用 stderr 里的 ENOENT 判断 */
const toolMissing = result =>
  !!result?.missing || (result?.code !== 0 && /\bENOENT\b/.test(String(result?.stderr || '')));

const usage = text => {
  const value = typeof text === 'number' ? text : Number(text);
  return Number.isFinite(value) ? Math.round(value) : null;
};

/* ffprobe 的时间字段可能是 "2.000000"、数字，也可能是 "N/A"；只接受有限数字 */
const secondsToUs = value => {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1e6) : null;
};

const tailLine = stderr => {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const last = lines[lines.length - 1];
  return `：${last.length > 300 ? `${last.slice(0, 300)}…` : last}`;
};

const timeText = seconds => `${Number(seconds).toFixed(3)} 秒`;

/* ── 真实进程执行（生产默认；测试注入 runCapture 时可完全替身） ── */
function defaultRunCapture(bin, args, signal, timeoutMs = TOOL_TIMEOUT_MS) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message || error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ code: CANCELED, stdout, stderr, canceled: true });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ code: -1, stdout, stderr: `${stderr}\n媒体处理超时` });
    }, timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout?.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr?.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error =>
      finish({ code: -1, stdout, stderr: String(error?.message || error), missing: error?.code === 'ENOENT' }),
    );
    child.on('close', code => finish({ code: code == null ? -1 : code, stdout, stderr }));
  });
}

/* ── 工具定位：调用方可以传明确路径（Electron 里由 exporter 统一找），否则按常见位置找 ── */
const FFMPEG_CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
const FFPROBE_CANDIDATES = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'];

function executable(file) {
  if (typeof file !== 'string' || !file) return '';
  try {
    return fs.existsSync(file) ? file : '';
  } catch {
    return '';
  }
}

function locateTool(name, explicit, fallbackDir) {
  if (explicit !== undefined) return typeof explicit === 'string' && explicit ? executable(explicit) : '';
  const candidates = name === 'ffprobe' ? FFPROBE_CANDIDATES : FFMPEG_CANDIDATES;
  if (fallbackDir) {
    const sibling = executable(nodePath.join(fallbackDir, name));
    if (sibling) return sibling;
  }
  for (const candidate of candidates) {
    const found = executable(candidate);
    if (found) return found;
  }
  let fromPath = '';
  try {
    for (const dir of String(process.env.PATH || '').split(nodePath.delimiter)) {
      const found = executable(nodePath.join(dir, name));
      if (found) {
        fromPath = found;
        break;
      }
    }
  } catch {}
  return fromPath;
}

/* ── 帧时间选择（纯函数，契约 1.2） ──
   timesUs：升序源帧「播放时间」（微秒）。只取 PTS < outUs 且可见区间 [PTS, 下一帧 PTS)
   与 [inUs, outUs) 相交（next > inUs）的最后一帧。返回相邻帧 PTS 供精确定位用。
   coverageEndUs：本次扫描已经完整覆盖到的播放时间上界；列表里没有下一帧时，说明下一帧
   在 coverageEndUs 之后（或媒体在此结束），用它代替 nominal 估算最后一帧的可见区间。
   不传时保持旧行为：最后一帧按 nominalFrameUs 估。 */
function pickFreezeFrame(timesUs, options = {}) {
  const inUs = usage(options.inUs);
  const outUs = usage(options.outUs);
  if (inUs == null || outUs == null || outUs <= inUs) return null;
  const nominalRaw = usage(options.nominalFrameUs);
  const nominal = nominalRaw != null && nominalRaw > 0 ? nominalRaw : Math.max(1, outUs - inUs);
  const coverageEnd = usage(options.coverageEndUs);
  const list = (Array.isArray(timesUs) ? timesUs : [])
    .map(usage)
    .filter(value => value != null && value >= 0)
    .sort((a, b) => a - b)
    .filter((value, index, array) => index === 0 || value !== array[index - 1]);
  let hit = -1;
  for (let index = 0; index < list.length; index++) {
    const pts = list[index];
    if (pts >= outUs) break; // 升序：再往后都 >= 出点
    const next =
      index + 1 < list.length
        ? list[index + 1]
        : coverageEnd != null && coverageEnd > pts
          ? coverageEnd
          : pts + nominal;
    if (next > inUs) hit = index;
  }
  if (hit < 0) return null;
  return {
    frameUs: list[hit],
    prevUs: hit > 0 ? list[hit - 1] : null,
    nextUs: hit + 1 < list.length ? list[hit + 1] : null,
  };
}

/* ── ffprobe：读视频流信息与容器呈现起点 ──
   startUs 是播放时间 0 对应的原始 PTS 偏移（format.start_time）；视频流自己的 start_time
   只作为容器没写起点时的兜底，绝不直接拿「视频第一帧 PTS」当 0。
   durationUs 是播放时间轴上的媒体结束位置（容器时长）；读不到时为 null。 */
async function probeVideoStream({ runCapture, ffprobe, file, signal }) {
  const result = await runCapture(
    ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=avg_frame_rate,r_frame_rate,width,height,start_time,duration',
      '-show_format',
      '-of',
      'json',
      file,
    ],
    signal,
  );
  if (aborted(signal) || result?.canceled) throw canceledError();
  if (toolMissing(result)) throw freezeError('media-tool-missing', '这台电脑上没找到 ffprobe，无法读取视频帧');
  if (!result || result.code !== 0)
    throw freezeError('media-no-video-stream', `读不出视频流，文件可能已损坏${tailLine(result?.stderr)}`);
  let data = null;
  try {
    data = JSON.parse(result.stdout);
  } catch {}
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const stream = streams[0];
  if (!stream) throw freezeError('media-no-video-stream', `文件里没有可用的视频流${tailLine(result?.stderr)}`);
  const rate = parseFrameRate(stream.avg_frame_rate) ?? parseFrameRate(stream.r_frame_rate);
  const containerStartUs = secondsToUs(data?.format?.start_time);
  const streamStartUs = secondsToUs(stream.start_time);
  const startUs = containerStartUs ?? streamStartUs ?? 0;
  const formatDurationUs = secondsToUs(data?.format?.duration);
  const streamDurationUs = secondsToUs(stream.duration);
  /* 容器没写总时长时，用视频流的 start + duration 换成播放时间上界；两者都没有就按未知处理 */
  const durationUs =
    formatDurationUs != null && formatDurationUs > 0
      ? formatDurationUs
      : streamDurationUs != null && streamDurationUs > 0 && streamStartUs != null
        ? streamStartUs + streamDurationUs - startUs
        : null;
  return {
    width: Math.round(Number(stream.width) || 0),
    height: Math.round(Number(stream.height) || 0),
    fps: rate,
    nominalFrameUs: rate ? Math.max(1, Math.round(1000000 / rate)) : 0,
    startUs,
    durationUs,
  };
}

function parseFrameRate(text) {
  if (typeof text === 'number') return Number.isFinite(text) && text > 0 ? text : null;
  if (typeof text !== 'string' || !text) return null;
  const parts = text.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) return num / den;
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* ── ffprobe：按播放时间区间扫真实帧 PTS ──
   -read_intervals 用的是文件原始时间轴（不是播放时间），所以先把播放区间加上 startUs；
   它还会从区间前的关键帧开始解码、可能带出区间外的帧，这里再按原始区间过滤。
   老版本 / 不支持的容器会失败，此时退回整段扫描再过滤。返回值统一是播放时间微秒。 */
async function scanFrameTimes({ runCapture, ffprobe, file, fromUs, toUs, startUs = 0, signal }) {
  const from = Math.max(0, Math.round(fromUs) || 0);
  const to = Math.max(from, Math.round(toUs) || 0);
  if (to <= from) return [];
  const rawFrom = Math.max(0, from + Math.round(startUs));
  const rawTo = Math.max(rawFrom + 1, to + Math.round(startUs));
  const args = [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-read_intervals',
    `${(rawFrom / 1e6).toFixed(6)}%${(rawTo / 1e6).toFixed(6)}`,
    '-show_entries',
    'frame=best_effort_timestamp_time',
    '-of',
    'json',
    file,
  ];
  let result = await runCapture(ffprobe, args, signal);
  if (aborted(signal) || result?.canceled) throw canceledError();
  if (toolMissing(result)) throw freezeError('media-tool-missing', '这台电脑上没找到 ffprobe，无法读取视频帧');
  if (!result || result.code !== 0) {
    const full = await runCapture(
      ffprobe,
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
      signal,
    );
    if (aborted(signal) || full?.canceled) throw canceledError();
    if (toolMissing(full)) throw freezeError('media-tool-missing', '这台电脑上没找到 ffprobe，无法读取视频帧');
    if (!full || full.code !== 0)
      throw freezeError('frame-extract-failed', `读不出视频的帧时间${tailLine(full?.stderr || result?.stderr)}`);
    result = full;
  }
  let data = null;
  try {
    data = JSON.parse(result.stdout);
  } catch {}
  const times = [];
  const seen = new Set();
  for (const frame of Array.isArray(data?.frames) ? data.frames : []) {
    const value = Number(frame?.best_effort_timestamp_time);
    if (!Number.isFinite(value)) continue;
    const rawPts = Math.round(value * 1e6);
    if (rawPts < rawFrom || rawPts > rawTo) continue;
    const pts = rawPts - Math.round(startUs);
    if (pts < 0 || seen.has(pts)) continue;
    seen.add(pts);
    times.push(pts);
  }
  return times.sort((a, b) => a - b);
}

/* ── 区间：in/out 有效就用 [in, out)；否则旧计划只给 atUs，把它当排他上界（入点 0） ── */
function freezeRange({ inUs, outUs, atUs }) {
  const cin = usage(inUs);
  const cout = usage(outUs);
  if (cin != null && cout != null && cin >= 0 && cout > cin) return { inUs: cin, outUs: cout };
  const at = usage(atUs);
  if (at != null && at > 0) return { inUs: 0, outUs: at };
  return null;
}

/* 在 [effectiveOut - width, scanTo] 里找目标帧；没有就把窗口向后成倍扩大。
   只扩大后边界，是因为目标帧是「出点之前最后一帧」，出点之后只需要看到下一帧是否存在。 */
async function findFreezeFrame({
  runCapture,
  ffprobe,
  file,
  inUs,
  outUs,
  startUs,
  mediaEndUs,
  nominalFrameUs,
  signal,
}) {
  const baseUs = Math.max(1000000, 4 * nominalFrameUs);
  const tailUs = Math.max(500000, 4 * nominalFrameUs);
  const effectiveOutUs = mediaEndUs != null ? Math.min(outUs, mediaEndUs) : outUs;
  const scanToUs = mediaEndUs != null ? Math.min(mediaEndUs, effectiveOutUs + tailUs) : effectiveOutUs + tailUs;
  /* 已知媒体结束位置时，最后一帧最多显示到这里；未知时保持 nominal 估算 */
  const coverageEndUs = mediaEndUs != null ? Math.min(mediaEndUs, scanToUs) : null;
  let widthUs = baseUs;
  let times = [];
  let picked = null;
  let fromUs = 0;
  for (let attempt = 0; attempt < SCAN_ATTEMPTS; attempt++) {
    fromUs = Math.max(0, effectiveOutUs - widthUs);
    times = await scanFrameTimes({ runCapture, ffprobe, file, fromUs, toUs: scanToUs, startUs, signal });
    picked = pickFreezeFrame(times, {
      inUs,
      outUs,
      nominalFrameUs,
      ...(coverageEndUs != null ? { coverageEndUs } : {}),
    });
    if (picked || fromUs === 0) break;
    widthUs = widthUs * 2 >= effectiveOutUs ? effectiveOutUs + 1 : widthUs * 2;
  }
  return { picked, fromUs, scanToUs, times };
}

async function extractFreezeFrame(options = {}) {
  const signal = options.signal;
  if (aborted(signal)) throw canceledError();
  const file = typeof options.file === 'string' ? options.file : '';
  if (!file) throw freezeError('freeze-range-missing', '定格画面没有关联源视频，无法生成');
  const injected = typeof options.runCapture === 'function';
  const runCapture = injected ? options.runCapture : defaultRunCapture;
  /* 注入 runCapture 时工具路径只作为命令名用；但调用方明确给空字符串仍代表「没找到工具」。 */
  const injectedTool = name => (Object.prototype.hasOwnProperty.call(options, name) ? options[name] : name);
  const ffmpeg = injected ? injectedTool('ffmpeg') : locateTool('ffmpeg', options.ffmpeg);
  if (!ffmpeg) throw freezeError('media-tool-missing', '这台电脑上没找到 ffmpeg，无法生成定格画面');
  const ffprobe = injected ? injectedTool('ffprobe') : locateTool('ffprobe', options.ffprobe, nodePath.dirname(ffmpeg));
  if (!ffprobe) throw freezeError('media-tool-missing', '这台电脑上没找到 ffprobe，无法读取视频帧');

  const range = freezeRange(options);
  if (!range) throw freezeError('freeze-range-missing', '定格片段的源入点/出点无效，无法确定要截取哪一帧');
  const { inUs, outUs } = range;

  const stream = await probeVideoStream({ runCapture, ffprobe, file, signal });
  const nominalFrameUs = stream.nominalFrameUs;
  const startUs = stream.startUs || 0;
  const mediaEndUs = stream.durationUs != null && stream.durationUs > 0 ? stream.durationUs : null;
  if (mediaEndUs != null && inUs >= mediaEndUs)
    throw freezeError(
      'freeze-no-frame',
      `源视频播放时间只有 ${timeText(mediaEndUs / 1e6)}，入点 ${timeText(inUs / 1e6)} 已经在源文件结束之后`,
    );

  const found = await findFreezeFrame({
    runCapture,
    ffprobe,
    file,
    inUs,
    outUs,
    startUs,
    mediaEndUs,
    nominalFrameUs,
    signal,
  });
  const picked = found.picked;
  if (!picked)
    throw freezeError(
      'freeze-no-frame',
      `源视频在播放时间 ${timeText(inUs / 1e6)} 到 ${timeText(outUs / 1e6)} 之间没有可用的画面帧`,
    );

  /* 前一帧未知时单独补探一次：seek 到两帧中点，避免落在帧边界上取错相邻帧。
     扫描窗口可能从长静止区间中间开始，所以补探窗口也从目标帧向前扩大。 */
  let prevUs = picked.prevUs;
  if (prevUs == null && picked.frameUs > 0) {
    let width = Math.max(1000000, 4 * nominalFrameUs);
    for (let attempt = 0; attempt < SCAN_ATTEMPTS && prevUs == null; attempt++) {
      const fromUs = Math.max(0, picked.frameUs - width);
      const before = await scanFrameTimes({
        runCapture,
        ffprobe,
        file,
        fromUs,
        toUs: Math.max(0, picked.frameUs - 1),
        startUs,
        signal,
      });
      const prior = before.filter(value => value < picked.frameUs);
      if (prior.length) prevUs = prior[prior.length - 1];
      if (fromUs === 0) break;
      width = width * 2 >= picked.frameUs ? picked.frameUs + 1 : width * 2;
    }
  }
  const seekUs =
    prevUs != null && prevUs < picked.frameUs
      ? Math.round((prevUs + picked.frameUs) / 2)
      : Math.max(0, picked.frameUs - 100);
  const seekSec = seekUs / 1e6;

  const outPath = typeof options.outPath === 'string' ? options.outPath : '';
  if (!outPath) throw freezeError('frame-extract-failed', '没有指定定格图片的输出路径');
  try {
    fs.rmSync(outPath, { force: true });
  } catch {}

  /* -ss 放在 -i 前：ffmpeg 按容器呈现起点解释 seekSec，正好是播放时间基准。 */
  const result = await runCapture(
    ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      seekSec.toFixed(6),
      '-i',
      file,
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-an',
      '-update',
      '1',
      outPath,
    ],
    signal,
  );
  if (aborted(signal) || result?.canceled) throw canceledError();
  if (toolMissing(result)) throw freezeError('media-tool-missing', '这台电脑上没找到 ffmpeg，无法生成定格画面');
  if (!result || result.code !== 0)
    throw freezeError('frame-extract-failed', `没能从视频里截取画面${tailLine(result?.stderr)}`);
  let stat = null;
  try {
    stat = fs.statSync(outPath);
  } catch {}
  if (!stat?.isFile() || stat.size <= 0)
    throw freezeError('frame-extract-failed', '没能从视频里截取画面（没有生成图片文件）');
  return { frameUs: picked.frameUs, seekSec, outPath };
}

module.exports = { pickFreezeFrame, extractFreezeFrame };
