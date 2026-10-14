/* 本机异常记录：固定一个小文件，不启用崩溃转储或上传；写日志失败不能影响应用。 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_RECORDS = 20;
const MAX_BYTES = 256 * 1024;
const MAX_TEXT = 8192;
const WINDOW_MS = 60 * 1000;
const MAX_WRITES = 10;
const abnormalReason = reason => !['clean-exit', 'normal-exit'].includes(reason);
const text = value => {
  try {
    return String(value ?? '').slice(0, MAX_TEXT);
  } catch {
    return '[无法读取异常信息]';
  }
};
function errorInfo(error) {
  try {
    return { message: text(error?.message ?? error), stack: text(error?.stack) };
  } catch {
    return { message: '[无法读取异常信息]', stack: '' };
  }
}

function createCrashLog({ dir, version, now = Date.now }) {
  const file = path.join(dir, '崩溃记录.json');
  const sessionFile = path.join(dir, '运行状态.json');
  const pending = file + '.tmp';
  let records = [];
  let writes = [];
  let session = null;
  let error = '';
  function bounded(items) {
    const kept = items.slice(-MAX_RECORDS);
    while (Buffer.byteLength(JSON.stringify(kept)) > MAX_BYTES) kept.shift();
    return kept;
  }
  function save(items) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const kept = bounded(items);
      fs.writeFileSync(pending, JSON.stringify(kept), { mode: 0o600 });
      fs.renameSync(pending, file);
      records = kept;
      error = '';
      return true;
    } catch (e) {
      error = text(e.message);
      try {
        fs.rmSync(pending, { force: true });
      } catch {}
      return false;
    }
  }
  function readSmall(name, limit) {
    if (fs.statSync(name).size > limit) throw new Error('记录文件超过大小限制');
    return JSON.parse(fs.readFileSync(name, 'utf8'));
  }
  function record(kind, info = {}, { fatal = false, recordedVersion = version } = {}) {
    try {
      const t = now();
      const entry = {
        time: new Date(t).toISOString(),
        version: text(recordedVersion),
        platform: process.platform,
        arch: process.arch,
        kind: text(kind),
        message: text(info.message),
        stack: text(info.stack),
      };
      // 同一异常一分钟内只记一次，连续不同异常一分钟最多写十次。
      // 为致命异常额外预留一次写入，错误风暴时也能留下退出线索。
      if (
        records.some(
          r =>
            t - Date.parse(r.time) < WINDOW_MS &&
            r.kind === entry.kind &&
            r.message === entry.message &&
            r.stack === entry.stack,
        )
      ) {
        if (fatal) markFatal();
        return true;
      }
      writes = writes.filter(at => t - at < WINDOW_MS);
      if (writes.length >= MAX_WRITES + (fatal ? 1 : 0)) return false;
      writes.push(t); // 失败也计入限流，磁盘不可写时不会连续重试。
      const ok = save([...records, entry]);
      if (fatal && ok) markFatal();
      return ok;
    } catch {
      return false;
    }
  }
  function markFatal() {
    if (!session || session.fatalRecorded) return;
    session.fatalRecorded = true;
    try {
      fs.writeFileSync(sessionFile, JSON.stringify(session), { mode: 0o600 });
    } catch {}
  }
  function start() {
    try {
      fs.rmSync(pending, { force: true });
    } catch {}
    try {
      const loaded = readSmall(file, MAX_BYTES);
      if (Array.isArray(loaded)) records = bounded(loaded.filter(r => r && typeof r === 'object'));
    } catch (e) {
      if (e.code !== 'ENOENT') error = text(e.message);
    }
    try {
      const previous = readSmall(sessionFile, MAX_TEXT);
      if (previous && !previous.fatalRecorded)
        record(
          'abnormal-exit',
          {
            message: `上次未正常退出（启动于 ${text(previous.startedAt)}）。可能发生崩溃、强制退出或断电，无法确定原因。`,
          },
          { fatal: true, recordedVersion: previous.version },
        );
    } catch {}
    session = { startedAt: new Date(now()).toISOString(), version, fatalRecorded: false };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify(session), { mode: 0o600 });
    } catch (e) {
      error = text(e.message);
    }
  }
  function finish() {
    try {
      fs.rmSync(sessionFile, { force: true });
    } catch {}
  }
  function clear() {
    if (!save([])) return { ok: false, error };
    writes = [];
    return { ok: true };
  }
  return {
    start,
    finish,
    record,
    clear,
    list: () => ({ records: [...records].reverse(), error, maxRecords: MAX_RECORDS, maxBytes: MAX_BYTES }),
  };
}

function monitorCrashes({ app, log, processEvents = process }) {
  // monitor 只观察，不吞掉原本的致命异常，也不改变 Electron 的异常处理。
  processEvents.on('uncaughtExceptionMonitor', (error, origin) => {
    log.record(
      'main-exception',
      { ...errorInfo(error), message: `${text(origin)}: ${errorInfo(error).message}` },
      { fatal: true },
    );
  });
  processEvents.on('unhandledRejection', error => log.record('main-rejection', errorInfo(error)));
  app.on('render-process-gone', (_event, _contents, details) => {
    if (abnormalReason(details.reason))
      log.record('renderer-crash', { message: `${text(details.reason)} · 退出码 ${text(details.exitCode)}` });
  });
  app.on('child-process-gone', (_event, details) => {
    if (abnormalReason(details.reason))
      log.record('child-crash', {
        message: `${text(details.type)} ${text(details.name || details.serviceName)} · ${text(details.reason)} · 退出码 ${text(details.exitCode)}`,
      });
  });
  // 只有真正退出才清标记：before-quit 可能被未保存的项目取消。
  app.on('quit', (_event, exitCode) => {
    if (exitCode === 0) log.finish();
  });
}

module.exports = { createCrashLog, monitorCrashes, errorInfo, MAX_BYTES, MAX_RECORDS };
