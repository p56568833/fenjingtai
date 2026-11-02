/* 剪映导出的流程编排：校验计划 → 预检 → 暂存目录里复制素材 / 抽定格与封面 → 生成草稿文件 → 校验 →
   同卷 rename 提交 → 登记草稿库 → 写报告。拥有本次任务的取消信号、阶段、暂存目录、提交状态和最终结果。
   具体能力在 electron/jianying/ 下按职责拆分：media-tools（媒体进程）、export-files（文件与暂存）、
   export-preflight（素材 / 媒体 / 命名 / 空间预检）、export-report（报告内容）、register（登记索引）。
   由 IPC 层传入已校验的通用导出计划；这里不信任外部输入，会再校验一遍。
   可注入 fs / 媒体工具 / 时钟 / ID / 登记函数，测试用临时目录跑完整流程，不依赖真实剪映和真实草稿库。
   所有写入先落在目标父目录里的隐藏暂存目录，校验通过后同卷 rename 提交；提交后的草稿是用户工作数据，不再删除。 */
'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { randomUUID } = require('node:crypto');
const paths = require('./jianying/paths');
const schema = require('./jianying/schema');
const meta = require('./jianying/meta');
const validate = require('./jianying/validate');
const register = require('./jianying/register');
const mediaInfo = require('./jianying/media-info');
const mediaTools = require('./jianying/media-tools');
const exportFiles = require('./jianying/export-files');
const preflight = require('./jianying/export-preflight');
const exportReport = require('./jianying/export-report');

const { BLOCK, WARN, INFO } = validate;

/* 阶段名与界面约定一致：probe / copy / freeze / build / commit / register */
const PHASES = Object.freeze({
  PROBE: 'probe',
  COPY: 'copy',
  FREEZE: 'freeze',
  BUILD: 'build',
  COMMIT: 'commit',
  REGISTER: 'register',
});

const CANCELED = 'canceled';

/* 没有可截帧素材时的兜底封面：16×16 白色 JPEG（222 字节，不依赖 ffmpeg） */
const FALLBACK_COVER = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgQEBMQExYWFhYWFhoYGhsbGxoaGhobGxsdHR0iIiIdHR0bGx0dICAiIiUmJSMjIiMmJigoKDAwLi44ODpFRVP/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z',
  'base64',
);

/* 无设备指纹 / 无 ffmpeg 等降级情况都在这里记；界面把它们当「需要知道的提醒」展示 */
const noteIssue = (issues, level, code, message) => issues.push({ level, code, message });

const canceledError = () => Object.assign(new Error('已取消'), { code: CANCELED, canceled: true });

const defaultCommit =
  ({ fs = nodeFs } = {}) =>
  (from, to) =>
    fs.renameSync(from, to);

const defaultIdFor = () => String(randomUUID()).toUpperCase();

const defaultWriteFile =
  ({ fs = nodeFs } = {}) =>
  (file, content) =>
    fs.writeFileSync(file, content, 'utf8');

/* 主任务。request: { plan, options, draftRoot, fingerprint, appVersion, osVersion, running, backupDir }
   hooks: { signal, onProgress({ phase, done, total, message }) }
   返回：成功 { ok:true, draftDir, draftName, segmentCount, assetCount, freezeCount, registered, needsQuit, reportPath, notes, issues }；
        失败 { ok:false, canceled?, error, phase, issues } */
async function runJianyingExport(request, hooks = {}, deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const clock = deps.now || (() => Date.now());
  const idFor = deps.idFor || defaultIdFor;
  const media = deps.media || mediaTools.createMediaTools();
  const freeBytes = deps.freeBytes || exportFiles.freeBytesFor({ fs });
  const commitDir = deps.commitDir || defaultCommit({ fs });
  const writeFile = deps.writeFile || defaultWriteFile({ fs });
  const registerDraft = deps.registerDraft || register.registerDraft;
  const progress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};
  const signal = hooks.signal || null;
  const canceled = () => !!signal?.aborted;
  const issues = [];
  const notes = [];
  let phase = PHASES.PROBE;
  const emit = (next, done = 0, total = 0, message = '') => {
    phase = next;
    try {
      progress({ phase: next, done, total, message });
    } catch {}
  };
  const fail = (error, extra = {}) => ({
    ok: false,
    error: String(error?.message || error),
    phase,
    issues,
    ...extra,
  });

  const plan = request?.plan;
  let staging = '';
  let committed = false;
  try {
    emit(PHASES.PROBE, 0, 0, '检查导出计划');
    const planIssues = validate.validatePlan(plan);
    issues.push(...planIssues);
    for (const item of Array.isArray(plan?.issues) ? plan.issues : []) {
      const level = item?.level === 'block' ? BLOCK : item?.level === 'confirm' ? WARN : INFO;
      noteIssue(
        issues,
        level,
        String(item?.code || 'plan-issue'),
        String(item?.message || '导出计划里有需要确认的问题'),
      );
    }
    if (issues.some(item => item.level === BLOCK)) return fail('导出计划有问题，已停止导出（没有写入任何文件）');

    const options = request?.options || {};
    const target = preflight.resolveTarget({
      options,
      snapshot: request?.snapshot,
      draftRoot: request?.draftRoot,
      path,
      fs,
    });
    if (!target.ok) return fail(target.error);
    const { mode, parent, draftRoot, draftName, finalDir, finalName } = target;

    /* 旧任务残留（带所有权标记、超过 6 小时且未提交）顺手清掉；不碰其他任何目录 */
    if (!canceled()) exportFiles.cleanupStaleStaging({ fs, path, parent, now: clock() });
    if (canceled()) return fail(canceledError(), { canceled: true });

    /* 预检：素材存在性 / 媒体探测与格式 / 抽音轨需求 / 资源命名去重 / 空间；只返回结果，不写文件 */
    const inspected = await preflight.inspectExport({ plan, target, fs, path, media, signal, freeBytes });
    issues.push(...(inspected.issues || []));
    if (!inspected.ok) {
      if (inspected.canceled) return fail(canceledError(), { canceled: true });
      return fail(inspected.error);
    }
    const {
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
    } = inspected;

    /* 剪映运行状态在「实际登记前」重新检测；request.running 只是导出开始时的快照，不能用于决定写索引。
       没有实时检测能力或检测抛错时按「不确定」保守处理：保留草稿、不改索引。 */
    const runningState = () => {
      try {
        if (typeof deps.isRunning === 'function') {
          const value = deps.isRunning();
          if (typeof value === 'boolean') return { known: true, running: value };
          return { known: false, running: true };
        }
      } catch {
        return { known: false, running: true };
      }
      return { known: false, running: true };
    };
    /* 登记前要确认索引没有被外部改过：记录导出开始时的原文，登记前再比一次。
       如果导出期间剪映草稿库发生变化，就停止自动登记、保留新草稿，让用户决定何时补登记。 */
    let indexRawAtStart = null;
    let draftIndexFile = '';
    if (mode === 'library') {
      draftIndexFile = paths.indexFileFor(draftRoot);
      const index = register.readIndex({ indexFile: draftIndexFile, fs, path });
      if (!index.ok)
        noteIssue(issues, INFO, 'index-unusable', `${index.error}；草稿仍会生成，稍后可点「加入剪映」重试`);
      else indexRawAtStart = index.raw;
    }

    /* 暂存目录：目标父目录里的隐藏目录，资源与结构校验通过后才提交 */
    const token = typeof deps.token === 'function' ? deps.token() : String(randomUUID());
    staging = path.join(parent, `${paths.TEMP_PREFIX}${token}`);
    const stagingResources = path.join(staging, 'Resources');
    const draftId = idFor('draft');
    const nowMs = clock();
    fs.mkdirSync(stagingResources, { recursive: true });
    exportFiles.writeOwnerMarker({ fs, path, staging, draftId, now: nowMs });
    if (finalName !== draftName) noteIssue(issues, INFO, 'name-deduped', `已有同名草稿，本次保存为「${finalName}」`);

    /* 复制素材 */
    const totalBytes = plannedBytes;
    let copiedBytes = 0;
    emit(PHASES.COPY, 0, totalBytes, '复制素材');
    for (const copy of copies) {
      if (canceled()) return fail(canceledError(), { canceled: true });
      await exportFiles.copyWithProgress({
        fs,
        source: copy.source,
        target: path.join(stagingResources, copy.targetName),
        signal,
        onBytes: delta => {
          copiedBytes += delta;
          emit(PHASES.COPY, copiedBytes, totalBytes, `复制素材：${copy.name}`);
        },
      });
    }
    if (altCopies.length) {
      const altDir = path.join(stagingResources, '备选素材');
      fs.mkdirSync(altDir, { recursive: true });
      for (const copy of altCopies) {
        if (canceled()) return fail(canceledError(), { canceled: true });
        await exportFiles.copyWithProgress({
          fs,
          source: copy.source,
          target: path.join(altDir, copy.targetName),
          signal,
          onBytes: delta => {
            copiedBytes += delta;
            emit(PHASES.COPY, copiedBytes, totalBytes, `复制备选素材：${copy.name}`);
          },
        });
      }
    }
    emit(PHASES.COPY, copiedBytes, totalBytes, '素材复制完成');

    /* 导出用真实媒体元数据：主进程探测结果才是宽高 / 方向 / 完整源时长的权威来源。
       应用层预检只负责存在性；这里绝不拿画布尺寸冒充源素材尺寸。 */
    const builtMeta = preflight.buildMediaMeta({ order, assets, probeInfo, fs, path });
    issues.push(...builtMeta.issues);
    const mediaMeta = builtMeta.mediaMeta;

    /* 定格帧：按源入点 / 排他出点在真实源帧里定位，不按项目帧率推算 */
    emit(PHASES.FREEZE, 0, freezes.length, freezes.length ? '处理定格画面' : '没有需要生成的定格');
    for (let index = 0; index < freezes.length; index++) {
      if (canceled()) return fail(canceledError(), { canceled: true });
      const freeze = freezes[index];
      const outPath = path.join(stagingResources, freeze.name);
      try {
        await media.extractFrame({
          sourcePath: freeze.asset.sourcePath,
          sourceInUs: freeze.asset.sourceInUs,
          sourceOutUs: freeze.asset.sourceOutUs,
          atUs: freeze.asset.atUs,
          outPath,
          signal,
        });
      } catch (error) {
        if (canceled() || error?.code === CANCELED) return fail(canceledError(), { canceled: true });
        const reason =
          error?.code === 'freeze-no-frame'
            ? '选定的源区间里没有可用的画面（可能出点太靠近片头或源视频比预期短）'
            : error?.code === 'media-no-video-stream'
              ? '源素材里没有视频画面'
              : String(error?.message || error);
        noteIssue(issues, BLOCK, 'freeze-failed', `定格画面生成失败：${reason}`);
        return fail('定格画面生成失败，已停止导出（没有留下草稿）');
      }
      let stat = null;
      try {
        stat = fs.statSync(outPath);
      } catch {}
      if (!stat?.isFile() || stat.size <= 0) return fail('定格画面生成失败，已停止导出（没有留下草稿）');
      const outputSize = mediaInfo.imageSizeOf({ fs, file: outPath });
      const sourceMeta = mediaMeta.get(freeze.asset.sourceAssetId) || {};
      const sourceInfo = probeInfo.get(freeze.asset.sourcePath);
      const width = Math.round(
        Number(outputSize?.width) ||
          Number(sourceMeta.width) ||
          Number(sourceInfo?.displayWidth) ||
          Number(sourceInfo?.width) ||
          0,
      );
      const height = Math.round(
        Number(outputSize?.height) ||
          Number(sourceMeta.height) ||
          Number(sourceInfo?.displayHeight) ||
          Number(sourceInfo?.height) ||
          0,
      );
      mediaMeta.set(freeze.planId, {
        width,
        height,
        displayWidth: width,
        displayHeight: height,
        rotation: 0,
        durationUs: schema.PHOTO_DURATION_US,
        hasVideo: false,
        hasAudio: false,
      });
      if (!outputSize)
        noteIssue(
          issues,
          INFO,
          'freeze-size-fallback',
          `定格图「${freeze.name}」的实际输出尺寸没能读出，草稿按源画面尺寸登记`,
        );
      emit(PHASES.FREEZE, index + 1, freezes.length, `定格画面 ${index + 1}/${freezes.length}`);
    }

    /* 视频口播抽音轨：结构生成前完成，失败不提交、不留草稿 */
    if (audioJobs.length) {
      emit(PHASES.BUILD, 0, 0, '抽取口播音轨');
      for (const job of audioJobs) {
        if (canceled()) return fail(canceledError(), { canceled: true });
        const outPath = path.join(stagingResources, job.targetName);
        try {
          await media.extractAudio({ sourcePath: job.source, outPath, signal });
        } catch (error) {
          if (canceled() || error?.code === CANCELED) return fail(canceledError(), { canceled: true });
          noteIssue(issues, BLOCK, 'audio-extract-failed', `口播音轨抽取失败：${error?.message || error}`);
          return fail('口播音轨抽取失败，已停止导出（没有留下草稿）');
        }
        let stat = null;
        try {
          stat = fs.statSync(outPath);
        } catch {}
        if (!stat?.isFile() || stat.size <= 0) return fail('口播音轨抽取失败，已停止导出（没有留下草稿）');
      }
    }

    /* 封面：取第一个画面素材的一帧；失败用内置小图兜底 */
    emit(PHASES.BUILD, 0, 0, '生成封面');
    const coverPath = path.join(staging, 'draft_cover.jpg');
    const firstVisual = [...(plan.tracks?.video || [])]
      .map(item => ({ item, asset: assets.get(item.assetId) }))
      .find(entry => entry.asset);
    let coverMade = false;
    if (firstVisual && mediaAvailable && typeof media.cover === 'function') {
      try {
        const visual = firstVisual.asset;
        await media.cover({
          sourcePath: visual.derived
            ? resourceSibling(stagingResources, resourceFiles.get(firstVisual.item.assetId))
            : visual.path,
          atUs: visual.derived ? 0 : (Number(firstVisual.item.sourceStartUs) || 0) + 100000,
          isImage: visual.derived || visual.kind === 'image' || visual.type === 'freeze',
          outPath: coverPath,
          signal,
        });
        coverMade = fs.existsSync(coverPath) && fs.statSync(coverPath).size > 0;
      } catch {
        if (canceled()) return fail(canceledError(), { canceled: true });
      }
    }
    if (!coverMade) {
      fs.writeFileSync(coverPath, FALLBACK_COVER);
      noteIssue(issues, INFO, 'cover-fallback', '封面用了默认图（没能从画面里截取）');
    }

    /* 生成草稿结构 */
    emit(PHASES.BUILD, 0, 0, '生成草稿文件');
    const finalResources = new Map();
    for (const planId of order) {
      const file = resourceFiles.get(planId);
      if (file) finalResources.set(planId, file);
    }
    const resourceMap = {};
    for (const [planId, file] of finalResources) resourceMap[planId] = file;
    const draft = { id: draftId, name: finalName, dir: finalDir, root: draftRoot };
    const doc = schema.buildDraftInfo({
      plan,
      draft,
      resources: resourceMap,
      fingerprint: request?.fingerprint,
      appVersion: request?.appVersion,
      osVersion: request?.osVersion,
      nowUs: nowMs * 1000,
      idFor,
      media: mediaMeta,
    });
    const usedMaterials = order
      .filter(planId => assets.get(planId) && !assets.get(planId).derived)
      .map(planId => {
        const asset = assets.get(planId);
        const metaEntry = mediaMeta.get(planId) || {};
        const extent = Math.max(
          0,
          ...[...(plan.tracks?.video || []), ...(plan.tracks?.audio || [])]
            .filter(track => track.assetId === planId)
            .map(track => (Number(track.sourceStartUs) || 0) + (Number(track.sourceDurationUs) || 0)),
        );
        return {
          name: path.basename(resourceFiles.get(planId)),
          path: resourceFiles.get(planId),
          kind: asset.kind,
          width: Math.round(Number(metaEntry.displayWidth) || Number(metaEntry.width) || 0),
          height: Math.round(Number(metaEntry.displayHeight) || Number(metaEntry.height) || 0),
          durationUs:
            asset.kind === 'image'
              ? schema.PHOTO_DURATION_US
              : Math.round(Number(metaEntry.durationUs) || Number(asset.durationUs) || extent || 0),
        };
      })
      .concat(
        freezes.map(freeze => {
          const metaEntry = mediaMeta.get(freeze.planId) || {};
          return {
            name: freeze.name,
            path: resourceFiles.get(freeze.planId),
            kind: 'image',
            width: Math.round(Number(metaEntry.width) || 0),
            height: Math.round(Number(metaEntry.height) || 0),
            durationUs: schema.PHOTO_DURATION_US,
          };
        }),
      );
    const resourcesBytes = exportFiles.sumDirBytes({ fs, path, dir: stagingResources });
    const metaInfo = meta.buildDraftMetaInfo({
      draft,
      materials: usedMaterials,
      materialsSize: resourcesBytes,
      durationUs: plan.durationUs,
      nowUs: nowMs * 1000,
      idFor,
    });
    const settings = meta.buildDraftSettings({ nowSec: Math.floor((nowMs * 1000) / 1000000) });
    const srt = typeof plan?.srt === 'string' ? plan.srt.trim() : '';
    if (srt) writeFile(path.join(staging, '字幕.srt'), `${srt}\n`);
    writeFile(path.join(staging, 'draft_info.json'), JSON.stringify(doc));
    writeFile(path.join(staging, 'draft_meta_info.json'), JSON.stringify(metaInfo));
    writeFile(path.join(staging, 'draft_settings'), settings);

    const draftIssues = validate.validateDraftInfo(doc, {
      draftDir: finalDir,
      resourceDir: stagingResources,
      plan,
      checkFiles: fs,
    });
    issues.push(...draftIssues);
    if (draftIssues.some(item => item.level === BLOCK))
      return fail('生成的草稿结构没通过校验，已停止导出（没有留下草稿）');

    /* 提交：同卷 rename；失败只清理本次暂存目录，目标位置不留下半成品 */
    emit(PHASES.COMMIT, 0, 0, '提交草稿目录');
    if (canceled()) return fail(canceledError(), { canceled: true });
    if (fs.existsSync(finalDir)) return fail('目标草稿目录在导出期间被占用，已停止（没有留下半成品）');
    try {
      commitDir(staging, finalDir);
    } catch (error) {
      return fail(`提交草稿目录失败：${error?.message || error}（没有留下半成品）`);
    }
    committed = true;
    staging = '';

    /* 登记：剪映运行中只生成不写索引；索引不可用时保留草稿并说明 */
    emit(PHASES.REGISTER, 0, 0, mode === 'folder' ? '保存草稿文件夹' : '加入剪映草稿库');
    const result = {
      ok: true,
      mode,
      draftDir: finalDir,
      draftName: finalName,
      segmentCount:
        (plan.tracks?.video || []).length + (plan.tracks?.audio || []).length + (plan.tracks?.text || []).length,
      assetCount: copies.length,
      freezeCount: freezes.length,
      audioExtractedCount: audioJobs.length,
      registered: false,
      needsQuit: false,
      reportPath: path.join(finalDir, 'fenjingtai-export.json'),
      notes,
      issues,
    };
    if (audioJobs.length) notes.push(`${audioJobs.length} 个口播源是视频，已抽出音轨作为独立音频轨放进草稿`);
    if (altCopies.length)
      notes.push(`${altCopies.length} 个备选素材已复制到 Resources/备选素材（不上时间线，可在剪映里手动添加）`);
    if (mode === 'library') {
      const state = runningState();
      if (!state.known) {
        result.needsQuit = true;
        result.runningUnknown = true;
        notes.push('无法确认剪映是否正在运行，为安全起见这次没有改草稿库索引；退出剪映后再点「加入剪映」补登记');
        noteIssue(issues, WARN, 'app-running-unknown', '无法确认剪映运行状态，这次没有改草稿库索引');
      } else if (state.running) {
        result.needsQuit = true;
        notes.push('剪映正在运行：草稿已生成，退出剪映后回到分镜台点「加入剪映」补登记');
        noteIssue(issues, INFO, 'app-running', '剪映正在运行，这次没有改草稿库索引；退出后可补登记');
      } else {
        let indexChanged = false;
        if (indexRawAtStart != null && draftIndexFile) {
          let currentRaw = null;
          try {
            currentRaw = fs.readFileSync(draftIndexFile, 'utf8');
          } catch {}
          indexChanged = currentRaw !== indexRawAtStart;
        }
        if (indexChanged) {
          notes.push('剪映草稿库索引在导出期间被改动，已停止登记并保留新草稿；确认草稿库稳定后可点「加入剪映」补登记');
          noteIssue(issues, WARN, 'register-failed', '剪映草稿库索引在导出期间被外部改动，草稿已保留但未自动登记');
        } else {
          let registeredResult = null;
          try {
            registeredResult = registerDraft({
              draftRoot,
              draftDir: finalDir,
              backupDir: request?.backupDir || '',
              now: clock,
              isRunning: typeof deps.isRunning === 'function' ? deps.isRunning : undefined,
              fs,
              path,
            });
          } catch (error) {
            registeredResult = { ok: false, registered: false, error: String(error?.message || error) };
          }
          if (registeredResult?.ok && registeredResult.registered) result.registered = true;
          else if (registeredResult?.needsQuit) {
            result.needsQuit = true;
            notes.push('登记时剪映正在运行或无法确认状态：草稿已生成，退出剪映后再点「加入剪映」补登记');
            noteIssue(issues, INFO, 'app-running', '剪映正在运行，这次没有改草稿库索引；退出后可补登记');
          } else {
            notes.push(`草稿已生成，但没加进剪映列表：${registeredResult?.error || '未知原因'}`);
            noteIssue(issues, WARN, 'register-failed', registeredResult?.error || '没能加入剪映草稿列表');
          }
        }
      }
    }

    /* 导出报告与说明：写失败不影响草稿本身 */
    try {
      const reportDoc = exportReport.buildReport({
        request: { ...request, nowMs },
        draft,
        result,
        issues,
        plannedBytes,
        copiedBytes,
      });
      writeFile(result.reportPath, JSON.stringify(reportDoc, null, 1));
      writeFile(
        path.join(finalDir, '导出说明.md'),
        exportReport.explanationText({ result, issues, appVersion: request?.appVersion, mode, hasSrt: !!plan?.srt }),
      );
    } catch {
      noteIssue(issues, INFO, 'report-failed', '导出报告没写出来（草稿本身不受影响）');
    }
    return result;
  } catch (error) {
    if (error?.code === CANCELED || canceled()) return fail(canceledError(), { canceled: true });
    return fail(error);
  } finally {
    /* 失败/取消清理暂存；已提交的草稿目录绝不动 */
    if (!committed && staging) exportFiles.cleanupOwnedStaging({ fs, path, dir: staging });
  }
}

/* 草稿最终资源路径 → 暂存目录里的同名字文件（媒体工具只用暂存路径） */
function resourceSibling(resourcesDir, finalFile) {
  return nodePath.join(resourcesDir, nodePath.basename(finalFile || ''));
}

/* 保持既有导出面：IPC 与测试脚本依赖这些名字，子模块拆分不改变契约 */
module.exports = {
  PHASES,
  CANCELED,
  createMediaTools: mediaTools.createMediaTools,
  runJianyingExport,
  copyWithProgress: exportFiles.copyWithProgress,
  cleanupOwnedStaging: exportFiles.cleanupOwnedStaging,
  cleanupStaleStaging: exportFiles.cleanupStaleStaging,
  usedPlanIds: preflight.usedPlanIds,
  FALLBACK_COVER,
};
