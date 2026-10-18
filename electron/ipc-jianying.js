/* 剪映导出的 IPC 通道：参数校验、任务 ID、单任务、取消、进度与结果事件。
   sender 校验由 main.js 的 handle 包装统一负责；这里只处理已授权的界面页请求。
   事件按 jobId 归属，只发给发起任务的窗口；跨窗口/换项目不会串台。 */
const { app, dialog, shell } = require('electron');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const platform = require('./jianying/platform');
const paths = require('./jianying/paths');
const register = require('./jianying/register');
const exporter = require('./jianying-export');

const CHANNELS = Object.freeze({
  DETECT: 'jianying:detect',
  EXPORT: 'jianying:export',
  CANCEL: 'jianying:cancel',
  REGISTER: 'jianying:register',
  REVEAL: 'jianying:reveal',
  OPEN_APP: 'jianying:open-app',
  PICK_FOLDER: 'jianying:pick-folder',
  PROGRESS: 'jianying:progress',
  RESULT: 'jianying:result',
});
const JOB_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_NAME = 200;

const isString = value => typeof value === 'string';
const validName = value => isString(value) && value.length > 0 && value.length <= MAX_NAME;

/* 计划里的路径：必须绝对、不含 .. 段；真正的文件/区间校验在导出任务里再做一遍 */
function checkPlanPath(value, issues) {
  if (!paths.isAbsolutePath(value)) issues.push('导出计划里有不是绝对路径的素材');
  else if (paths.hasTraversal(value)) issues.push('导出计划里有包含 .. 的路径');
}

function validateExportRequest(req) {
  if (!req || typeof req !== 'object') return { ok: false, error: '导出请求无效' };
  if (!isString(req.jobId) || !JOB_ID_RE.test(req.jobId)) return { ok: false, error: '任务 ID 无效' };
  if (!isString(req.projectId) || !req.projectId || req.projectId.length > MAX_NAME)
    return { ok: false, error: '项目 ID 无效' };
  const plan = req.plan;
  if (!plan || typeof plan !== 'object' || plan.schemaVersion !== 1)
    return { ok: false, error: '导出计划版本不受支持，请更新分镜台' };
  if (!plan.canvas || !(Number(plan.canvas.width) > 0) || !(Number(plan.canvas.height) > 0))
    return { ok: false, error: '导出计划缺少画布尺寸' };
  const options = req.options && typeof req.options === 'object' ? req.options : {};
  const mode = options.mode === 'folder' ? 'folder' : 'library';
  if (mode === 'folder') {
    if (!paths.isAbsolutePath(options.destDir)) return { ok: false, error: '没有选择保存草稿的文件夹' };
    if (paths.hasTraversal(options.destDir)) return { ok: false, error: '保存文件夹路径无效' };
  }
  if (options.draftName !== undefined && !validName(options.draftName)) return { ok: false, error: '草稿名称无效' };
  if (req.snapshot?.title !== undefined && !isString(req.snapshot.title)) return { ok: false, error: '项目标题无效' };
  const pathIssues = [];
  for (const asset of Array.isArray(plan.assets) ? plan.assets : []) checkPlanPath(asset?.path, pathIssues);
  for (const freeze of Array.isArray(plan.derived) ? plan.derived : []) checkPlanPath(freeze?.sourcePath, pathIssues);
  for (const alt of Array.isArray(plan.altAssets) ? plan.altAssets : []) checkPlanPath(alt?.path, pathIssues);
  if (pathIssues.length) return { ok: false, error: pathIssues[0] };
  return { ok: true, mode };
}

function registerJianyingIpc({ handle, win, deps = {} } = {}) {
  const electronApp = deps.app || app;
  const electronDialog = deps.dialog || dialog;
  const electronShell = deps.shell || shell;
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const detect = deps.detect || (() => platform.detect());
  const isRunning = deps.isRunning || (() => platform.isRunning());
  /* 默认导出必须把实时运行检测交给任务：request.running 只是请求开始时的旧快照，
     复制素材的几十秒里用户可能已经打开剪映，登记时要按实时状态判断。
     其他依赖照旧传下去，测试仍可注入媒体工具/时钟。 */
  const runExport =
    deps.runExport || ((request, hooks) => exporter.runJianyingExport(request, hooks, { ...deps, isRunning }));
  const registerDraft = deps.registerDraft || register.registerDraft;
  const detectTtl = Number.isFinite(deps.detectTtl) ? deps.detectTtl : 3000;
  const dataDir = () => {
    try {
      return path.join(electronApp.getPath('userData'), '剪映导出');
    } catch {
      return '';
    }
  };
  const backupDir = () => {
    const dir = dataDir();
    return dir ? path.join(dir, '索引备份') : '';
  };

  let job = null; // { jobId, projectId, controller, senderId }
  let detectCache = null; // { at, value }

  const detectNow = () => {
    if (detectCache && Date.now() - detectCache.at < detectTtl) return detectCache.value;
    let value;
    try {
      value = detect();
    } catch (error) {
      value = { ok: false, error: String(error?.message || error), issues: [] };
    }
    detectCache = { at: Date.now(), value };
    return value;
  };
  /* 实时运行状态：判断不了就当剪映在运行（只生成草稿、不写索引）；
     known=false 表示检测本身失败了，需要给用户「无法确认」的说明而不是断言在运行。 */
  const runningState = () => {
    if (typeof isRunning !== 'function') return { running: false, known: true };
    try {
      return { running: !!isRunning(), known: true };
    } catch {
      return { running: true, known: false };
    }
  };
  const runningNow = () => runningState().running;

  /* 探测本机剪映与草稿库 */
  handle(CHANNELS.DETECT, () => {
    const detected = detectNow();
    return { ...detected, running: detected.running || runningNow() };
  });

  /* 开始导出：立即返回 jobId，进度/结果走事件；同一时间只允许一个任务 */
  handle(CHANNELS.EXPORT, (e, req) => {
    const checked = validateExportRequest(req);
    if (!checked.ok) return { ok: false, error: checked.error };
    if (job) return { ok: false, error: '正在导出另一个剪映草稿，等它做完再试' };
    const detected = detectNow();
    /* 版本未验证（含已安装但版本未知）一律不生成、不登记：只有探测到 supported=true
       才继续，真正的登记还会再核对 canRegister / 索引状态。文案与 platform 共用一处。 */
    if (detected?.supported === false)
      return { ok: false, error: platform.unsupportedVersionMessage(detected.version) };
    const jobId = req.jobId;
    const controller = new AbortController();
    job = { jobId, projectId: req.projectId, controller, senderId: e?.sender?.id ?? 0 };
    const sender = e?.sender;
    const emit = (channel, payload) => {
      try {
        if (sender && !sender.isDestroyed()) sender.send(channel, payload);
      } catch {}
    };
    const publishProgress = progress => emit(CHANNELS.PROGRESS, { ...progress, jobId });
    const begin = () =>
      runExport(
        {
          plan: req.plan,
          options: req.options,
          snapshot: req.snapshot,
          draftRoot: detected?.draftRoot || '',
          running: !!detected?.running,
          fingerprint: detected?.fingerprint || null,
          appVersion: detected?.version || '',
          osVersion: detected?.fingerprint?.platform?.os_version || '',
          backupDir: backupDir(),
        },
        { signal: controller.signal, onProgress: publishProgress },
      );
    Promise.resolve()
      .then(begin)
      .then(result => emit(CHANNELS.RESULT, { ...result, jobId }))
      .catch(error =>
        emit(CHANNELS.RESULT, {
          jobId,
          ok: false,
          canceled: !!error?.canceled,
          error: String(error?.message || error),
          phase: 'unknown',
          issues: [],
        }),
      )
      .finally(() => {
        if (job && job.jobId === jobId) job = null;
      });
    return { ok: true, jobId };
  });

  /* 取消：只取消当前任务；取消后仍会收到一次 jobId 匹配的 result（canceled:true） */
  handle(CHANNELS.CANCEL, (_e, jobId) => {
    if (!job || !isString(jobId) || job.jobId !== jobId) return false;
    try {
      job.controller.abort();
    } catch {}
    return true;
  });

  /* 退出剪映后补登记：只接受草稿库里的草稿目录，并重新生成索引条目 */
  handle(CHANNELS.REGISTER, async (_e, req) => {
    const draftDir = req?.draftDir;
    if (!isString(draftDir) || !paths.isAbsolutePath(draftDir) || paths.hasTraversal(draftDir))
      return { ok: false, registered: false, error: '草稿路径无效' };
    const detected = detectNow();
    /* 登记会写剪映草稿库索引：版本未验证时和导出入口一样拒绝，不能绕过导出直接登记。 */
    if (detected?.supported === false)
      return { ok: false, registered: false, error: platform.unsupportedVersionMessage(detected.version) };
    if (!paths.isAbsolutePath(detected?.draftRoot)) return { ok: false, registered: false, error: '没找到剪映草稿库' };
    if (!paths.insideDir(detected.draftRoot, draftDir))
      return { ok: false, registered: false, error: '这个目录不在剪映草稿库里' };
    const running = runningState();
    if (running.running)
      return {
        ok: false,
        registered: false,
        needsQuit: true,
        error: running.known
          ? '剪映正在运行，退出后再加入草稿库'
          : '无法确认剪映是否已经退出，为安全起见没有加入草稿库',
      };
    try {
      return registerDraft({
        draftRoot: detected.draftRoot,
        draftDir,
        backupDir: backupDir(),
        /* 兜底再查一次：两次检查之间剪映可能刚被打开，register.js 会在写索引前调用 */
        isRunning: runningNow,
        fs,
        path,
      });
    } catch (error) {
      return { ok: false, registered: false, error: String(error?.message || error) };
    }
  });

  /* 在访达里显示草稿或文件 */
  handle(CHANNELS.REVEAL, (_e, target) => {
    if (!isString(target) || !paths.isAbsolutePath(target)) return { ok: false, error: '路径无效' };
    try {
      if (!fs.existsSync(target)) return { ok: false, error: '文件不在了' };
    } catch {
      return { ok: false, error: '文件不在了' };
    }
    electronShell.showItemInFolder(target);
    return { ok: true };
  });

  /* 打开剪映应用（不是「打开草稿」：没有实测的直达草稿入口） */
  handle(CHANNELS.OPEN_APP, async () => {
    const detected = detectNow();
    if (!detected?.appPath) return { ok: false, error: '没有找到剪映应用' };
    try {
      const error = await electronShell.openPath(detected.appPath);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  /* 选择「保存草稿文件夹」的目标目录 */
  handle(CHANNELS.PICK_FOLDER, async (_e, current) => {
    const fallback = (() => {
      try {
        return electronApp.getPath('videos');
      } catch {
        return '';
      }
    })();
    const defaultPath =
      isString(current) && paths.isAbsolutePath(current) && fs.existsSync(current) ? current : fallback;
    const result = await electronDialog.showOpenDialog(win?.(), {
      title: '选择保存草稿的文件夹',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });
}

module.exports = { registerJianyingIpc, validateExportRequest, CHANNELS };
