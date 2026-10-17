/* 导出前的结构校验：通用导出计划、生成的 draft_info.json、草稿库索引。
   返回问题数组而不是抛错，便于把「阻塞 / 提醒」一起交给界面；调用方决定是否继续。
   问题形状与界面约定一致：{ level: 'block'|'warn'|'info', code, message }。 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

const DRAFT_VERSION = 360000;
const NEW_VERSION = '189.0.0';
const BLOCK = 'block';
const WARN = 'warn';
const INFO = 'info';
const KINDS = new Set(['video', 'audio', 'image']);

const issue = (level, code, message) => ({ level, code, message });
const isInt = value => Number.isInteger(value);
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const tableOf = (value, fallback = []) => (Array.isArray(value) ? value : fallback);

function assetIndex(plan) {
  const map = new Map();
  for (const asset of tableOf(plan?.assets)) map.set(asset?.planId, { ...asset, derived: false });
  for (const freeze of tableOf(plan?.derived)) map.set(freeze?.planId, { ...freeze, derived: true, kind: 'image' });
  return map;
}

/* 轨道片段的基础时间/引用校验；type 决定哪些字段必须存在 */
function validateSegments(plan, issues) {
  const assets = assetIndex(plan);
  const durationUs = plan?.durationUs;
  for (const [type, key] of [
    ['video', 'video'],
    ['audio', 'audio'],
    ['text', 'text'],
  ]) {
    const list = tableOf(plan?.tracks?.[key]);
    const seen = new Set();
    let previousEnd = 0;
    list.forEach((item, index) => {
      const at = `${type}[${index}]`;
      if (item?.id !== undefined && item.id !== null && typeof item.id !== 'string')
        issues.push(issue(BLOCK, 'plan-segment-id', `${at} 的片段 ID 不是字符串`));
      if (!isInt(item?.targetStartUs) || item.targetStartUs < 0)
        issues.push(issue(BLOCK, 'plan-segment-time', `${at} 的目标起点不是非负整数微秒`));
      if (!isInt(item?.targetDurationUs) || item.targetDurationUs <= 0)
        issues.push(issue(BLOCK, 'plan-segment-time', `${at} 的目标时长不是正整数微秒`));
      if (isInt(item?.targetStartUs) && isInt(item?.targetDurationUs) && isInt(durationUs)) {
        if (item.targetStartUs + item.targetDurationUs > durationUs)
          issues.push(issue(BLOCK, 'plan-segment-overflow', `${at} 超出草稿总时长`));
        if (item.targetStartUs < previousEnd)
          issues.push(issue(BLOCK, 'plan-segment-overlap', `${at} 与同轨上一段重叠`));
        previousEnd = Math.max(previousEnd, item.targetStartUs + item.targetDurationUs);
      }
      if (type !== 'text') {
        const asset = assets.get(item?.assetId);
        if (!asset) issues.push(issue(BLOCK, 'plan-asset-ref', `${at} 引用了导出计划里不存在的素材`));
        if (!isInt(item?.sourceStartUs) || item.sourceStartUs < 0)
          issues.push(issue(BLOCK, 'plan-segment-source', `${at} 的源起点不是非负整数微秒`));
        if (!isInt(item?.sourceDurationUs) || item.sourceDurationUs <= 0)
          issues.push(issue(BLOCK, 'plan-segment-source', `${at} 的源时长不是正整数微秒`));
        if (
          asset &&
          !asset.derived &&
          asset.kind === 'video' &&
          isInt(item?.sourceStartUs) &&
          isInt(item?.sourceDurationUs)
        ) {
          const known = Number(asset.durationUs);
          if (Number.isFinite(known) && known > 0 && item.sourceStartUs + item.sourceDurationUs > known + 1) {
            issues.push(issue(BLOCK, 'plan-source-out-of-range', `${at} 要用的源区间超出了素材时长`));
          }
        }
        if (asset && asset.kind === 'video' && !isInt(item?.sourceDurationUs))
          issues.push(issue(BLOCK, 'plan-segment-source', `${at} 缺少源时长`));
      } else if (typeof item?.text !== 'string' || !item.text.trim()) {
        issues.push(issue(BLOCK, 'plan-text-empty', `${at} 的字幕文字为空`));
      }
      if (typeof item?.id === 'string' && item.id) {
        if (seen.has(item.id))
          issues.push(issue(WARN, 'plan-segment-duplicate', `${at} 的片段 ID 重复，导出时会重新分配`));
        seen.add(item.id);
      }
    });
  }
}

/* 通用导出计划：只查结构与可写路径，不读文件系统之外的任何东西 */
function validatePlan(plan, { requireVisual = true } = {}) {
  const issues = [];
  if (!isPlainObject(plan)) return [issue(BLOCK, 'plan-missing', '没有拿到导出计划')];
  if (plan.schemaVersion !== 1) issues.push(issue(BLOCK, 'plan-schema', '导出计划版本不受支持'));
  const width = plan?.canvas?.width;
  const height = plan?.canvas?.height;
  if (!isInt(width) || width <= 0 || !isInt(height) || height <= 0)
    issues.push(issue(BLOCK, 'plan-canvas', '画布尺寸无效'));
  const num = Number(plan?.fps?.num);
  const den = Number(plan?.fps?.den);
  if (!(num > 0) || !(den > 0)) issues.push(issue(BLOCK, 'plan-fps', '帧率无效'));
  if (!isInt(plan.durationUs) || plan.durationUs <= 0) issues.push(issue(BLOCK, 'plan-duration', '草稿总时长无效'));

  const ids = new Set();
  const assetIds = new Set();
  tableOf(plan?.assets).forEach((asset, index) => {
    const at = `assets[${index}]`;
    if (typeof asset?.planId !== 'string' || !asset.planId)
      issues.push(issue(BLOCK, 'plan-asset-id', `${at} 缺少素材 ID`));
    else if (ids.has(asset.planId)) issues.push(issue(BLOCK, 'plan-asset-id', `${at} 的素材 ID 重复`));
    else {
      ids.add(asset.planId);
      assetIds.add(asset.planId);
    }
    if (!KINDS.has(asset?.kind)) issues.push(issue(BLOCK, 'plan-asset-kind', `${at} 的素材类型不认识`));
    if (!paths.isAbsolutePath(asset?.path)) issues.push(issue(BLOCK, 'plan-asset-path', `${at} 的路径不是绝对路径`));
    else if (paths.hasTraversal(asset.path)) issues.push(issue(BLOCK, 'plan-asset-path', `${at} 的路径包含 ..`));
  });
  tableOf(plan?.derived).forEach((freeze, index) => {
    const at = `derived[${index}]`;
    if (freeze?.type !== 'freeze') issues.push(issue(BLOCK, 'plan-derived-type', `${at} 不是定格派生`));
    if (typeof freeze?.planId !== 'string' || !freeze.planId)
      issues.push(issue(BLOCK, 'plan-derived-id', `${at} 缺少派生 ID`));
    else if (ids.has(freeze.planId)) issues.push(issue(BLOCK, 'plan-derived-id', `${at} 的派生 ID 与素材重复`));
    else {
      ids.add(freeze.planId);
      assetIds.add(freeze.planId);
    }
    if (!assetIds.has(freeze?.sourceAssetId))
      issues.push(issue(BLOCK, 'plan-derived-source', `${at} 的源素材不在计划里`));
    if (!paths.isAbsolutePath(freeze?.sourcePath))
      issues.push(issue(BLOCK, 'plan-derived-source', `${at} 的源路径不是绝对路径`));
    if (!Number.isFinite(freeze?.atUs) || freeze.atUs < 0)
      issues.push(issue(BLOCK, 'plan-derived-time', `${at} 的抽帧时间无效`));
    if (typeof freeze?.outputName !== 'string' || !freeze.outputName.trim())
      issues.push(issue(BLOCK, 'plan-derived-name', `${at} 缺少输出文件名`));
  });

  validateSegments(plan, issues);
  if (requireVisual && !tableOf(plan?.tracks?.video).length)
    issues.push(issue(BLOCK, 'plan-empty', '导出计划里没有画面片段'));
  return issues;
}

/* draft_info.json：引用完整性、时间边界、素材路径必须指向最终草稿目录 / Resources */
function validateDraftInfo(doc, { draftDir, resourceDir, plan, checkFiles = fs } = {}) {
  const issues = [];
  if (!isPlainObject(doc)) return [issue(BLOCK, 'draft-missing', '没有生成草稿结构')];
  if (doc.version !== DRAFT_VERSION) issues.push(issue(BLOCK, 'draft-version', '草稿版本号不对'));
  if (doc.new_version !== NEW_VERSION) issues.push(issue(BLOCK, 'draft-version', '草稿新版本号不对'));
  if (typeof doc.id !== 'string' || !doc.id) issues.push(issue(BLOCK, 'draft-id', '草稿缺少 ID'));
  if (typeof doc.name !== 'string' || !doc.name) issues.push(issue(BLOCK, 'draft-name', '草稿缺少名称'));
  if (typeof draftDir === 'string' && doc.path !== draftDir)
    issues.push(issue(BLOCK, 'draft-path', '草稿目录与计划不一致'));
  if (!Number.isInteger(doc.duration) || doc.duration <= 0)
    issues.push(issue(BLOCK, 'draft-duration', '草稿总时长无效'));
  if (!(Number(doc.fps) > 0)) issues.push(issue(BLOCK, 'draft-fps', '草稿帧率无效'));
  if (!(Number(doc.canvas_config?.width) > 0) || !(Number(doc.canvas_config?.height) > 0))
    issues.push(issue(BLOCK, 'draft-canvas', '草稿画布无效'));

  const materialIds = new Set();
  const idToList = new Map();
  const lists = doc.materials && typeof doc.materials === 'object' ? doc.materials : {};
  for (const [list, items] of Object.entries(lists)) {
    if (!Array.isArray(items)) {
      issues.push(issue(BLOCK, 'draft-material-list', `素材分组 ${list} 不是数组`));
      continue;
    }
    for (const item of items) {
      const id = item?.id;
      if (typeof id !== 'string' || !id) {
        issues.push(issue(BLOCK, 'draft-material-id', `素材分组 ${list} 里有条目缺少 ID`));
        continue;
      }
      if (materialIds.has(id)) issues.push(issue(BLOCK, 'draft-material-duplicate', `素材 ID 重复：${id}`));
      materialIds.add(id);
      idToList.set(id, list);
    }
  }

  const resourcesFinal = typeof draftDir === 'string' ? paths.draftResourcesDir(draftDir) : '';
  const segmentIds = new Set();
  const tracks = tableOf(doc.tracks);
  if (!tracks.length) issues.push(issue(BLOCK, 'draft-empty', '草稿里没有轨道'));
  tracks.forEach((track, ti) => {
    const type = track?.type;
    if (!['video', 'audio', 'text'].includes(type))
      issues.push(issue(BLOCK, 'draft-track', `第 ${ti + 1} 条轨道类型不认识`));
    const segments = tableOf(track?.segments);
    if (!segments.length) issues.push(issue(BLOCK, 'draft-track', `第 ${ti + 1} 条轨道没有片段`));
    let previousEnd = 0;
    segments.forEach((segment, si) => {
      const at = `轨道 ${ti + 1} 第 ${si + 1} 段`;
      if (typeof segment?.id !== 'string' || !segment.id)
        issues.push(issue(BLOCK, 'draft-segment-id', `${at} 缺少 ID`));
      else if (segmentIds.has(segment.id)) issues.push(issue(BLOCK, 'draft-segment-duplicate', `${at} 的 ID 重复`));
      else segmentIds.add(segment.id);
      const start = segment?.target_timerange?.start;
      const length = segment?.target_timerange?.duration;
      if (!Number.isInteger(start) || start < 0 || !Number.isInteger(length) || length <= 0)
        issues.push(issue(BLOCK, 'draft-segment-time', `${at} 的时间范围无效`));
      else {
        if (start + length > doc.duration) issues.push(issue(BLOCK, 'draft-segment-overflow', `${at} 超出草稿总时长`));
        if (start < previousEnd) issues.push(issue(BLOCK, 'draft-segment-overlap', `${at} 与同轨上一段重叠`));
        previousEnd = Math.max(previousEnd, start + length);
      }
      if (!materialIds.has(segment?.material_id))
        issues.push(issue(BLOCK, 'draft-material-missing', `${at} 引用了不存在的素材`));
      const expectedList = type === 'audio' ? 'audios' : type === 'text' ? 'texts' : 'videos';
      if (idToList.get(segment?.material_id) !== expectedList)
        issues.push(issue(BLOCK, 'draft-material-kind', `${at} 的素材类型与轨道不匹配`));
      for (const ref of tableOf(segment?.extra_material_refs))
        if (!materialIds.has(ref)) issues.push(issue(BLOCK, 'draft-ref-missing', `${at} 的附加素材引用不存在`));
      if (type !== 'text') {
        const source = segment?.source_timerange;
        if (
          !Number.isInteger(source?.start) ||
          source.start < 0 ||
          !Number.isInteger(source?.duration) ||
          source.duration <= 0
        )
          issues.push(issue(BLOCK, 'draft-segment-source', `${at} 的源区间无效`));
      }
    });
  });

  /* 素材路径：绝对最终路径、只指向本次草稿的 Resources、文件真的在（resourceDir 允许是暂存目录） */
  for (const list of ['videos', 'audios']) {
    for (const item of tableOf(lists[list])) {
      const file = item?.path;
      if (!paths.isAbsolutePath(file)) {
        issues.push(issue(BLOCK, 'draft-material-path', `${list} 里的素材不是绝对路径`));
        continue;
      }
      if (resourcesFinal && path.dirname(file) !== resourcesFinal)
        issues.push(issue(BLOCK, 'draft-material-path', `${path.basename(file)} 没有指向草稿的 Resources`));
      if (checkFiles && typeof resourceDir === 'string') {
        const onDisk = path.join(resourceDir, path.basename(file));
        if (!checkFiles.existsSync(onDisk))
          issues.push(issue(BLOCK, 'draft-material-file', `素材文件不在草稿里：${path.basename(file)}`));
      }
    }
  }
  for (const item of tableOf(lists.texts)) {
    let content = null;
    try {
      content = JSON.parse(item?.content || '');
    } catch {
      issues.push(issue(BLOCK, 'draft-text-content', '文字素材内容不是合法 JSON'));
    }
    if (content && !String(content.text || '').trim())
      issues.push(issue(BLOCK, 'draft-text-empty', '文字素材没有文字'));
  }

  if (plan) {
    const expect = {
      video: tableOf(plan?.tracks?.video).length,
      audio: tableOf(plan?.tracks?.audio).length,
      text: tableOf(plan?.tracks?.text).length,
    };
    const actual = { video: 0, audio: 0, text: 0 };
    for (const track of tracks)
      if (actual[track?.type] !== undefined) actual[track.type] += tableOf(track?.segments).length;
    for (const type of ['video', 'audio', 'text'])
      if (actual[type] !== expect[type])
        issues.push(issue(BLOCK, 'draft-segment-count', `${type} 片段数量与导出计划不一致`));
    if (Number.isInteger(doc.duration) && Number.isInteger(plan.durationUs) && doc.duration !== plan.durationUs)
      issues.push(issue(BLOCK, 'draft-duration', '草稿总时长与导出计划不一致'));
  }
  return issues;
}

/* root_meta_info.json：只检查能不能安全地追加一条，结构不认识就停手 */
function validateIndexDoc(doc) {
  const issues = [];
  if (!isPlainObject(doc) || !Array.isArray(doc.all_draft_store))
    return [issue(BLOCK, 'index-shape', '草稿库索引结构不认识，未做任何修改')];
  const ids = new Set();
  doc.all_draft_store.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      issues.push(issue(BLOCK, 'index-entry', `索引第 ${index + 1} 条不是对象`));
      return;
    }
    if (typeof entry.draft_id !== 'string' || !entry.draft_id)
      issues.push(issue(BLOCK, 'index-entry', `索引第 ${index + 1} 条缺少 draft_id`));
    else if (ids.has(entry.draft_id))
      issues.push(issue(WARN, 'index-entry', `索引里 draft_id 重复：${entry.draft_id}`));
    else ids.add(entry.draft_id);
    if (typeof entry.draft_name !== 'string')
      issues.push(issue(WARN, 'index-entry', `索引第 ${index + 1} 条缺少草稿名`));
  });
  return issues;
}

module.exports = {
  BLOCK,
  WARN,
  INFO,
  validatePlan,
  validateDraftInfo,
  validateIndexDoc,
};
