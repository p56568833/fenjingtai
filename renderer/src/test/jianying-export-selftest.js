/* 导出到剪映的自测，三层：
   1) 结果面板布局（沿用原有断言，不降低强度）；
   2) controller 纯逻辑：预检序号、视图代次、重复启动、取消早于任务 ID、后台完成、项目归属；
   3) 真实弹窗接线：命令打开、预检摘要 / 问题定位 / 确认项 / 选项、重复点击、执行中取消、
      关闭后后台完成与结果操作。原生能力全部用 window.fjtHooks 替身，不碰真实剪映、网络和磁盘。 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const change = el => el.dispatchEvent(new Event('change', { bubbles: true }));
const input = el => el.dispatchEvent(new Event('input', { bubbles: true }));
const waitFor = async (check, timeout = 4000, step = 25) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (check()) return true;
    } catch {}
    await sleep(step);
  }
  return false;
};
function deferred() {
  let resolve;
  const promise = new Promise(r => (resolve = r));
  return { promise, resolve };
}

/* ── 1. 结果面板布局（原有断言） ── */
function runLayoutTests(t) {
  const mask = document.getElementById('jianyingMask');
  const modal = mask?.querySelector('.modal');
  const done = document.getElementById('jyDonePane');
  const result = document.getElementById('jyResult');
  if (!mask || !modal || !done || !result) {
    t('导出结果面板已挂载', false, '#jianyingMask / #jyResult 不在页面里');
    return;
  }
  const shown = mask.classList.contains('show');
  const scrollLeft = modal.scrollLeft;
  const panes = ['jyConfigPane', 'jyRunPane'].map(id => document.getElementById(id));
  const paneHidden = panes.map(pane => pane?.hidden);
  const doneHidden = done.hidden;
  const html = result.innerHTML;
  const path =
    '~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/最终测试-20261018-0230/fenjingtai-export.json';
  // 与 resultRows 的行结构保持一致：左侧定宽标签 + 右侧 nowrap 路径
  result.innerHTML = ['位置', '导出说明']
    .map(label => `<div class="jy-res-row"><b>${label}</b><code title="${path}">${path}</code></div>`)
    .join('');
  panes.forEach(pane => pane && (pane.hidden = true));
  done.hidden = false;
  mask.classList.add('show');
  try {
    modal.scrollLeft = 0;
    const code = result.querySelector('code');
    const style = getComputedStyle(code);
    t(
      '导出结果：长路径不撑出横向滚动条',
      modal.scrollWidth <= modal.clientWidth + 1,
      `${modal.scrollWidth} / ${modal.clientWidth}`,
    );
    t(
      '导出结果：长路径按省略号截断',
      code.scrollWidth > code.clientWidth && style.textOverflow === 'ellipsis',
      `${code.scrollWidth} / ${code.clientWidth} · ${style.textOverflow}`,
    );
  } finally {
    result.innerHTML = html;
    panes.forEach((pane, index) => pane && (pane.hidden = paneHidden[index]));
    done.hidden = doneHidden;
    if (!shown) mask.classList.remove('show');
    modal.scrollLeft = scrollLeft;
  }
}

/* ── 2. controller 纯逻辑 ── */
const DEFAULT_OPTIONS = { width: 1920, height: 1080, fps: 30, subtitles: false, altAssets: false };
const GOOD_DETECTION = {
  ok: true,
  appPath: '/Applications/剪映专业版.app',
  version: '11.6.0',
  draftRoot: '/tmp/剪映导出自测草稿库',
  running: false,
  canRegister: true,
  supported: true,
  issues: [],
};
const makePrepared = (snapshot, options, extra = {}) => ({
  ok: true,
  snapshot,
  options,
  plan: {
    marker: `${options.width}x${options.height}@${options.fps}`,
    stats: { shots: 1, segments: 2 },
    tracks: { video: [{}], audio: [] },
    durationUs: 2e6,
    timing: { source: 'rate' },
  },
  probes: {},
  volume: { files: 1, bytes: 1048576, unknown: 0, freezeCount: 0 },
  issues: [],
  ...extra,
});

function fakeApi(overrides = {}) {
  const calls = {
    detect: 0,
    prepare: [],
    save: [],
    capture: 0,
    start: [],
    cancel: [],
    pick: 0,
    reveal: [],
    openApp: 0,
    register: [],
    job: null,
  };
  let snapshot = { projectId: 'p1', title: '项目一', rows: [] };
  const api = {
    loadJianyingSettings: () => ({ mode: 'library', destDir: '', options: { ...DEFAULT_OPTIONS } }),
    saveJianyingSettings: patch => {
      calls.save.push(patch);
      return true;
    },
    captureExportSnapshot: () => {
      calls.capture++;
      return { ok: true, snapshot: JSON.parse(JSON.stringify(snapshot)) };
    },
    detectJianying: async () => {
      calls.detect++;
      return { ...GOOD_DETECTION };
    },
    prepareJianyingExport: async (snap, options) => {
      calls.prepare.push({ snapshot: snap, options });
      return makePrepared(snap, options);
    },
    startPreparedJianyingExport: (prepared, handlers) => {
      calls.start.push({ prepared, handlers });
      calls.job = deferred();
      return calls.job.promise;
    },
    cancelJianyingExport: async jobId => {
      calls.cancel.push(jobId);
      return true;
    },
    pickJianyingFolder: async () => null,
    revealJianyingDraft: async path => {
      calls.reveal.push(path);
      return true;
    },
    openJianyingApp: async () => {
      calls.openApp++;
      return true;
    },
    registerJianyingDraft: async draftDir => {
      calls.register.push(draftDir);
      return { ok: true, registered: true };
    },
  };
  return {
    api: { ...api, ...overrides },
    calls,
    setSnapshot: next => {
      snapshot = next;
    },
  };
}

function fakeTimers() {
  const queue = [];
  return {
    queue,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      queue.push(timer);
      return timer;
    },
    clearTimer: timer => {
      if (timer) timer.cleared = true;
    },
    fire: () => {
      const batch = queue.splice(0);
      for (const timer of batch) if (!timer.cleared) timer.fn();
    },
  };
}

export async function runJianyingExportControllerTests(t) {
  const { createJianyingExportController } = await import('../features/jianying-export-controller.js');
  const setup = (overrides = {}, timers = null) => {
    const fake = fakeApi(overrides);
    const controller = createJianyingExportController({ api: fake.api, ...(timers || {}) });
    return { ...fake, c: controller };
  };
  const formOf = (c, extra = {}) => {
    const state = c.getState();
    return { ...state.form, options: { ...state.form.options }, ...extra };
  };

  /* 状态字段：controller 统一拥有预检序号 / 视图代次 / 配置 / 执行 / 完成 / 任务 / 取消 / 最近结果 */
  {
    const required = [
      'viewToken',
      'prepareSeq',
      'pane',
      'formSeq',
      'form',
      'prefs',
      'detection',
      'snapshot',
      'prepared',
      'preparing',
      'starting',
      'configIssues',
      'configError',
      'running',
      'lastDone',
      'doneIssues',
      'donePending',
      'registering',
      'blockReason',
    ];
    const { c } = setup();
    const state = c.getState();
    t(
      'controller：状态字段齐全（代次 / 预检 / 任务 / 取消 / 最近结果）',
      required.every(key => key in state),
      required.filter(key => !(key in state)).join(','),
    );
  }

  /* 配置状态的放行条件：结果、名称、保存位置、确认项都从纯数据判断 */
  {
    const { c, api, calls } = setup();
    await c.open({ title: '配置状态' });
    let state = c.getState();
    t(
      'controller：打开后完成预检并允许导出',
      state.pane === 'config' &&
        state.detection?.version === '11.6.0' &&
        state.prepared?.ok === true &&
        state.blockReason === '' &&
        state.form.name === '配置状态',
      JSON.stringify({ pane: state.pane, block: state.blockReason }),
    );
    c.updateForm(formOf(c, { name: '' }));
    t('controller：草稿名称为空时阻塞', c.getState().blockReason === '草稿名称不能为空');
    c.updateForm(formOf(c, { name: '配置状态', mode: 'folder' }));
    t('controller：保存文件夹模式没选位置时阻塞', c.getState().blockReason === '先选择草稿保存位置');
    api.pickJianyingFolder = async () => '/tmp/剪映导出自测位置';
    const picked = await c.pickDest();
    state = c.getState();
    t(
      'controller：选择位置后放行并记住设置',
      picked.picked === '/tmp/剪映导出自测位置' &&
        state.prefs.destDir === '/tmp/剪映导出自测位置' &&
        state.blockReason === '' &&
        calls.save.some(patch => patch.destDir === '/tmp/剪映导出自测位置'),
      JSON.stringify({ dest: state.prefs.destDir, block: state.blockReason }),
    );

    /* 确认项：有 confirm 级问题且没勾选时拦住，勾选后放行 */
    api.prepareJianyingExport = async (snap, options) =>
      makePrepared(snap, options, {
        issues: [{ level: 'confirm', code: 'overlay', message: '「叠加」是叠加素材', rowId: 7 }],
      });
    await c.open({ title: '确认项' });
    t(
      'controller：需确认项未勾选时阻塞',
      c.getState().configIssues.length === 1 && c.getState().blockReason === '先勾选确认上面的待确认项',
      c.getState().blockReason,
    );
    c.updateForm(formOf(c, { confirm: true, mode: 'library' }));
    t('controller：勾选确认后放行', c.getState().blockReason === '');
  }

  /* F1：快速连续改选项，旧预检结果不得覆盖新结果（序号 + 乱序返回） */
  {
    const timers = fakeTimers();
    const { c, api } = setup({}, timers);
    const prepares = [];
    api.prepareJianyingExport = (snap, options) => {
      const pending = deferred();
      prepares.push({ options, pending });
      return pending.promise;
    };
    const opening = c.open({ title: '顺序测试' });
    await sleep(0);
    prepares[0].pending.resolve(makePrepared({ projectId: 'p1', title: '顺序测试' }, prepares[0].options));
    await opening;
    const base = c.getState().form;
    c.updateForm(
      { ...base, options: { ...base.options, width: 1080, height: 1920 } },
      { persist: true, reprepare: true },
    );
    timers.fire();
    await sleep(0); // 预检 A 已在途
    c.updateForm(
      { ...base, options: { ...base.options, width: 1080, height: 1080 } },
      { persist: true, reprepare: true },
    );
    timers.fire();
    await sleep(0); // 预检 B 已在途
    t(
      'F1 快速改选项：只按最后一次预检结果走（A 未返回时已发起 B）',
      prepares.length === 3,
      `预检 ${prepares.length} 次`,
    );
    prepares[2].pending.resolve(makePrepared({ projectId: 'p1', title: '顺序测试' }, prepares[2].options));
    await sleep(0);
    t(
      'F1 新预检结果先应用',
      c.getState().prepared?.plan.marker === '1080x1080@30' && c.getState().preparing === false,
      c.getState().prepared?.plan.marker,
    );
    prepares[1].pending.resolve(makePrepared({ projectId: 'p1', title: '顺序测试' }, prepares[1].options));
    await sleep(0);
    const state = c.getState();
    t(
      'F1 旧预检结果乱序返回不覆盖新结果',
      state.prepared?.plan.marker === '1080x1080@30' && state.form.options.width === 1080 && !state.preparing,
      JSON.stringify({ marker: state.prepared?.plan.marker, width: state.form.options.width }),
    );
  }

  /* F2：关闭后重开，过期回调不得污染新配置（视图代次） */
  {
    const { c, api } = setup();
    const prepares = [];
    api.prepareJianyingExport = (snap, options) => {
      const pending = deferred();
      prepares.push({ options, pending });
      return pending.promise;
    };
    const firstView = c.open({ title: '旧视图' });
    await sleep(0);
    t('F2 旧视图的预检已发起', prepares.length === 1, `${prepares.length}`);
    c.close();
    const secondView = c.open({ title: '新视图' });
    await sleep(0);
    t('F2 重开后发起新的预检', prepares.length === 2, `${prepares.length}`);
    // 旧视图的回调晚到：必须被视图代次挡住
    prepares[0].pending.resolve(makePrepared({ projectId: 'p1', title: '旧视图' }, prepares[0].options));
    await firstView;
    await sleep(0);
    let state = c.getState();
    t(
      'F2 过期回调不污染新配置',
      state.prepared === null && state.configError === '' && state.form.name === '新视图' && state.detection === null,
      JSON.stringify({ name: state.form.name, prepared: !!state.prepared, detection: !!state.detection }),
    );
    prepares[1].pending.resolve(makePrepared({ projectId: 'p1', title: '新视图' }, prepares[1].options));
    await secondView;
    state = c.getState();
    t('F2 新视图的预检正常应用', state.prepared?.ok === true && state.form.name === '新视图' && !state.preparing);
  }

  /* F3：重复点击只启动一个任务 */
  {
    const { c, calls } = setup();
    await c.open({ title: '单任务' });
    const form = formOf(c);
    const first = c.start(form);
    const second = await c.start(form);
    const third = await c.start(form);
    const outcome = await first;
    t(
      'F3 重复点击只启动一个任务',
      second.started === false && third.started === false && outcome.started === true && calls.start.length === 1,
      `启动 ${calls.start.length} 次`,
    );
    t(
      'F3 重复点击没有重复抓快照与预检',
      calls.capture === 2 && calls.prepare.length === 2,
      `${calls.capture}/${calls.prepare.length}`,
    );
    t('F3 启动后进入执行状态', c.getState().pane === 'run' && c.getState().running?.draftName === '单任务');
    calls.job.resolve({
      ok: true,
      draftName: '单任务',
      draftDir: '/tmp/剪映导出自测位置/单任务',
      segmentCount: 2,
      assetCount: 0,
      registered: true,
      issues: [],
      planIssues: [],
    });
    await sleep(0);
    t('F3 完成后进入结果状态', c.getState().pane === 'done' && c.getState().lastDone?.result.ok === true);
  }

  /* F5：任务 ID 返回前点击取消，拿到 ID 后仍要发出取消 */
  {
    const { c, calls } = setup();
    await c.open({ title: '取消早于 ID' });
    await c.start(formOf(c, { name: '取消草稿' }));
    const handlers = calls.start[0].handlers;
    const early = await c.requestCancel();
    t(
      'F5 任务 ID 返回前点取消：先记住请求，不发空 ID',
      early.requested === true &&
        early.pending === true &&
        calls.cancel.length === 0 &&
        c.getState().running?.cancelRequested === true,
      JSON.stringify(early),
    );
    handlers.onJob({ jobId: 'native-5' });
    await sleep(0);
    t(
      'F5 任务 ID 到达后立刻发出取消',
      calls.cancel.length === 1 && calls.cancel[0] === 'native-5',
      calls.cancel.join(',') || '没有发出',
    );
    const again = await c.requestCancel();
    t('F5 取消请求不重复发送', again.requested === false && calls.cancel.length === 1);
    calls.job.resolve({ ok: false, canceled: true, error: '已取消' });
    await sleep(0);
    t('F5 取消后进入完成状态', c.getState().pane === 'done' && c.getState().lastDone?.result.canceled === true);
  }

  /* 取消失败：回到可再次取消的状态，并给出提示数据 */
  {
    const { c, calls } = setup({ cancelJianyingExport: async jobId => (calls.cancel.push(jobId), false) });
    await c.open({ title: '取消失败' });
    await c.start(formOf(c));
    calls.start[0].handlers.onJob({ jobId: 'native-x' });
    await sleep(0);
    const failed = await c.requestCancel();
    t(
      '取消失败：撤销取消标记并给出提示',
      failed.requested === false &&
        failed.notice?.text === '没能取消，任务可能已经完成' &&
        c.getState().running?.cancelRequested === false,
      JSON.stringify(failed),
    );
  }

  /* F4：关闭执行窗口仍允许后台完成，再打开能看到真实状态 */
  {
    const { c, calls } = setup();
    const events = [];
    c.subscribe((state, event) => events.push(event));
    await c.open({ title: '后台完成' });
    const outcome = await c.start(formOf(c, { name: '后台草稿' }));
    const handlers = calls.start[0].handlers;
    handlers.onJob({ jobId: 'native-4' });
    await sleep(0);
    t('F4 导出已启动', outcome.started === true && c.getState().pane === 'run');
    const closed = c.close();
    t(
      'F4 关闭执行窗口不取消任务',
      closed.background === true && c.getState().running?.jobId === 'native-4' && calls.cancel.length === 0,
    );
    await c.open({ title: '后台完成' });
    t(
      'F4 重开仍显示同一个任务',
      c.getState().pane === 'run' && c.getState().running?.jobId === 'native-4',
      c.getState().pane,
    );
    handlers.onProgress({ phase: 'copy', done: 2, total: 8, message: '复制素材' });
    await sleep(0);
    t(
      'F4 重开后进度来自真实任务',
      c.getState().running?.progress?.phase === 'copy' && c.getState().running.progress.done === 2,
    );
    c.close();
    calls.job.resolve({
      ok: true,
      draftName: '后台草稿',
      draftDir: '/tmp/剪映导出自测位置/后台草稿',
      segmentCount: 2,
      assetCount: 0,
      registered: true,
      issues: [],
      planIssues: [],
    });
    await sleep(0);
    const state = c.getState();
    t(
      'F4 关闭状态下任务照常完成',
      state.pane === 'done' && state.running === null && state.lastDone?.result.draftName === '后台草稿',
    );
    t(
      'F4 完成事件带最近结果',
      events.some(event => event?.type === 'finished' && event.entry.result.draftName === '后台草稿'),
    );
    t('F4 关闭期间没有发出取消', calls.cancel.length === 0);
    t(
      'F4 重开结果页能看到真实状态',
      c.showLastResult() === true && c.getState().pane === 'done' && c.getState().lastDone.result.segmentCount === 2,
    );
  }

  /* 完成后的结果操作与问题合并 */
  {
    const { c, api, calls } = setup();
    await c.open({ title: '结果操作' });
    await c.start(formOf(c, { name: '结果草稿' }));
    calls.start[0].handlers.onJob({ jobId: 'native-6' });
    await sleep(0);
    const issue = { level: 'confirm', code: 'overlay', message: '「叠加」需在剪映里手动安排', rowId: 7, assetId: 'a1' };
    calls.job.resolve({
      ok: true,
      draftName: '结果草稿',
      draftDir: '/tmp/剪映导出自测位置/结果草稿',
      segmentCount: 2,
      assetCount: 1,
      registered: false,
      planIssues: [issue],
      issues: [{ ...issue }],
    });
    await sleep(0);
    const state = c.getState();
    t(
      '结果问题合并去重，待处理数正确',
      state.doneIssues.length === 1 && state.donePending === 1 && state.lastDone.result.assetCount === 1,
      `issues=${state.doneIssues.length} pending=${state.donePending}`,
    );
    t(
      '问题按作用域和序号取回',
      c.issueAt('done', 0)?.code === 'overlay' && c.issueAt('config', 0) === null && c.issueAt('done', 99) === null,
    );
    t('在访达中显示用最近结果的草稿位置', (await c.reveal()) === true && calls.reveal[0].endsWith('/结果草稿'));
    t('打开剪映调用原生入口', (await c.openApp()) === true && calls.openApp === 1);
    const registered = await c.register();
    t(
      '加入剪映草稿更新最近结果并提示',
      registered.ok === true &&
        registered.notice?.text === '已加入剪映草稿列表' &&
        c.getState().lastDone.result.registered === true &&
        calls.register[0] === '/tmp/剪映导出自测位置/结果草稿',
    );
    api.registerJianyingDraft = async () => ({ ok: false, needsQuit: true, error: '剪映在运行' });
    const needsQuit = await c.register();
    t(
      '剪映运行时加入草稿给出对应提示',
      needsQuit.ok === false && needsQuit.notice?.text === '剪映还在运行，退出剪映后再点「加入剪映草稿」',
      needsQuit.notice?.text,
    );
    t(
      '完成后重新打开会重新预检',
      (await c.backToConfig({ title: '结果操作' }), c.getState().pane === 'config' && !!c.getState().prepared),
    );
  }

  /* F6：切换项目不改变已启动任务的项目归属 */
  {
    const { c, api, calls, setSnapshot } = setup();
    await c.open({ title: '项目一' });
    await c.start(formOf(c, { name: '项目一草稿' }));
    calls.start[0].handlers.onJob({ jobId: 'native-7' });
    await sleep(0);
    // 切换项目：之后任何重新抓快照都会拿到项目二
    setSnapshot({ projectId: 'p2', title: '项目二', rows: [] });
    const capturedBefore = calls.capture;
    calls.job.resolve({
      ok: true,
      jobId: 'native-7',
      projectId: 'p1',
      projectTitle: '项目一',
      projectChanged: true,
      draftName: '项目一草稿',
      draftDir: '/tmp/剪映导出自测位置/项目一草稿',
      segmentCount: 2,
      assetCount: 0,
      registered: true,
      issues: [],
      planIssues: [],
    });
    await sleep(0);
    const state = c.getState();
    const result = state.lastDone?.result;
    t(
      'F6 已启动任务的项目归属不变',
      result?.projectId === 'p1' && result?.projectTitle === '项目一' && result?.projectChanged === true,
      JSON.stringify({ projectId: result?.projectId, title: result?.projectTitle, changed: result?.projectChanged }),
    );
    t('F6 启动后不再按新项目重新抓快照', calls.capture === capturedBefore, `${calls.capture}/${capturedBefore}`);
    t(
      'F6 任务用的是启动那一刻的快照',
      calls.start[0].prepared.snapshot.projectId === 'p1',
      calls.start[0].prepared.snapshot.projectId,
    );
    t('F6 任务归属不影响完成状态', state.pane === 'done' && state.running === null);
    api.captureExportSnapshot = () => {
      calls.capture++;
      return { ok: false, error: '新项目没有快照' };
    };
    await c.backToConfig({ title: '项目二' });
    t('F6 回到配置页才使用当前项目', c.getState().configError === '新项目没有快照' && c.getState().snapshot === null);
  }

  /* P1：预检未返回时关窗、切项目、重开成新视图，旧请求不得启动任务、不得污染新窗口 */
  {
    const { c, api, calls, setSnapshot } = setup();
    await c.open({ title: '项目A' });
    const immediatePrepare = api.prepareJianyingExport;
    let releaseStale = null;
    api.prepareJianyingExport = (snap, options) =>
      new Promise(resolve => {
        releaseStale = () => resolve(makePrepared(snap, options));
      });
    const staleStart = c.start(formOf(c, { name: 'A 旧草稿' }));
    t('P1 旧请求的预检已挂起、还没启动任务', !!releaseStale && calls.start.length === 0);
    c.close();

    // 切到项目 B 并重开：新的视图代次已经 resetConfigState
    setSnapshot({ projectId: 'p2', title: '项目B', rows: [] });
    api.loadJianyingSettings = () => ({ mode: 'folder', destDir: '/tmp/位置B', options: { ...DEFAULT_OPTIONS } });
    api.prepareJianyingExport = immediatePrepare;
    await c.open({ title: '项目B' });
    releaseStale();
    const staleOutcome = await staleStart;
    let state = c.getState();
    t(
      'P1 旧预检返回后不启动任务，窗口留在新项目配置页',
      staleOutcome.started === false &&
        staleOutcome.stale === true &&
        calls.start.length === 0 &&
        state.pane === 'config' &&
        state.starting === false,
      JSON.stringify({
        started: staleOutcome.started,
        stale: staleOutcome.stale,
        pane: state.pane,
        starts: calls.start.length,
        starting: state.starting,
      }),
    );
    t(
      'P1 旧请求不污染新窗口的预检、快照与表单',
      state.form.name === '项目B' &&
        state.prefs.destDir === '/tmp/位置B' &&
        state.snapshot?.title === '项目B' &&
        state.prepared?.snapshot.title === '项目B' &&
        state.configError === '',
      JSON.stringify({ name: state.form.name, dest: state.prefs.destDir, snapshot: state.snapshot?.title }),
    );
    t('P1 旧请求不给新窗口弹「开始/失败」提示', staleOutcome.notice == null);
    const freshStart = await c.start(formOf(c, { name: 'B 草稿' }));
    const handlers = calls.start[0]?.handlers || {};
    t(
      'P1 新项目按自己的名称 / 目录 / 配置正常生成',
      freshStart.started === true &&
        handlers.draftName === 'B 草稿' &&
        handlers.mode === 'folder' &&
        handlers.destDir === '/tmp/位置B' &&
        calls.start[0].prepared.options.fps === 30,
      JSON.stringify({ draft: handlers.draftName, mode: handlers.mode, dest: handlers.destDir }),
    );
  }

  /* P1：同一窗口关闭重开后，旧请求作废但新窗口仍能正常生成 */
  {
    const { c, api, calls } = setup();
    await c.open({ title: '同窗重开' });
    const immediatePrepare = api.prepareJianyingExport;
    let releaseStale = null;
    api.prepareJianyingExport = (snap, options) =>
      new Promise(resolve => {
        releaseStale = () => resolve(makePrepared(snap, options));
      });
    const staleStart = c.start(formOf(c, { name: '旧草稿' }));
    c.close();
    api.prepareJianyingExport = immediatePrepare;
    await c.open({ title: '同窗重开' });
    releaseStale();
    const staleOutcome = await staleStart;
    t(
      'P1 同窗重开：旧请求作废但不影响新窗口状态',
      staleOutcome.stale === true && calls.start.length === 0 && c.getState().pane === 'config',
      JSON.stringify(staleOutcome),
    );
    const freshStart = await c.start(formOf(c, { name: '新草稿' }));
    t(
      'P1 同窗重开后重新点生成用当前项目当前表单',
      freshStart.started === true && calls.start[0].handlers.draftName === '新草稿',
    );
  }

  /* P2：任务 ID 未返回时点取消，ID 到达后自动取消失败 —— 要恢复可取消并只提示一次 */
  {
    let cancelAttempts = 0;
    const { c, api, calls } = setup();
    api.cancelJianyingExport = async jobId => {
      cancelAttempts++;
      calls.cancel.push(jobId);
      return cancelAttempts >= 2;
    };
    const events = [];
    c.subscribe((state, event) => events.push(event));
    await c.open({ title: 'P2 自动取消' });
    await c.start(formOf(c, { name: 'P2 草稿' }));
    const early = await c.requestCancel();
    t('P2 早取消：先记住请求，不发空 ID', early.pending === true && calls.cancel.length === 0);
    calls.start[0].handlers.onJob({ jobId: 'native-p2a' });
    await sleep(0);
    const notices = events.filter(
      item => item?.type === 'notice' && item.notice?.text === '没能取消，任务可能已经完成',
    );
    t(
      'P2 自动取消失败：清除取消标记、恢复界面、只提示一次',
      c.getState().running?.cancelRequested === false && notices.length === 1,
      JSON.stringify({ cancelRequested: c.getState().running?.cancelRequested, notices: notices.length }),
    );
    const retry = await c.requestCancel();
    t(
      'P2 自动取消失败后再次点取消会重新发起并成功',
      retry.requested === true && retry.canceled === true && calls.cancel.length === 2,
      `cancel=${calls.cancel.length}`,
    );
    calls.job.resolve({ ok: false, canceled: true, error: '已取消' });
    await sleep(0);
    t(
      'P2 第二次取消成功后进入取消结果',
      c.getState().pane === 'done' && c.getState().lastDone?.result.canceled === true,
    );
  }

  /* P2：任务 ID 已返回后第一次取消失败，返回提示且还能再取消 */
  {
    let cancelAttempts = 0;
    const { c, api, calls } = setup();
    api.cancelJianyingExport = async jobId => {
      cancelAttempts++;
      calls.cancel.push(jobId);
      return cancelAttempts >= 2;
    };
    await c.open({ title: 'P2 直接取消' });
    await c.start(formOf(c, { name: 'P2 直接草稿' }));
    calls.start[0].handlers.onJob({ jobId: 'native-p2b' });
    await sleep(0);
    const first = await c.requestCancel();
    t(
      'P2 任务 ID 已返回时取消失败：返回提示并恢复可取消',
      first.requested === false &&
        first.notice?.text === '没能取消，任务可能已经完成' &&
        c.getState().running?.cancelRequested === false &&
        calls.cancel.length === 1,
      JSON.stringify({ first, cancelRequested: c.getState().running?.cancelRequested }),
    );
    const second = await c.requestCancel();
    t(
      'P2 取消失败后可以再次取消',
      second.requested === true && second.canceled === true && calls.cancel.length === 2,
      JSON.stringify(second),
    );
  }

  /* P2：取消在途时任务已结束 —— 不清标记、不误报失败 */
  {
    const { c, api, calls } = setup();
    let resolveCancel = null;
    api.cancelJianyingExport = () => new Promise(resolve => (resolveCancel = resolve));
    const events = [];
    c.subscribe((state, event) => events.push(event));
    await c.open({ title: 'P2 在途结束' });
    await c.start(formOf(c, { name: '在途草稿' }));
    calls.start[0].handlers.onJob({ jobId: 'native-p2c' });
    await sleep(0);
    const pendingCancel = c.requestCancel();
    await sleep(0);
    calls.job.resolve({
      ok: true,
      draftName: '在途草稿',
      draftDir: '/tmp/在途草稿',
      segmentCount: 1,
      assetCount: 0,
      registered: true,
      issues: [],
      planIssues: [],
    });
    await sleep(0);
    resolveCancel(false); // 取消失败，但任务其实已经结束
    const outcome = await pendingCancel;
    t(
      'P2 取消在途时任务已结束：不误清标记、不误报失败',
      outcome.canceled === true &&
        c.getState().running === null &&
        c.getState().pane === 'done' &&
        !events.some(item => item?.type === 'notice'),
      JSON.stringify({ outcome, notices: events.filter(item => item?.type === 'notice').length }),
    );
  }
}

/* ── 3. 真实弹窗接线 ── */
export async function runJianyingExportUiTests(t) {
  const hooksBefore = window.fjtHooks;
  const events = { progress: null, result: null };
  const calls = { detect: 0, export: [], cancel: [], register: [], reveal: [], openApp: 0, pick: 0 };
  let deferExport = false;
  let pendingExport = null;
  let cancelFailures = 0; // >0 时下一次取消失败，用来复现「正在取消…」卡死
  let hangPack = false; // 挂起预检：让 packSizes 一直不返回
  let releasePack = null;
  window.fjtHooks = {
    ...(hooksBefore || {}),
    jianyingDetect: async () => {
      calls.detect++;
      return { ...GOOD_DETECTION };
    },
    jianyingExport: req => {
      calls.export.push(req);
      if (!deferExport) return Promise.resolve({ ok: true, jobId: req.jobId });
      return new Promise(resolve => {
        pendingExport = () => resolve({ ok: true, jobId: req.jobId });
      });
    },
    jianyingCancel: async jobId => {
      calls.cancel.push(jobId);
      if (cancelFailures > 0) {
        cancelFailures--;
        return false;
      }
      return true;
    },
    packSizes: paths => {
      if (!hangPack) return window.native.packSizes(paths);
      return new Promise(resolve => {
        releasePack = () => resolve({});
      });
    },
    jianyingRegister: async req => {
      calls.register.push(req);
      return { ok: true, registered: true };
    },
    jianyingReveal: async target => {
      calls.reveal.push(target);
      return { ok: true };
    },
    jianyingOpenApp: async () => {
      calls.openApp++;
      return { ok: true };
    },
    jianyingPickFolder: async () => {
      calls.pick++;
      return '/tmp/剪映导出自测位置';
    },
    onJianyingProgress: cb => {
      events.progress = cb;
      return () => {
        events.progress = null;
      };
    },
    onJianyingResult: cb => {
      events.result = cb;
      return () => {
        events.result = null;
      };
    },
  };
  const [{ state }, { parseAny }, storage, { runCommand }, { viewState }, features] = await Promise.all([
    import('../app/state.js'),
    import('../core/parse.js'),
    import('../app/storage.js'),
    import('../ui/base/commands.js'),
    import('../app/view-state.js'),
    import('../features/jianying-export.js'),
  ]);
  const controller = features.jianyingExportController;
  const originalId = state.projectId;
  let tempA = null;
  let tempB = null;
  let p1A = null;
  let p1B = null;
  const maskShown = () => $('#jianyingMask')?.classList.contains('show') || false;
  const lastJobId = () => calls.export[calls.export.length - 1]?.jobId || '';
  const goReady = () => !!$('#jyGo') && !$('#jyGo').disabled && !$('#jyGo').hidden;

  try {
    /* 准备一个可控项目：一句有失联素材（阻塞），一句挂了叠加素材（需确认） */
    tempA = storage.createProject('剪映导出交互自测', parseAny('第一句口播。\n第二句口播。'));
    const lines = state.rows.filter(row => row.kind === 'line');
    lines[0].assetUsages = [{ assetId: 'as-missing', role: 'main' }];
    lines[1].assetUsages = [{ assetId: 'as-overlay', role: 'overlay' }];
    state.assets['as-missing'] = {
      id: 'as-missing',
      kind: 'video',
      path: '/tmp/剪映导出自测-失联素材.mp4',
      name: '失联素材.mp4',
    };
    state.assets['as-overlay'] = {
      id: 'as-overlay',
      kind: 'image',
      path: '/tmp/剪映导出自测-叠加素材.png',
      name: '叠加素材.png',
    };

    /* —— 配置页：目标剪映、摘要、问题列表、确认项、选项、问题定位 —— */
    runCommand('jianying:export');
    const opened = await waitFor(() => maskShown() && !$('#jyConfigPane').hidden);
    const ready = await waitFor(
      () => $('#jyTarget').textContent.includes('已适配') && !$('#jyIssues').hidden && !$('#jyGo').hidden,
    );
    const targetText = $('#jyTarget').textContent;
    t('导出弹窗：命令能打开配置页', opened && ready, `${opened}/${ready}`);
    t(
      '导出弹窗：目标剪映状态显示已适配',
      targetText.includes('剪映 11.6.0') && targetText.includes('已适配') && $('#jyTarget').dataset.level === 'ok',
      targetText,
    );
    const summaryText = $('#jySummary').textContent;
    t(
      '导出弹窗：摘要显示画面片段与问题计数',
      summaryText.includes('个画面') &&
        summaryText.includes('个片段') &&
        summaryText.includes('1 项阻塞') &&
        summaryText.includes('1 项需确认'),
      summaryText,
    );
    t(
      '导出弹窗：问题列表分级别并可定位',
      $$('#jyIssues .jy-issue').length >= 2 &&
        $('#jyIssues .jy-issues-head').textContent.includes('1 项阻塞') &&
        !!$('#jyIssues [data-jy-issue][data-jy-scope="config"]'),
      JSON.stringify({
        issueRows: $$('#jyIssues .jy-issue').length,
        head: $('#jyIssues .jy-issues-head')?.textContent || '',
        buttons: $$('#jyIssues [data-jy-issue]').map(item => item.dataset.jyScope),
      }),
    );
    t(
      '导出弹窗：需确认项显示确认勾选行',
      !$('#jyConfirmRow').hidden && $('#jyConfirmRow').textContent.includes('我已了解上述待确认项'),
    );
    t(
      '导出弹窗：有阻塞问题时禁用生成',
      $('#jyGo').disabled === true && $('#jyGo').title.includes('阻塞'),
      `${$('#jyGo').disabled} / ${$('#jyGo').title}`,
    );
    t(
      '导出弹窗：画幅 / 帧率 / 字幕 / 备选选项齐全',
      $('#jyCanvas').options.length === 3 &&
        $('#jyFps').options.length === 4 &&
        !!$('#jySubs') &&
        !!$('#jyAlt') &&
        $('#jyMore').tagName === 'DETAILS',
    );
    t(
      '导出弹窗：表单按本机设置预填',
      $('#jyName').value === '剪映导出交互自测' &&
        document.querySelector('input[name="jyMode"][value="library"]').checked &&
        $('#jyCanvas').value === '1920x1080' &&
        $('#jyFps').value === '30',
    );
    const confirmBox = $('#jyConfirm');
    confirmBox.checked = true;
    change(confirmBox);
    await sleep(0);
    t(
      '导出弹窗：确认勾选写回表单（仍被阻塞问题拦住）',
      controller.getState().form.confirm === true && $('#jyGo').disabled === true && $('#jyGo').title.includes('阻塞'),
      $('#jyGo').title,
    );

    /* 问题定位：点问题 → 关弹窗并跳到对应句子 */
    const jumpRowId = lines[0].id;
    click($('#jyIssues [data-jy-issue]'));
    const closedByIssue = await waitFor(() => !maskShown());
    t(
      '问题定位：点问题关闭弹窗并跳到对应句子',
      closedByIssue && viewState.sel === jumpRowId,
      `closed=${closedByIssue} sel=${viewState.sel} want=${jumpRowId}`,
    );

    /* 清掉问题素材，重开得到可直接导出的配置 */
    lines[0].assetUsages = [];
    lines[1].assetUsages = [];
    delete state.assets['as-missing'];
    delete state.assets['as-overlay'];
    runCommand('jianying:export');
    const clean = await waitFor(() => maskShown() && goReady());
    t('重开导出面板：问题清掉后可以生成', clean, `go=${$('#jyGo').disabled}`);
    t(
      '重开导出面板：只剩提醒时没有确认行和定位按钮',
      $('#jyConfirmRow').hidden === true && $$('#jyIssues [data-jy-issue]').length === 0,
      JSON.stringify({ confirm: $('#jyConfirmRow').hidden, buttons: $$('#jyIssues [data-jy-issue]').length }),
    );

    /* 选项改动：帧率写入设置并重新预检 */
    const fps = $('#jyFps');
    fps.value = '60';
    change(fps);
    const fpsApplied = await waitFor(
      () => controller.getState().prepared?.options?.fps === 60 && controller.getState().prefs?.options?.fps === 60,
    );
    t('导出选项：改帧率会保存设置并重新预检', fpsApplied && goReady());
    const name = $('#jyName');
    name.value = '改名草稿';
    input(name);
    await sleep(0);
    t('导出选项：草稿名称实时写回表单', controller.getState().form.name === '改名草稿');
    const folderRadio = document.querySelector('input[name="jyMode"][value="folder"]');
    folderRadio.checked = true;
    change(folderRadio);
    await sleep(0);
    t(
      '导出选项：保存到文件夹时先要求选择位置',
      !$('#jyDestRow').hidden && $('#jyGo').disabled === true && $('#jyGo').title === '先选择草稿保存位置',
      $('#jyGo').title,
    );
    click($('#jyPickDest'));
    const picked = await waitFor(() => controller.getState().prefs.destDir === '/tmp/剪映导出自测位置');
    t(
      '导出选项：选择位置后放行并显示目标目录',
      picked && goReady() && $('#jyDest').textContent.includes('改名草稿') && calls.pick === 1,
      $('#jyDest').textContent,
    );
    const libraryRadio = document.querySelector('input[name="jyMode"][value="library"]');
    libraryRadio.checked = true;
    change(libraryRadio);
    await sleep(0);
    t('导出选项：切回加入剪映草稿后隐藏保存位置', $('#jyDestRow').hidden === true);

    /* —— 执行页：重复点击只启动一个任务 + 任务 ID 返回前取消 —— */
    deferExport = true;
    click($('#jyGo'));
    click($('#jyGo'));
    const startedOnce = await waitFor(() => calls.export.length >= 1, 2000);
    await sleep(300);
    t(
      'F3 真实界面：重复点击只启动一个任务',
      startedOnce && calls.export.length === 1 && !$('#jyRunPane').hidden && $('#jyConfigPane').hidden,
      `export=${calls.export.length}`,
    );
    click($('#jyCancelRun'));
    await sleep(0);
    t(
      'F5 真实界面：ID 返回前点取消先进入取消中且没有发空 ID',
      $('#jyCancelRun').disabled === true &&
        $('#jyRunHead').textContent.includes('正在取消') &&
        calls.cancel.length === 0 &&
        controller.getState().running?.cancelRequested === true,
      $('#jyRunHead').textContent,
    );
    pendingExport?.();
    const canceledAfterId = await waitFor(() => calls.cancel.length === 1, 2000);
    t(
      'F5 真实界面：任务 ID 到达后立刻发出取消',
      canceledAfterId && calls.cancel[0] === lastJobId(),
      `${calls.cancel[0]} / ${lastJobId()}`,
    );
    events.result?.({ jobId: lastJobId(), ok: false, canceled: true, error: '已取消' });
    const cancelDone = await waitFor(() => !$('#jyDonePane').hidden, 2000);
    t('F5 真实界面：取消结果进入结果页', cancelDone && $('#jyDoneHead').textContent.includes('已取消'));
    click($('#jyClose'));
    await waitFor(() => !maskShown());

    /* —— F4 真实界面：关闭执行窗口后台完成，再打开看到真实状态 —— */
    deferExport = false;
    runCommand('jianying:export');
    await waitFor(() => maskShown() && goReady());
    click($('#jyGo'));
    const runShown = await waitFor(() => !$('#jyRunPane').hidden, 2000);
    const jobId4 = lastJobId();
    t('F4 真实界面：生成时进入执行页', runShown && !!jobId4 && !!controller.getState().running);
    click($('#jyBackground'));
    const backgrounded = await waitFor(() => !maskShown());
    t(
      'F4 真实界面：关闭执行窗口提示后台继续且任务还在',
      backgrounded &&
        $('#toastTxt').textContent.includes('后台继续') &&
        controller.getState().running?.jobId === jobId4 &&
        calls.cancel.length === 1,
      $('#toastTxt').textContent,
    );
    events.progress?.({ jobId: jobId4, phase: 'copy', done: 2, total: 8, message: '复制素材' });
    await sleep(0);
    runCommand('jianying:export');
    const reopenedRunning = await waitFor(() => maskShown() && !$('#jyRunPane').hidden);
    t(
      'F4 真实界面：重开执行页显示真实进度',
      reopenedRunning &&
        $('#jyProgress').dataset.known === '1' &&
        $('#jyProgressTxt').textContent.includes('%') &&
        controller.getState().running?.progress?.done === 2,
      JSON.stringify({ known: $('#jyProgress').dataset.known, txt: $('#jyProgressTxt').textContent }),
    );
    click($('#jyBackground'));
    await waitFor(() => !maskShown());
    events.result?.({
      jobId: jobId4,
      ok: true,
      draftName: '自测结果草稿',
      draftDir: '/tmp/剪映导出自测位置/自测结果草稿',
      segmentCount: 2,
      assetCount: 0,
      freezeCount: 0,
      registered: true,
      issues: [],
      notes: [],
      reportPath: '/tmp/剪映导出自测位置/自测结果草稿/导出说明.md',
    });
    const notified = await waitFor(() => $('#toastTxt').textContent.includes('剪映草稿已生成'), 3000);
    t(
      'F4 真实界面：后台完成用提示带回结果',
      notified && $('#toastAct').style.display !== 'none' && $('#toastTxt').textContent.includes('自测结果草稿'),
      $('#toastTxt').textContent,
    );
    click($('#toastAct'));
    const doneShown = await waitFor(() => maskShown() && !$('#jyDonePane').hidden);
    const resultText = $('#jyResult').textContent;
    t(
      'F4 真实界面：查看结果打开结果页并显示真实草稿',
      doneShown &&
        resultText.includes('自测结果草稿') &&
        resultText.includes('2 个片段') &&
        resultText.includes('已加入剪映草稿列表'),
      resultText,
    );
    t(
      '结果操作：按钮按结果状态显示',
      !$('#jyReveal').hidden && !$('#jyOpenApp').hidden && $('#jyRegister').hidden && !$('#jyAdjust').hidden,
      JSON.stringify({
        reveal: $('#jyReveal').hidden,
        app: $('#jyOpenApp').hidden,
        register: $('#jyRegister').hidden,
        adjust: $('#jyAdjust').hidden,
      }),
    );
    click($('#jyReveal'));
    const revealed = await waitFor(() => calls.reveal.length === 1);
    t(
      '结果操作：在访达中显示打开的正是这份草稿',
      revealed && calls.reveal[0].endsWith('/自测结果草稿'),
      calls.reveal[0] || '没有调用',
    );
    click($('#jyOpenApp'));
    const appOpened = await waitFor(() => calls.openApp === 1);
    t('结果操作：打开剪映调用原生入口', appOpened);
    click($('#jyAdjust'));
    const backToConfig = await waitFor(() => maskShown() && !$('#jyConfigPane').hidden);
    t('结果操作：调整设置回到配置页并重新预检', backToConfig && controller.getState().pane === 'config');
    click($('#jyClose'));
    await waitFor(() => !maskShown());

    /* —— F6 真实界面：切换项目不改变已启动任务的项目归属 —— */
    runCommand('jianying:export');
    await waitFor(() => maskShown() && goReady());
    click($('#jyGo'));
    const runBeforeSwitch = await waitFor(() => !$('#jyRunPane').hidden, 2000);
    const jobId6 = lastJobId();
    const projectATitle = state.title;
    tempB = storage.createProject('剪映导出切换项目', parseAny('另一个项目。'));
    await sleep(50);
    t(
      'F6 真实界面：任务执行中切换了项目',
      runBeforeSwitch && state.projectId === tempB && controller.getState().running?.jobId === jobId6,
      state.projectId,
    );
    events.result?.({
      jobId: jobId6,
      ok: true,
      projectId: tempA,
      projectTitle: projectATitle,
      projectChanged: true,
      draftName: '跨项目草稿',
      draftDir: '/tmp/剪映导出自测位置/跨项目草稿',
      segmentCount: 2,
      assetCount: 0,
      registered: false,
      issues: [],
      notes: [],
    });
    const crossDone = await waitFor(() => !$('#jyDonePane').hidden, 3000);
    const crossText = $('#jyResult').textContent;
    t(
      'F6 真实界面：结果仍标记为开始导出时的项目',
      crossDone &&
        controller.getState().lastDone?.result.projectId === tempA &&
        crossText.includes('基于') &&
        crossText.includes(projectATitle),
      crossText,
    );
    t(
      'F6 真实界面：切换项目没有取消任务',
      calls.cancel.length === 1 && controller.getState().running === null,
      `cancel=${calls.cancel.length}`,
    );
    t('F6 真实界面：未加入草稿列表时显示加入按钮', !$('#jyRegister').hidden);
    click($('#jyRegister'));
    const registered = await waitFor(
      () => calls.register.length === 1 && $('#toastTxt').textContent.includes('已加入剪映草稿列表'),
    );
    t(
      '结果操作：加入剪映草稿调用原生并更新结果',
      registered &&
        calls.register[0].draftDir === '/tmp/剪映导出自测位置/跨项目草稿' &&
        controller.getState().lastDone.result.registered === true &&
        $('#toastTxt').textContent.includes('已加入剪映草稿列表'),
      JSON.stringify(calls.register[0] || null),
    );

    /* —— P2 真实界面：ID 未返回时点取消，自动取消失败后按钮恢复、可再次取消 —— */
    click($('#jyClose'));
    await waitFor(() => !maskShown());
    deferExport = true;
    runCommand('jianying:export');
    await waitFor(() => maskShown() && goReady());
    const cancelCountBeforeP2 = calls.cancel.length;
    const exportCountBeforeP2 = calls.export.length;
    click($('#jyGo'));
    await waitFor(() => calls.export.length === exportCountBeforeP2 + 1, 3000);
    click($('#jyCancelRun'));
    await sleep(0);
    t(
      'P2 真实界面：ID 未返回时取消先进入取消中',
      calls.cancel.length === cancelCountBeforeP2 &&
        controller.getState().running?.cancelRequested === true &&
        $('#jyCancelRun').disabled === true,
    );
    cancelFailures = 1;
    pendingExport?.();
    const cancelRestored = await waitFor(
      () =>
        $('#jyCancelRun').textContent === '取消生成' &&
        $('#jyCancelRun').disabled === false &&
        $('#toastTxt').textContent.includes('没能取消'),
      3000,
    );
    t(
      'P2 真实界面：自动取消失败后按钮恢复并给出提示',
      cancelRestored &&
        $('#jyRunHead').textContent.includes('正在生成剪映草稿') &&
        controller.getState().running?.cancelRequested === false,
      JSON.stringify({
        text: $('#jyCancelRun').textContent,
        disabled: $('#jyCancelRun').disabled,
        toast: $('#toastTxt').textContent,
      }),
    );
    click($('#jyCancelRun'));
    const cancelRetried = await waitFor(() => calls.cancel.length === cancelCountBeforeP2 + 2, 3000);
    t(
      'P2 真实界面：失败后可以再次取消并成功',
      cancelRetried && $('#jyCancelRun').disabled === true && $('#jyRunHead').textContent.includes('正在取消'),
      `cancel=${calls.cancel.length - cancelCountBeforeP2}`,
    );
    events.result?.({ jobId: lastJobId(), ok: false, canceled: true, error: '已取消' });
    const p2Done = await waitFor(() => !$('#jyDonePane').hidden, 3000);
    t('P2 真实界面：第二次取消成功后结果页显示已取消', p2Done && $('#jyDoneHead').textContent.includes('已取消'));
    click($('#jyClose'));
    await waitFor(() => !maskShown());
    deferExport = false;

    /* —— P1 真实界面：预检挂起时关窗、切项目、重开，旧请求不得启动任务 —— */
    p1A = storage.createProject('剪映导出P1甲', parseAny('甲项目口播。'));
    const p1Line = state.rows.find(row => row.kind === 'line');
    p1Line.assetUsages = [{ assetId: 'as-alt-p1', role: 'alt' }];
    state.assets['as-alt-p1'] = {
      id: 'as-alt-p1',
      kind: 'image',
      path: '/tmp/剪映导出自测-备选素材.png',
      name: '备选素材.png',
    };
    runCommand('jianying:export');
    await waitFor(() => maskShown() && goReady());
    const exportCountBeforeP1 = calls.export.length;
    hangPack = true;
    click($('#jyGo'));
    const packHung = await waitFor(() => !!releasePack, 3000);
    t(
      'P1 真实界面：预检已挂起且还没启动任务',
      packHung && calls.export.length === exportCountBeforeP1,
      JSON.stringify({ hung: packHung, exports: calls.export.length }),
    );
    click($('#jyClose'));
    await waitFor(() => !maskShown());
    p1B = storage.createProject('剪映导出P1乙', parseAny('乙项目口播。'));
    hangPack = false;
    runCommand('jianying:export');
    const p1BReady = await waitFor(() => maskShown() && goReady());
    releasePack?.();
    await sleep(250);
    t(
      'P1 真实界面：放行旧预检后不启动任务，窗口留在新项目配置页',
      p1BReady &&
        calls.export.length === exportCountBeforeP1 &&
        $('#jyConfigPane').hidden === false &&
        $('#jyRunPane').hidden === true &&
        controller.getState().pane === 'config',
      JSON.stringify({ exports: calls.export.length, before: exportCountBeforeP1, pane: controller.getState().pane }),
    );
    t(
      'P1 真实界面：新项目表单没有被旧项目覆盖',
      $('#jyName').value === '剪映导出P1乙' && controller.getState().form.name === '剪映导出P1乙',
      $('#jyName').value,
    );
    click($('#jyGo'));
    const p1BStarted = await waitFor(() => calls.export.length === exportCountBeforeP1 + 1, 3000);
    const p1Job = calls.export[calls.export.length - 1];
    t(
      'P1 真实界面：新项目按自己的名称生成',
      p1BStarted && p1Job?.options?.draftName === '剪映导出P1乙',
      JSON.stringify(p1Job?.options || null),
    );
    events.result?.({
      jobId: p1Job?.jobId,
      ok: true,
      draftName: '剪映导出P1乙',
      draftDir: '/tmp/剪映导出自测位置/剪映导出P1乙',
      segmentCount: 1,
      assetCount: 0,
      registered: true,
      issues: [],
      notes: [],
    });
    await waitFor(() => !$('#jyDonePane').hidden, 3000);
    click($('#jyClose'));
    await waitFor(() => !maskShown());
  } finally {
    try {
      controller.close();
    } catch {}
    $('#jianyingMask')?.classList.remove('show');
    if (state.projectId !== originalId) storage.switchProject(originalId);
    if (p1B) storage.deleteProject(p1B);
    if (p1A) storage.deleteProject(p1A);
    if (tempB) storage.deleteProject(tempB);
    if (tempA) storage.deleteProject(tempA);
    window.fjtHooks = hooksBefore || null;
  }
}

export async function runJianyingExportTests(t) {
  runLayoutTests(t);
  await runJianyingExportControllerTests(t);
  await runJianyingExportUiTests(t);
}
