/* 剪映导出的文件任务：预检、复制素材、抽定格/封面、生成草稿文件、校验、暂存目录原子提交、登记草稿库。
   由 IPC 层传入已校验的通用导出计划；这里不信任外部输入，会再校验一遍。
   可注入 fs / 媒体工具 / 时钟 / ID / 登记函数，测试用临时目录跑完整流程，不依赖真实剪映和真实草稿库。
   所有写入先落在目标父目录里的隐藏暂存目录，校验通过后同卷 rename 提交；提交后的草稿是用户工作数据，不再删除。 */
'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { findFfmpeg } = require('./video-tools');
const paths = require('./jianying/paths');
const schema = require('./jianying/schema');
const meta = require('./jianying/meta');
const validate = require('./jianying/validate');
const register = require('./jianying/register');

const { BLOCK, WARN, INFO } = validate;

/* 阶段名与界面约定一致：probe / copy / freeze / build / commit / register */
const PHASES = Object.freeze({
  PROBE: 'probe',
  COPY: 'copy',
  FREEZE: 'freeze',
  BUILD: 'build',
  COMMIT: 'commit',
  REGISTER: 'register',
});

const DISK_MARGIN = 32 * 1024 * 1024;
const FREEZE_ESTIMATE = 6 * 1024 * 1024;
const AUDIO_ESTIMATE = 8 * 1024 * 1024; // 抽出的音轨大小上限估计
const COVER_ESTIMATE = 512 * 1024;
const STALE_STAGING_MS = 6 * 60 * 60 * 1000;
const CANCELED = 'canceled';

/* 没有可截帧素材时的兜底封面：16×16 白色 JPEG（222 字节，不依赖 ffmpeg） */
const FALLBACK_COVER = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgQEBMQExYWFhYWFhoYGhsbGxoaGhobGxsdHR0iIiIdHR0bGx0dICAiIiUmJSMjIiMmJigoKDAwLi44ODpFRVP/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z',
  'base64',
);

/* 无设备指纹 / 无 ffmpeg 等降级情况都在这里记；界面把它们当「需要知道的提醒」展示 */
const noteIssue = (issues, level, code, message) => issues.push({ level, code, message });

const canceledError = () => Object.assign(new Error('已取消'), { code: CANCELED, canceled: true });
const exportError = (code, message) => Object.assign(new Error(message), { code });
const canceledSignal = signal => !!signal?.aborted;

function mapCopyError(error) {
  if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT')
    return exportError('disk-full', '复制素材时磁盘空间不足，导出已停止，没有留下草稿');
  if (error?.code === CANCELED || error?.name === 'AbortError') return canceledError();
  return new Error(`复制素材失败：${error?.message || error}`);
}

/* ── 媒体工具（真实实现用 ffmpeg / ffprobe；测试注入替身） ── */

function ffprobeFor(ffmpeg) {
  const candidates = [
    nodePath.join(nodePath.dirname(ffmpeg), 'ffprobe'),
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe',
  ];
  return candidates.find(candidate => nodeFs.existsSync(candidate)) || '';
}

function createMediaTools({ find = findFfmpeg, spawnProcess = spawn } = {}) {
  let ffmpeg = null;
  let probed = false;
  const ffmpegBin = () => {
    if (!probed) {
      probed = true;
      try {
        ffmpeg = find();
      } catch {
        ffmpeg = null;
      }
    }
    return ffmpeg;
  };
  const ffprobeBin = () => {
    const bin = ffmpegBin();
    return bin ? ffprobeFor(bin) : '';
  };

  /* 跑命令并收集输出；不把「进程失败」当异常（ffprobe 探测失败要靠 stderr 判断） */
  function runCapture(bin, args, signal, timeoutMs = 120000) {
    return new Promise(resolve => {
      let child;
      try {
        child = spawnProcess(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
        finish({ code: -1, stdout, stderr: stderr + '\n媒体处理超时' });
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
      child.on('error', error => finish({ code: -1, stdout, stderr: String(error?.message || error) }));
      child.on('close', code => finish({ code: code ?? -1, stdout, stderr }));
    });
  }

  async function run(bin, args, signal) {
    const result = await runCapture(bin, args, signal);
    if (result.canceled || signal?.aborted) throw canceledError();
    if (result.code !== 0)
      throw new Error(
        String(result.stderr || '')
          .trim()
          .split('\n')
          .pop() || '媒体处理失败',
      );
    return result;
  }

  function parseFfmpegProbe(stderr) {
    const text = String(stderr || '');
    const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const durationUs = durationMatch
      ? Math.round(
          (Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])) * 1000000,
        )
      : 0;
    const video = text.match(/Stream #\d+:\d+.*?:\s*Video:\s*([^,\s]+)[^\n]*?(\d{2,5})x(\d{2,5})/);
    const audio = /Stream #\d+:\d+.*?:\s*Audio:/.test(text);
    return {
      durationUs,
      width: video ? Number(video[2]) : 0,
      height: video ? Number(video[3]) : 0,
      videoCodec: video ? video[1] : '',
      audioCodec: audio ? 'audio' : '',
      hasVideo: !!video,
      hasAudio: audio,
    };
  }

  return {
    available: () => !!ffmpegBin(),
    /* 探测时长/分辨率；找不到 ffmpeg 或探测失败返回 null，不阻塞不需要转码的导出 */
    async probe({ path: file, signal } = {}) {
      const bin = ffmpegBin();
      if (!bin || !file) return null;
      const probe = ffprobeBin();
      if (probe) {
        const result = await runCapture(
          probe,
          ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
          signal,
        );
        if (result.canceled) throw canceledError();
        if (result.code === 0) {
          try {
            const data = JSON.parse(result.stdout);
            const streams = Array.isArray(data.streams) ? data.streams : [];
            const video = streams.find(stream => stream.codec_type === 'video');
            const audio = streams.find(stream => stream.codec_type === 'audio');
            const rotation = Number(
              video?.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0,
            );
            const duration = Number(data.format?.duration ?? video?.duration ?? 0);
            return {
              durationUs: Number.isFinite(duration) ? Math.round(duration * 1000000) : 0,
              width: Number(video?.width) || 0,
              height: Number(video?.height) || 0,
              rotation: Number.isFinite(rotation) ? rotation : 0,
              videoCodec: video?.codec_name || '',
              audioCodec: audio?.codec_name || '',
              hasVideo: !!video,
              hasAudio: !!audio,
            };
          } catch {
            return null;
          }
        }
        return null;
      }
      const fallback = await runCapture(bin, ['-hide_banner', '-i', file], signal, 30000);
      if (fallback.canceled) throw canceledError();
      const parsed = parseFfmpegProbe(fallback.stderr);
      return parsed.hasVideo || parsed.hasAudio || parsed.durationUs ? parsed : null;
    },
    /* 抽一帧 PNG：-ss 放在 -i 之后是精确定位，定格要的就是出点前最后一帧。
       源帧率低于项目帧率时，出点前 1/fps 可能落在最后一帧之后：依次往前退一点再试。 */
    async extractFrame({ sourcePath, atUs = 0, outPath, signal } = {}) {
      const bin = ffmpegBin();
      if (!bin) throw exportError('media-tool-missing', '这台电脑上没找到 ffmpeg，无法生成定格画面');
      try {
        nodeFs.rmSync(outPath, { force: true });
      } catch {}
      const base = Math.max(0, Number(atUs) / 1000000);
      const attempts = [base, Math.max(0, base - 0.2), Math.max(0, base - 1)];
      let lastError = '';
      for (const attempt of attempts) {
        try {
          await run(
            bin,
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-y',
              '-i',
              sourcePath,
              '-ss',
              attempt.toFixed(6),
              '-frames:v',
              '1',
              '-an',
              '-update',
              '1',
              outPath,
            ],
            signal,
          );
        } catch (error) {
          if (canceledSignal(signal)) throw canceledError();
          lastError = String(error?.message || error);
          continue;
        }
        try {
          if (nodeFs.statSync(outPath).size > 0) return;
        } catch {}
      }
      throw new Error(lastError || '没能从视频里截取画面（源视频可能更短或帧率更低）');
    },
    /* 从视频里抽音轨（口播源是 mp4/mov 时用；剪映 audios 素材不认视频容器） */
    async extractAudio({ sourcePath, outPath, signal } = {}) {
      const bin = ffmpegBin();
      if (!bin) throw exportError('media-tool-missing', '这台电脑上没找到 ffmpeg，无法抽取口播音轨');
      await run(
        bin,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          sourcePath,
          '-vn',
          '-acodec',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          outPath,
        ],
        signal,
      );
    },
    /* 封面：视频取一帧，图片直接转 JPEG */
    async cover({ sourcePath, atUs = 0, isImage = false, outPath, signal } = {}) {
      const bin = ffmpegBin();
      if (!bin) throw exportError('media-tool-missing', '这台电脑上没找到 ffmpeg，无法生成封面图');
      const args = ['-hide_banner', '-loglevel', 'error', '-y'];
      if (!isImage) args.push('-ss', Math.max(0, Number(atUs) / 1000000).toFixed(6));
      args.push('-i', sourcePath, '-frames:v', '1', '-q:v', '3', '-update', '1', outPath);
      await run(bin, args, signal);
    },
  };
}

/* ── 文件工具（注入点集中在这里，测试不碰真实 fs 行为之外的东西） ── */

const defaultFreeBytes =
  ({ fs = nodeFs } = {}) =>
  dir => {
    try {
      const stat = fs.statfsSync(dir);
      return stat.bavail * stat.bsize;
    } catch {
      return null;
    }
  };

const defaultCommit =
  ({ fs = nodeFs } = {}) =>
  (from, to) =>
    fs.renameSync(from, to);

const defaultIdFor = () => String(randomUUID()).toUpperCase();

const defaultWriteFile =
  ({ fs = nodeFs } = {}) =>
  (file, content) =>
    fs.writeFileSync(file, content, 'utf8');

function writeOwnerMarker({ fs, path, staging, draftId, now }) {
  fs.writeFileSync(
    path.join(staging, paths.OWNER_FILE),
    JSON.stringify({ owner: 'fenjingtai', state: 'building', draftId, createdAt: now }),
    'utf8',
  );
}

function cleanupOwnedStaging({ fs, path, dir }) {
  try {
    const raw = fs.readFileSync(path.join(dir, paths.OWNER_FILE), 'utf8');
    const marker = JSON.parse(raw);
    if (marker?.owner !== 'fenjingtai' || marker.state === 'committed') return false;
  } catch {
    return false; // 没有所有权标记：不是本次任务的产物，绝不动它
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/* 上次异常退出留下的、带所有权标记且超过 6 小时的暂存目录 */
function cleanupStaleStaging({ fs, path, parent, now, maxAgeMs = STALE_STAGING_MS }) {
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(paths.TEMP_PREFIX)) continue;
    const dir = path.join(parent, entry.name);
    let age;
    try {
      age = now - fs.statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (age < maxAgeMs) continue;
    if (cleanupOwnedStaging({ fs, path, dir })) removed++;
  }
  return removed;
}

function sumDirBytes({ fs, path, dir }) {
  let total = 0;
  const walk = current => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(file).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

/* 用流复制，按块回报进度；取消/磁盘满都会停下来，调用方负责清理暂存目录 */
async function copyWithProgress({ fs, source, target, signal, onBytes }) {
  let copied = 0;
  let sourceSize = 0;
  try {
    sourceSize = fs.statSync(source).size;
  } catch {}
  const reader = fs.createReadStream(source, { highWaterMark: 1024 * 1024 });
  reader.on('data', chunk => {
    copied += chunk.length;
    if (onBytes) onBytes(chunk.length);
  });
  const writer = fs.createWriteStream(target, { flags: 'wx' });
  try {
    if (signal) await pipeline(reader, writer, { signal });
    else await pipeline(reader, writer);
  } catch (error) {
    throw mapCopyError(error);
  }
  let finalSize = 0;
  try {
    finalSize = fs.statSync(target).size;
  } catch {}
  if (sourceSize && finalSize !== sourceSize)
    throw exportError('source-changed', '复制素材时源文件发生变化，导出已停止，没有留下草稿');
  return copied;
}

/* 计划里真正会被轨道用到的素材（按首次出现顺序，保证可重复） */
function usedPlanIds(plan) {
  const seen = new Set();
  const order = [];
  const add = id => {
    if (typeof id !== 'string' || !id || seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };
  for (const item of [...(plan?.tracks?.video || []), ...(plan?.tracks?.audio || [])]) add(item?.assetId);
  return order;
}

function assetTable(plan) {
  const map = new Map();
  for (const asset of plan?.assets || []) map.set(asset.planId, { ...asset, derived: false });
  for (const freeze of plan?.derived || []) map.set(freeze.planId, { ...freeze, derived: true, kind: 'image' });
  return map;
}

function checkOptions(options, { draftRoot, path, fs }) {
  const mode = options?.mode === 'folder' ? 'folder' : 'library';
  if (mode === 'folder') {
    const destDir = options?.destDir;
    if (!paths.isAbsolutePath(destDir)) return { ok: false, error: '没有选择保存草稿的文件夹' };
    if (paths.hasTraversal(destDir)) return { ok: false, error: '保存文件夹路径无效' };
    let stat = null;
    try {
      stat = fs.statSync(destDir);
    } catch {}
    if (!stat?.isDirectory()) return { ok: false, error: '保存文件夹不存在，请重新选择' };
    return { ok: true, mode, parent: destDir, draftRoot: destDir };
  }
  if (!paths.isAbsolutePath(draftRoot)) return { ok: false, error: '找不到剪映草稿库，可改用「保存草稿文件夹」' };
  let stat = null;
  try {
    stat = fs.statSync(draftRoot);
  } catch {}
  if (!stat?.isDirectory()) return { ok: false, error: '找不到剪映草稿库，可改用「保存草稿文件夹」' };
  return { ok: true, mode, parent: draftRoot, draftRoot };
}

/* 报告和说明放在草稿目录里，方便连同草稿一起交付；不写用户设备标识 */
function buildReport({ request, draft, result, issues, plannedBytes, copiedBytes }) {
  const plan = request?.plan || {};
  return {
    generator: '分镜台',
    reportVersion: 1,
    target: {
      app: 'Mac 剪映专业版',
      version: String(request?.appVersion || ''),
      draftInfoVersion: schema.DRAFT_VERSION,
      newVersion: schema.NEW_VERSION,
    },
    exportedAt: new Date(Number(request?.nowMs) || Date.now()).toISOString(),
    mode: result.mode,
    draft: { name: draft.name, id: draft.id, dir: draft.dir },
    stats: {
      durationUs: Number(plan.durationUs) || 0,
      segments: result.segmentCount,
      assets: result.assetCount,
      freezeFrames: result.freezeCount,
      audioExtracted: result.audioExtractedCount,
      altFiles: Array.isArray(plan.altAssets) ? plan.altAssets.length : 0,
      plannedBytes,
      copiedBytes,
    },
    timing: plan.timing || null,
    registered: result.registered,
    issues,
  };
}

function explanationText({ result, issues, appVersion, mode, hasSrt = false }) {
  const lines = [
    '# 剪映导出说明',
    '',
    `目标版本：Mac 剪映专业版 ${appVersion || '11.6'}（草稿格式 11.6）`,
    `草稿目录：${result.draftDir}`,
    `片段：${result.segmentCount} 段；素材：${result.assetCount} 个；定格画面：${result.freezeCount} 张`,
    `保存方式：${mode === 'library' ? '加入本机剪映草稿' : '保存草稿文件夹（未加入剪映草稿库）'}`,
    '',
  ];
  if (mode === 'folder') lines.push('把整个草稿文件夹放进剪映草稿库后，用「加入剪映」补登记，或按剪映的导入入口打开。');
  else if (result.registered) lines.push('已经可以在这台电脑的剪映「本地草稿」里看到并打开。');
  else if (result.needsQuit)
    lines.push('导出时剪映正在运行，草稿没有自动加入列表：退出剪映后回到分镜台点「加入剪映」即可。');
  else lines.push('草稿没有自动加入剪映列表，可在剪映退出后回到分镜台点「加入剪映」重试。');
  if (hasSrt) lines.push('附带了字幕文件「字幕.srt」，剪映里同时有可编辑的文字轨。');
  if (result.audioExtractedCount)
    lines.push(`口播源里有 ${result.audioExtractedCount} 个视频文件，已抽出音轨作为独立音频放进草稿。`);
  if (result.notes.some(note => note.includes('备选素材')))
    lines.push('备选素材在 Resources/备选素材；它们不上时间线，需要时在剪映里手动添加。');
  lines.push('草稿已把素材复制到自身的 Resources 目录，移动草稿目录不影响打开；请勿在剪映里继续编辑后由分镜台覆盖。');
  const manual = issues.filter(item => item.level !== 'info');
  if (manual.length) {
    lines.push('', '## 需要你处理', '');
    for (const item of manual) lines.push(`- ${item.message}`);
  }
  return `${lines.join('\n')}\n`;
}

/* 主任务。request: { plan, options, draftRoot, fingerprint, appVersion, osVersion, running, backupDir }
   hooks: { signal, onProgress({ phase, done, total, message }) }
   返回：成功 { ok:true, draftDir, draftName, segmentCount, assetCount, freezeCount, registered, needsQuit, reportPath, notes, issues }；
        失败 { ok:false, canceled?, error, phase, issues } */
async function runJianyingExport(request, hooks = {}, deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const clock = deps.now || (() => Date.now());
  const idFor = deps.idFor || defaultIdFor;
  const media = deps.media || createMediaTools();
  const freeBytes = deps.freeBytes || defaultFreeBytes({ fs });
  const commitDir = deps.commitDir || defaultCommit({ fs });
  const writeFile = deps.writeFile || defaultWriteFile({ fs });
  const registerDraft = deps.registerDraft || register.registerDraft;
  const progress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};
  const signal = hooks.signal || null;
  const canceled = () => !!signal?.aborted;
  const issues = [];
  const notes = [];
  let phase = PHASES.PROBE;
  const emit = (next, done = 0, total = 0, message = '') => {
    phase = next;
    try {
      progress({ phase: next, done, total, message });
    } catch {}
  };
  const fail = (error, extra = {}) => ({
    ok: false,
    error: String(error?.message || error),
    phase,
    issues,
    ...extra,
  });

  const plan = request?.plan;
  let staging = '';
  let committed = false;
  try {
    emit(PHASES.PROBE, 0, 0, '检查导出计划');
    const planIssues = validate.validatePlan(plan);
    issues.push(...planIssues);
    for (const item of Array.isArray(plan?.issues) ? plan.issues : []) {
      const level = item?.level === 'block' ? BLOCK : item?.level === 'confirm' ? WARN : INFO;
      noteIssue(
        issues,
        level,
        String(item?.code || 'plan-issue'),
        String(item?.message || '导出计划里有需要确认的问题'),
      );
    }
    if (issues.some(item => item.level === BLOCK)) return fail('导出计划有问题，已停止导出（没有写入任何文件）');

    const options = request?.options || {};
    const checked = checkOptions(options, { draftRoot: request?.draftRoot, path, fs });
    if (!checked.ok) return fail(checked.error);
    const mode = checked.mode;
    const parent = checked.parent;
    const draftRoot = checked.draftRoot;
    const draftName = paths.safeDraftName(options.draftName || request?.snapshot?.title || '剪映草稿');
    const finalDir = paths.uniqueName(parent, draftName, candidate => fs.existsSync(candidate));
    const finalName = path.basename(finalDir);

    /* 旧任务残留（带所有权标记、超过 6 小时且未提交）顺手清掉；不碰其他任何目录 */
    if (!canceled()) cleanupStaleStaging({ fs, path, parent, now: clock() });
    if (canceled()) return fail(canceledError(), { canceled: true });

    /* 1) 素材存在性：同一源文件只复制一份；定格与「视频抽音轨」是派生任务 */
    const assets = assetTable(plan);
    const order = usedPlanIds(plan);
    for (const planId of order) {
      const asset = assets.get(planId);
      if (!asset) return fail('导出计划里的素材引用不完整');
      const source = asset.derived ? asset.sourcePath : asset.path;
      if (!paths.isAbsolutePath(source)) {
        noteIssue(issues, BLOCK, 'asset-missing', `素材路径无效：${asset.name || planId}`);
        continue;
      }
      let stat = null;
      try {
        stat = fs.statSync(source);
      } catch {}
      if (!stat?.isFile()) {
        noteIssue(
          issues,
          BLOCK,
          'asset-missing',
          `${asset.derived ? '定格画面的源素材' : '素材文件'}不在了：${asset.name || path.basename(source)}`,
        );
        continue;
      }
      try {
        fs.accessSync(source, nodeFs.constants.R_OK);
      } catch {
        noteIssue(issues, BLOCK, 'asset-unreadable', `没有权限读取素材：${asset.name || path.basename(source)}`);
      }
    }
    if (issues.some(item => item.level === BLOCK)) return fail('有素材不能读取，已停止导出（没有写入任何文件）');

    /* 2) 媒体探测：有 ffmpeg 才做（时长复核 + 判断口播源是不是视频）；缺工具只拦需要转码的导出 */
    const mediaAvailable = typeof media.available === 'function' ? !!media.available() : true;
    const probeInfo = new Map();
    if (mediaAvailable && typeof media.probe === 'function') {
      for (const planId of order) {
        const asset = assets.get(planId);
        if (!asset || asset.derived || probeInfo.has(asset.path)) continue;
        let info = null;
        try {
          info = await media.probe({ path: asset.path, signal });
        } catch {
          if (canceled()) return fail(canceledError(), { canceled: true });
        }
        probeInfo.set(asset.path, info || null);
        if (!info) continue;
        if (asset.kind === 'video' && info.hasVideo === false) {
          noteIssue(issues, BLOCK, 'media-not-video', `素材里没有视频画面：${asset.name || path.basename(asset.path)}`);
          continue;
        }
        const known = Number(info.durationUs);
        if (!(known > 0)) continue;
        const wanted = Math.max(
          0,
          ...[...(plan.tracks?.video || []), ...(plan.tracks?.audio || [])]
            .filter(track => track.assetId === planId)
            .map(track => (Number(track.sourceStartUs) || 0) + (Number(track.sourceDurationUs) || 0)),
        );
        if (wanted > known + 100000)
          noteIssue(
            issues,
            BLOCK,
            'source-out-of-range',
            `素材时长不够，导出区间超出文件：${path.basename(asset.path)}`,
          );
      }
    } else if (!mediaAvailable) {
      noteIssue(issues, INFO, 'media-tool-missing', '没找到 ffmpeg，已跳过素材复核（需要抽音轨或定格的导出会被拦下）');
    }

    /* 3) 口播源是视频时抽音轨：剪映的 audios 素材只接受音频容器 */
    const VIDEO_FILE_RE = /\.(mp4|mov|m4v|mkv|webm|avi|flv|wmv|ts|mts|m2ts)$/i;
    const audioExtractIds = new Set();
    for (const planId of order) {
      const asset = assets.get(planId);
      if (!asset || asset.derived || asset.kind !== 'audio') continue;
      const info = probeInfo.get(asset.path);
      // 视频容器（哪怕探测到只有音轨）也抽成 m4a：剪映 audios 素材只认音频容器
      const videoLike = VIDEO_FILE_RE.test(asset.path) || info?.hasVideo === true;
      if (info && info.hasVideo === true && info.hasAudio === false) {
        noteIssue(
          issues,
          BLOCK,
          'audio-missing',
          `口播源是视频「${asset.name || path.basename(asset.path)}」，但它没有音轨`,
        );
        continue;
      }
      if (!videoLike) continue;
      if (!mediaAvailable || typeof media.extractAudio !== 'function') {
        noteIssue(
          issues,
          BLOCK,
          'media-tool-missing',
          `口播源是视频「${asset.name || path.basename(asset.path)}」，需要 ffmpeg 抽出音轨后才能放进草稿`,
        );
        continue;
      }
      audioExtractIds.add(planId);
    }
    if (issues.some(item => item.level === BLOCK)) {
      const first = issues.find(item => item.level === BLOCK);
      return fail(`有素材不能按计划使用，已停止导出（没有写入任何文件）：${first?.message || ''}`);
    }

    /* 4) 资源命名与复制清单 */
    const namer = paths.resourceNamer();
    const resourceFiles = new Map(); // planId → 最终绝对路径
    const bySource = new Map(); // 源路径 → { targetName, bytes }
    const copies = [];
    const freezes = [];
    const audioJobs = [];
    const audioBySource = new Map();
    for (const planId of order) {
      const asset = assets.get(planId);
      if (!asset) continue;
      if (asset.derived) {
        const name = namer.derivedNameOf(planId, asset.outputName);
        resourceFiles.set(planId, paths.resourcePath(finalDir, name));
        freezes.push({ planId, asset, name });
        continue;
      }
      if (audioExtractIds.has(planId)) {
        const existingJob = audioBySource.get(asset.path);
        if (existingJob) {
          resourceFiles.set(planId, paths.resourcePath(finalDir, existingJob.targetName));
          continue;
        }
        const rawName = String(asset.name || path.basename(asset.path));
        const stem = path.basename(rawName, path.extname(rawName)) || '口播';
        const targetName = namer.nameOf(`${asset.path}::audio`, `${stem}-音频.m4a`);
        const job = { planId, asset, source: asset.path, targetName };
        audioJobs.push(job);
        audioBySource.set(asset.path, job);
        resourceFiles.set(planId, paths.resourcePath(finalDir, targetName));
        continue;
      }
      const existing = bySource.get(asset.path);
      if (existing) {
        resourceFiles.set(planId, paths.resourcePath(finalDir, existing.targetName));
        continue;
      }
      let stat = null;
      try {
        stat = fs.statSync(asset.path);
      } catch {}
      if (!stat?.isFile()) continue; // 第 1 步已经报过阻塞
      const targetName = namer.nameOf(asset.path, asset.name || asset.path);
      resourceFiles.set(planId, paths.resourcePath(finalDir, targetName));
      bySource.set(asset.path, { targetName, bytes: stat.size });
      copies.push({
        planId,
        source: asset.path,
        targetName,
        bytes: stat.size,
        kind: asset.kind,
        name: asset.name || path.basename(asset.path),
      });
    }

    if (!mediaAvailable && freezes.length)
      return fail('这台电脑上没找到 ffmpeg，无法生成定格画面（导出已停止，没有写入任何文件）');

    /* 备选素材：只在用户勾选时随草稿附带（不进时间线、不登记素材库），交付时说明清楚 */
    const altCopies = [];
    const altNamer = paths.resourceNamer();
    for (const alt of Array.isArray(plan?.altAssets) ? plan.altAssets : []) {
      if (!paths.isAbsolutePath(alt?.path)) {
        noteIssue(issues, INFO, 'alt-skipped', `备选素材「${alt?.name || '未命名'}」没有本地路径，未随草稿复制`);
        continue;
      }
      let altStat = null;
      try {
        altStat = fs.statSync(alt.path);
      } catch {}
      if (!altStat?.isFile()) {
        noteIssue(
          issues,
          INFO,
          'alt-skipped',
          `备选素材「${alt.name || path.basename(alt.path)}」文件不在了，未随草稿复制`,
        );
        continue;
      }
      altCopies.push({
        source: alt.path,
        targetName: altNamer.nameOf(alt.path, alt.name || alt.path),
        bytes: altStat.size,
        name: alt.name || path.basename(alt.path),
      });
    }
    const altBytes = altCopies.reduce((sum, item) => sum + item.bytes, 0);
    const plannedBytes = [...bySource.values()].reduce((sum, item) => sum + item.bytes, 0) + altBytes;
    const estimatedBytes =
      plannedBytes +
      freezes.length * FREEZE_ESTIMATE +
      audioJobs.length * AUDIO_ESTIMATE +
      (order.length ? COVER_ESTIMATE : 0) +
      DISK_MARGIN;
    const free = freeBytes(parent);
    if (free !== null && free < estimatedBytes) {
      noteIssue(issues, BLOCK, 'disk-full', '目标磁盘剩余空间不够，导出已停止（没有写入任何文件）');
      return fail('目标磁盘剩余空间不够');
    }

    /* 剪映运行状态会影响登记，但不影响生成本次唯一草稿目录 */
    const isRunningNow = () => {
      try {
        return typeof deps.isRunning === 'function' ? !!deps.isRunning() : !!request?.running;
      } catch {
        return true; // 判断不了就当它在运行：只生成、不写索引
      }
    };
    if (mode === 'library') {
      const index = register.readIndex({ indexFile: paths.indexFileFor(draftRoot), fs, path });
      if (!index.ok)
        noteIssue(issues, INFO, 'index-unusable', `${index.error}；草稿仍会生成，稍后可点「加入剪映」重试`);
    }

    /* 暂存目录：目标父目录里的隐藏目录，资源与结构校验通过后才提交 */
    const token = typeof deps.token === 'function' ? deps.token() : String(randomUUID());
    staging = path.join(parent, `${paths.TEMP_PREFIX}${token}`);
    const stagingResources = path.join(staging, 'Resources');
    const draftId = idFor('draft');
    const nowMs = clock();
    fs.mkdirSync(stagingResources, { recursive: true });
    writeOwnerMarker({ fs, path, staging, draftId, now: nowMs });
    if (finalName !== draftName) noteIssue(issues, INFO, 'name-deduped', `已有同名草稿，本次保存为「${finalName}」`);

    /* 复制素材 */
    const totalBytes = plannedBytes;
    let copiedBytes = 0;
    emit(PHASES.COPY, 0, totalBytes, '复制素材');
    for (const copy of copies) {
      if (canceled()) return fail(canceledError(), { canceled: true });
      await copyWithProgress({
        fs,
        source: copy.source,
        target: path.join(stagingResources, copy.targetName),
        signal,
        onBytes: delta => {
          copiedBytes += delta;
          emit(PHASES.COPY, copiedBytes, totalBytes, `复制素材：${copy.name}`);
        },
      });
    }
    if (altCopies.length) {
      const altDir = path.join(stagingResources, '备选素材');
      fs.mkdirSync(altDir, { recursive: true });
      for (const copy of altCopies) {
        if (canceled()) return fail(canceledError(), { canceled: true });
        await copyWithProgress({
          fs,
          source: copy.source,
          target: path.join(altDir, copy.targetName),
          signal,
          onBytes: delta => {
            copiedBytes += delta;
            emit(PHASES.COPY, copiedBytes, totalBytes, `复制备选素材：${copy.name}`);
          },
        });
      }
    }
    emit(PHASES.COPY, copiedBytes, totalBytes, '素材复制完成');

    /* 定格帧 */
    emit(PHASES.FREEZE, 0, freezes.length, freezes.length ? '处理定格画面' : '没有需要生成的定格');
    for (let index = 0; index < freezes.length; index++) {
      if (canceled()) return fail(canceledError(), { canceled: true });
      const freeze = freezes[index];
      const outPath = path.join(stagingResources, freeze.name);
      try {
        await media.extractFrame({
          sourcePath: freeze.asset.sourcePath,
          atUs: freeze.asset.atUs,
          outPath,
          signal,
        });
      } catch (error) {
        if (canceled() || error?.code === CANCELED) return fail(canceledError(), { canceled: true });
        noteIssue(issues, BLOCK, 'freeze-failed', `定格画面生成失败：${error?.message || error}`);
        return fail('定格画面生成失败，已停止导出（没有留下草稿）');
      }
      let stat = null;
      try {
        stat = fs.statSync(outPath);
      } catch {}
      if (!stat?.isFile() || stat.size <= 0) return fail('定格画面生成失败，已停止导出（没有留下草稿）');
      emit(PHASES.FREEZE, index + 1, freezes.length, `定格画面 ${index + 1}/${freezes.length}`);
    }

    /* 视频口播抽音轨：结构生成前完成，失败不提交、不留草稿 */
    if (audioJobs.length) {
      emit(PHASES.BUILD, 0, 0, '抽取口播音轨');
      for (const job of audioJobs) {
        if (canceled()) return fail(canceledError(), { canceled: true });
        const outPath = path.join(stagingResources, job.targetName);
        try {
          await media.extractAudio({ sourcePath: job.source, outPath, signal });
        } catch (error) {
          if (canceled() || error?.code === CANCELED) return fail(canceledError(), { canceled: true });
          noteIssue(issues, BLOCK, 'audio-extract-failed', `口播音轨抽取失败：${error?.message || error}`);
          return fail('口播音轨抽取失败，已停止导出（没有留下草稿）');
        }
        let stat = null;
        try {
          stat = fs.statSync(outPath);
        } catch {}
        if (!stat?.isFile() || stat.size <= 0) return fail('口播音轨抽取失败，已停止导出（没有留下草稿）');
      }
    }

    /* 封面：取第一个画面素材的一帧；失败用内置小图兜底 */
    emit(PHASES.BUILD, 0, 0, '生成封面');
    const coverPath = path.join(staging, 'draft_cover.jpg');
    const firstVisual = [...(plan.tracks?.video || [])]
      .map(item => ({ item, asset: assets.get(item.assetId) }))
      .find(entry => entry.asset);
    let coverMade = false;
    if (firstVisual && mediaAvailable && typeof media.cover === 'function') {
      try {
        const visual = firstVisual.asset;
        await media.cover({
          sourcePath: visual.derived
            ? resourceSibling(stagingResources, resourceFiles.get(firstVisual.item.assetId))
            : visual.path,
          atUs: visual.derived ? 0 : (Number(firstVisual.item.sourceStartUs) || 0) + 100000,
          isImage: visual.derived || visual.kind === 'image' || visual.type === 'freeze',
          outPath: coverPath,
          signal,
        });
        coverMade = fs.existsSync(coverPath) && fs.statSync(coverPath).size > 0;
      } catch {
        if (canceled()) return fail(canceledError(), { canceled: true });
      }
    }
    if (!coverMade) {
      fs.writeFileSync(coverPath, FALLBACK_COVER);
      noteIssue(issues, INFO, 'cover-fallback', '封面用了默认图（没能从画面里截取）');
    }

    /* 生成草稿结构 */
    emit(PHASES.BUILD, 0, 0, '生成草稿文件');
    const finalResources = new Map();
    for (const planId of order) {
      const file = resourceFiles.get(planId);
      if (file) finalResources.set(planId, file);
    }
    const resourceMap = {};
    for (const [planId, file] of finalResources) resourceMap[planId] = file;
    const draft = { id: draftId, name: finalName, dir: finalDir, root: draftRoot };
    const doc = schema.buildDraftInfo({
      plan,
      draft,
      resources: resourceMap,
      fingerprint: request?.fingerprint,
      appVersion: request?.appVersion,
      osVersion: request?.osVersion,
      nowUs: nowMs * 1000,
      idFor,
    });
    const canvasWidth = Math.max(1, Number(plan.canvas?.width) || 1920);
    const canvasHeight = Math.max(1, Number(plan.canvas?.height) || 1080);
    const usedMaterials = order
      .filter(planId => assets.get(planId) && !assets.get(planId).derived)
      .map(planId => {
        const asset = assets.get(planId);
        const extent = Math.max(
          0,
          ...[...(plan.tracks?.video || []), ...(plan.tracks?.audio || [])]
            .filter(track => track.assetId === planId)
            .map(track => (Number(track.sourceStartUs) || 0) + (Number(track.sourceDurationUs) || 0)),
        );
        return {
          name: path.basename(resourceFiles.get(planId)),
          path: resourceFiles.get(planId),
          kind: asset.kind,
          width: Number(asset.width) > 0 ? Math.round(Number(asset.width)) : canvasWidth,
          height: Number(asset.height) > 0 ? Math.round(Number(asset.height)) : canvasHeight,
          durationUs: asset.kind === 'image' ? schema.PHOTO_DURATION_US : Number(asset.durationUs) || extent || 0,
        };
      })
      .concat(
        freezes.map(freeze => ({
          name: freeze.name,
          path: resourceFiles.get(freeze.planId),
          kind: 'image',
          width: Number(freeze.asset.width) || 0,
          height: Number(freeze.asset.height) || 0,
          durationUs: schema.PHOTO_DURATION_US,
        })),
      );
    const resourcesBytes = sumDirBytes({ fs, path, dir: stagingResources });
    const metaInfo = meta.buildDraftMetaInfo({
      draft,
      materials: usedMaterials,
      materialsSize: resourcesBytes,
      durationUs: plan.durationUs,
      nowUs: nowMs * 1000,
      idFor,
    });
    const settings = meta.buildDraftSettings({ nowSec: Math.floor((nowMs * 1000) / 1000000) });
    const srt = typeof plan?.srt === 'string' ? plan.srt.trim() : '';
    if (srt) writeFile(path.join(staging, '字幕.srt'), `${srt}\n`);
    writeFile(path.join(staging, 'draft_info.json'), JSON.stringify(doc));
    writeFile(path.join(staging, 'draft_meta_info.json'), JSON.stringify(metaInfo));
    writeFile(path.join(staging, 'draft_settings'), settings);

    const draftIssues = validate.validateDraftInfo(doc, {
      draftDir: finalDir,
      resourceDir: stagingResources,
      plan,
      checkFiles: fs,
    });
    issues.push(...draftIssues);
    if (draftIssues.some(item => item.level === BLOCK))
      return fail('生成的草稿结构没通过校验，已停止导出（没有留下草稿）');

    /* 提交：同卷 rename；失败只清理本次暂存目录，目标位置不留下半成品 */
    emit(PHASES.COMMIT, 0, 0, '提交草稿目录');
    if (canceled()) return fail(canceledError(), { canceled: true });
    if (fs.existsSync(finalDir)) return fail('目标草稿目录在导出期间被占用，已停止（没有留下半成品）');
    try {
      commitDir(staging, finalDir);
    } catch (error) {
      return fail(`提交草稿目录失败：${error?.message || error}（没有留下半成品）`);
    }
    committed = true;
    staging = '';

    /* 登记：剪映运行中只生成不写索引；索引不可用时保留草稿并说明 */
    emit(PHASES.REGISTER, 0, 0, mode === 'folder' ? '保存草稿文件夹' : '加入剪映草稿库');
    const result = {
      ok: true,
      mode,
      draftDir: finalDir,
      draftName: finalName,
      segmentCount:
        (plan.tracks?.video || []).length + (plan.tracks?.audio || []).length + (plan.tracks?.text || []).length,
      assetCount: copies.length,
      freezeCount: freezes.length,
      audioExtractedCount: audioJobs.length,
      registered: false,
      needsQuit: false,
      reportPath: path.join(finalDir, 'fenjingtai-export.json'),
      notes,
      issues,
    };
    if (audioJobs.length) notes.push(`${audioJobs.length} 个口播源是视频，已抽出音轨作为独立音频轨放进草稿`);
    if (altCopies.length)
      notes.push(`${altCopies.length} 个备选素材已复制到 Resources/备选素材（不上时间线，可在剪映里手动添加）`);
    if (mode === 'library') {
      if (isRunningNow()) {
        result.needsQuit = true;
        notes.push('剪映正在运行：草稿已生成，退出剪映后回到分镜台点「加入剪映」补登记');
        noteIssue(issues, INFO, 'app-running', '剪映正在运行，这次没有改草稿库索引；退出后可补登记');
      } else {
        let registeredResult = null;
        try {
          registeredResult = registerDraft({
            draftRoot,
            draftDir: finalDir,
            backupDir: request?.backupDir || '',
            now: () => nowMs * 1000,
            fs,
            path,
          });
        } catch (error) {
          registeredResult = { ok: false, registered: false, error: String(error?.message || error) };
        }
        if (registeredResult?.ok && registeredResult.registered) result.registered = true;
        else {
          result.needsQuit = !!registeredResult?.needsQuit;
          notes.push(`草稿已生成，但没加进剪映列表：${registeredResult?.error || '未知原因'}`);
          noteIssue(issues, WARN, 'register-failed', registeredResult?.error || '没能加入剪映草稿列表');
        }
      }
    }

    /* 导出报告与说明：写失败不影响草稿本身 */
    try {
      const report = buildReport({
        request: { ...request, nowMs },
        draft,
        result,
        issues,
        plannedBytes,
        copiedBytes,
      });
      writeFile(result.reportPath, JSON.stringify(report, null, 1));
      writeFile(
        path.join(finalDir, '导出说明.md'),
        explanationText({ result, issues, appVersion: request?.appVersion, mode, hasSrt: !!plan?.srt }),
      );
    } catch {
      noteIssue(issues, INFO, 'report-failed', '导出报告没写出来（草稿本身不受影响）');
    }
    return result;
  } catch (error) {
    if (error?.code === CANCELED || canceled()) return fail(canceledError(), { canceled: true });
    return fail(error);
  } finally {
    /* 失败/取消清理暂存；已提交的草稿目录绝不动 */
    if (!committed && staging) cleanupOwnedStaging({ fs, path, dir: staging });
  }
}

/* 草稿最终资源路径 → 暂存目录里的同名字文件（媒体工具只用暂存路径） */
function resourceSibling(resourcesDir, finalFile) {
  return nodePath.join(resourcesDir, nodePath.basename(finalFile || ''));
}

module.exports = {
  PHASES,
  CANCELED,
  createMediaTools,
  runJianyingExport,
  copyWithProgress,
  cleanupOwnedStaging,
  cleanupStaleStaging,
  usedPlanIds,
  FALLBACK_COVER,
};
