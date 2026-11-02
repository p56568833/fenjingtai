/* 媒体工具：ffmpeg / ffprobe 的定位、探测、抽帧、抽音轨、封面。
   只负责「拿外部进程把媒体信息读出来 / 把画面和音轨取出来」，不碰草稿目录、暂存目录和导出计划。
   真实实现依赖本机 ffmpeg；测试通过 createMediaTools({ find, spawnProcess }) 注入替身。 */
'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawn } = require('node:child_process');
const { findFfmpeg } = require('../video-tools');
const frameTools = require('./frame');
const mediaInfo = require('./media-info');

const CANCELED = 'canceled';
/* ffprobe 报出的图片编解码名：用来识别「声明成视频、实际是图片」这类格式不符 */
const IMAGE_CODECS = new Set(['png', 'mjpeg', 'jpegls', 'gif', 'webp', 'bmp', 'tiff', 'heic', 'heif', 'avif']);

const canceledError = () => Object.assign(new Error('已取消'), { code: CANCELED, canceled: true });
const exportError = (code, message) => Object.assign(new Error(message), { code });

function ffprobeFor(ffmpeg) {
  const candidates = [
    nodePath.join(nodePath.dirname(ffmpeg), 'ffprobe'),
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe',
  ];
  return candidates.find(candidate => nodeFs.existsSync(candidate)) || '';
}

function createMediaTools({ find = findFfmpeg, spawnProcess = spawn, probeTimeoutMs = 120000 } = {}) {
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
        finish({ code: -1, stdout, stderr: stderr + '\n媒体处理超时', timedOut: true });
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

  /* 容器缺总时长时，只解复用视频包推算完整源时长；失败返回 0，不阻塞导出但也绝不编造。 */
  async function estimateDuration({ probe, file, signal }) {
    if (!probe) return 0;
    const result = await runCapture(
      probe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', file],
      signal,
      probeTimeoutMs,
    );
    if (!result || result.canceled || result.timedOut || result.code !== 0) return 0;
    try {
      return mediaInfo.durationFromPackets(JSON.parse(result.stdout));
    } catch {
      return 0;
    }
  }

  return {
    available: () => !!ffmpegBin(),
    /* 探测媒体：返回 { ok:true, durationUs, width, height, rotation, displayWidth, displayHeight,
       frameRate, videoCodec, audioCodec, hasVideo, hasAudio } 或 { ok:false, code, error }。
       失败原因区分工具缺失 / 超时 / 损坏 / 不支持 / 解析失败，交给上层决定是否阻塞。 */
    async probe({ path: file, signal } = {}) {
      const bin = ffmpegBin();
      if (!bin || !file)
        return { ok: false, code: 'media-tool-missing', error: '这台电脑上没找到 ffmpeg，无法复核素材' };
      if (ffprobeBin()) {
        const result = await runCapture(
          ffprobeBin(),
          ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
          signal,
          probeTimeoutMs,
        );
        if (result.canceled) throw canceledError();
        if (result.timedOut)
          return {
            ok: false,
            code: 'media-probe-timeout',
            error: `探测素材超时（超过 ${Math.max(1, Math.round(probeTimeoutMs / 1000))} 秒）`,
          };
        if (result.code !== 0) {
          const failure = mediaInfo.classifyProbeFailure({ stderr: result.stderr, exitCode: result.code });
          return { ok: false, code: failure.code, error: failure.message };
        }
        let data;
        try {
          data = JSON.parse(result.stdout);
        } catch {
          return { ok: false, code: 'media-probe-failed', error: '素材探测结果无法解析，文件可能已损坏' };
        }
        const info = mediaInfo.normalizeProbe(data);
        if (
          info.ok &&
          info.hasVideo &&
          !(Number(info.durationUs) > 0) &&
          !IMAGE_CODECS.has(String(info.videoCodec || '').toLowerCase())
        ) {
          const estimated = await estimateDuration({ probe: ffprobeBin(), file, signal });
          if (estimated > 0) {
            info.durationUs = estimated;
            info.durationEstimated = true;
          }
        }
        return info;
      }
      /* 没有 ffprobe 时退回 ffmpeg -i 文本解析；只用于降级探测 */
      const fallback = await runCapture(bin, ['-hide_banner', '-i', file], signal, probeTimeoutMs);
      if (fallback.canceled) throw canceledError();
      if (fallback.timedOut) return { ok: false, code: 'media-probe-timeout', error: '探测素材超时' };
      const parsed = parseFfmpegProbe(fallback.stderr);
      if (!(parsed.hasVideo || parsed.hasAudio || parsed.durationUs)) {
        const failure = mediaInfo.classifyProbeFailure({ stderr: fallback.stderr, exitCode: fallback.code });
        return { ok: false, code: failure.code, error: failure.message };
      }
      return {
        ok: true,
        durationUs: parsed.durationUs,
        width: parsed.width,
        height: parsed.height,
        rotation: 0,
        displayWidth: parsed.width,
        displayHeight: parsed.height,
        frameRate: null,
        videoCodec: parsed.videoCodec,
        audioCodec: parsed.audioCodec,
        hasVideo: parsed.hasVideo,
        hasAudio: parsed.hasAudio,
      };
    },
    /* 抽定格帧：真实源帧定位由 frame.js 完成（源入点 / 排他出点 → 区间内最后一个可见源帧），
       不按项目帧率推算，也不做 0.2 / 1 秒盲退。 */
    async extractFrame({ sourcePath, sourceInUs, sourceOutUs, atUs = 0, outPath, signal } = {}) {
      const bin = ffmpegBin();
      if (!bin) throw exportError('media-tool-missing', '这台电脑上没找到 ffmpeg，无法生成定格画面');
      try {
        nodeFs.rmSync(outPath, { force: true });
      } catch {}
      return frameTools.extractFreezeFrame({
        ffmpeg: bin,
        ffprobe: ffprobeBin(),
        file: sourcePath,
        inUs: sourceInUs,
        outUs: sourceOutUs,
        atUs,
        outPath,
        signal,
        runCapture,
      });
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

module.exports = { IMAGE_CODECS, ffprobeFor, createMediaTools };
