/* 导出到剪映的控制器：预检序号、视图代次、配置 / 执行 / 完成状态、当前任务、取消请求和最近结果
   都只放在这里。不碰 DOM：表单值由接线层以纯数据快照传进来，界面渲染由 jianying-export-view.js 负责。
   真正的保存、快照、预检、计划和原生任务都在 app/edit-export.js；这里只编排它们的先后与去重。
   依赖注入 api（默认就是 app/edit-export.js）和定时器，方便 Node 里做纯逻辑单测。 */
import * as editExport from '../app/edit-export.js';
import { isVersionSupported, unsupportedVersionText } from '../core/jianying-target.js';

const PREPARE_DEBOUNCE_MS = 180;

/* 问题级别只有三种语义：阻塞 / 需确认（含旧数据的 warn）/ 提醒。 */
export const levelOf = issue =>
  issue?.level === 'block' ? 'block' : issue?.level === 'confirm' || issue?.level === 'warn' ? 'confirm' : 'info';
const isBlocking = issue => levelOf(issue) === 'block';
const isConfirm = issue => levelOf(issue) === 'confirm';

/* 配置问题和结果问题可能重叠（计划问题 + 文件兜底），合并时按级别 + 位置 + 文案去重。 */
export function mergeIssues(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const issue of group || []) {
      if (!issue || typeof issue !== 'object') continue;
      const key = [levelOf(issue), issue.code, issue.rowId ?? '', issue.assetId ?? '', issue.message ?? ''].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(issue);
    }
  }
  return out;
}

const DEFAULT_OPTIONS = Object.freeze({ width: 1920, height: 1080, fps: 30, subtitles: false, altAssets: false });

function normalizeOptions(raw = {}) {
  return {
    width: Number(raw.width) || DEFAULT_OPTIONS.width,
    height: Number(raw.height) || DEFAULT_OPTIONS.height,
    fps: Number(raw.fps) || DEFAULT_OPTIONS.fps,
    subtitles: !!raw.subtitles,
    altAssets: !!raw.altAssets,
  };
}

export function createJianyingExportController({
  api = editExport,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const listeners = new Set();
  let prepareTimer = null;

  const state = {
    viewToken: 0, // 视图代次：关窗 / 重开后，之前发起的异步回调一律作废
    prepareSeq: 0, // 预检序号：只接受最后一次预检的结果，防止乱序返回覆盖新选项
    pane: 'config', // config | run | done
    formSeq: 0, // 表单装载代次：只有它变化时界面才回填输入框，不跟用户抢输入
    form: { name: '', mode: 'library', options: { ...DEFAULT_OPTIONS }, confirm: false },
    prefs: { mode: 'library', destDir: '', options: { ...DEFAULT_OPTIONS } },
    detection: null,
    snapshot: null,
    prepared: null,
    preparing: false,
    starting: false,
    configIssues: [],
    configError: '',
    running: null, // { jobId, cancelRequested, mode, destDir, options, draftName, progress }
    lastDone: null, // { result, mode, destDir, options, draftName }
    doneIssues: [],
    donePending: 0,
    registering: false,
    blockReason: '',
  };

  function emit(event = null) {
    for (const listener of [...listeners]) {
      try {
        listener(state, event);
      } catch (error) {
        console.error('处理剪映导出状态失败', error);
      }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getState() {
    return state;
  }

  function formOfPrefs(title) {
    return {
      name: title || '未命名项目',
      mode: state.prefs.mode === 'folder' ? 'folder' : 'library',
      options: normalizeOptions(state.prefs.options),
      confirm: false,
    };
  }

  function normalizeForm(raw = {}) {
    const options = raw.options && typeof raw.options === 'object' ? raw.options : state.form.options;
    return {
      name: typeof raw.name === 'string' ? raw.name : state.form.name,
      mode: raw.mode === 'folder' ? 'folder' : 'library',
      options: normalizeOptions(options),
      confirm: !!raw.confirm,
    };
  }

  /* 放行条件：提示文案与按钮状态同源，和原来的 goBlocker 一一对应。 */
  function updateBlockReason() {
    const { detection, prepared, configError, configIssues, preparing, starting, form } = state;
    let reason = '';
    if (starting) reason = '正在准备导出';
    else if (preparing) reason = '正在检查项目和素材';
    else if (!detection) reason = '正在检测剪映';
    else if (detection.unavailable) reason = detection.error || '这个版本还不支持导出到剪映';
    else if (!(detection.ok || detection.version || detection.appPath)) reason = '没找到 Mac 版剪映专业版';
    else if (!isVersionSupported(detection)) reason = unsupportedVersionText(detection.version);
    else if (form.mode === 'library' && !detection.ok) reason = '剪映草稿库暂时不可用，改用「保存草稿文件夹」';
    else if (!prepared?.ok) reason = prepared?.error || configError || '导出计划还没准备好';
    else if (configIssues.some(isBlocking)) reason = '有阻塞问题，先处理后再导出';
    else if (!form.name) reason = '草稿名称不能为空';
    else if (form.mode === 'folder' && !state.prefs.destDir) reason = '先选择草稿保存位置';
    else if (configIssues.some(isConfirm) && !form.confirm) reason = '先勾选确认上面的待确认项';
    state.blockReason = reason;
  }

  function clearPrepareTimer() {
    if (prepareTimer != null) clearTimer(prepareTimer);
    prepareTimer = null;
  }

  /* 选项一变就让在途预检作废：序号先加，旧结果回来时对不上就不会写进状态。 */
  function invalidatePrepare() {
    state.prepareSeq++;
    clearPrepareTimer();
  }

  async function refreshConfig() {
    const seq = ++state.prepareSeq;
    const token = state.viewToken;
    const alive = () => token === state.viewToken && seq === state.prepareSeq;
    state.preparing = true;
    updateBlockReason();
    emit();

    if (!state.snapshot) {
      const captured = api.captureExportSnapshot();
      if (!captured.ok) {
        if (!alive()) return;
        state.preparing = false;
        state.configError = captured.error;
        updateBlockReason();
        emit();
        return;
      }
      state.snapshot = captured.snapshot;
    }
    const snapshot = state.snapshot;
    const options = normalizeOptions(state.form.options);
    const detection = state.detection || (await api.detectJianying());
    if (!alive()) return;
    const prep = await api.prepareJianyingExport(snapshot, options);
    if (!alive()) return;
    state.preparing = false;
    state.detection = detection;
    state.prepared = prep.ok ? prep : null;
    state.configError = prep.ok ? '' : prep.error;
    state.configIssues = prep.ok ? prep.issues : [];
    syncConfirm();
    updateBlockReason();
    emit();
  }

  /* 没有待确认项时确认勾选自然作废，界面回填和放行条件读的是同一份状态 */
  function syncConfirm() {
    if (!state.configIssues.some(isConfirm)) state.form.confirm = false;
  }

  function schedulePrepare() {
    clearPrepareTimer();
    const token = state.viewToken;
    prepareTimer = setTimer(() => {
      prepareTimer = null;
      if (token !== state.viewToken || state.pane !== 'config') return;
      void refreshConfig();
    }, PREPARE_DEBOUNCE_MS);
  }

  function resetConfigState(title) {
    state.prefs = api.loadJianyingSettings();
    state.detection = null;
    state.snapshot = null;
    state.prepared = null;
    state.configIssues = [];
    state.configError = '';
    state.preparing = false;
    state.starting = false;
    state.pane = 'config';
    state.form = formOfPrefs(title);
    state.formSeq++;
  }

  /* ── 打开 / 关闭 ── */
  async function open({ title = '' } = {}) {
    state.viewToken++;
    invalidatePrepare();
    if (state.running) {
      state.pane = 'run';
      updateBlockReason();
      emit();
      return state;
    }
    resetConfigState(title);
    updateBlockReason();
    emit();
    await refreshConfig();
    return state;
  }

  /* 关闭弹窗：任务继续在后台跑，只作废界面这一代的异步回调。 */
  function close() {
    state.viewToken++;
    invalidatePrepare();
    return { background: state.pane === 'run' && !!state.running };
  }

  /* 后台完成后的「查看结果」：不改任务状态，只把视图切到最近一次结果。 */
  function showLastResult() {
    if (!state.lastDone) return false;
    state.viewToken++;
    state.pane = 'done';
    updateBlockReason();
    emit();
    return true;
  }

  /* 从结果页回到配置页：重新读本机设置、重新预检，任务和最近结果都不动。 */
  async function backToConfig({ title = '' } = {}) {
    state.viewToken++;
    invalidatePrepare();
    resetConfigState(title);
    updateBlockReason();
    emit();
    await refreshConfig();
    return state;
  }

  /* ── 表单（纯数据快照） ── */
  function updateForm(form = {}, { persist = false, reprepare = false } = {}) {
    state.form = normalizeForm(form);
    if (persist) {
      state.prefs = { ...state.prefs, mode: state.form.mode, options: { ...state.form.options } };
      api.saveJianyingSettings({ mode: state.form.mode, options: state.form.options });
    }
    if (reprepare) invalidatePrepare();
    updateBlockReason();
    emit();
    if (reprepare) schedulePrepare();
    return state;
  }

  async function pickDest() {
    const picked = await api.pickJianyingFolder(state.prefs.destDir || '');
    if (!picked) return { picked: null };
    state.prefs = { ...state.prefs, destDir: picked };
    api.saveJianyingSettings({ destDir: picked });
    updateBlockReason();
    emit();
    return { picked };
  }

  /* ── 开始生成：重复点击只启动一个任务；本次请求的参数在入口一次固定 ── */
  async function start(form = null) {
    if (form) state.form = normalizeForm(form);
    if (state.starting || state.running) return { started: false };
    updateBlockReason();
    if (state.blockReason) return { started: false };
    /* 名称 / 目录 / 配置 / 确认都取调用这一刻的纯数据：await 之后不再现读 state，
       这样预检期间关窗、切项目、重开成新的一代视图，旧请求也不会拿新项目的名称去启动。 */
    const token = state.viewToken;
    const request = {
      mode: state.form.mode,
      options: normalizeOptions(state.form.options),
      draftName: state.form.name,
      destDir: state.prefs.destDir,
      confirm: state.form.confirm,
    };
    const alive = () => token === state.viewToken;
    state.starting = true;
    updateBlockReason();
    emit();
    try {
      state.prefs = { ...state.prefs, mode: request.mode, options: request.options };
      api.saveJianyingSettings({ mode: request.mode, options: request.options });
      const captured = api.captureExportSnapshot();
      if (!captured.ok) return { started: false, notice: { text: captured.error, kind: 'error' } };
      state.snapshot = captured.snapshot;
      const prep = await api.prepareJianyingExport(captured.snapshot, request.options);
      /* 预检期间关了窗口 / 换了项目：这次请求作废，不写新窗口的状态，也不启动任务 */
      if (!alive()) return { started: false, stale: true };
      if (!prep.ok) {
        state.configError = prep.error;
        state.prepared = null;
        updateBlockReason();
        emit();
        return { started: false, notice: { text: prep.error, kind: 'error' } };
      }
      state.prepared = prep;
      state.configIssues = prep.issues;
      syncConfirm();
      updateBlockReason();
      emit();
      if (prep.issues.some(isBlocking))
        return { started: false, notice: { text: '还有阻塞问题，先处理后再导出', kind: 'warn' } };
      if (prep.issues.some(isConfirm) && !request.confirm)
        return { started: false, notice: { text: '先勾选确认上面的待确认项', kind: 'warn' } };
      return { started: launchJob({ ...request, prepared: prep }) };
    } finally {
      /* 新窗口已经 resetConfigState 过：旧请求不能再用 finally 改它的状态或重绘 */
      if (alive()) {
        state.starting = false;
        updateBlockReason();
        emit();
      }
    }
  }

  function launchJob({ mode, destDir, draftName, options, prepared }) {
    if (state.running) return false;
    const job = { jobId: '', cancelRequested: false, mode, destDir, options, draftName, progress: null };
    state.running = job;
    state.pane = 'run';
    updateBlockReason();
    emit();
    const settle = result => {
      if (state.running !== job) return;
      state.running = null;
      finishInto(result, job);
    };
    api
      .startPreparedJianyingExport(prepared, {
        mode,
        destDir,
        draftName,
        onProgress: progress => {
          if (state.running !== job) return;
          job.progress = progress;
          emit();
        },
        onJob: info => {
          if (state.running !== job) return;
          job.jobId = info.jobId;
          emit();
          /* 取消早于任务 ID：请求先记住，等 ID 到了立刻发出；失败只发一次提示事件给接线层 */
          if (job.cancelRequested)
            void cancelRunning(job).then(outcome => {
              if (outcome.notice && state.running === job) emit({ type: 'notice', notice: outcome.notice });
            });
        },
      })
      .then(result => settle(result || { ok: false, error: '没有收到导出结果' }))
      .catch(error => settle({ ok: false, error: '导出失败：' + (error?.message || error) }));
    return true;
  }

  function finishInto(result, job) {
    const entry = { result, mode: job.mode, destDir: job.destDir, options: job.options, draftName: job.draftName };
    state.lastDone = entry;
    state.doneIssues = mergeIssues(result.planIssues, result.issues);
    state.donePending = state.doneIssues.filter(issue => levelOf(issue) !== 'info').length;
    /* 成功后记住这次的设置，下次打开导出面板时预先填好，仍由用户确认后才开始 */
    if (result?.ok && !result.canceled) {
      api.saveJianyingSettings({ mode: job.mode, destDir: job.destDir, options: job.options });
      state.prefs = api.loadJianyingSettings();
    }
    state.pane = 'done';
    updateBlockReason();
    emit({ type: 'finished', entry });
  }

  async function sendCancel(jobId) {
    if (!jobId) return false;
    try {
      return !!(await api.cancelJianyingExport(jobId));
    } catch {
      return false;
    }
  }

  /* 取消失败的唯一处理（用户点击 / ID 到达后补发共用）：
     任务还在跑就撤销取消标记、恢复界面并给出提示；任务已经结束就什么都不动，也不误报失败。 */
  async function cancelRunning(job) {
    const canceled = await sendCancel(job.jobId);
    if (state.running !== job) return { canceled: true, ended: true };
    if (canceled) return { canceled: true, ended: false };
    job.cancelRequested = false;
    updateBlockReason();
    emit();
    return { canceled: false, ended: false, notice: { text: '没能取消，任务可能已经完成', kind: 'warn' } };
  }

  async function requestCancel() {
    const job = state.running;
    if (!job || job.cancelRequested) return { requested: false };
    job.cancelRequested = true;
    updateBlockReason();
    emit();
    if (!job.jobId) return { requested: true, pending: true };
    const outcome = await cancelRunning(job);
    return outcome.canceled ? { requested: true, canceled: true } : { requested: false, notice: outcome.notice };
  }

  /* ── 完成后动作 ── */
  function issueAt(scope, index) {
    const list = scope === 'done' ? state.doneIssues : state.configIssues;
    return list[Number(index)] || null;
  }

  async function reveal() {
    return api.revealJianyingDraft(state.lastDone?.result?.draftDir);
  }

  async function openApp() {
    return api.openJianyingApp();
  }

  async function register() {
    const entry = state.lastDone;
    const draftDir = entry?.result?.draftDir;
    if (!draftDir) return { ok: false };
    state.registering = true;
    emit();
    let result;
    try {
      result = await api.registerJianyingDraft(draftDir);
    } finally {
      state.registering = false;
    }
    if (!result?.ok) {
      emit();
      return {
        ok: false,
        notice: {
          text: result?.needsQuit
            ? '剪映还在运行，退出剪映后再点「加入剪映草稿」'
            : '没能加入剪映草稿列表：' + (result?.error || '请退出剪映后再试'),
          kind: 'warn',
        },
      };
    }
    if (result.registered) {
      entry.result.registered = true;
      emit();
      return { ok: true, notice: { text: '已加入剪映草稿列表', kind: 'ok' } };
    }
    emit();
    return { ok: false, notice: { text: '剪映还在运行，退出后再试一次', kind: 'warn' } };
  }

  return {
    getState,
    subscribe,
    open,
    close,
    showLastResult,
    backToConfig,
    updateForm,
    pickDest,
    start,
    requestCancel,
    issueAt,
    reveal,
    openApp,
    register,
  };
}
