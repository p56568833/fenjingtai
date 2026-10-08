/* 原生能力的唯一出入口：其余模块不直接碰 window.native。
   正常走 preload 暴露的 window.native；自测可以用 window.fjtHooks 注入替身
   （contextBridge 暴露的对象不可覆写，测试替身只能从这个钩子进）。 */
const n = () => window.native;
const hook = name => window.fjtHooks?.[name] || n()?.[name];
const call =
  name =>
  (...args) => {
    const fn = hook(name);
    return fn ? fn(...args) : Promise.resolve(null);
  };

export const isNative = () => !!window.native;

/* 数据 */
export const loadData = () => n().loadData();
export const dataStatus = () => n().dataStatus?.() || null;
export const saveData = patch => n().saveData(patch);
export const saveDataSync = patch => n().saveDataSync(patch);
export const listBackups = () => n().listBackups();
export const restoreBackup = f => n().restoreBackup(f);
export const openDataFolder = () => n().openDataFolder?.();

/* 文件 */
export const exportFile = (name, content) => n().exportFile(name, content);
export const exportPdf = (name, doc) => n().exportPdf(name, doc);
export const importFile = kind => n().importFile(kind);
export const readScriptFile = call('readScriptFile');
export const pickAssets = call('pickAssets');
export const pickOneAsset = call('pickOneAsset');
export const pickVoice = call('pickVoice');
export const pickFolderFiles = call('pickFolderFiles');
export const openAsset = call('openAsset');
export const previewImage = path => n()?.previewImage(path);
export const probeAssets = paths => (n()?.probeAssets ? n().probeAssets(paths) : Promise.resolve({}));
export const getPathForFile = file => (n()?.getPathForFile ? n().getPathForFile(file) : '') || file?.path || '';

/* 视频审核 */
export const pickFolder = call('pickFolder');
export const hasFfmpeg = call('hasFfmpeg');
export const saveVideoSegment = call('saveVideoSegment');
export const downloadOriginalVideo = call('downloadOriginalVideo');
export const tagSavedClip = call('tagSavedClip');
export const writeCandidateReview = call('writeCandidateReview');
export const revealAsset = call('revealAsset');
export const onSegmentProgress = cb => n()?.onSegmentProgress?.(cb);
export const onDownloadProgress = cb => n()?.onDownloadProgress?.(cb);

/* 菜单 / 系统 */
export const onMenuAction = cb => n().onMenuAction(cb);
export const fixtureInfo = () => n()?.fixtureInfo?.() || null;
