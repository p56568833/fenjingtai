/* ZIP 目录解析（读 docx 的 script-reader.js 和读项目包的 project-pack.js 共用）：
   找目录结束记录 → 读中央目录 → 每个条目的名字、压缩方式、大小、本地头位置（支持 ZIP64）。 */
const MAX32 = 0xffffffff;
const EOCD_SEARCH = 65557; // 目录结束记录 22 字节 + 最长 65535 字节的注释

/* 在文件尾部那一段里倒着找目录结束记录，返回它在 tail 里的位置；找不到返回 -1 */
function findEocd(tail) {
  for (let i = tail.length - 22; i >= Math.max(0, tail.length - EOCD_SEARCH); i--)
    if (tail.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

/* 目录结束记录里的条目数和中央目录位置；有 ZIP64 定位记录时给出 ZIP64 记录的绝对位置，由调用方读出后交给 zip64Directory */
function eocdInfo(tail, eocd) {
  const locAt = eocd - 20;
  return {
    count: tail.readUInt16LE(eocd + 10),
    cdSize: tail.readUInt32LE(eocd + 12),
    cdStart: tail.readUInt32LE(eocd + 16),
    zip64At: locAt >= 0 && tail.readUInt32LE(locAt) === 0x07064b50 ? Number(tail.readBigUInt64LE(locAt + 8)) : null,
  };
}
function zip64Directory(rec) {
  if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error('ZIP64 目录损坏');
  return {
    count: Number(rec.readBigUInt64LE(32)),
    cdSize: Number(rec.readBigUInt64LE(40)),
    cdStart: Number(rec.readBigUInt64LE(48)),
  };
}

function parseCentralDirectory(cd, count) {
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
  return out;
}

/* 本地文件头之后才是数据：头 30 字节 + 文件名 + 附加字段 */
const localDataStart = (header, local) => {
  if (header.readUInt32LE(0) !== 0x04034b50) return -1;
  return local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
};

module.exports = { MAX32, EOCD_SEARCH, findEocd, eocdInfo, zip64Directory, parseCentralDirectory, localDataStart };
