/* 剪映导出的路径规则：草稿库位置、Resources 内文件命名、唯一目录、绝对路径与穿越校验。
   只做路径计算和安全命名，不读写文件（是否存在由调用方判断）。 */
const path = require('node:path');
const { safeFileName } = require('../fs-utils');

const TEMP_PREFIX = '.fenjingtai-export-'; // 暂存目录前缀（隐藏、带所有权标记，提交前只在这里写）
const OWNER_FILE = '.fenjingtai-export.json'; // 所有权标记：应用重启后只清理带标记且未提交的目录

/* 绝对路径：非空、无 NUL、长度受控。Windows 路径不会出现在 mac 剪映里，这里只认绝对路径。 */
function isAbsolutePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes('\0') &&
    path.isAbsolute(value)
  );
}

/* 含 .. 段：拼路径前拒掉，避免计划里的路径把写入带出目标目录 */
function hasTraversal(value) {
  return /(^|[\\/])\.\.([\\/]|$)/.test(String(value || ''));
}

/* child 在 parent 里面（不含 parent 本身）；用于确认草稿目录确实在草稿库里 */
function insideDir(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const draftRootFor = home => path.join(home, 'Movies', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft');
const indexFileFor = draftRoot => path.join(draftRoot, 'root_meta_info.json');
const draftResourcesDir = draftDir => path.join(draftDir, 'Resources');
const resourcePath = (draftDir, name) => path.join(draftResourcesDir(draftDir), name);

/* 草稿名：系统不允许的字符执行清理，空名兜底；不覆盖任何已有目录由 uniqueDir 处理 */
const safeDraftName = (value, fallback = '剪映草稿') => safeFileName(value, fallback).replace(/\.+$/, '') || fallback;

/* 素材文件名：保留扩展名，主名净化；同一源文件复用同一个名字，同名不同源自动加 (2)、(3)… */
function resourceNamer() {
  const bySource = new Map(); // 源文件绝对路径 → 资源文件名
  const used = new Set(); // 已占用的资源文件名（小写比较，macOS 默认大小写不敏感）
  return {
    /* 返回最终文件名；同一 sourcePath 多次调用得到同一个名字 */
    nameOf(sourcePath, displayName) {
      if (bySource.has(sourcePath)) return bySource.get(sourcePath);
      const base = path.basename(String(displayName || sourcePath || '素材'));
      const ext = path.extname(base);
      const stem = safeFileName(path.basename(base, ext), '素材');
      let candidate = `${stem}${ext}`;
      for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`;
      used.add(candidate.toLowerCase());
      bySource.set(sourcePath, candidate);
      return candidate;
    },
    /* 派生素材（定格 PNG）用导出计划里的 outputName，不带源文件名歧义 */
    derivedNameOf(planId, outputName) {
      if (bySource.has(planId)) return bySource.get(planId);
      const base = safeFileName(path.basename(String(outputName || '定格.png')), '定格');
      const stem = path.basename(base, path.extname(base)) || '定格';
      let candidate = `${stem}.png`;
      for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i}).png`;
      used.add(candidate.toLowerCase());
      bySource.set(planId, candidate);
      return candidate;
    },
  };
}

/* 目标父目录里不重名的名字：docs/草稿 → docs/草稿 (2)；与 fs.existsSync 解耦，便于测试注入 */
function uniqueName(dir, name, exists) {
  const has = p => (typeof exists === 'function' ? exists(p) : false);
  let candidate = path.join(dir, name);
  for (let i = 2; has(candidate); i++) candidate = path.join(dir, `${name} (${i})`);
  return candidate;
}

module.exports = {
  TEMP_PREFIX,
  OWNER_FILE,
  isAbsolutePath,
  hasTraversal,
  insideDir,
  draftRootFor,
  indexFileFor,
  draftResourcesDir,
  resourcePath,
  safeDraftName,
  resourceNamer,
  uniqueName,
};
