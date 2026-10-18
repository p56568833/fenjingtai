/* 本机剪映探测：应用位置/版本、草稿库、是否正在运行、设备指纹（用于 platform 字段）。
   全部本机探测，不把任何设备标识写死；找不到就明确标记降级，由上层提示。
   依赖可注入（fs / run / home），测试不碰真实剪映。 */
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const paths = require('./paths');

const BUNDLE_ID = 'com.lemon.lvpro'; // 剪映专业版；CapCut（com.lemon.lv）不是本适配器目标
const RUNNING_MARK = 'VideoFusion-macOS.app/Contents/MacOS/VideoFusion-macOS'; // 11.6 实测进程名
/* 只在本机 Mac 剪映专业版 11.6.0 上实测过，版本号必须与它完全一致才算验证：
   11.6.1 / 11.6.99 / 11.7.0 等后续版本都没验证过；11.6.0.1 / 11.6.0-beta 也不做“规范化”当成 11.6.0。
   未验证版本不生成草稿、不登记草稿库（见 unsupportedVersionMessage）。 */
const VERIFIED_VERSION = '11.6.0';
const isVerifiedVersion = version => String(version ?? '') === VERIFIED_VERSION;
const unsupportedVersionMessage = version =>
  `本机剪映版本 ${String(version || '').trim() || '未知'} 未验证：当前仅在 Mac 剪映专业版 11.6.0 上实测，其他版本不生成草稿、不登记草稿库`;
const APP_NAMES = ['VideoFusion-macOS.app', '剪映专业版.app', '剪映.app'];

/* 跑一条只读系统命令：失败返回空串（不把「找不到」当成错误） */
function runText(command, args) {
  try {
    const out = execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return String(out || '').trim();
  } catch (error) {
    return String(error?.stdout || '').trim();
  }
}

function appCandidates({ fs, path, applications }) {
  const out = [];
  for (const dir of applications) {
    for (const name of APP_NAMES) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) out.push(p);
    }
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/\.app$/.test(entry) || !/(剪映|videofusion|jianying)/i.test(entry)) continue;
      const p = path.join(dir, entry);
      if (!out.includes(p) && fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

/* 读 Info.plist 的 bundle id / 版本：defaults 是 macOS 自带命令，不引第三方 plist 依赖 */
function readBundle({ run, path, appPath }) {
  const info = path.join(appPath, 'Contents', 'Info.plist');
  const id = run('/usr/bin/defaults', ['read', info, 'CFBundleIdentifier']);
  if (id !== BUNDLE_ID) return null;
  const version = run('/usr/bin/defaults', ['read', info, 'CFBundleShortVersionString']);
  return { appPath, version };
}

/* 剪映是否正在运行。生产路径不能把「检测命令本身失败」当成「没在运行」：
   pgrep 退出码 0 = 在运行、1 = 没在运行；其它退出码或起不了进程必须抛错，
   让导出任务按「无法确认」保守处理（只生成草稿、不写索引）。注入的 run 保持测试语义。 */
function isRunning({ run } = {}) {
  if (typeof run === 'function') return !!run('/usr/bin/pgrep', ['-f', RUNNING_MARK]);
  const result = spawnSync('/usr/bin/pgrep', ['-f', RUNNING_MARK], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`无法确认剪映是否正在运行：${result.error.message}`);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`无法确认剪映是否正在运行（pgrep 退出码 ${result.status}）`);
}

function osProductVersion(run = runText) {
  return run('/usr/bin/sw_vers', ['-productVersion']);
}

/* 从 platform / last_modified_platform 里取本机设备标识；空值不算 */
function fingerprintFrom(platform) {
  if (!platform || typeof platform !== 'object') return null;
  const deviceId = String(platform.device_id || '');
  if (!deviceId) return null;
  return {
    device_id: deviceId,
    hard_disk_id: String(platform.hard_disk_id || ''),
    mac_address: String(platform.mac_address || ''),
  };
}

function safeParse(readFile, file) {
  try {
    const text = readFile(file);
    if (!text || text[0] !== '{') return null; // 剪映重写后的文件是二进制密文
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function platformOfDoc(doc) {
  return fingerprintFrom(doc?.last_modified_platform) || fingerprintFrom(doc?.platform);
}

function platformOfSubdraft(doc) {
  const direct = fingerprintFrom(doc?.last_modified_platform) || fingerprintFrom(doc?.platform);
  if (direct) return direct;
  const drafts = doc?.materials?.drafts;
  if (!Array.isArray(drafts)) return null;
  for (const item of drafts) {
    const found = fingerprintFrom(item?.draft?.platform) || fingerprintFrom(item?.draft?.last_modified_platform);
    if (found) return found;
  }
  return null;
}

/* 设备指纹探测顺序（契约）：明文 draft_info.json → subdraft 里的 draft_content.json → Timelines 里的 template.tmp → 降级 */
function probeFingerprint({ fs, path, draftRoot, appVersion, osVersion }) {
  const readFile = file => fs.readFileSync(file, 'utf8');
  const platform = {
    app_id: 3704,
    app_source: 'lv',
    app_version: appVersion || '11.6.0',
    os: 'mac',
    os_version: osVersion || '',
  };
  const done = (found, source) => ({ ok: true, source, platform: { ...platform, ...found } });
  let drafts;
  try {
    drafts = fs.readdirSync(draftRoot, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch {
    return { ok: false, source: 'fallback', platform };
  }
  drafts = drafts.filter(e => !e.name.startsWith('.')).slice(0, 80);

  /* a. 草稿目录里的明文 draft_info.json */
  for (const entry of drafts) {
    const doc = safeParse(readFile, path.join(draftRoot, entry.name, 'draft_info.json'));
    const found = platformOfDoc(doc);
    if (found) return done(found, 'draft_info');
  }
  /* b. subdraft/<id>/draft_content.json（老版本留下的明文时间线） */
  for (const entry of drafts) {
    const subRoot = path.join(draftRoot, entry.name, 'subdraft');
    let subs;
    try {
      subs = fs.readdirSync(subRoot, { withFileTypes: true }).filter(e => e.isDirectory());
    } catch {
      continue;
    }
    for (const sub of subs.slice(0, 40)) {
      const doc = safeParse(readFile, path.join(subRoot, sub.name, 'draft_content.json'));
      const found = platformOfSubdraft(doc);
      if (found) return done(found, 'subdraft');
    }
  }
  /* c. Timelines/<id>/template.tmp（常常是空壳，聊胜于无） */
  for (const entry of drafts) {
    const timelineRoot = path.join(draftRoot, entry.name, 'Timelines');
    let ids;
    try {
      ids = fs.readdirSync(timelineRoot, { withFileTypes: true }).filter(e => e.isDirectory());
    } catch {
      continue;
    }
    for (const id of ids.slice(0, 20)) {
      const doc = safeParse(readFile, path.join(timelineRoot, id.name, 'template.tmp'));
      const found = platformOfDoc(doc);
      if (found) return done(found, 'timelines');
    }
  }
  /* d. 找不到：只给通用字段，让上层提示「无设备指纹草稿」 */
  return { ok: false, source: 'fallback', platform };
}

function readIndexState({ fs, path, draftRoot }) {
  const file = paths.indexFileFor(draftRoot);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.all_draft_store))
      return { ok: false, error: '草稿库索引结构不认识，未做任何修改' };
    return { ok: true, raw, count: doc.all_draft_store.length };
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? '没有找到剪映草稿库索引' : '草稿库索引无法解析，未做任何修改';
    return { ok: false, error: reason };
  }
}

/* 探测本机剪映：返回契约里的 { ok, appPath, version, draftRoot, running, canRegister, fingerprint, supported, issues } */
function detect(deps = {}) {
  const fs = deps.fs || nodeFs;
  const os = deps.os || nodeOs;
  const path = deps.path || nodePath;
  const run = deps.run || runText;
  const home = deps.home || os.homedir();
  const applications = deps.applications || [path.join('/', 'Applications'), path.join(home, 'Applications')];
  const draftRoot = deps.draftRoot || paths.draftRootFor(home);
  const issues = [];

  let app = null;
  for (const candidate of appCandidates({ fs, path, applications })) {
    app = readBundle({ run, path, appPath: candidate });
    if (app) break;
  }
  const version = app?.version || '';
  const supported = isVerifiedVersion(version);
  if (!app) {
    issues.push({ level: 'warn', code: 'app-not-found', message: '没有找到剪映专业版（导出仅验证 11.6.0）' });
  } else if (!supported) {
    issues.push({
      level: 'warn',
      code: 'version-unsupported',
      message: unsupportedVersionMessage(version),
    });
  }

  let rootOk;
  try {
    rootOk = fs.statSync(draftRoot).isDirectory();
  } catch {
    rootOk = false;
  }
  if (!rootOk) {
    issues.push({
      level: 'warn',
      code: 'draft-root-missing',
      message: '没有找到剪映草稿库目录，可改用「保存草稿文件夹」',
    });
  }

  const index = rootOk ? readIndexState({ fs, path, draftRoot }) : { ok: false, error: '草稿库不可用' };
  if (rootOk && !index.ok) issues.push({ level: 'info', code: 'index-unusable', message: index.error });

  /* 没注入 run 时走 isRunning 的生产实现：检测失败抛错而不是静默当作没运行 */
  const running = rootOk ? (deps.run ? isRunning({ run }) : isRunning()) : false;
  const osVersion = osProductVersion(run);
  const fingerprint = probeFingerprint({ fs, path, draftRoot, appVersion: version, osVersion });
  if (!fingerprint.ok)
    issues.push({
      level: 'info',
      code: 'fingerprint-fallback',
      message: '没有找到本机剪映设备指纹，草稿将不带设备标识（首次打开时剪映会补齐）',
    });

  return {
    ok: !!app && rootOk,
    appPath: app?.appPath || '',
    version,
    draftRoot,
    running,
    canRegister: !!app && supported && rootOk && index.ok,
    fingerprint,
    supported,
    issues,
  };
}

module.exports = {
  BUNDLE_ID,
  RUNNING_MARK,
  VERIFIED_VERSION,
  isVerifiedVersion,
  unsupportedVersionMessage,
  detect,
  isRunning,
  osProductVersion,
  probeFingerprint,
  readIndexState,
  runText,
};
