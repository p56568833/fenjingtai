/* 应用内更新（主进程用，纯 Node，网络请求由调用方传入，便于单测）：
   · 检查：先读最新一版 Release 里的 latest.json（github.com/<仓库>/releases/latest/download/latest.json，
     是普通文件下载，不占 GitHub API 每个公网 IP 每小时 60 次的匿名额度）；取不到再退回
     api.github.com/repos/<仓库>/releases/latest。版本号比当前新就有更新
   · 下载：按本机芯片取 FenJingTai-mac-<arch>.zip，边下边算 SHA-256，和 GitHub 给的 digest 对上才算数
   · 准备：在「应用程序」文件夹里解压到隐藏的临时位置，核对 Bundle ID、版本号、签名完整
   · 安装：写一个小脚本，等分镜台退出（数据先存盘）后两次改名换上新版、清掉旧版、再打开
   苹果官方的自动更新要求开发者签名，分镜台是 ad-hoc 签名用不了，所以这里自己做；
   用户数据在 ~/Library/Application Support/分镜台/，和应用本身分开，换应用不动数据。 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const REPO = 'p56568833/fenjingtai';
const BUNDLE_ID = 'com.andychen.fenjingtai';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const MANIFEST_NAME = 'latest.json';
const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/${MANIFEST_NAME}`;
const USER_AGENT = 'FenJingTai-Updater';
const assetName = arch => `FenJingTai-mac-${arch === 'x64' ? 'x64' : 'arm64'}.zip`;

/* "v1.10.0" / "1.10.0" → [1, 10, 0]；比较时逐段比数字（1.10 比 1.9 新） */
const parseVersion = v =>
  String(v || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map(x => parseInt(x, 10) || 0);
function compareVersions(a, b) {
  const x = parseVersion(a),
    y = parseVersion(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}

/* GitHub 的 release JSON → 这台电脑能用的更新信息（没有对应芯片的 zip 就当没有更新包） */
function pickUpdate(release, { current, arch }) {
  if (!release || typeof release !== 'object' || release.draft || release.prerelease) return { available: false };
  const version = String(release.tag_name || release.name || '').replace(/^v/i, '');
  if (!version || compareVersions(version, current) <= 0) return { available: false, latest: version };
  const asset = (release.assets || []).find(a => a && a.name === assetName(arch));
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest || '');
  return {
    available: true,
    version,
    notes: String(release.body || '').slice(0, 6000),
    page: release.html_url || RELEASES_PAGE,
    ...(asset
      ? {
          url: asset.browser_download_url,
          size: Number(asset.size) || 0,
          sha256: digest ? digest[1].toLowerCase() : '',
        }
      : { url: '', size: 0, sha256: '' }),
  };
}

/* latest.json（发版时 scripts/release-manifest.mjs 生成）→ 和 pickUpdate 一样的更新信息。
   格式：{ version, notes, page, assets: [{ name, size, sha256, url }] }；不像清单就返回 null，交给 API 再查 */
function pickManifest(manifest, { current, arch }) {
  if (!manifest || typeof manifest !== 'object') return null;
  const version = String(manifest.version || '')
    .trim()
    .replace(/^v/i, '');
  if (!/^\d+\.\d+/.test(version)) return null;
  if (compareVersions(version, current) <= 0) return { available: false, latest: version };
  const asset = (Array.isArray(manifest.assets) ? manifest.assets : []).find(a => a && a.name === assetName(arch));
  // 隔了好几版：把中间每一版的说明都带上（新的在前），一次更新到最新时知道改了什么
  const skipped = (Array.isArray(manifest.history) ? manifest.history : [])
    .filter(h => h && /^\d+\.\d+/.test(String(h.version || '')) && typeof h.notes === 'string')
    .filter(h => compareVersions(h.version, current) > 0 && compareVersions(h.version, version) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  const versions = skipped.length ? skipped.map(h => String(h.version)) : [version];
  const notes =
    skipped.length > 1
      ? skipped.map(h => `【分镜台 ${h.version}】\n${h.notes.trim()}`).join('\n\n')
      : String(manifest.notes || '');
  const url = /^https:\/\//i.test(String(asset?.url || '')) ? asset.url : '';
  const sha256 = /^[0-9a-f]{64}$/i.test(String(asset?.sha256 || '')) ? asset.sha256.toLowerCase() : '';
  return {
    available: true,
    version,
    notes: notes.slice(0, 12000),
    versions,
    page: /^https:\/\//i.test(String(manifest.page || '')) ? manifest.page : RELEASES_PAGE,
    url,
    size: url ? Number(asset.size) || 0 : 0,
    sha256: url ? sha256 : '',
  };
}

/* 带超时取 JSON；网络错误照常抛出，超时的错误带 timeout 标记 */
async function getJson(url, { fetchImpl, timeoutMs, headers = {} }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: ctl.signal });
    return { status: res.status, ok: res.ok, json: res.ok ? await res.json() : null };
  } catch (e) {
    if (ctl.signal.aborted) throw Object.assign(new Error('超时'), { timeout: true });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function checkViaApi({ current, arch, fetchImpl, timeoutMs }) {
  try {
    const r = await getJson(LATEST_API, { fetchImpl, timeoutMs, headers: { Accept: 'application/vnd.github+json' } });
    if (r.status === 404) return { ok: true, available: false, source: 'api' };
    if (r.status === 403 || r.status === 429) return { ok: false, error: 'GitHub 暂时限制了查询次数，过一会儿再试' };
    if (!r.ok) return { ok: false, error: `检查更新失败：HTTP ${r.status}` };
    return { ok: true, source: 'api', ...pickUpdate(r.json, { current, arch }) };
  } catch (e) {
    return {
      ok: false,
      error: e?.timeout ? '连不上 GitHub（超时），请检查网络或代理' : '连不上 GitHub：' + (e?.message || e),
    };
  }
}

async function checkForUpdate({ current, arch, fetchImpl, timeoutMs = 15000 }) {
  // ① latest.json：普通文件下载，不占 API 匿名额度（共用公网 IP 的 VPN / 公司网络也不会被别人用光）
  try {
    const r = await getJson(MANIFEST_URL, { fetchImpl, timeoutMs: Math.min(timeoutMs, 10000) });
    const info = r.ok ? pickManifest(r.json, { current, arch }) : null;
    if (info) return { ok: true, source: 'manifest', ...info };
  } catch {}
  // ② 取不到（老版本的 Release 没传 latest.json、网络不通、内容不对）：退回 GitHub API
  return checkViaApi({ current, arch, fetchImpl, timeoutMs });
}

/* 下载更新包：流式写临时文件、算 SHA-256；进度最多每 250 毫秒报一次；可以取消 */
async function downloadUpdate({ url, sha256, size }, dest, { fetchImpl, onProgress, signal } = {}) {
  if (!/^https:\/\//i.test(String(url || ''))) return { ok: false, error: '更新包地址无效' };
  const tmp = `${dest}.${process.pid}.part`;
  let out = null;
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal });
    if (!res.ok || !res.body) return { ok: false, error: `下载失败：HTTP ${res.status}` };
    const total = Number(res.headers?.get?.('content-length')) || size || 0;
    const hash = crypto.createHash('sha256');
    out = fs.createWriteStream(tmp);
    const reader = res.body.getReader();
    let got = 0,
      tick = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      hash.update(buf);
      got += buf.length;
      if (!out.write(buf)) await new Promise(r => out.once('drain', r));
      const now = Date.now();
      if (onProgress && now - tick >= 250) {
        tick = now;
        onProgress(got, total);
      }
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
    out = null;
    if (total && got !== total) throw new Error('下载不完整，连接中途断开了');
    const actual = hash.digest('hex');
    if (sha256 && actual !== sha256) throw new Error('更新包校验没通过（文件内容和 GitHub 上登记的不一致），已丢弃');
    fs.renameSync(tmp, dest);
    onProgress?.(got, total || got);
    return { ok: true, path: dest, bytes: got, sha256: actual, verified: !!sha256 };
  } catch (e) {
    out?.destroy();
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    if (signal?.aborted) return { ok: false, canceled: true, error: '已取消下载' };
    return { ok: false, error: String(e?.message || e) };
  }
}

/* 正在运行的应用装在哪：…/分镜台.app/Contents/MacOS/分镜台 → …/分镜台.app。
   不在「应用程序」这种能写的地方（比如直接从 dmg 或「下载」里打开、被系统隔离运行）就不能原地更新 */
function installTarget(exePath, { isPackaged = true, platform = process.platform, canWrite } = {}) {
  if (platform !== 'darwin') return { ok: false, reason: '自动更新只支持 macOS' };
  if (!isPackaged) return { ok: false, reason: '开发版本不能自动更新（用 npm run install-local）' };
  const app = path.resolve(exePath, '..', '..', '..');
  if (!app.endsWith('.app')) return { ok: false, reason: '找不到应用所在的位置' };
  if (app.includes('/AppTranslocation/'))
    return { ok: false, reason: '请先把分镜台拖进「应用程序」文件夹，从那里打开后再更新' };
  if (app.startsWith('/Volumes/')) return { ok: false, reason: '请先把分镜台从安装盘拖进「应用程序」文件夹再更新' };
  const parent = path.dirname(app);
  const writable =
    canWrite ||
    (p => {
      try {
        fs.accessSync(p, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (!writable(parent) || !writable(app))
    return { ok: false, reason: `没有权限改动「${parent}」里的分镜台，请用管理员账户更新，或手动下载安装` };
  return { ok: true, app, parent };
}

/* 解压到目标旁边的隐藏文件夹（同一个磁盘，后面改名是瞬间完成的），再核对是不是分镜台、版本对不对、签名完整 */
function prepareUpdate(zipPath, { parent, version, run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' }) }) {
  const stage = path.join(parent, `.分镜台-更新-${Date.now()}`);
  fs.mkdirSync(stage, { recursive: true });
  try {
    run('/usr/bin/ditto', ['-x', '-k', zipPath, stage]);
    const appName = fs.readdirSync(stage).find(f => f.endsWith('.app'));
    if (!appName) throw new Error('更新包里没有应用');
    const app = path.join(stage, appName);
    const plist = path.join(app, 'Contents', 'Info.plist');
    const read = key => String(run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).trim();
    if (read('CFBundleIdentifier') !== BUNDLE_ID) throw new Error('更新包不是分镜台');
    const v = read('CFBundleShortVersionString');
    if (version && compareVersions(v, version) !== 0)
      throw new Error(`更新包的版本（${v}）和发布的版本（${version}）对不上`);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    try {
      run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]); // 自己下载的，不需要系统再拦一次
    } catch {}
    return { ok: true, stage, app };
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    return { ok: false, error: String(e?.message || e) };
  }
}

/* 换上新版的小脚本：等当前进程退出（退出前界面会把没存完的改动存盘），旧的改名让开、新的改名换上；
   换不上就把旧的放回去；最后清掉临时文件夹、打开分镜台 */
const SWAP_SCRIPT = `#!/bin/bash
PID="$1"; NEW="$2"; TARGET="$3"; STAGE="$4"
OLD="$(dirname "$TARGET")/.分镜台-替换下来-$$.app"
for i in $(seq 1 600); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
if mv "$TARGET" "$OLD"; then
  if mv "$NEW" "$TARGET"; then rm -rf "$OLD"; else mv "$OLD" "$TARGET"; fi
fi
rm -rf "$STAGE"
open "$TARGET"
`;
function scheduleSwap({ pid, newApp, target, stage, tmpDir, spawnImpl = spawn }) {
  const script = path.join(tmpDir, `分镜台更新-${Date.now()}.sh`);
  fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 });
  const child = spawnImpl('/bin/bash', [script, String(pid), newApp, target, stage], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref?.();
  return script;
}

module.exports = {
  REPO,
  BUNDLE_ID,
  LATEST_API,
  RELEASES_PAGE,
  MANIFEST_NAME,
  MANIFEST_URL,
  assetName,
  compareVersions,
  pickUpdate,
  pickManifest,
  checkForUpdate,
  downloadUpdate,
  installTarget,
  prepareUpdate,
  scheduleSwap,
  SWAP_SCRIPT,
};
