/* 导出预检：目标目录解析、素材存在性、媒体探测与格式校验、口播抽音轨需求、
   资源命名与去重清单、空间估算。只返回明确的预检结果与资源清单；
   不创建最终草稿、不建暂存目录、不登记索引 —— 这些由入口在预检通过后负责。 */
'use strict';

const paths = require('./paths');
const schema = require('./schema');
const validate = require('./validate');
const mediaInfo = require('./media-info');
const { IMAGE_CODECS } = require('./media-tools');

const { BLOCK, WARN, INFO } = validate;

const DISK_MARGIN = 32 * 1024 * 1024;
const FREEZE_ESTIMATE = 6 * 1024 * 1024;
const AUDIO_ESTIMATE = 8 * 1024 * 1024; // 抽出的音轨大小上限估计
const COVER_ESTIMATE = 512 * 1024;
const VIDEO_FILE_RE = /\.(mp4|mov|m4v|mkv|webm|avi|flv|wmv|ts|mts|m2ts)$/i;

const noteIssue = (issues, level, code, message) => issues.push({ level, code, message });

/* 计划里真正会被轨道用到的素材（按首次出现顺序，保证可重复） */
function usedPlanIds(plan) {
  const seen = new Set();
  const order = [];
  const add = id => {
    if (typeof id !== 'string' || !id || seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };
  for (const item of [...(plan?.tracks?.video || []), ...(plan?.tracks?.audio || [])]) add(item?.assetId);
  return order;
}

function assetTable(plan) {
  const map = new Map();
  for (const asset of plan?.assets || []) map.set(asset.planId, { ...asset, derived: false });
  for (const freeze of plan?.derived || []) map.set(freeze.planId, { ...freeze, derived: true, kind: 'image' });
  return map;
}

function checkOptions(options, { draftRoot, path, fs }) {
  const mode = options?.mode === 'folder' ? 'folder' : 'library';
  if (mode === 'folder') {
    const destDir = options?.destDir;
    if (!paths.isAbsolutePath(destDir)) return { ok: false, error: '没有选择保存草稿的文件夹' };
    if (paths.hasTraversal(destDir)) return { ok: false, error: '保存文件夹路径无效' };
    let stat = null;
    try {
      stat = fs.statSync(destDir);
    } catch {}
    if (!stat?.isDirectory()) return { ok: false, error: '保存文件夹不存在，请重新选择' };
    return { ok: true, mode, parent: destDir, draftRoot: destDir };
  }
  if (!paths.isAbsolutePath(draftRoot)) return { ok: false, error: '找不到剪映草稿库，可改用「保存草稿文件夹」' };
  let stat = null;
  try {
    stat = fs.statSync(draftRoot);
  } catch {}
  if (!stat?.isDirectory()) return { ok: false, error: '找不到剪映草稿库，可改用「保存草稿文件夹」' };
  return { ok: true, mode, parent: draftRoot, draftRoot };
}

/* 目标父目录、草稿名与不重名的最终目录（只解析，不创建） */
function resolveTarget({ options, snapshot, draftRoot, path, fs }) {
  const checked = checkOptions(options || {}, { draftRoot, path, fs });
  if (!checked.ok) return checked;
  const draftName = paths.safeDraftName(options?.draftName || snapshot?.title || '剪映草稿');
  const finalDir = paths.uniqueName(checked.parent, draftName, candidate => fs.existsSync(candidate));
  return {
    ok: true,
    mode: checked.mode,
    parent: checked.parent,
    draftRoot: checked.draftRoot,
    draftName,
    finalDir,
    finalName: path.basename(finalDir),
  };
}

/* 素材、媒体、命名、空间的完整预检。返回 { ok:true, issues, …资源清单 } 或 { ok:false, error, canceled? }。 */
async function inspectExport({ plan, target, fs, path, media, signal, freeBytes }) {
  const issues = [];
  const canceled = () => !!signal?.aborted;
  const { parent, finalDir } = target;

  /* 1) 素材存在性：同一源文件只复制一份；定格与「视频抽音轨」是派生任务 */
  const assets = assetTable(plan);
  const order = usedPlanIds(plan);
  for (const planId of order) {
    const asset = assets.get(planId);
    if (!asset) return { ok: false, issues, error: '导出计划里的素材引用不完整' };
    const source = asset.derived ? asset.sourcePath : asset.path;
    if (!paths.isAbsolutePath(source)) {
      noteIssue(issues, BLOCK, 'asset-missing', `素材路径无效：${asset.name || planId}`);
      continue;
    }
    let stat = null;
    try {
      stat = fs.statSync(source);
    } catch {}
    if (!stat?.isFile()) {
      noteIssue(
        issues,
        BLOCK,
        'asset-missing',
        `${asset.derived ? '定格画面的源素材' : '素材文件'}不在了：${asset.name || path.basename(source)}`,
      );
      continue;
    }
    try {
      fs.accessSync(source, fs.constants ? fs.constants.R_OK : 4);
    } catch {
      noteIssue(issues, BLOCK, 'asset-unreadable', `没有权限读取素材：${asset.name || path.basename(source)}`);
    }
  }
  if (issues.some(item => item.level === BLOCK))
    return { ok: false, issues, error: '有素材不能读取，已停止导出（没有写入任何文件）' };

  /* 2) 媒体探测：所有必需素材都探测；探测失败 / 缺流 / 格式不符都定位到素材与原句。
     缺 ffmpeg 是「工具缺失」，与「文件损坏 / 格式不支持 / 没有所需媒体流 / 超时」分开处理。 */
  const mediaAvailable = typeof media.available === 'function' ? !!media.available() : true;
  const probeInfo = new Map(); // 路径 → 归一化探测信息
  const probeFailures = new Map(); // 路径 → { code, error }
  const assetLabel = asset => asset?.name || path.basename(asset?.path || '') || '素材';
  const refOf = asset =>
    Array.isArray(asset?.refs) ? asset.refs.find(item => item && (item.lineNo != null || item.rowId != null)) : null;
  const locateAsset = planId => {
    const asset = assets.get(planId);
    const ref = refOf(asset);
    return {
      rowId: ref?.rowId ?? null,
      lineNo: ref?.lineNo ?? null,
      assetId: asset?.sourceAssetId || planId,
    };
  };
  const addMediaIssue = (level, code, planId, message) => {
    const asset = assets.get(planId);
    const ref = refOf(asset);
    const where = ref?.lineNo != null ? `（第 ${ref.lineNo} 句）` : '';
    issues.push({ level, code, message: `${message}${where}`, ...locateAsset(planId) });
  };
  if (mediaAvailable && typeof media.probe === 'function') {
    for (const planId of order) {
      const asset = assets.get(planId);
      if (!asset || asset.derived || probeInfo.has(asset.path) || probeFailures.has(asset.path)) continue;
      let info;
      try {
        info = await media.probe({ path: asset.path, signal });
      } catch (error) {
        if (canceled() || error?.code === 'canceled') return { ok: false, issues, canceled: true, error: '已取消' };
        info = { ok: false, code: 'media-probe-failed', error: String(error?.message || error) };
      }
      if (info && info.ok !== false) probeInfo.set(asset.path, info);
      else
        probeFailures.set(asset.path, {
          code: info?.code || 'media-probe-failed',
          error: info?.error || '素材探测失败，无法确认它能放进草稿',
        });
    }
    for (const planId of order) {
      const asset = assets.get(planId);
      if (!asset || asset.derived) continue;
      const failed = probeFailures.get(asset.path);
      const info = probeInfo.get(asset.path);
      if (failed) {
        addMediaIssue(
          BLOCK,
          failed.code,
          planId,
          `素材「${assetLabel(asset)}」无法作为必需的音视频素材使用：${failed.error}`,
        );
        continue;
      }
      if (!info) continue;
      if (asset.kind === 'video') {
        if (info.hasVideo === false)
          addMediaIssue(
            BLOCK,
            'media-no-video-stream',
            planId,
            `素材「${assetLabel(asset)}」里没有视频画面，不能放到画面轨`,
          );
        else if (IMAGE_CODECS.has(String(info.videoCodec || '').toLowerCase()))
          addMediaIssue(
            BLOCK,
            'media-unsupported',
            planId,
            `素材「${assetLabel(asset)}」实际是图片（${info.videoCodec}），不能当视频使用`,
          );
      } else if (asset.kind === 'image') {
        if (info.hasVideo === false)
          addMediaIssue(BLOCK, 'media-no-image-stream', planId, `素材「${assetLabel(asset)}」里没有可用的图片画面`);
        else if (info.videoCodec && !IMAGE_CODECS.has(String(info.videoCodec).toLowerCase()))
          addMediaIssue(
            BLOCK,
            'media-unsupported',
            planId,
            `素材「${assetLabel(asset)}」不是可用的图片格式（${info.videoCodec}）`,
          );
      }
      const known = Number(info.durationUs);
      if (!(known > 0) || asset.kind !== 'video') continue;
      const wanted = Math.max(
        0,
        ...[...(plan.tracks?.video || []), ...(plan.tracks?.audio || [])]
          .filter(track => track.assetId === planId)
          .map(track => (Number(track.sourceStartUs) || 0) + (Number(track.sourceDurationUs) || 0)),
      );
      if (wanted > known + 100000)
        addMediaIssue(BLOCK, 'source-out-of-range', planId, `素材时长不够，导出区间超出文件：${assetLabel(asset)}`);
    }
  } else if (!mediaAvailable) {
    noteIssue(issues, INFO, 'media-tool-missing', '没找到 ffmpeg，已跳过音视频探测（需要抽音轨或定格的导出会被拦下）');
    /* 图片尺寸只读文件头、不依赖 ffmpeg：损坏图片不能因为「没装工具」就静默当成功 */
    for (const planId of order) {
      const asset = assets.get(planId);
      if (!asset || asset.derived || asset.kind !== 'image') continue;
      if (!mediaInfo.imageSizeOf({ fs, file: asset.path }))
        addMediaIssue(
          BLOCK,
          'media-probe-failed',
          planId,
          `图片「${assetLabel(asset)}」不是可用的图片文件（读不出图片尺寸），不能作为画面素材`,
        );
    }
  }

  /* 3) 口播源是视频时抽音轨：剪映的 audios 素材只接受音频容器 */
  const audioExtractIds = new Set();
  for (const planId of order) {
    const asset = assets.get(planId);
    if (!asset || asset.derived || asset.kind !== 'audio') continue;
    const info = probeInfo.get(asset.path);
    // 视频容器（哪怕探测到只有音轨）也抽成 m4a：剪映 audios 素材只认音频容器
    const videoLike = VIDEO_FILE_RE.test(asset.path) || info?.hasVideo === true;
    if (info && info.hasVideo === true && info.hasAudio === false) {
      noteIssue(
        issues,
        BLOCK,
        'audio-missing',
        `口播源是视频「${asset.name || path.basename(asset.path)}」，但它没有音轨`,
      );
      continue;
    }
    if (!videoLike) continue;
    if (!mediaAvailable || typeof media.extractAudio !== 'function') {
      noteIssue(
        issues,
        BLOCK,
        'media-tool-missing',
        `口播源是视频「${asset.name || path.basename(asset.path)}」，需要 ffmpeg 抽出音轨后才能放进草稿`,
      );
      continue;
    }
    audioExtractIds.add(planId);
  }
  if (issues.some(item => item.level === BLOCK)) {
    const first = issues.find(item => item.level === BLOCK);
    return {
      ok: false,
      issues,
      error: `有素材不能按计划使用，已停止导出（没有写入任何文件）：${first?.message || ''}`,
    };
  }

  /* 4) 资源命名与复制清单 */
  const namer = paths.resourceNamer();
  const resourceFiles = new Map(); // planId → 最终绝对路径
  const bySource = new Map(); // 源路径 → { targetName, bytes }
  const copies = [];
  const freezes = [];
  const audioJobs = [];
  const audioBySource = new Map();
  for (const planId of order) {
    const asset = assets.get(planId);
    if (!asset) continue;
    if (asset.derived) {
      const name = namer.derivedNameOf(planId, asset.outputName);
      resourceFiles.set(planId, paths.resourcePath(finalDir, name));
      freezes.push({ planId, asset, name });
      continue;
    }
    if (audioExtractIds.has(planId)) {
      const existingJob = audioBySource.get(asset.path);
      if (existingJob) {
        resourceFiles.set(planId, paths.resourcePath(finalDir, existingJob.targetName));
        continue;
      }
      const rawName = String(asset.name || path.basename(asset.path));
      const stem = path.basename(rawName, path.extname(rawName)) || '口播';
      const targetName = namer.nameOf(`${asset.path}::audio`, `${stem}-音频.m4a`);
      const job = { planId, asset, source: asset.path, targetName };
      audioJobs.push(job);
      audioBySource.set(asset.path, job);
      resourceFiles.set(planId, paths.resourcePath(finalDir, targetName));
      continue;
    }
    const existing = bySource.get(asset.path);
    if (existing) {
      resourceFiles.set(planId, paths.resourcePath(finalDir, existing.targetName));
      continue;
    }
    let stat = null;
    try {
      stat = fs.statSync(asset.path);
    } catch {}
    if (!stat?.isFile()) continue; // 第 1 步已经报过阻塞
    const targetName = namer.nameOf(asset.path, asset.name || asset.path);
    resourceFiles.set(planId, paths.resourcePath(finalDir, targetName));
    bySource.set(asset.path, { targetName, bytes: stat.size });
    copies.push({
      planId,
      source: asset.path,
      targetName,
      bytes: stat.size,
      kind: asset.kind,
      name: asset.name || path.basename(asset.path),
    });
  }

  if (!mediaAvailable && freezes.length)
    return {
      ok: false,
      issues,
      error: '这台电脑上没找到 ffmpeg，无法生成定格画面（导出已停止，没有写入任何文件）',
    };

  /* 备选素材：只在用户勾选时随草稿附带（不进时间线、不登记素材库），交付时说明清楚 */
  const altCopies = [];
  const altNamer = paths.resourceNamer();
  for (const alt of Array.isArray(plan?.altAssets) ? plan.altAssets : []) {
    if (!paths.isAbsolutePath(alt?.path)) {
      noteIssue(issues, INFO, 'alt-skipped', `备选素材「${alt?.name || '未命名'}」没有本地路径，未随草稿复制`);
      continue;
    }
    let altStat = null;
    try {
      altStat = fs.statSync(alt.path);
    } catch {}
    if (!altStat?.isFile()) {
      noteIssue(
        issues,
        INFO,
        'alt-skipped',
        `备选素材「${alt.name || path.basename(alt.path)}」文件不在了，未随草稿复制`,
      );
      continue;
    }
    altCopies.push({
      source: alt.path,
      targetName: altNamer.nameOf(alt.path, alt.name || alt.path),
      bytes: altStat.size,
      name: alt.name || path.basename(alt.path),
    });
  }
  const altBytes = altCopies.reduce((sum, item) => sum + item.bytes, 0);
  const plannedBytes = [...bySource.values()].reduce((sum, item) => sum + item.bytes, 0) + altBytes;
  const estimatedBytes =
    plannedBytes +
    freezes.length * FREEZE_ESTIMATE +
    audioJobs.length * AUDIO_ESTIMATE +
    (order.length ? COVER_ESTIMATE : 0) +
    DISK_MARGIN;
  const free = freeBytes(parent);
  if (free !== null && free < estimatedBytes) {
    noteIssue(issues, BLOCK, 'disk-full', '目标磁盘剩余空间不够，导出已停止（没有写入任何文件）');
    return { ok: false, issues, error: '目标磁盘剩余空间不够' };
  }

  return {
    ok: true,
    issues,
    assets,
    order,
    probeInfo,
    mediaAvailable,
    copies,
    freezes,
    audioJobs,
    altCopies,
    plannedBytes,
    resourceFiles,
  };
}

/* 导出用真实媒体元数据：主进程探测结果才是宽高 / 方向 / 完整源时长的权威来源。
   应用层预检只负责存在性；这里绝不拿画布尺寸冒充源素材尺寸。 */
function buildMediaMeta({ order, assets, probeInfo, fs, path }) {
  const issues = [];
  const mediaMeta = new Map();
  const assetLabel = asset => asset?.name || path.basename(asset?.path || '') || '素材';
  const refOf = asset =>
    Array.isArray(asset?.refs) ? asset.refs.find(item => item && (item.lineNo != null || item.rowId != null)) : null;
  const locateAsset = planId => {
    const asset = assets.get(planId);
    const ref = refOf(asset);
    return {
      rowId: ref?.rowId ?? null,
      lineNo: ref?.lineNo ?? null,
      assetId: asset?.sourceAssetId || planId,
    };
  };
  const addMediaIssue = (level, code, planId, message) => {
    const asset = assets.get(planId);
    const ref = refOf(asset);
    const where = ref?.lineNo != null ? `（第 ${ref.lineNo} 句）` : '';
    issues.push({ level, code, message: `${message}${where}`, ...locateAsset(planId) });
  };
  for (const planId of order) {
    const asset = assets.get(planId);
    if (!asset || asset.derived) continue;
    const info = probeInfo.get(asset.path);
    const header = asset.kind === 'image' ? mediaInfo.imageSizeOf({ fs, file: asset.path }) : null;
    /* width/height 是源画面尺寸；displayWidth/displayHeight 是旋转后的显示方向。
       schema 优先用 display 尺寸，两者都传，避免旋转素材被二次交换。 */
    const width = Math.round(Number(info?.width) || Number(header?.width) || Number(asset.width) || 0);
    const height = Math.round(Number(info?.height) || Number(header?.height) || Number(asset.height) || 0);
    const displayWidth = Math.round(Number(info?.displayWidth) || width || Number(asset.width) || 0);
    const displayHeight = Math.round(Number(info?.displayHeight) || height || Number(asset.height) || 0);
    const durationUs =
      asset.kind === 'image'
        ? schema.PHOTO_DURATION_US
        : Math.round(Number(info?.durationUs) || Number(asset.durationUs) || 0) || null;
    mediaMeta.set(planId, {
      width,
      height,
      displayWidth,
      displayHeight,
      rotation: Number(info?.rotation) || 0,
      durationUs,
      hasVideo: info?.hasVideo === true,
      hasAudio: info?.hasAudio === true,
    });
    if (asset.kind !== 'audio' && (!(width > 0) || !(height > 0)))
      noteIssue(
        issues,
        WARN,
        'media-meta-missing',
        `没能确认素材「${assetLabel(asset)}」的实际尺寸，草稿里会少登记宽高（不会用画布尺寸代替）`,
      );
    if (asset.kind === 'video' && !durationUs)
      noteIssue(
        issues,
        WARN,
        'media-duration-unknown',
        `没能确认「${assetLabel(asset)}」的完整源时长，进入剪映后可能无法在源范围内继续延长裁剪`,
      );
    else if (asset.kind === 'video' && info?.durationEstimated)
      addMediaIssue(
        INFO,
        'media-duration-estimated',
        planId,
        `「${assetLabel(asset)}」的容器没写总时长，已按视频包时间戳推算为 ${(durationUs / 1e6).toFixed(1)} 秒；进入剪映后仍可在源范围内继续延长裁剪`,
      );
  }
  return { mediaMeta, issues };
}

module.exports = { usedPlanIds, assetTable, resolveTarget, inspectExport, buildMediaMeta };
