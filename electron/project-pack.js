/* 项目打包（主进程用，纯 Node，便于单测）：把项目 JSON 和用到的本地素材装进一个 ZIP，或者从 ZIP 里解出来。
   - 写：不压缩（视频本来就压缩过，再压只会更慢），边读边算 CRC，大文件 / 文件多时自动用 ZIP64；
     先写到 .part，写完才改名，取消或出错不留半截文件
   - 读：自己解析目录，支持不压缩和 deflate（别人用访达重新压过的也能读）；
     只解到指定文件夹里：绝对路径、「..」、符号链接一律拒绝；校验 CRC 和大小
   - 进度按字节回报；用 AbortSignal 取消 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

/* 打包里的项目文件名：导入时靠它认出这是分镜台的项目包 */
const PROJECT_ENTRY = '分镜台项目.json';
const CHUNK = 4 * 1024 * 1024;
const MAX32 = 0xffffffff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
/* zlib.crc32 是原生实现（Node 22.2+）；老版本退回查表 */
function crc32(buf, prev = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, prev);
  let c = (prev ^ MAX32) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ MAX32) >>> 0;
}

function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const abortError = () => Object.assign(new Error('已取消'), { canceled: true });
const checkAbort = signal => {
  if (signal?.aborted) throw abortError();
};

/* 包内路径：统一用 /，不能是绝对路径，不能有 . / .. 段、反斜杠和控制字符 */
function safeEntryName(name) {
  const s = String(name || '');
  // eslint-disable-next-line no-control-regex -- 控制字符本来就是要拒绝的
  if (!s || s.length > 1024 || /[\\\u0000-\u001f]/.test(s) || s.startsWith('/')) return null;
  const parts = s.split('/');
  const isDir = s.endsWith('/');
  const segs = isDir ? parts.slice(0, -1) : parts;
  if (!segs.length || segs.some(p => !p || p === '.' || p === '..')) return null;
  return s;
}

/* ── 写 ZIP ──
   entries: [{ name, data }]（data 是字符串 / Buffer）或 [{ name, file }]（本地文件，按块读）
   onProgress(done, total)：按字节；forceZip64 只给测试用 */
async function writeZip(zipPath, entries, { onProgress, signal, forceZip64 = false, now = new Date() } = {}) {
  if (typeof zipPath !== 'string' || !path.isAbsolute(zipPath)) throw new Error('保存位置无效');
  const list = [];
  for (const e of entries || []) {
    const name = safeEntryName(e?.name);
    if (!name || name.endsWith('/')) throw new Error(`包内文件名不合法：${e?.name}`);
    if (e.file != null) {
      const st = await fsp.stat(e.file).catch(() => null);
      if (!st || !st.isFile()) throw new Error(`找不到文件：${e.file}`);
      list.push({ name, file: e.file, size: st.size });
    } else {
      const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
      list.push({ name, data, size: data.length });
    }
  }
  const seen = new Set();
  for (const e of list) {
    if (seen.has(e.name)) throw new Error(`包内有重名文件：${e.name}`);
    seen.add(e.name);
  }
  const total = list.reduce((s, e) => s + e.size, 0);
  const part = zipPath + '.part';
  const fh = await fsp.open(part, 'w');
  const { time, date } = dosTime(now);
  let offset = 0,
    done = 0,
    lastTick = 0;
  const tick = (force = false) => {
    const t = Date.now();
    if (onProgress && (force || t - lastTick > 100)) {
      lastTick = t;
      onProgress(done, total);
    }
  };
  const write = async buf => {
    await fh.write(buf, 0, buf.length, offset);
    offset += buf.length;
  };
  const central = [];
  try {
    for (const e of list) {
      checkAbort(signal);
      const nameBuf = Buffer.from(e.name, 'utf8');
      const big = forceZip64 || e.size >= MAX32;
      const headerAt = offset;
      const extra = big ? Buffer.alloc(20) : Buffer.alloc(0);
      if (big) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(16, 2);
        extra.writeBigUInt64LE(BigInt(e.size), 4);
        extra.writeBigUInt64LE(BigInt(e.size), 12);
      }
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(big ? 45 : 20, 4);
      local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
      local.writeUInt16LE(0, 8); // 不压缩
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(0, 14); // CRC 写完数据再回填
      local.writeUInt32LE(big ? MAX32 : e.size, 18);
      local.writeUInt32LE(big ? MAX32 : e.size, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(extra.length, 28);
      await write(Buffer.concat([local, nameBuf, extra]));
      let crc = 0;
      if (e.data) {
        crc = crc32(e.data);
        await write(e.data);
        done += e.size;
      } else {
        const src = await fsp.open(e.file, 'r');
        try {
          const buf = Buffer.allocUnsafe(CHUNK);
          let got = 0;
          for (;;) {
            checkAbort(signal);
            const { bytesRead } = await src.read(buf, 0, CHUNK, got);
            if (!bytesRead) break;
            const chunk = buf.subarray(0, bytesRead);
            crc = crc32(chunk, crc);
            await write(chunk);
            got += bytesRead;
            done += bytesRead;
            tick();
          }
          if (got !== e.size) throw new Error(`打包期间文件被改动了：${e.file}`);
        } finally {
          await src.close();
        }
      }
      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32LE(crc >>> 0, 0);
      await fh.write(crcBuf, 0, 4, headerAt + 14);
      central.push({ nameBuf, size: e.size, crc: crc >>> 0, headerAt });
      tick();
    }
    checkAbort(signal);
    const cdStart = offset;
    for (const c of central) {
      const needSize = forceZip64 || c.size >= MAX32;
      const needOff = forceZip64 || c.headerAt >= MAX32;
      const fields = [];
      if (needSize) fields.push(c.size, c.size);
      if (needOff) fields.push(c.headerAt);
      const extra = Buffer.alloc(fields.length ? 4 + 8 * fields.length : 0);
      if (fields.length) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8 * fields.length, 2);
        fields.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
      }
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE((3 << 8) | 45, 4); // Unix 生成
      h.writeUInt16LE(fields.length ? 45 : 20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(time, 12);
      h.writeUInt16LE(date, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(needSize ? MAX32 : c.size, 20);
      h.writeUInt32LE(needSize ? MAX32 : c.size, 24);
      h.writeUInt16LE(c.nameBuf.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt16LE(0, 32);
      h.writeUInt16LE(0, 34);
      h.writeUInt16LE(0, 36);
      h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 普通文件 rw-r--r--
      h.writeUInt32LE(needOff ? MAX32 : c.headerAt, 42);
      await write(Buffer.concat([h, c.nameBuf, extra]));
    }
    const cdSize = offset - cdStart;
    const zip64 = forceZip64 || central.length >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
    if (zip64) {
      const recAt = offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(0x06064b50, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE((3 << 8) | 45, 12);
      rec.writeUInt16LE(45, 14);
      rec.writeUInt32LE(0, 16);
      rec.writeUInt32LE(0, 20);
      rec.writeBigUInt64LE(BigInt(central.length), 24);
      rec.writeBigUInt64LE(BigInt(central.length), 32);
      rec.writeBigUInt64LE(BigInt(cdSize), 40);
      rec.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(recAt), 8);
      loc.writeUInt32LE(1, 16);
      await write(Buffer.concat([rec, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(zip64 ? 0xffff : central.length, 8);
    end.writeUInt16LE(zip64 ? 0xffff : central.length, 10);
    end.writeUInt32LE(zip64 ? MAX32 : cdSize, 12);
    end.writeUInt32LE(zip64 ? MAX32 : cdStart, 16);
    await write(end);
    await fh.sync();
    await fh.close();
    await fsp.rename(part, zipPath);
    tick(true);
    return { ok: true, path: zipPath, bytes: offset, files: list.length };
  } catch (err) {
    await fh.close().catch(() => {});
    await fsp.rm(part, { force: true }).catch(() => {});
    throw err;
  }
}

/* ── 读 ZIP 目录 ── */
async function readZipIndex(zipPath) {
  const fh = await fsp.open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557 + 20);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdStart = tail.readUInt32LE(eocd + 16);
    const locAt = eocd - 20;
    if (locAt >= 0 && tail.readUInt32LE(locAt) === 0x07064b50) {
      const recAt = Number(tail.readBigUInt64LE(locAt + 8));
      const rec = Buffer.alloc(56);
      await fh.read(rec, 0, 56, recAt);
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error('ZIP64 目录损坏');
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdStart = Number(rec.readBigUInt64LE(48));
    }
    if (cdStart + cdSize > size) throw new Error('ZIP 目录损坏');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdStart);
    const out = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 目录损坏');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const ext = cd.readUInt32LE(p + 38);
      let local = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      let q = p + 46 + nameLen;
      const extraEnd = q + extraLen;
      while (q + 4 <= extraEnd) {
        const id = cd.readUInt16LE(q),
          len = cd.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (usize === MAX32) ((usize = Number(cd.readBigUInt64LE(r))), (r += 8));
          if (csize === MAX32) ((csize = Number(cd.readBigUInt64LE(r))), (r += 8));
          if (local === MAX32) local = Number(cd.readBigUInt64LE(r));
        }
        q += 4 + len;
      }
      const mode = (ext >>> 16) & 0o170000;
      out.push({
        name,
        method,
        crc,
        csize,
        usize,
        local,
        encrypted: !!(flags & 1),
        dir: name.endsWith('/') || mode === 0o040000,
        symlink: mode === 0o120000,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: out, size };
  } finally {
    await fh.close();
  }
}

async function dataOffset(fh, entry) {
  const h = Buffer.alloc(30);
  await fh.read(h, 0, 30, entry.local);
  if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP 内部结构损坏：${entry.name}`);
  return entry.local + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
}

/* 读出一个小文件（项目 JSON）到内存 */
async function readZipText(zipPath, entry, limit = 64 * 1024 * 1024) {
  if (entry.usize > limit) throw new Error('项目文件太大');
  const fh = await fsp.open(zipPath, 'r');
  try {
    const start = await dataOffset(fh, entry);
    const buf = Buffer.alloc(entry.csize);
    await fh.read(buf, 0, entry.csize, start);
    const data = entry.method === 0 ? buf : entry.method === 8 ? zlib.inflateRawSync(buf) : null;
    if (!data) throw new Error('不支持的压缩方式');
    if (crc32(data) >>> 0 !== entry.crc >>> 0) throw new Error('项目文件校验失败，压缩包可能损坏');
    return data.toString('utf8');
  } finally {
    await fh.close();
  }
}

/* 看一眼压缩包：认出项目文件、包内根目录（打包时外面套了一层文件夹）、要解出来的文件和总大小 */
async function inspectPack(zipPath) {
  if (typeof zipPath !== 'string' || !path.isAbsolute(zipPath)) throw new Error('路径无效');
  const { entries } = await readZipIndex(zipPath);
  const proj = entries
    .filter(e => !e.dir && (e.name === PROJECT_ENTRY || e.name.endsWith('/' + PROJECT_ENTRY)))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
  if (!proj) throw new Error('这个压缩包里没有分镜台项目（缺少「分镜台项目.json」）');
  const root = proj.name.slice(0, proj.name.length - PROJECT_ENTRY.length); // '' 或 '某文件夹/'
  const files = entries.filter(e => !e.dir && e.name.startsWith(root) && !skipEntry(e.name));
  for (const e of files) {
    if (!safeEntryName(e.name)) throw new Error(`压缩包里有不安全的路径：${e.name}`);
    if (e.symlink) throw new Error(`压缩包里有符号链接，不导入：${e.name}`);
    if (e.encrypted) throw new Error('压缩包加了密码，不能导入');
    if (e.method !== 0 && e.method !== 8) throw new Error(`不支持的压缩方式：${e.name}`);
  }
  const text = await readZipText(zipPath, proj);
  return { root, project: text, files, bytes: files.reduce((s, e) => s + e.usize, 0) };
}
const skipEntry = name => /(^|\/)__MACOSX\//.test(name) || /(^|\/)\.DS_Store$/.test(name);

/* 解压到 destDir（必须是新建的空文件夹）：只解 root 下面的文件，去掉 root 前缀 */
async function extractPack(zipPath, destDir, { onProgress, signal } = {}) {
  const info = await inspectPack(zipPath);
  const base = path.resolve(destDir);
  const total = info.bytes;
  let done = 0,
    lastTick = 0;
  const tick = (force = false) => {
    const t = Date.now();
    if (onProgress && (force || t - lastTick > 100)) {
      lastTick = t;
      onProgress(done, total);
    }
  };
  const fh = await fsp.open(zipPath, 'r');
  try {
    for (const e of info.files) {
      checkAbort(signal);
      const rel = e.name.slice(info.root.length);
      const dest = path.resolve(base, ...rel.split('/'));
      if (dest !== base && !dest.startsWith(base + path.sep)) throw new Error(`压缩包里有不安全的路径：${e.name}`);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const start = await dataOffset(fh, e);
      let crc = 0,
        written = 0;
      const out = fs.createWriteStream(dest, { flags: 'wx' });
      if (e.csize === 0) {
        // 空文件：读取流的 end 会小于 start（Node 直接报参数越界），不读，直接建空文件
        await new Promise((res, rej) => out.end(err => (err ? rej(err) : res())));
        if (e.usize !== 0 || e.crc >>> 0 !== 0) throw new Error(`文件校验失败，压缩包可能损坏：${rel}`);
        continue;
      }
      const reader = fh.createReadStream({ start, end: start + e.csize - 1, autoClose: false, highWaterMark: CHUNK });
      const check = new Transform({
        transform(chunk, _enc, cb) {
          if (signal?.aborted) return cb(abortError());
          crc = crc32(chunk, crc);
          written += chunk.length;
          done += chunk.length;
          tick();
          cb(null, chunk);
        },
      });
      await pipeline(reader, ...(e.method === 8 ? [zlib.createInflateRaw()] : []), check, out, { signal });
      if (written !== e.usize || crc >>> 0 !== e.crc >>> 0) throw new Error(`文件校验失败，压缩包可能损坏：${rel}`);
    }
    tick(true);
    return { ok: true, dir: base, project: info.project, files: info.files.length, bytes: total };
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') throw abortError();
    throw err;
  } finally {
    await fh.close();
  }
}

/* 不重名的新文件夹：项目名 → 项目名 (2) … */
function uniqueDir(parent, name) {
  let p = path.join(parent, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(parent, `${name} (${i})`);
  return p;
}

/* 一组本地文件的大小（打包前统计用） */
async function fileSizes(paths) {
  const out = {};
  for (const p of paths || []) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
    try {
      const st = await fsp.stat(p);
      out[p] = st.isFile() ? { exists: true, size: st.size } : { exists: false };
    } catch {
      out[p] = { exists: false };
    }
  }
  return out;
}

/* 磁盘剩余空间（字节）；拿不到就返回 null，不拦着 */
function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

module.exports = {
  PROJECT_ENTRY,
  crc32,
  safeEntryName,
  writeZip,
  readZipIndex,
  inspectPack,
  extractPack,
  uniqueDir,
  fileSizes,
  freeBytes,
};
