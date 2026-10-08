/* 视频审核（1.5）主进程工具：纯 Node，便于单测。
   · 候选清单回写：审核结果写回 Claude 生成的候选清单 JSON，只认 type = fenjingtai-candidates 的文件
   · 只保存那几秒：用本机 ffmpeg 从在线视频直接截取入点到出点，不下载整片
   · 下载完整原片：用户明确点了才下，跟随重定向，写到临时文件再改名 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const CANDIDATE_TYPE = 'fenjingtai-candidates';

/* ── 文件名 ── */
const safeName = s =>
  String(s || '视频')
    .replace(/[\\/:*?"<>|\n\r\t]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '视频';
const mmss = s => {
  s = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};
/* 目标目录里不覆盖已有文件：重名就加 (2)、(3)… */
function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}${ext}`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}
const segmentFileBase = (name, start, end) => `${safeName(name)}_${mmss(start)}-${mmss(end)}`;
/* 原子地占住一个不重名的目标文件（先建一个空文件占位）：两个同名任务同时保存时各拿各的文件名，不会写到同一个文件 */
function reservePath(dir, base, ext) {
  for (let i = 1; i < 1000; i++) {
    const p = path.join(dir, i === 1 ? `${base}${ext}` : `${base} (${i})${ext}`);
    try {
      fs.closeSync(fs.openSync(p, 'wx'));
      return p;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('同名文件太多，请换个保存位置');
}
const tmpBeside = p => `${p}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`;
const removeQuiet = p => {
  try {
    fs.rmSync(p, { force: true });
  } catch {}
};

/* ── ffmpeg ── */
const FFMPEG_CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
/* 找到过一次就记住（不再每次同步跑 which）；记住的路径失效了再重新找 */
let ffmpegCache = null;
function findFfmpeg(extra = []) {
  if (!extra.length && ffmpegCache && fs.existsSync(ffmpegCache)) return ffmpegCache;
  const found = locateFfmpeg(extra);
  if (!extra.length) ffmpegCache = found;
  return found;
}
function locateFfmpeg(extra) {
  const env = process.env.FJT_FFMPEG ? [process.env.FJT_FFMPEG] : [];
  for (const p of [...env, ...extra, ...FFMPEG_CANDIDATES]) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  // 从终端启动时 PATH 里可能有；从访达双击启动的应用 PATH 很短，上面的固定路径兜底
  try {
    const p = execFileSync('/usr/bin/which', ['ffmpeg'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return null;
}
/* 截取参数：-ss 放在 -i 前面，ffmpeg 只按需读取那一段（mp4 / webm 都支持按范围请求），
   再重新编码保证从入点那一帧开始，而不是跳到前一个关键帧 */
function segmentArgs(url, start, end, out, seekAfterInput = false) {
  const dur = Math.max(0.1, Number(end) - Number(start));
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostats',
    '-progress',
    'pipe:1', // 机器可读的进度（out_time_us=…）写到 stdout，界面据此显示百分比
    '-y',
    // 只允许走网络协议：候选清单来自网上，不让 m3u8 之类的播放列表再去引用本机文件
    '-protocol_whitelist',
    'http,https,tls,tcp,crypto',
    ...(seekAfterInput
      ? ['-i', url, '-ss', String(Math.max(0, Number(start)))]
      : ['-ss', String(Math.max(0, Number(start))), '-i', url]),
    '-t',
    String(dur),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    out,
  ];
}
/* 从 ffmpeg -progress 输出里取已处理到的秒数（out_time_us / out_time_ms 都是微秒，out_time 是 HH:MM:SS.xx） */
function progressSeconds(chunk) {
  let sec = null;
  for (const line of String(chunk).split(/\r?\n/)) {
    const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
    if (m) sec = +m[1] / 1e6;
    else {
      const t = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (t) sec = +t[1] * 3600 + +t[2] * 60 + +t[3];
    }
  }
  return sec;
}
function runFfmpeg(bin, args, { timeoutMs = 10 * 60 * 1000, onProgress } = {}) {
  return new Promise(resolve => {
    let err = '';
    let output = '';
    let frames = 0;
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => {
      output += d.toString();
      const end = output.lastIndexOf('\n');
      if (end < 0) return;
      const lines = output.slice(0, end + 1);
      output = output.slice(end + 1);
      for (const m of lines.matchAll(/^frame=(\d+)/gm)) frames = Math.max(frames, +m[1]);
      const sec = progressSeconds(lines);
      if (sec != null && onProgress) onProgress(sec);
    });
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      resolve({ ok: false, error: '截取超时（10 分钟），网络太慢或视频太大' });
    }, timeoutMs);
    p.stderr.on('data', d => {
      err = (err + d.toString()).slice(-2000);
    });
    p.on('error', e => {
      clearTimeout(timer);
      resolve({ ok: false, error: '无法运行 ffmpeg：' + e.message });
    });
    p.on('close', code => {
      clearTimeout(timer);
      const empty = code === 0 && frames === 0;
      resolve(
        code === 0 && !empty
          ? { ok: true, frames }
          : {
              ok: false,
              error: empty
                ? /HTTP error 429|Too many requests/i.test(err)
                  ? '视频来源请求过多（HTTP 429），没有截到画面，请稍后再试'
                  : '没有截到视频画面，请检查片段时间和视频链接'
                : (err.trim().split('\n').pop() || `ffmpeg 退出码 ${code}`).slice(0, 300),
            },
      );
    });
  });
}
const isHttpUrl = u => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:';
  } catch {
    return false;
  }
};
/* 流媒体播放列表（HLS / DASH）可以再引用任意地址，不直接交给 ffmpeg */
const isPlaylist = u => {
  try {
    return /\.(m3u8?|mpd)$/i.test(new URL(u).pathname);
  } catch {
    return false;
  }
};
async function saveSegment(
  { url, start, end, dir, name },
  { ffmpeg = findFfmpeg(), run = runFfmpeg, onProgress } = {},
) {
  if (!isHttpUrl(url)) return { ok: false, error: '只支持在线视频链接' };
  if (isPlaylist(url)) return { ok: false, error: '这是流媒体播放列表（m3u8 / mpd），请换成直接的视频文件地址' };
  if (!(Number(end) > Number(start))) return { ok: false, error: '出点必须晚于入点' };
  if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir)) return { ok: false, error: '保存位置不存在，请重新选择' };
  if (!ffmpeg)
    return {
      ok: false,
      needFfmpeg: true,
      error: '这台电脑上没找到 ffmpeg。在「终端」里运行 brew install ffmpeg 装好后再试。',
    };
  let out;
  try {
    out = reservePath(dir, segmentFileBase(name, start, end), '.mp4');
  } catch (e) {
    return { ok: false, error: '没法在保存位置建文件：' + (e.message || e) };
  }
  const tmp = tmpBeside(out) + '.mp4';
  const dur = Math.max(0.1, Number(end) - Number(start));
  const attempt = async seekAfterInput => {
    const result = await run(ffmpeg, segmentArgs(url.split('#')[0], start, end, tmp, seekAfterInput), {
      onProgress: sec => onProgress?.(Math.max(0, Math.min(1, sec / dur))),
    });
    if (!result.ok) return result;
    let size = 0;
    try {
      size = fs.statSync(tmp).size;
    } catch {}
    return size >= 1024 ? result : { ok: false, error: '没有截到有效的视频画面' };
  };
  let r;
  try {
    r = await attempt(false);
    // 一些视频站点拒绝随机跳转请求，却允许从头顺序读取；只在空片段或限流时再试一次。
    if (!r.ok && /没有截到|HTTP 429|Too many requests/i.test(r.error || '')) {
      removeQuiet(tmp);
      onProgress?.(0);
      r = await attempt(true);
    }
    if (r.ok) fs.renameSync(tmp, out);
  } catch (e) {
    r = { ok: false, error: String(e?.message || e) };
  }
  if (!r.ok) {
    removeQuiet(tmp);
    removeQuiet(out); // 占位的空文件
    return r;
  }
  return { ok: true, path: out };
}

/* ── 下载完整原片（用户明确要求时） ── */
/* 下载：跟随重定向（只跟到 http / https），30 秒没有任何数据就算超时，可以取消（signal），
   进度最多每 250 毫秒报一次；写到随机临时文件，完整收到后再改名 */
const DOWNLOAD_IDLE_MS = 30 * 1000;
function downloadFile(url, dest, { get, maxRedirects = 6, onProgress, signal, idleMs = DOWNLOAD_IDLE_MS } = {}) {
  const getter = get || (u => (u.startsWith('https:') ? require('node:https') : require('node:http')).get(u));
  return new Promise(resolve => {
    let settled = false;
    let cleanup = () => {};
    const finish = r => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };
    if (signal?.aborted) return finish({ ok: false, canceled: true, error: '已取消下载' });
    const go = (u, left) => {
      let req;
      try {
        req = getter(u);
      } catch (e) {
        finish({ ok: false, error: String(e.message || e) });
        return;
      }
      const onAbort = () => {
        req.destroy?.();
        finish({ ok: false, canceled: true, error: '已取消下载' });
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      req.setTimeout?.(idleMs, () => {
        req.destroy?.();
        finish({ ok: false, error: `下载超时：${Math.round(idleMs / 1000)} 秒没有收到数据` });
      });
      req.on('response', res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
          res.resume();
          signal?.removeEventListener?.('abort', onAbort);
          let next;
          try {
            next = new URL(res.headers.location, u).href;
          } catch {
            finish({ ok: false, error: '下载失败：跳转地址无效' });
            return;
          }
          if (!isHttpUrl(next)) {
            finish({ ok: false, error: '下载失败：跳转到了不支持的地址' });
            return;
          }
          go(next, left - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          finish({ ok: false, error: `下载失败：HTTP ${res.statusCode}` });
          return;
        }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0,
          lastTick = 0;
        const tmp = tmpBeside(dest);
        const f = fs.createWriteStream(tmp);
        cleanup = () => {
          signal?.removeEventListener?.('abort', onAbort);
        };
        const fail = e => {
          res.destroy?.();
          f.destroy();
          removeQuiet(tmp);
          finish({ ok: false, error: String((e && e.message) || e) });
        };
        signal?.addEventListener?.('abort', () => fail(new Error('已取消下载')), { once: true });
        res.on('data', d => {
          got += d.length;
          const now = Date.now();
          if (onProgress && now - lastTick >= 250) {
            lastTick = now;
            onProgress(got, total);
          }
        });
        res.pipe(f);
        f.on('finish', () => {
          f.close(() => {
            if (settled) return removeQuiet(tmp);
            if (total && got < total) return fail(new Error('下载不完整，连接中途断开了'));
            try {
              fs.renameSync(tmp, dest);
            } catch (e) {
              return fail(e);
            }
            onProgress?.(got, total || got);
            finish({ ok: true, path: dest, bytes: got });
          });
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('下载中断，连接被关闭')));
        f.on('error', fail);
      });
      req.on('error', e => finish({ ok: false, error: String(e.message || e) }));
    };
    go(url, maxRedirects);
  });
}
async function downloadOriginal({ url, dir, name }, opts = {}) {
  if (!isHttpUrl(url)) return { ok: false, error: '只支持在线视频链接' };
  if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir)) return { ok: false, error: '保存位置不存在，请重新选择' };
  const clean = url.split('#')[0];
  const ext = (path.extname(new URL(clean).pathname) || '.mp4').toLowerCase().slice(0, 6);
  let dest;
  try {
    dest = reservePath(dir, `${safeName(name)}_完整原片`, ext);
  } catch (e) {
    return { ok: false, error: '没法在保存位置建文件：' + (e.message || e) };
  }
  const r = await downloadFile(clean, dest, opts);
  if (!r.ok) removeQuiet(dest); // 占位的空文件
  return r;
}

/* ── 已保存的片段补上句号 ──
   旧版本保存的文件名只有视频标题，看不出对应哪一句：在同一文件夹里改名成「第125-127句_原文件名」。
   只改名不移动，只认视频文件，已经带句号的不再改；重名加 (2)、(3)… 不覆盖 */
const LINE_TAG_RE = /^第\d+(?:-\d+)?句_/;
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
function renameWithLineTag(oldPath, tag) {
  if (typeof oldPath !== 'string' || !path.isAbsolute(oldPath)) return { ok: false, error: '路径无效' };
  if (!/^第\d+(?:-\d+)?句$/.test(String(tag || ''))) return { ok: false, error: '句号无效' };
  const ext = path.extname(oldPath);
  const base = path.basename(oldPath, ext);
  if (!VIDEO_EXT.has(ext.toLowerCase())) return { ok: false, error: '不是视频文件' };
  if (LINE_TAG_RE.test(base)) return { ok: true, path: oldPath, unchanged: true };
  try {
    if (!fs.statSync(oldPath).isFile()) return { ok: false, error: '文件不存在' };
  } catch {
    return { ok: false, error: '文件不存在' };
  }
  const dest = uniquePath(path.dirname(oldPath), `${tag}_${base}`, ext);
  try {
    fs.renameSync(oldPath, dest);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return { ok: true, path: dest };
}

/* ── 候选清单回写 ──
   results: [{ key, lines, decision, note, savedPath }]；按 key（同时核对 lines）找到候选，写进它的 review 字段。
   只改 type 为 fenjingtai-candidates 的 .json 文件，其他文件一律拒绝 */
function writeReview(file, results, { now = () => new Date().toISOString(), write } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.json$/i.test(file))
    return { ok: false, error: '不是候选清单文件' };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, error: '候选清单读不出来' };
  }
  if (!doc || doc.type !== CANDIDATE_TYPE || !Array.isArray(doc.shots)) return { ok: false, error: '不是候选清单文件' };
  const map = new Map((Array.isArray(results) ? results : []).map(r => [`${r.lines}|${r.key}`, r]));
  let n = 0;
  for (const s of doc.shots)
    for (const c of Array.isArray(s.cands) ? s.cands : []) {
      const r = map.get(`${s.lines}|${c.key}`);
      if (!r) continue;
      c.review = {
        decision: ['ok', 'no', 're'].includes(r.decision) ? r.decision : '',
        note: String(r.note || ''),
        ...(r.savedPath ? { savedPath: r.savedPath } : {}),
        at: now(),
      };
      n++;
    }
  doc.reviewedAt = now();
  const text = JSON.stringify(doc, null, 2);
  try {
    if (write) write(file, text);
    else {
      // 写临时文件 + 落盘 + 改名：中途断电也不会留下半截清单
      const tmp = tmpBeside(file);
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, text, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    }
  } catch (e) {
    return {
      ok: false,
      error: '清单写不进去：' + (e.code === 'EACCES' || e.code === 'EPERM' ? '没有写入权限' : e.message || e),
    };
  }
  return { ok: true, updated: n };
}

module.exports = {
  CANDIDATE_TYPE,
  safeName,
  uniquePath,
  segmentFileBase,
  reservePath,
  isPlaylist,
  findFfmpeg,
  segmentArgs,
  saveSegment,
  downloadFile,
  renameWithLineTag,
  progressSeconds,
  downloadOriginal,
  writeReview,
};
