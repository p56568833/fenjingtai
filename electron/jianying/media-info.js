/* 真实媒体元数据与探测失败分类：把 ffprobe JSON 归一化成导出用的媒体信息；按文件头读图片尺寸（不依赖 ffmpeg）；
   把探测失败分成「工具缺失 / 探测超时 / 不支持 / 损坏或非媒体 / 解析失败」等可展示给用户的原因。
   纯逻辑模块：不碰 Electron、不自己起进程；文件读写只走传入的 fs（测试可注入）。
   约定：宽高/时长都是整数（时长微秒）；旋转按 ffprobe 的 rotation（顺时针度数为正，反之为负）。
   失败信息里的文案会直接显示给用户，必须中文可读，不夹 ffprobe 原始输出。 */
'use strict';

const nodeFs = require('node:fs');

const CODES = Object.freeze({
  TOOL_MISSING: 'media-tool-missing',
  PROBE_TIMEOUT: 'media-probe-timeout',
  UNSUPPORTED: 'media-unsupported',
  PROBE_FAILED: 'media-probe-failed',
});

const failure = (code, error) => ({ ok: false, code, error });
const positive = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const integer = (value, fallback = 0) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
};
const text = value => (value == null ? '' : String(value));

/* 帧率：ffprobe 给的是 "30000/1001" 或 "25"；0/0、N/A 当未知 */
function parseFrameRate(value) {
  if (value == null) return null;
  const raw = text(value).trim();
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (match) {
    const num = Number(match[1]);
    const den = Number(match[2]);
    return num > 0 && den > 0 ? { num, den } : null;
  }
  const single = Number(raw);
  return single > 0 ? { num: single, den: 1 } : null;
}

/* 视频流旋转：优先 Display Matrix 的 side_data_list[].rotation，其次旧式 tags.rotate */
function rotationOf(video) {
  const side = Array.isArray(video?.side_data_list) ? video.side_data_list : [];
  const sideEntry = side.find(item => item && item.rotation !== undefined && item.rotation !== null);
  const raw = sideEntry ? sideEntry.rotation : video?.tags?.rotate;
  const rotation = Number(raw);
  return Number.isFinite(rotation) ? rotation : 0;
}

/* ffprobe JSON → 导出用的媒体信息。
   raw 来自 `ffprobe -show_format -show_streams -of json`。
   成功：{ ok:true, durationUs, width, height, rotation, displayWidth, displayHeight, frameRate,
          videoCodec, audioCodec, hasVideo, hasAudio, formatName }
   失败：{ ok:false, code, error }（没有流 / 解析失败 / 文件损坏读不到画面尺寸）。
   注意：width/height 是源画面尺寸；带 90/270 度旋转时 displayWidth/displayHeight 才是显示方向。 */
function normalizeProbe(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return failure(CODES.PROBE_FAILED, '没有读到素材信息，文件可能已损坏或不是媒体文件');
  const streams = Array.isArray(raw.streams) ? raw.streams.filter(item => item && typeof item === 'object') : [];
  if (!streams.length) return failure(CODES.PROBE_FAILED, '文件里没有可用的媒体流（可能已损坏或不是媒体文件）');
  /* 音频文件里的封面图也是 codec_type=video 的流（disposition.attached_pic=1），不算视频画面 */
  const video = streams.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1) || null;
  const audio = streams.find(stream => stream.codec_type === 'audio') || null;
  const width = video ? integer(positive(video.width)) : 0;
  const height = video ? integer(positive(video.height)) : 0;
  /* 有些损坏的图片 ffprobe 仍能给出 image2 流，但尺寸是 0：这种不算可用素材 */
  if (video && (!width || !height))
    return failure(CODES.PROBE_FAILED, '素材文件已损坏或不是可用的媒体文件（读不到画面尺寸）');
  const durationSec = Number(raw.format?.duration ?? video?.duration ?? 0);
  const durationUs = Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec * 1000000) : 0;
  const rotation = rotationOf(video);
  const quarterTurn = Math.abs(Math.round(rotation)) % 180 === 90;
  return {
    ok: true,
    durationUs,
    width,
    height,
    rotation,
    displayWidth: quarterTurn ? height : width,
    displayHeight: quarterTurn ? width : height,
    frameRate: parseFrameRate(video?.avg_frame_rate ?? video?.r_frame_rate),
    videoCodec: text(video?.codec_name),
    audioCodec: text(audio?.codec_name),
    hasVideo: !!video,
    hasAudio: !!audio,
    formatName: text(raw.format?.format_name),
  };
}

/* 常见「不是音视频」的 ffprobe format_name：解出来也放不进草稿 */
const NOT_MEDIA_FORMAT = /^(tty|data|ass|srt|webvtt|microdvd|subviewer|subrip)$/i;
/* 已知能放进剪映的封装/图片容器（ffprobe 的 format_name 可能是逗号分隔的别名，取第一个判断） */
const KNOWN_MEDIA_FORMAT =
  /^(mov|mp4|m4a|3gp|3g2|mj2|matroska|webm|avi|flv|wmv|asf|mpeg|mpegts|ts|mxf|ogg|wav|mp3|flac|aac|ac3|eac3|png|jpeg|jpg|gif|webp|bmp|tiff|image2|image2pipe|rawvideo|h264|hevc|ivf|nut|yuv4mpegpipe)$/i;

/* 探测失败的 stderr 特征：先看「不支持」，再看「损坏 / 打不开」。
   顺序重要：'could not find codec parameters' 是编码不支持，'invalid data' 才是文件坏了。 */
const UNSUPPORTED_RE =
  /unsupported|not supported|unknown (?:decoder|encoder|codec|format|input format)|decoder .*not found|no decoder|codec .*not found|could not find tag for codec|protocol not found|unknown format|\. [a-z0-9]+ is not supported|not implemented/i;
const CORRUPT_RE =
  /moov atom not found|invalid data found|invalid (?:png|jpeg|jpg|gif|webp|bmp|tiff|heic|avif) signature|invalid .*signature|error reading header|could not read|could not find codec parameters|truncated|unexpected end of file|end of file|failed to read|no such file or directory|permission denied|cannot open|is empty|empty file/i;

const shortStderr = value => {
  const lines = text(value).trim().split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
};

/* 探测失败 → 用户可读的 { code, message }。
   分类只认契约里的四个 code：
   · media-tool-missing  工具缺失
   · media-probe-timeout 探测超时（FIFO / 卡死）
   · media-unsupported   格式或编码不支持
   · media-probe-failed  损坏 / 不是媒体 / 其它读不出来（文案里说明「已损坏或不是媒体」）
   「没有所需媒体流」不算探测失败：探测成功但 hasVideo/hasAudio 不符合素材类型，由调用方按素材用途判断。
   exitCode / formatName 是可选补充：formatName 来自已拿到的 ffprobe format（或按文件签名猜到的格式），
   给了但不在已知媒体格式里 → 按不支持处理；都在已知格式里却失败 → 按损坏处理。 */
function classifyProbeFailure({ stderr, timedOut, toolMissing, formatName, exitCode } = {}) {
  if (toolMissing) return { code: CODES.TOOL_MISSING, message: '这台电脑上没找到 ffmpeg / ffprobe，无法读取素材信息' };
  if (timedOut) return { code: CODES.PROBE_TIMEOUT, message: '读取素材信息超时（文件可能不可读或已损坏）' };
  const raw = text(stderr);
  if (UNSUPPORTED_RE.test(raw))
    return { code: CODES.UNSUPPORTED, message: '暂不支持这个素材的格式或编码，请先转换成常见的 mp4 / mov / png / jpg' };
  if (CORRUPT_RE.test(raw))
    return { code: CODES.PROBE_FAILED, message: '素材文件已损坏或不是可用的媒体文件，请换一个文件' };
  const label = text(formatName).trim().split(',')[0];
  if (label) {
    if (NOT_MEDIA_FORMAT.test(label))
      return { code: CODES.PROBE_FAILED, message: '这个文件不是可用的媒体文件（没有音视频内容）' };
    if (!KNOWN_MEDIA_FORMAT.test(label))
      return { code: CODES.UNSUPPORTED, message: `暂不支持这种文件格式（${label.slice(0, 40)}）` };
    return { code: CODES.PROBE_FAILED, message: '读不出素材信息，文件可能已损坏' };
  }
  const tail = shortStderr(stderr);
  if (tail) return { code: CODES.PROBE_FAILED, message: `读不出素材信息（文件可能已损坏或不是媒体文件）：${tail}` };
  const code = Number(exitCode);
  if (Number.isFinite(code) && code !== 0)
    return { code: CODES.PROBE_FAILED, message: '读不出素材信息（文件可能已损坏或不是媒体文件）' };
  return { code: CODES.PROBE_FAILED, message: '读不出素材信息，文件可能已损坏' };
}

/* ── 图片尺寸（只读文件头，不引第三方依赖） ── */

const readHead = (fs, file, bytes) => {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, Math.max(0, read));
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height, format: 'png' } : null;
}

/* JPEG：逐段跳过标记，找到 SOFn（C0–CF，排除 C4/C8/CC）读宽高。
   最多读 8MB 头，避免超大图或超长 EXIF 把整个文件读进内存。 */
function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++; // 标记之间的填充/异常，向后重同步
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) break; // 到扫描数据还没见到 SOF：不是能读的 JPEG
    if (offset + 4 > buffer.length) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (offset + 9 > buffer.length) break;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height, format: 'jpeg' } : null;
    }
    offset += 2 + length;
  }
  return null;
}

function gifSize(buffer) {
  if (buffer.length < 10) return null;
  const signature = buffer.toString('ascii', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height, format: 'gif' } : null;
}

/* WebP：RIFF....WEBP + VP8（有损）/ VP8L（无损）/ VP8X（扩展）三种头 */
function webpSize(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height, format: 'webp' } : null;
  }
  if (chunk === 'VP8L') {
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >> 14) & 0x3fff);
    return { width, height, format: 'webp' };
  }
  if (chunk === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return width > 0 && height > 0 ? { width, height, format: 'webp' } : null;
  }
  return null;
}

/* 图片真实尺寸：{ width, height, format } | null（读不出来 / 不是图片）。
   只需要文件头；PNG / JPEG / GIF / WebP 都按容器格式解析，不依赖 ffmpeg。 */
function imageSizeOf({ fs = nodeFs, file } = {}) {
  if (!file || typeof file !== 'string') return null;
  let buffer;
  try {
    const stat = fs.statSync(file);
    if (!stat?.isFile?.() || !(Number(stat.size) > 0)) return null;
    const limit = Math.min(Number(stat.size), 8 * 1024 * 1024);
    buffer = readHead(fs, file, limit);
  } catch {
    return null;
  }
  if (!buffer?.length) return null;
  return pngSize(buffer) || jpegSize(buffer) || gifSize(buffer) || webpSize(buffer);
}

/* 容器没有写总时长时的兜底：只解复用视频包，按真实包时间戳推算完整源时长（不解码、不重新编码）。
   · 有 pts 的容器：最后一个包 pts + duration；
   · 裸流没有 pts（如 raw H.264）：包数 × 每包 duration_time。
   返回整数微秒；推算不出来返回 0。调用方要把结果标注为「推算」，不能冒充容器元数据。 */
function durationFromPackets(data) {
  const packets = Array.isArray(data?.packets) ? data.packets : [];
  if (!packets.length) return 0;
  let first = null;
  let end = 0;
  let sumDuration = 0;
  for (const packet of packets) {
    const pts = Number(packet?.pts_time);
    const duration = Number(packet?.duration_time);
    if (Number.isFinite(pts)) {
      if (first == null) first = pts;
      end = Math.max(end, pts + (Number.isFinite(duration) && duration > 0 ? duration : 0));
    }
    if (Number.isFinite(duration) && duration > 0) sumDuration += duration;
  }
  /* 用首包 PTS 归一化：容器时间轴不从 0 开始时，end 是绝对时间，不能直接当总时长 */
  if (end > 0) {
    const start = first != null ? first : 0;
    return Math.round(Math.max(0, end - start) * 1e6);
  }
  if (sumDuration > 0) return Math.round(sumDuration * 1e6);
  return 0;
}

module.exports = {
  CODES,
  classifyProbeFailure,
  durationFromPackets,
  imageSizeOf,
  normalizeProbe,
};
