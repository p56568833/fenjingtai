/* 导出用文件工具：复制素材（可取消 / 按块回报）、暂存目录所有权标记与清理、目录体积统计。
   所有权规则：只有带合法标记（owner=fenjingtai 且未提交）的本应用暂存目录才能删；
   没有标记或已提交的目录是别人的 / 用户的成果，一律不动。 */
'use strict';

const { pipeline } = require('node:stream/promises');
const paths = require('./paths');

const STALE_STAGING_MS = 6 * 60 * 60 * 1000;
const CANCELED = 'canceled';

const canceledError = () => Object.assign(new Error('已取消'), { code: CANCELED, canceled: true });
const exportError = (code, message) => Object.assign(new Error(message), { code });

function mapCopyError(error) {
  if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT')
    return exportError('disk-full', '复制素材时磁盘空间不足，导出已停止，没有留下草稿');
  if (error?.code === CANCELED || error?.name === 'AbortError') return canceledError();
  return new Error(`复制素材失败：${error?.message || error}`);
}

/* 目标父目录里的空闲字节；读不到（权限 / 不支持的 fs）返回 null，不当作磁盘满 */
const freeBytesFor =
  ({ fs } = {}) =>
  dir => {
    try {
      const stat = fs.statfsSync(dir);
      return stat.bavail * stat.bsize;
    } catch {
      return null;
    }
  };

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

module.exports = {
  STALE_STAGING_MS,
  copyWithProgress,
  freeBytesFor,
  writeOwnerMarker,
  cleanupOwnedStaging,
  cleanupStaleStaging,
  sumDirBytes,
};
