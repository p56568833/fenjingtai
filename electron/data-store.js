/* 数据落盘（主进程用，纯 Node，便于单测）：原子写、分层保留的自动备份、损坏文件自救。
   - 备份节奏：写盘时距上次备份超过 30 分钟就顺带滚一份
   - 保留策略：最近 24 小时全留；更早的每天留最新一份，最多 30 天；总数封顶 80 份
   - 数据文件读不出来：原文件改名保留（不覆盖），自动用最近一份能读的备份顶上，并把情况告诉界面 */
const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('./fs-utils');

const BACKUP_INTERVAL = 30 * 60 * 1000;
const DAY = 24 * 3600 * 1000;
const KEEP_DAYS = 30;
const KEEP_MAX = 80;

const pad = n => String(n).padStart(2, '0');
/* 可按字典序排序的时间戳：2026-09-23 14-05-09 */
function stamp(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/* 纯函数：给定 [{f,t}] 和当前时间，返回应保留的文件名集合 */
function retentionKeep(list, now = Date.now()) {
  const sorted = [...list].sort((a, b) => b.t - a.t);
  const keep = new Set();
  const days = new Set();
  for (const b of sorted) {
    const age = now - b.t;
    if (age < DAY) {
      keep.add(b.f);
      continue;
    }
    if (age > KEEP_DAYS * DAY) continue;
    const day = new Date(b.t).toDateString();
    if (!days.has(day)) {
      days.add(day);
      keep.add(b.f);
    }
  }
  return new Set(
    sorted
      .filter(b => keep.has(b.f))
      .slice(0, KEEP_MAX)
      .map(b => b.f),
  );
}

function createStore(dataDir) {
  const LIB = () => path.join(dataDir(), '分镜台数据.json');
  const BACKUPS = () => path.join(dataDir(), '自动备份');
  let lastBackupAt = 0;
  let loadInfo = { status: 'missing' };
  let loaded = false;
  let cache = null;
  /* 损坏原件既没能改名、也没能复制保留：原路径上还是唯一一份原件，任何写入都可能把它盖掉。
     这个状态只能由 retryPreserve() 真正保留成功后解除，不随保存、重新读取或重开界面消失。 */
  let writeBlocked = false;
  let writeBlockedReason = '';

  function listBackups() {
    try {
      return fs
        .readdirSync(BACKUPS())
        .filter(f => /\.json$/i.test(f))
        .map(f => ({ f, t: fs.statSync(path.join(BACKUPS(), f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    } catch {
      return [];
    }
  }

  function prune(now = Date.now()) {
    const list = listBackups();
    const keep = retentionKeep(list, now);
    for (const { f } of list) if (!keep.has(f)) fs.rmSync(path.join(BACKUPS(), f), { force: true });
  }

  let backupError = null;
  /* force：危险操作（整库恢复等）前不管隔了多久都先滚一份 */
  function maybeBackup(now = Date.now(), { force = false } = {}) {
    if (!force && now - lastBackupAt < BACKUP_INTERVAL) return;
    try {
      if (!fs.existsSync(LIB())) return;
      fs.mkdirSync(BACKUPS(), { recursive: true });
      fs.copyFileSync(LIB(), path.join(BACKUPS(), `备份-${stamp(now)}.json`));
      lastBackupAt = now; // 复制成功才算备份过；失败了下次保存时再试，不会空等 30 分钟
      backupError = null;
      prune(now);
    } catch (e) {
      backupError = String(e?.message || e); // 备份失败不阻塞保存，但界面能看到
    }
  }

  const validLibrary = d =>
    d && typeof d === 'object' && !Array.isArray(d) && d.projects && typeof d.projects === 'object';
  /* 单个项目能不能载入：至少要有句子数组 */
  const validProject = p => p && typeof p === 'object' && Array.isArray(p.rows);
  /* 把结构坏掉的项目挪到 quarantine 里（原样保留在数据文件中，不删），其余项目照常打开 */
  function quarantineBroken(data) {
    const bad = [];
    for (const [id, p] of Object.entries(data.projects)) {
      if (validProject(p)) continue;
      data.quarantine = { ...(data.quarantine || {}), [id]: p };
      delete data.projects[id];
      bad.push((p && typeof p.title === 'string' && p.title) || id);
    }
    return bad;
  }

  /* 只在第一次读的时候做自救；之后返回内存里那份结果 */
  function load() {
    if (loaded) return cache;
    loaded = true;
    const file = LIB();
    if (!fs.existsSync(file)) {
      loadInfo = { status: 'missing' };
      return (cache = null);
    }
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!validLibrary(data)) throw new Error('文件里没有项目列表');
      const bad = quarantineBroken(data);
      if (!Object.keys(data.projects).length && bad.length) throw new Error('所有项目的结构都损坏了');
      loadInfo = bad.length ? { status: 'partial', broken: bad } : { status: 'ok' };
      return (cache = data);
    } catch (err) {
      const kept = path.join(dataDir(), `分镜台数据.损坏-${stamp()}.json`);
      let preserved = false;
      try {
        fs.renameSync(file, kept);
        preserved = true;
      } catch {
        try {
          fs.copyFileSync(file, kept); // 改名不行就复制一份
          preserved = true;
        } catch {
          /* 保留不了原件：下面不往原文件位置写，免得盖掉它 */
        }
      }
      if (!preserved) {
        // 原件还在原路径，是唯一一份：不恢复、不写入，等用户先备份或修复。
        // kept 留空——不能谎称已经保留到某个文件名下。
        writeBlocked = true;
        writeBlockedReason = '原始数据文件损坏，且无法改名或复制保留（原文件仍在原位置）；为避免覆盖，已停止写入';
        loadInfo = { status: 'corrupt', kept: '', error: writeBlockedReason, writeBlocked: true };
        return (cache = null);
      }
      for (const b of listBackups()) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(BACKUPS(), b.f), 'utf8'));
          if (!validLibrary(data)) continue;
          quarantineBroken(data);
          if (!Object.keys(data.projects).length) continue;
          writeAtomic(file, JSON.stringify(data));
          loadInfo = {
            status: 'recovered',
            from: b.f,
            fromTime: b.t,
            kept: path.basename(kept),
            error: String(err.message || err),
            writeBlocked: false,
          };
          return (cache = data);
        } catch {
          /* 这份备份也读不了，试下一份 */
        }
      }
      loadInfo = {
        status: 'corrupt',
        kept: path.basename(kept),
        error: String(err.message || err),
        writeBlocked: false,
      };
      return (cache = null);
    }
  }

  /* 增量保存：渲染层只发改动过的项目（null = 删除）+ 当前项目 id / 设置 / 回收站；
     这里并进内存里的整库再整文件原子写。{ full } = 整库替换（恢复备份时）。 */
  function savePatch(patch) {
    if (!patch || typeof patch !== 'object') throw new Error('无效的保存内容');
    if (patch.full) {
      if (!validLibrary(patch.full)) throw new Error('无效的项目库');
      // 整库替换（恢复备份）前先把现在的库备份一份，恢复错了还能回来
      const full = { ...patch.full };
      if (cache?.quarantine && !full.quarantine) full.quarantine = cache.quarantine;
      return save(full, { forceBackup: true });
    }
    const base = load() || { v: 2, projects: {} };
    const merged = { ...base, projects: { ...base.projects } };
    if (typeof patch.currentId === 'string') merged.currentId = patch.currentId;
    if (patch.settings && typeof patch.settings === 'object') merged.settings = patch.settings;
    if (patch.trash && typeof patch.trash === 'object') merged.trash = patch.trash;
    for (const [id, p] of Object.entries(patch.projects || {})) {
      if (p === null) delete merged.projects[id];
      else if (p && typeof p === 'object' && Array.isArray(p.rows)) merged.projects[id] = p;
    }
    if (!Object.keys(merged.projects).length) throw new Error('拒绝写入空的项目库');
    return save(merged);
  }

  function blockedError() {
    const error = new Error(writeBlockedReason || '原始数据文件尚未安全保留，已停止写入');
    error.code = 'DATA_WRITE_BLOCKED';
    error.blocked = true;
    return error;
  }

  /* 唯一解除写保护的入口：真的把损坏原件改名或复制保留成功，才允许继续写；
     时间经过、下一次保存或重开界面都不会自动解除。 */
  function retryPreserve() {
    if (!writeBlocked) return true;
    const file = LIB();
    if (!fs.existsSync(file)) {
      // 原件已经不在了（用户手动移走 / 修好），没有覆盖风险
      writeBlocked = false;
      writeBlockedReason = '';
      loadInfo = { ...loadInfo, kept: '', error: '原始数据文件已不在原位置，可以继续写入', writeBlocked: false };
      return true;
    }
    const kept = path.join(dataDir(), `分镜台数据.损坏-${stamp()}.json`);
    try {
      fs.renameSync(file, kept);
    } catch {
      try {
        fs.copyFileSync(file, kept);
      } catch {
        return false;
      }
    }
    writeBlocked = false;
    writeBlockedReason = '';
    loadInfo = {
      status: 'corrupt',
      kept: path.basename(kept),
      error: String(loadInfo?.error || ''),
      writeBlocked: false,
    };
    return true;
  }

  function save(library, { forceBackup = false } = {}) {
    // 唯一原件还没安全保留：所有保存入口（含全量 savePatch）都在这里被拦下
    if (writeBlocked) throw blockedError();
    fs.mkdirSync(dataDir(), { recursive: true });
    maybeBackup(Date.now(), { force: forceBackup });
    writeAtomic(LIB(), JSON.stringify(library));
    cache = library;
    loaded = true;
    return true;
  }

  /* 恢复备份：只接受备份目录里的文件名，拒绝任何路径（防 ../ 越界读） */
  function readBackup(name) {
    if (typeof name !== 'string' || name !== path.basename(name) || !/\.json$/i.test(name)) return { ok: false };
    try {
      const data = JSON.parse(fs.readFileSync(path.join(BACKUPS(), name), 'utf8'));
      return validLibrary(data) ? { ok: true, data } : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  return {
    load,
    save,
    savePatch,
    listBackups,
    readBackup,
    maybeBackup,
    prune,
    retryPreserve,
    info: () => ({
      ...loadInfo,
      writeBlocked,
      ...(writeBlocked && writeBlockedReason ? { writeBlockedReason } : {}),
      ...(backupError ? { backupError } : {}),
    }),
    paths: { LIB, BACKUPS },
    _resetForTest: () => {
      loaded = false;
      cache = null;
      lastBackupAt = 0;
    },
  };
}

module.exports = { createStore, writeAtomic, retentionKeep, stamp, BACKUP_INTERVAL };
