/* 项目字段的唯一清单：加载、保存、交换文件、撤销和协作据此选择字段。
   项目身份、光标、协作连接信息属于外层；文件目录和语速不跟随普通编辑撤销。 */
import { normalizeTypes } from './types.js';
import { normalizeReworkRequests } from './candidate-scope.js';

export const PROJECT_FIELDS = Object.freeze({
  title: { initial: () => '', history: true, shared: 'meta' },
  rows: { initial: () => [], history: true, shared: 'rows' },
  assets: { initial: () => ({}), history: true, shared: 'assets' },
  types: { initial: () => normalizeTypes(null), history: true, shared: 'meta' },
  timing: { initial: () => null, history: true, shared: 'meta', omit: value => !value },
  voice: { initial: () => null, history: true, shared: 'meta', omit: value => !value },
  candidates: { initial: () => [], history: true, shared: 'candidates', omit: value => !value?.length },
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

/* 外部项目进入应用时统一补默认值；句子、素材和候选的详细校验仍由各自模型负责。 */
export function normalizeProjectData(project) {
  const data = projectData(project);
  data.title = typeof data.title === 'string' ? data.title : '';
  data.rows = Array.isArray(data.rows) ? data.rows : [];
  data.assets = data.assets && typeof data.assets === 'object' && !Array.isArray(data.assets) ? data.assets : {};
  data.types = normalizeTypes(data.types);
  data.timing = data.timing && Array.isArray(data.timing.cues) ? data.timing : null;
  data.voice = data.voice && typeof data.voice.path === 'string' ? data.voice : null;
  // 2.1.0 起候选都记着给哪几句（forIds）；旧格式清单导入的候选不再保留，已通过挂上的素材留在表格里
  data.candidates = Array.isArray(data.candidates)
    ? data.candidates.filter(c => Array.isArray(c?.forIds) && c.forIds.length)
    : [];
  data.reworkRequests = normalizeReworkRequests(data.reworkRequests);
  data.mediaDir = typeof data.mediaDir === 'string' ? data.mediaDir : '';
  const rate = Number(data.speechRate);
  data.speechRate = rate >= 1 && rate <= 10 ? rate : 4.5;
  return data;
}
