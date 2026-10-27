/* 应用内更新的通道：检查、下载校验、取消、退出时换上新版 */
const { app, net } = require('electron');
// Electron 里 fs 会把 .asar 当成文件夹；换应用、写 app.asar、删临时文件夹都要按普通文件处理
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const updater = require('./updater');

/* 返回 cleanStaleUpdates：启动时清掉上次没装完的临时文件夹 */
function registerUpdateIpc({ handle, isSelftest }) {
  /* ── 应用内更新：查 GitHub 最新版 → 下载并校验 → 退出时换上新版、自动重新打开（见 updater.js） ── */
  const update = { info: null, ctl: null, prepared: null, installing: false };
  const sendUpdate = (e, payload) => {
    if (!e.sender.isDestroyed()) e.sender.send('update:progress', payload);
  };
  const whereInstalled = () => updater.installTarget(app.getPath('exe'), { isPackaged: app.isPackaged });
  /* 上次没装完留下的临时文件夹（下载好了但没重启就关了应用）：启动时清掉 */
  function cleanStaleUpdates() {
    const where = whereInstalled();
    if (!where.ok) return;
    try {
      for (const f of fs.readdirSync(where.parent))
        if (f.startsWith('.分镜台-更新-') || f.startsWith('.分镜台-替换下来-'))
          fs.rmSync(path.join(where.parent, f), { recursive: true, force: true });
    } catch {}
  }
  handle('update:check', async (_e, { auto = false } = {}) => {
    const current = app.getVersion();
    // 开发版 / 自测不在启动时自动联网检查（手动「检查更新…」照常可以看）
    if (auto && (!app.isPackaged || isSelftest)) return { ok: true, available: false, skipped: true, current };
    const where = whereInstalled();
    const runtime = where.ok ? updater.readRuntime(where.app) : '';
    const r = await updater.checkForUpdate({ current, arch: process.arch, runtime, fetchImpl: net.fetch });
    if (r.ok && r.available) update.info = r;
    return {
      ...r,
      // 能走增量时显示增量包的大小（约 1 MB），不再显示完整安装包的大小
      size: r.patch?.size || r.size,
      delta: !!r.patch,
      current,
      canInstall: where.ok && !!(r.url || r.patch),
      reason: where.ok
        ? r.available && !r.url && !r.patch
          ? '这一版没有适合这台电脑的更新包，请到下载页面下载'
          : ''
        : where.reason,
      ready: !!update.prepared && update.prepared.version === r.version,
    };
  });
  handle('update:download', async e => {
    const info = update.info;
    if (!info?.url && !info?.patch) return { ok: false, error: '没有可下载的更新包' };
    const where = whereInstalled();
    if (!where.ok) return { ok: false, error: where.reason };
    if (update.ctl) return { ok: false, error: '正在下载更新' };
    if (update.prepared?.version === info.version) return { ok: true, version: info.version };
    const ctl = new AbortController();
    update.ctl = ctl;
    const dir = fs.mkdtempSync(path.join(app.getPath('temp'), '分镜台更新-'));
    const onProgress = (got, total) => sendUpdate(e, { phase: 'download', got, total });
    try {
      let p = null;
      let verified = false;
      // ① 增量：只下应用代码（约 1 MB），套在当前应用上；任何一步不成就退回完整安装包
      if (info.patch) {
        const d = await updater.downloadUpdate(info.patch, path.join(dir, updater.PATCH_NAME), {
          fetchImpl: net.fetch,
          signal: ctl.signal,
          onProgress,
        });
        if (d.canceled) return d;
        if (d.ok) {
          sendUpdate(e, { phase: 'verify' });
          const r = updater.preparePatch(d.path, {
            parent: where.parent,
            app: where.app,
            version: info.version,
            asarSha256: info.patch.asarSha256,
          });
          if (r.ok) [p, verified] = [r, true];
          else console.warn('[更新] 增量包没用上，改下载完整安装包：', r.error);
        } else console.warn('[更新] 增量包下载失败，改下载完整安装包：', d.error);
      }
      // ② 完整安装包
      if (!p) {
        if (!info.url) return { ok: false, error: '没有可下载的更新包' };
        const d = await updater.downloadUpdate(info, path.join(dir, updater.assetName(process.arch)), {
          fetchImpl: net.fetch,
          signal: ctl.signal,
          onProgress,
        });
        if (!d.ok) return d;
        sendUpdate(e, { phase: 'verify' });
        p = updater.prepareUpdate(d.path, { parent: where.parent, version: info.version });
        if (!p.ok) return p;
        verified = d.verified;
      }
      // 之前下好的旧一版（下好后又发了新版）：换掉，临时文件夹一起清掉
      if (update.prepared && update.prepared.stage !== p.stage)
        fs.rmSync(update.prepared.stage, { recursive: true, force: true });
      update.prepared = { ...p, target: where.app, version: info.version };
      return { ok: true, version: info.version, verified };
    } finally {
      update.ctl = null;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  handle('update:cancel', () => {
    update.ctl?.abort();
    return true;
  });
  handle('update:install', () => {
    const p = update.prepared;
    if (!p || !fs.existsSync(p.app)) return { ok: false, error: '更新包不见了，请重新下载' };
    update.installing = true;
    updater.scheduleSwap({
      pid: process.pid,
      newApp: p.app,
      target: p.target,
      stage: p.stage,
      tmpDir: app.getPath('temp'),
    });
    // 先回话再退出：窗口关闭前界面会把没存完的改动同步存盘（beforeunload）
    setTimeout(() => app.quit(), 150);
    return { ok: true };
  });
  /* 下载好了但没点「重启更新」就退出：清掉放在「应用程序」里的临时新版 */
  app.on('will-quit', () => {
    if (update.prepared && !update.installing) fs.rmSync(update.prepared.stage, { recursive: true, force: true });
  });
  return { cleanStaleUpdates };
}

module.exports = { registerUpdateIpc };
