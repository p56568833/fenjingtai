/* 项目字段的唯一清单：加载、保存、交换文件、撤销和协作据此选择字段。
   项目身份、光标、协作连接信息属于外层；文件目录和语速不跟随普通编辑撤销。 */
import { normalizeTypes } from './types.js';
import { normalizeReworkRequests } from './candidate-scope.js';
import { noteLine } from './candidate-values.js';
import { normalizeReviewBatches } from './review-batches.js';

export const PROJECT_FIELDS = Object.freeze({
  title: { initial: () => '', history: true, shared: 'meta' },
  rows: { initial: () => [], history: true, shared: 'rows' },
  assets: { initial: () => ({}), history: true, shared: 'assets' },
  types: { initial: () => normalizeTypes(null), history: true, shared: 'meta' },
  langMode: { initial: () => '', history: true, shared: 'meta', omit: value => !value },
  timing: { initial: () => null, history: true, shared: 'meta', omit: value => !value },
  subTiming: { initial: () => null, history: true, shared: 'meta', omit: value => !value },
  voice: { initial: () => null, history: true, shared: 'meta', omit: value => !value },
  candidates: { initial: () => [], history: true, shared: 'candidates', omit: value => !value?.length },
  reviewBatches: {
    initial: () => ({}),
    history: true,
    shared: 'meta',
    omit: value => !Object.keys(value || {}).length,
  },
  reworkRequests: {
    initial: () => ({}),
    history: true,
    shared: 'meta',
    omit: value => !Object.keys(value || {}).length,
  },
  mediaDir: { initial: () => '', history: false, shared: false, omit: value => !value },
  speechRate: { initial: () => 4.5, history: false, shared: 'meta' },
});

export const projectFieldKeys = scope =>
  Object.keys(PROJECT_FIELDS).filter(key =>
    scope === 'history'
      ? PROJECT_FIELDS[key].history
      : scope === 'sharedMeta'
        ? PROJECT_FIELDS[key].shared === 'meta'
        : true,
  );

/* 返回字段视图，不深拷贝；跨进程 / 快照在自己的边界序列化。
   storage / exchange 省略空的可选字段，state / history 保留默认值。 */
export function projectData(project, scope = 'state') {
  const result = {};
  for (const key of projectFieldKeys(scope)) {
    const field = PROJECT_FIELDS[key];
    const value = project[key] ?? field.initial();
    if ((scope === 'storage' || scope === 'exchange') && field.omit?.(value)) continue;
    result[key] = value;
  }
  return result;
}

export function applyProjectData(target, source, scope = 'state') {
  const data = projectData(source, scope);
  for (const key of projectFieldKeys(scope)) {
    if (Object.hasOwn(data, key)) target[key] = data[key];
    else delete target[key];
  }
  return target;
}

function normalizeTimingField(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cues)) return null;
  const cues = raw.cues
    .filter(
      c =>
        c &&
        typeof c === 'object' &&
        typeof c.start === 'number' &&
        typeof c.end === 'number' &&
        Number.isFinite(c.start) &&
        Number.isFinite(c.end) &&
        c.start >= 0 &&
        c.end > c.start &&
        typeof c.text === 'string',
    )
    .map(c => ({
      start: c.start,
      end: c.end,
      text: c.text,
      ...(Array.isArray(c.rawLines) ? { rawLines: c.rawLines.filter(l => typeof l === 'string') } : {}),
    }));
  return {
    ...raw,
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.raw === 'string' ? { raw: raw.raw } : {}),
    cues,
  };
}

/* 外部项目进入应用时统一补默认值；句子、素材和候选的详细校验仍由各自模型负责。 */
export function normalizeProjectData(project) {
  const data = projectData(project);
  data.title = typeof data.title === 'string' ? data.title : '';
  data.rows = Array.isArray(data.rows) ? data.rows.map(r => (r && typeof r === 'object' ? { ...r } : r)) : [];
  data.assets = data.assets && typeof data.assets === 'object' && !Array.isArray(data.assets) ? data.assets : {};
  data.types = normalizeTypes(data.types);
  data.langMode = data.langMode === 'en-zh' ? 'en-zh' : '';
  data.timing = normalizeTimingField(data.timing);
  data.subTiming = normalizeTimingField(data.subTiming);
  if (data.voice && typeof data.voice === 'object' && typeof data.voice.path === 'string' && data.voice.path.trim()) {
    const path = data.voice.path.trim();
    const duration = typeof data.voice.duration === 'number' ? data.voice.duration : Number(data.voice.duration);
    data.voice = {
      path,
      ...(typeof data.voice.name === 'string' && data.voice.name ? { name: data.voice.name } : {}),
      ...(data.voice.duration != null && Number.isFinite(duration) && duration > 0 ? { duration } : {}),
    };
  } else {
    data.voice = null;
  }
  // 2.1.0 起候选都记着给哪几句（forIds）；旧格式清单导入的候选不再保留，已通过挂上的素材留在表格里
  // 2.1.4 起审核结果只有通过 / 不要：旧的「换一个」（re）并成「不要」，意见原样保留
  data.candidates = Array.isArray(data.candidates)
    ? data.candidates
        .filter(c => Array.isArray(c?.forIds) && c.forIds.length)
        .map(c => (c.decision === 're' ? { ...c, decision: 'no' } : { ...c }))
    : [];
  data.reviewBatches = normalizeReviewBatches(data.reviewBatches, data.candidates);
  // 2.1.4 以前通过候选会往画面描述里追加一行来源（「视频：标题｜时间段｜版权｜网址」）：摘掉，来源只记在素材上
  const sourceLines = new Set(data.candidates.filter(c => c.decision === 'ok' && c.url).map(noteLine));
  if (sourceLines.size)
    for (const r of data.rows)
      if (typeof r?.note === 'string' && r.note.includes('视频：'))
        r.note = r.note
          .split('\n')
          .filter(l => !sourceLines.has(l))
          .join('\n');
  data.reworkRequests = normalizeReworkRequests(data.reworkRequests);
  data.mediaDir = typeof data.mediaDir === 'string' ? data.mediaDir : '';
  const rate = Number(data.speechRate);
  data.speechRate = rate >= 1 && rate <= 10 ? rate : 4.5;
  return data;
}
