/* 原生能力的唯一出入口：其余模块不直接碰 window.native。
   正常走 preload 暴露的 window.native；自测可以用 window.fjtHooks 注入替身
   （contextBridge 暴露的对象不可覆写，测试替身只能从这个钩子进）。 */
const n = () => window.native;
const hook = name => window.fjtHooks?.[name] || n()?.[name];
const call =
  name =>
  (...args) => {
    const fn = hook(name);
    if (fn) return fn(...args);
    if (!n()) return Promise.resolve(null); // 浏览器里预览：本来就没有原生能力
    // 主进程少了这条通道（版本不配套）：报错而不是让按钮点了没反应，main.js 统一提示
    const error = new Error(`这个功能暂时用不了（缺少 ${name}），请重新安装分镜台`);
    error.nativeMissing = true;
    console.error(error);
    return Promise.reject(error);
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
export const saveVideoSegment = call('saveVideoSegment');
export const downloadOriginalVideo = call('downloadOriginalVideo');
export const cancelDownload = call('cancelDownload');
export const tagSavedClip = call('tagSavedClip');
export const retagLineFile = call('retagLineFile');
export const writeCandidateReview = call('writeCandidateReview');
export const writeReworkDoc = call('writeReworkDoc');
export const revealAsset = call('revealAsset');
export const onSegmentProgress = cb => n()?.onSegmentProgress?.(cb);
export const onDownloadProgress = cb => n()?.onDownloadProgress?.(cb);

/* 项目打包（ZIP） */
export const packSizes = call('packSizes');
export const packExport = call('packExport');
export const packInspect = call('packInspect');
export const packPickDest = call('packPickDest');
export const packExtract = call('packExtract');
export const packCancel = call('packCancel');
export const onPackProgress = cb => n()?.onPackProgress?.(cb);

/* 局域网协作 */
export const collabMachine = call('collabMachine');
export const collabHostStart = call('collabHostStart');
export const collabHostUpdate = call('collabHostUpdate');
export const collabHostStop = call('collabHostStop');
export const collabDiscover = call('collabDiscover');
export const collabConnect = call('collabConnect');
export const collabSend = call('collabSend');
export const collabClose = call('collabClose');
export const collabAddresses = call('collabAddresses');
export const collabFileOffer = call('collabFileOffer');
export const collabFileFetch = call('collabFileFetch');
export const collabFileExpect = call('collabFileExpect');
export const collabFilePush = call('collabFilePush');
export const collabFileCancel = call('collabFileCancel');
export const collabFileInfo = call('collabFileInfo');
export const collabFindFiles = call('collabFindFiles');
export const collabFindCancel = call('collabFindCancel');
export const onCollabEvent = cb => n()?.onCollabEvent?.(cb);

/* 应用内更新 */
export const checkUpdate = call('checkUpdate');
export const downloadUpdate = call('downloadUpdate');
export const cancelUpdate = call('cancelUpdate');
export const installUpdate = call('installUpdate');
export const onUpdateProgress = cb => n()?.onUpdateProgress?.(cb);

/* 菜单 / 系统 */
export const onMenuAction = cb => n().onMenuAction(cb);
export const fixtureInfo = () => n()?.fixtureInfo?.() || null;
