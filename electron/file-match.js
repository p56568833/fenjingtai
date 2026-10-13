/* 按内容认文件（不看文件名、不存记录）：协作时对方电脑上的素材，这台电脑上是不是已经有一份。
   · 指纹：文件大小 + 开头 1 MB + 结尾 1 MB 算 SHA-256，几 G 的视频也是一瞬间；内容一样指纹就一样，改名、挪位置都不影响。
   · 找：遍历文件夹（含所有子文件夹），先只看大小，一字节不差的才读内容算指纹。
   不依赖 Electron，主进程测试里直接 require。 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 1024 * 1024;

async function fingerprint(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('不是文件');
    const hash = crypto.createHash('sha256').update(`${st.size}:`);
    const read = async (pos, len) => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      hash.update(buf.subarray(0, bytesRead));
    };
    if (st.size <= EDGE * 2) await read(0, st.size);
    else {
      await read(0, EDGE);
      await read(st.size - EDGE, EDGE);
    }
    return { size: st.size, fp: hash.digest('hex') };
  } finally {
    await fh.close();
  }
}

/* wants: [{ size, fp }]；返回 { found: { 下标: 路径 }, scanned, canceled }。
   跳过隐藏文件 / 文件夹和替身（链接），不会绕圈；isCanceled() 为真就停下；onProgress(已看过几个文件) */
async function findByContent({ dirs, wants, isCanceled = () => false, onProgress = () => {} }) {
  const bySize = new Map();
  (wants || []).forEach((w, i) => {
    if (!w || !Number.isFinite(w.size) || !w.fp) return;
    if (!bySize.has(w.size)) bySize.set(w.size, []);
    bySize.get(w.size).push(i);
  });
  const found = {};
  let left = [...bySize.values()].reduce((n, l) => n + l.length, 0);
  let scanned = 0;
  let lastReport = 0;
  const seen = new Set();
  async function walk(dir) {
    if (!left || isCanceled()) return;
    let real;
    try {
      real = await fs.promises.realpath(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (!left || isCanceled()) return;
      if (d.name.startsWith('.') || d.isSymbolicLink()) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!d.isFile()) continue;
      scanned++;
      if (scanned - lastReport >= 200) {
        lastReport = scanned;
        onProgress(scanned);
      }
      let st;
      try {
        st = await fs.promises.stat(p);
      } catch {
        continue;
      }
      const idx = bySize.get(st.size)?.filter(i => !(i in found));
      if (!idx?.length) continue;
      let fp;
      try {
        ({ fp } = await fingerprint(p));
      } catch {
        continue;
      }
      for (const i of idx)
        if (wants[i].fp === fp) {
          found[i] = p;
          left--;
        }
    }
  }
  for (const dir of dirs || []) if (typeof dir === 'string' && path.isAbsolute(dir)) await walk(dir);
  onProgress(scanned);
  return { found, scanned, canceled: isCanceled() };
}

module.exports = { fingerprint, findByContent };
