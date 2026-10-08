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

/* ── ffmpeg ── */
const FFMPEG_CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
function findFfmpeg(extra = []) {
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
function segmentArgs(url, start, end, out) {
  const dur = Math.max(0.1, Number(end) - Number(start));
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(Math.max(0, Number(start))),
    '-i',
    url,
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
function runFfmpeg(bin, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise(resolve => {
    let err = '';
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, error: (err.trim().split('\n').pop() || `ffmpeg 退出码 ${code}`).slice(0, 300) },
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
async function saveSegment({ url, start, end, dir, name }, { ffmpeg = findFfmpeg(), run = runFfmpeg } = {}) {
  if (!isHttpUrl(url)) return { ok: false, error: '只支持在线视频链接' };
  if (!(Number(end) > Number(start))) return { ok: false, error: '出点必须晚于入点' };
  if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir)) return { ok: false, error: '保存位置不存在，请重新选择' };
  if (!ffmpeg)
    return {
      ok: false,
      needFfmpeg: true,
      error: '这台电脑上没找到 ffmpeg。在「终端」里运行 brew install ffmpeg 装好后再试。',
    };
  const out = uniquePath(dir, segmentFileBase(name, start, end), '.mp4');
  const tmp = out + '.part.mp4';
  const r = await run(ffmpeg, segmentArgs(url.split('#')[0], start, end, tmp));
  if (!r.ok) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return r;
  }
  fs.renameSync(tmp, out);
  return { ok: true, path: out };
}

/* ── 下载完整原片（用户明确要求时） ── */
function downloadFile(url, dest, { get, maxRedirects = 6, onProgress } = {}) {
  const getter = get || (u => (u.startsWith('https:') ? require('node:https') : require('node:http')).get(u));
  return new Promise(resolve => {
    const go = (u, left) => {
      let req;
      try {
        req = getter(u);
      } catch (e) {
        resolve({ ok: false, error: String(e.message || e) });
        return;
      }
      req.on('response', res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
          res.resume();
          go(new URL(res.headers.location, u).href, left - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ ok: false, error: `下载失败：HTTP ${res.statusCode}` });
          return;
        }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        const tmp = dest + '.part';
        const f = fs.createWriteStream(tmp);
        res.on('data', d => {
          got += d.length;
          if (onProgress) onProgress(got, total);
        });
        res.pipe(f);
        f.on('finish', () => {
          f.close(() => {
            fs.renameSync(tmp, dest);
            resolve({ ok: true, path: dest, bytes: got });
          });
        });
        const fail = e => {
          try {
            fs.rmSync(tmp, { force: true });
          } catch {}
          resolve({ ok: false, error: String((e && e.message) || e) });
        };
        res.on('error', fail);
        f.on('error', fail);
      });
      req.on('error', e => resolve({ ok: false, error: String(e.message || e) }));
    };
    go(url, maxRedirects);
  });
}
async function downloadOriginal({ url, dir, name }, opts = {}) {
  if (!isHttpUrl(url)) return { ok: false, error: '只支持在线视频链接' };
  if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir)) return { ok: false, error: '保存位置不存在，请重新选择' };
  const clean = url.split('#')[0];
  const ext = (path.extname(new URL(clean).pathname) || '.mp4').toLowerCase().slice(0, 6);
  const dest = uniquePath(dir, `${safeName(name)}_完整原片`, ext);
  return downloadFile(clean, dest, opts);
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
  if (write) write(file, text);
  else {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  }
  return { ok: true, updated: n };
}

module.exports = {
  CANDIDATE_TYPE,
  safeName,
  uniquePath,
  segmentFileBase,
  findFfmpeg,
  segmentArgs,
  saveSegment,
  downloadFile,
  downloadOriginal,
  writeReview,
};
