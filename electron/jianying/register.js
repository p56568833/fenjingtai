/* root_meta_info.json 索引的安全写入：先读、备份、校验、只追加本次条目、写临时文件后原子替换；
   写入前再读一次检测外部变更；索引不可解析、结构不认识、剪映正在运行或已存在同目录条目时一律停手。
   不改动其他草稿条目和未知字段（只改 all_draft_store 数组本身）。 */
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const paths = require('./paths');
const validate = require('./validate');
const meta = require('./meta');

const stampOf = now => {
  const ts = typeof now === 'function' ? now() : Number(now);
  const date = new Date(Number.isFinite(ts) && ts > 0 ? ts : Date.now());
  const pad = n => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${Math.random().toString(36).slice(2, 8)}`
  );
};

function readIndex({ indexFile, fs = nodeFs, path = nodePath } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(indexFile, 'utf8');
  } catch (error) {
    const errorMessage =
      error?.code === 'ENOENT' ? '没有找到剪映草稿库索引（root_meta_info.json）' : '剪映草稿库索引读不出来';
    return { ok: false, error: errorMessage };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, error: '剪映草稿库索引无法解析，未做任何修改' };
  }
  const issues = validate.validateIndexDoc(doc);
  if (issues.some(item => item.level === validate.BLOCK))
    return { ok: false, error: issues.find(item => item.level === validate.BLOCK).message, issues };
  return { ok: true, raw, doc, indexFile };
}

/* 草稿里的素材总大小（剪映索引里 draft_timeline_materials_size 对应 Resources 的字节数） */
function draftMaterialsSize({ draftDir, fs = nodeFs, path = nodePath } = {}) {
  const root = paths.draftResourcesDir(draftDir);
  let total = 0;
  const walk = dir => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.slice(0, 50000)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(file).size;
        } catch {}
      }
    }
  };
  walk(root);
  return total;
}

/* 从已经生成好的草稿目录反推一条索引（退出剪映后补登记走这里） */
function entryFromDraftDir({ draftRoot, draftDir, now = Date.now, fs = nodeFs, path = nodePath } = {}) {
  const infoFile = path.join(draftDir, 'draft_info.json');
  let doc;
  try {
    const text = fs.readFileSync(infoFile, 'utf8');
    doc = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: '这个草稿的 draft_info.json 不是明文（剪映打开后会加密），无法自动补登记；请从分镜台重新导出',
    };
  }
  if (!doc || typeof doc.id !== 'string' || !doc.id || !Number.isInteger(doc.duration))
    return { ok: false, error: '草稿文件不完整，无法补登记' };
  const name = typeof doc.name === 'string' && doc.name ? doc.name : path.basename(draftDir);
  const nowUs = typeof now === 'function' ? now() : now;
  const draft = { id: doc.id, name, dir: draftDir, root: draftRoot };
  return {
    ok: true,
    entry: meta.buildIndexEntry({
      draft,
      durationUs: doc.duration,
      materialsSize: draftMaterialsSize({ draftDir, fs, path }),
      nowUs,
    }),
  };
}

/* 原子写索引：备份原文件 → 写同目录临时文件 → 再读一次确认没被外部改动 → 替换 */
function writeIndexAtomic({ indexFile, raw, nextRaw, backupDir, now = Date.now, fs = nodeFs, path = nodePath } = {}) {
  let backupPath;
  const backupRoot = backupDir || path.dirname(indexFile);
  const backupName = backupDir
    ? `root_meta_info-${stampOf(now)}.json`
    : `root_meta_info.fenjingtai-backup-${stampOf(now)}.json`;
  try {
    fs.mkdirSync(backupRoot, { recursive: true });
    backupPath = path.join(backupRoot, backupName);
    fs.writeFileSync(backupPath, raw, 'utf8');
  } catch {
    return { ok: false, error: '无法备份剪映草稿库索引，已停止登记（未修改任何索引内容）' };
  }
  const tmp = `${indexFile}.fenjingtai-${Math.random().toString(36).slice(2, 10)}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, nextRaw, 'utf8');
    fs.fsyncSync(fd);
  } catch {
    try {
      fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
    } catch {}
    return { ok: false, error: '临时索引文件写不进去，已停止登记（未修改任何索引内容）' };
  }
  try {
    fs.closeSync(fd);
  } catch {}
  let current;
  try {
    current = fs.readFileSync(indexFile, 'utf8');
  } catch {
    current = null;
  }
  if (current !== raw) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return { ok: false, conflict: true, error: '剪映草稿库索引在导出期间被改动，已停止登记并保留新草稿' };
  }
  try {
    fs.renameSync(tmp, indexFile);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return { ok: false, error: '草稿库索引替换失败，已停止登记并保留新草稿' };
  }
  return { ok: true, backupPath };
}

/* 把一个已生成的草稿目录登记进剪映草稿库；返回 { ok, registered, error?, backupPath?, already? } */
function registerDraft({
  draftRoot,
  draftDir,
  backupDir = '',
  running = false,
  now = Date.now,
  fs = nodeFs,
  path = nodePath,
} = {}) {
  if (!paths.isAbsolutePath(draftRoot) || !paths.isAbsolutePath(draftDir))
    return { ok: false, registered: false, error: '草稿路径无效' };
  if (!paths.insideDir(draftRoot, draftDir)) return { ok: false, registered: false, error: '草稿目录不在剪映草稿库里' };
  if (running) return { ok: false, registered: false, needsQuit: true, error: '剪映正在运行，退出剪映后再加入草稿库' };
  let stat = null;
  try {
    stat = fs.statSync(draftDir);
  } catch {}
  if (!stat?.isDirectory()) return { ok: false, registered: false, error: '草稿目录不存在' };

  const nowUs = typeof now === 'function' ? now() : now;
  const indexFile = paths.indexFileFor(draftRoot);
  const index = readIndex({ indexFile, fs, path });
  if (!index.ok) return { ok: false, registered: false, error: index.error };

  const built = entryFromDraftDir({ draftRoot, draftDir, now: nowUs, fs, path });
  if (!built.ok) return { ok: false, registered: false, error: built.error };
  const entry = built.entry;

  const sameId = index.doc.all_draft_store.find(item => item?.draft_id === entry.draft_id);
  if (sameId) return { ok: true, registered: true, already: true };
  const sameDir = index.doc.all_draft_store.find(item => item?.draft_fold_path === draftDir);
  if (sameDir)
    return {
      ok: false,
      registered: false,
      error: '草稿库索引里已经有指向这个目录的条目，未做修改',
    };

  const next = { ...index.doc, all_draft_store: [entry, ...index.doc.all_draft_store] };
  const written = writeIndexAtomic({
    indexFile,
    raw: index.raw,
    nextRaw: JSON.stringify(next),
    backupDir,
    now: nowUs,
    fs,
    path,
  });
  if (!written.ok) return { ok: false, registered: false, error: written.error, conflict: written.conflict };
  return { ok: true, registered: true, backupPath: written.backupPath };
}

module.exports = {
  readIndex,
  writeIndexAtomic,
  entryFromDraftDir,
  draftMaterialsSize,
  registerDraft,
};
