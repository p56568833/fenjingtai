/* 数据落盘（主进程用，纯 Node，便于单测）：原子写、分层保留的自动备份、损坏文件自救。
   - 备份节奏：写盘时距上次备份超过 30 分钟就顺带滚一份
   - 保留策略：最近 24 小时全留；更早的每天留最新一份，最多 30 天；总数封顶 80 份
   - 数据文件读不出来：原文件改名保留（不覆盖），自动用最近一份能读的备份顶上，并把情况告诉界面 */
const fs = require('node:fs');
const path = require('node:path');

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

function writeAtomic(file, content) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd); // 先落到磁盘再改名，断电也不会留下半截文件
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
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

  function maybeBackup(now = Date.now()) {
    if (now - lastBackupAt < BACKUP_INTERVAL) return;
    lastBackupAt = now;
    try {
      if (!fs.existsSync(LIB())) return;
      fs.mkdirSync(BACKUPS(), { recursive: true });
      fs.copyFileSync(LIB(), path.join(BACKUPS(), `备份-${stamp(now)}.json`));
      prune(now);
    } catch {
      /* 备份失败不阻塞保存 */
    }
  }

  const validLibrary = d => d && typeof d === 'object' && d.projects && typeof d.projects === 'object';

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
      loadInfo = { status: 'ok' };
      return (cache = data);
    } catch (err) {
      const kept = path.join(dataDir(), `分镜台数据.损坏-${stamp()}.json`);
      try {
        fs.renameSync(file, kept);
      } catch {
        /* 改名失败就原地留着，下面照样不覆盖它 */
      }
      for (const b of listBackups()) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(BACKUPS(), b.f), 'utf8'));
          if (!validLibrary(data) || !Object.keys(data.projects).length) continue;
          writeAtomic(file, JSON.stringify(data));
          loadInfo = {
            status: 'recovered',
            from: b.f,
            fromTime: b.t,
            kept: path.basename(kept),
            error: String(err.message || err),
          };
          return (cache = data);
        } catch {
          /* 这份备份也读不了，试下一份 */
        }
      }
      loadInfo = { status: 'corrupt', kept: path.basename(kept), error: String(err.message || err) };
      return (cache = null);
    }
  }

  /* 增量保存：渲染层只发改动过的项目（null = 删除）+ 当前项目 id / 设置 / 回收站；
     这里并进内存里的整库再整文件原子写。{ full } = 整库替换（恢复备份时）。 */
  function savePatch(patch) {
    if (!patch || typeof patch !== 'object') throw new Error('无效的保存内容');
    if (patch.full) {
      if (!validLibrary(patch.full)) throw new Error('无效的项目库');
      return save(patch.full);
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

  function save(library) {
    fs.mkdirSync(dataDir(), { recursive: true });
    maybeBackup();
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
    info: () => loadInfo,
    paths: { LIB, BACKUPS },
    _resetForTest: () => {
      loaded = false;
      cache = null;
      lastBackupAt = 0;
    },
  };
}

module.exports = { createStore, writeAtomic, retentionKeep, stamp, BACKUP_INTERVAL };
