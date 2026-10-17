/* 导出到剪映：紧凑弹窗。
   首屏：目标剪映与兼容状态、草稿名称、保存方式、素材复制体积、摘要、更多设置。
   执行：真实阶段与进度、取消；关掉窗口任务继续，完成时用提示带回结果。
   完成：草稿位置、片段数、待手动处理项、打开剪映 / 在访达中显示 / 调整设置。
   这里只管界面：保存、快照、预检、计划和原生任务都在 app/edit-export.js。 */
import { state } from '../app/state.js';
import { rowById } from '../app/project-queries.js';
import * as editExport from '../app/edit-export.js';
import { usageList } from '../core/asset-model.js';
import { fmtTc, fmtLen, safeFileName } from '../core/text.js';
import { toast, esc } from '../ui/base/dom.js';
import { registerModal } from '../ui/base/modal.js';
import { closePop } from '../ui/base/popover.js';
import { registerCommand, runCommand } from '../ui/base/commands.js';

const $ = s => document.querySelector(s);

const CANVAS_OPTIONS = [
  { value: '1920x1080', width: 1920, height: 1080, label: '1920 × 1080 · 横屏' },
  { value: '1080x1920', width: 1080, height: 1920, label: '1080 × 1920 · 竖屏' },
  { value: '1080x1080', width: 1080, height: 1080, label: '1080 × 1080 · 方形' },
];
const FPS_OPTIONS = [30, 25, 24, 60];
/* 界面上把 build / commit 合成「生成草稿」一个阶段；register 在保存文件夹模式下不需要 */
const STAGES = [
  { key: 'probe', label: '检查素材' },
  { key: 'copy', label: '复制素材' },
  { key: 'freeze', label: '处理定格' },
  { key: 'build', label: '生成草稿' },
  { key: 'register', label: '加入剪映' },
];
const PHASE_STAGE = { probe: 0, copy: 1, freeze: 2, build: 3, commit: 3, register: 4 };
const LEVEL_LABEL = { block: '阻塞', confirm: '需确认', info: '提醒' };

let prefs = null;
let detection = null;
let snapshot = null;
let prepared = null;
let preparing = false;
let prepareTimer = null;
let prepareSeq = 0;
let viewToken = 0;
let pane = 'config';
let configIssues = [];
let doneIssues = [];
let configError = '';
let running = null; // 本次正在跑的任务 { jobId, cancelRequested, mode, destDir, options, draftName, progress }
let lastDone = null; // 最近一次结果 { result, mode, destDir, options, draftName }
let starting = false;
let quickSuppressed = false;

function fmtBytes(n) {
  if (!(n > 0)) return '0 MB';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1) + ' GB';
  return Math.max(0.1, n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1) + ' MB';
}
const shortPath = p => String(p || '').replace(/^\/Users\/[^/]+/, '~');
const levelOf = issue =>
  issue?.level === 'block' ? 'block' : issue?.level === 'confirm' || issue?.level === 'warn' ? 'confirm' : 'info';
const isBlocking = issue => levelOf(issue) === 'block';
const isConfirm = issue => levelOf(issue) === 'confirm';

function mergeIssues(...groups) {
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

function firstRowForAsset(assetId) {
  return state.rows.find(row => row.kind === 'line' && usageList(row).some(usage => usage.assetId === assetId));
}

function issueRow(issue) {
  if (!issue) return null;
  if (issue.rowId != null) {
    const row = rowById(issue.rowId);
    if (row) return row;
  }
  if (issue.lineNo != null) {
    const row = state.rows.find(item => item.kind === 'line' && item.no === issue.lineNo);
    if (row) return row;
  }
  if (issue.assetId) return firstRowForAsset(issue.assetId) || null;
  return null;
}

/* ── 弹窗骨架 ── */
function modalHtml() {
  return `<div class="modal-mask" id="jianyingMask"><div class="modal jy-modal">
    <h3 id="jyTitle">导出到剪映</h3>
    <div class="jy-target" id="jyTarget" data-level="pending" role="status"><b>正在检测本机剪映…</b></div>

    <div class="jy-pane" id="jyConfigPane">
      <label class="jy-field"><span>草稿名称</span><input id="jyName" maxlength="120" autocomplete="off" spellcheck="false"></label>
      <div class="jy-seg" role="radiogroup" aria-label="保存方式">
        <label class="jy-choice"><input type="radio" name="jyMode" value="library" checked><span><b>加入本机剪映草稿</b><small>生成后出现在剪映「本地草稿」，打开就能继续剪</small></span></label>
        <label class="jy-choice"><input type="radio" name="jyMode" value="folder"><span><b>保存草稿文件夹</b><small>只生成到指定文件夹，不加入剪映；用于交付或手动放置</small></span></label>
      </div>
      <div class="jy-dest" id="jyDestRow" hidden><span>保存到</span><code id="jyDest"></code><button class="btn ghost" id="jyPickDest" type="button">选择位置…</button></div>
      <p class="jy-line" id="jyAssets">素材会随草稿一起复制，正在统计体积…</p>
      <div class="jy-summary" id="jySummary"><p class="jy-empty">正在读取项目排布…</p></div>
      <details class="jy-more" id="jyMore"><summary>更多设置</summary>
        <div class="jy-more-grid">
          <label><span>画幅</span><select id="jyCanvas">${CANVAS_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}</select></label>
          <label><span>帧率</span><select id="jyFps">${FPS_OPTIONS.map(f => `<option value="${f}">${f} fps</option>`).join('')}</select></label>
          <label class="jy-check"><input type="checkbox" id="jySubs"> 生成可编辑字幕（文字轨）</label>
          <label class="jy-check"><input type="checkbox" id="jyAlt"> 复制备选素材（不上时间线）</label>
        </div>
        <p class="jy-hint">这些设置只影响这次生成的草稿，不改变分镜台里的项目排布。</p>
      </details>
      <div class="jy-issues" id="jyIssues" hidden></div>
      <label class="jy-confirm" id="jyConfirmRow" hidden><input type="checkbox" id="jyConfirm"> 我已了解上述待确认项，继续生成</label>
    </div>

    <div class="jy-pane" id="jyRunPane" hidden>
      <div class="jy-run-head" id="jyRunHead">正在生成剪映草稿</div>
      <ol class="jy-stages" id="jyStages"></ol>
      <div class="jy-progress" id="jyProgress" data-known="0"><div class="pack-bar"><div id="jyBar"></div></div><div class="jy-progress-txt" id="jyProgressTxt"></div></div>
      <p class="jy-hint" id="jyRunHint">生成期间可以关掉这个窗口，任务会继续在后台跑。</p>
    </div>

    <div class="jy-pane" id="jyDonePane" hidden>
      <p class="jy-done-head" id="jyDoneHead"></p>
      <div class="jy-result" id="jyResult"></div>
      <div class="jy-issues" id="jyDoneIssues" hidden></div>
      <p class="jy-hint" id="jyDoneHint"></p>
    </div>

    <div class="m-btns jy-btns">
      <button class="btn" id="jyClose" type="button">取消</button>
      <button class="btn ghost" id="jyBackground" type="button" hidden>后台继续</button>
      <button class="btn ghost" id="jyAdjust" type="button" hidden>调整设置</button>
      <button class="btn" id="jyReveal" type="button" hidden>在访达中显示</button>
      <button class="btn" id="jyOpenApp" type="button" hidden>打开剪映</button>
      <button class="btn" id="jyRegister" type="button" hidden>加入剪映草稿</button>
      <button class="btn primary" id="jyGo" type="button">生成剪映草稿</button>
      <button class="btn danger" id="jyCancelRun" type="button" hidden>取消生成</button>
    </div>
  </div></div>`;
}

/* ── 面板切换 ── */
function isShown() {
  return $('#jianyingMask')?.classList.contains('show') || false;
}
function showMask() {
  $('#jianyingMask').classList.add('show');
}
function hideMask() {
  viewToken++;
  $('#jianyingMask').classList.remove('show');
}
function closeModal() {
  if (pane === 'run' && running) return dismissRunning();
  hideMask();
}
function dismissRunning() {
  hideMask();
  toast('导出还在后台继续，完成后会提示', null, 'info');
}
function setPane(name) {
  pane = name;
  $('#jyConfigPane').hidden = name !== 'config';
  $('#jyRunPane').hidden = name !== 'run';
  $('#jyDonePane').hidden = name !== 'done';
  $('#jyGo').hidden = name !== 'config';
  $('#jyGo').disabled = false;
  $('#jyGo').textContent = '生成剪映草稿';
  $('#jyClose').hidden = name === 'run';
  $('#jyClose').textContent = name === 'done' ? '完成' : '取消';
  $('#jyAdjust').hidden = name !== 'done';
  $('#jyReveal').hidden = true;
  $('#jyOpenApp').hidden = true;
  $('#jyRegister').hidden = true;
  $('#jyBackground').hidden = name !== 'run';
  $('#jyCancelRun').hidden = name !== 'run';
  $('#jyCancelRun').disabled = false;
  $('#jyCancelRun').textContent = '取消生成';
}

/* ── 首屏 ── */
export function openJianyingExport() {
  if (isShown()) return;
  closePop();
  viewToken++;
  const token = viewToken;
  showMask();
  if (running) {
    setPane('run');
    renderRun();
    return;
  }
  prefs = editExport.loadJianyingSettings();
  detection = null;
  prepared = null;
  snapshot = null;
  configIssues = [];
  configError = '';
  preparing = false;
  applyPrefsToForm();
  renderTarget();
  hideIssues($('#jyIssues'));
  if (prefs.configured && !quickSuppressed) {
    void tryQuickStart(token).catch(error => {
      console.error('快捷生成剪映草稿失败', error);
      quickSuppressed = true;
      configError = '准备导出时出错：' + (error?.message || error);
      setPane('config');
      renderSummary();
      renderAssetsLine();
      updateGoState();
    });
    return;
  }
  setPane('config');
  renderSummary();
  renderAssetsLine();
  updateGoState();
  void refreshConfig(token);
}

/* 成功导出过一次之后的入口：按记住的本机设置直接开始。
   发现版本不兼容、需要确认的问题或目录失效时退回完整设置，不静默降级。 */
async function tryQuickStart(token) {
  setPane('run');
  $('#jyRunHead').textContent = '正在按上次的设置准备…';
  $('#jyProgressTxt').textContent = '正在检查项目与素材…';
  renderStages();
  detection = await editExport.detectJianying();
  if (token !== viewToken) return;
  renderTarget();
  const appFound = detection.ok || !!detection.version || !!detection.appPath;
  if (!appFound || !detection.supported || (prefs.mode !== 'folder' && !detection.ok)) {
    setPane('config');
    renderSummary();
    renderAssetsLine();
    updateGoState();
    void refreshConfig(token);
    return;
  }
  if (prefs.mode === 'folder' && !prefs.destDir) {
    quickSuppressed = true;
    setPane('config');
    renderSummary();
    renderAssetsLine();
    updateGoState();
    return;
  }
  const captured = editExport.captureExportSnapshot();
  if (token !== viewToken) return;
  if (!captured.ok) {
    configError = captured.error;
    quickSuppressed = true;
    setPane('config');
    renderSummary();
    renderAssetsLine();
    updateGoState();
    return;
  }
  snapshot = captured.snapshot;
  const prep = await editExport.prepareJianyingExport(snapshot, prefs.options);
  if (token !== viewToken) return;
  if (!prep.ok || prep.issues.some(issue => levelOf(issue) !== 'info')) {
    if (!prep.ok) configError = prep.error;
    quickSuppressed = true;
    setPane('config');
    prepared = prep.ok ? prep : null;
    configIssues = prep.ok ? prep.issues : [];
    renderSummary();
    renderAssetsLine();
    renderIssues($('#jyIssues'), configIssues, 'config');
    renderConfirmRow();
    updateGoState();
    return;
  }
  prepared = prep;
  configIssues = prep.issues;
  launchJob({
    mode: prefs.mode,
    destDir: prefs.destDir,
    draftName: state.title || '未命名项目',
    options: prefs.options,
    prepared: prep,
    quick: true,
  });
}

function applyPrefsToForm() {
  $('#jyName').value = state.title || '未命名项目';
  document.querySelectorAll('input[name="jyMode"]').forEach(input => (input.checked = input.value === prefs.mode));
  $('#jyCanvas').value = canvasValue(prefs.options);
  $('#jyFps').value = String(prefs.options.fps);
  $('#jySubs').checked = !!prefs.options.subtitles;
  $('#jyAlt').checked = !!prefs.options.altAssets;
  $('#jyConfirm').checked = false;
  renderDestRow();
}

function canvasValue(options) {
  const hit = CANVAS_OPTIONS.find(item => item.width === options.width && item.height === options.height);
  return hit ? hit.value : CANVAS_OPTIONS[0].value;
}
function formOptions() {
  const [width, height] = String($('#jyCanvas').value || '1920x1080')
    .split('x')
    .map(Number);
  const fps = Number($('#jyFps').value);
  return {
    width: width || 1920,
    height: height || 1080,
    fps: FPS_OPTIONS.includes(fps) ? fps : 30,
    subtitles: !!$('#jySubs').checked,
    altAssets: !!$('#jyAlt').checked,
  };
}
function currentMode() {
  return document.querySelector('input[name="jyMode"]:checked')?.value === 'folder' ? 'folder' : 'library';
}
function formName() {
  return $('#jyName').value.trim() || state.title || '未命名项目';
}

function renderTarget() {
  const el = $('#jyTarget');
  if (!detection) {
    el.dataset.level = 'pending';
    el.innerHTML = '<b>正在检测本机剪映…</b>';
    return;
  }
  const issues = (detection.issues || []).filter(issue => issue?.message).map(issue => esc(issue.message));
  const tail = issues.length ? `<small>${issues.join('；')}</small>` : '';
  if (detection.unavailable) {
    el.dataset.level = 'warn';
    el.innerHTML = `<b>暂不可用</b><span>${esc(detection.error || '这个版本还不支持导出到剪映')}</span>${tail}`;
    return;
  }
  const appFound = detection.ok || !!detection.version || !!detection.appPath;
  if (!appFound) {
    el.dataset.level = 'warn';
    el.innerHTML = `<b>没找到 Mac 版剪映专业版</b><span>${esc(detection.error || '请先安装剪映再试')}</span>${tail}`;
    return;
  }
  const version = detection.version ? `剪映 ${detection.version}` : 'Mac 版剪映专业版';
  if (!detection.supported) {
    el.dataset.level = 'warn';
    el.innerHTML = `<b>${esc(version)} · 未验证版本</b><span>首版只验证过 11.6，这个版本暂不生成，避免做出来的草稿打不开</span>${tail}`;
    return;
  }
  if (!detection.ok) {
    el.dataset.level = 'warn';
    el.innerHTML = `<b>${esc(version)} · 剪映草稿库暂时不可用</b><span>可以改用「保存草稿文件夹」生成草稿</span>${tail}`;
    return;
  }
  el.dataset.level = 'ok';
  el.innerHTML = `<b>${esc(version)} · 已适配</b><span>${detection.running ? '剪映正在运行' : '草稿会出现在剪映「本地草稿」'}</span>${tail}`;
}

function renderDestRow() {
  const folder = currentMode() === 'folder';
  $('#jyDestRow').hidden = !folder;
  if (!folder) return;
  const base = prefs?.destDir || '';
  const name = safeFileName(formName());
  $('#jyDest').textContent = base ? `${shortPath(base)}/${name}` : '还没有选择位置';
  $('#jyDest').title = base || '';
  $('#jyPickDest').textContent = base ? '更换位置…' : '选择位置…';
}

function renderAssetsLine() {
  const el = $('#jyAssets');
  const volume = prepared?.volume;
  if (!volume) {
    el.textContent = '素材复制：把用到的本地素材复制进草稿文件夹，正在统计体积…';
    return;
  }
  const parts = [];
  if (volume.files) parts.push(`约 ${fmtBytes(volume.bytes)}`);
  if (volume.unknown) parts.push(`${volume.unknown} 个文件读不到大小`);
  if (volume.freezeCount) parts.push(`另生成 ${volume.freezeCount} 张定格图`);
  el.textContent = `素材复制：把用到的本地素材复制进草稿文件夹${parts.length ? ' · ' + parts.join(' · ') : ''}`;
}

function renderSummary() {
  const host = $('#jySummary');
  if (configError) {
    host.innerHTML = `<p class="jy-error">${esc(configError)}</p>`;
    return;
  }
  const plan = prepared?.plan;
  if (!plan) {
    host.innerHTML = '<p class="jy-empty">正在读取项目排布…</p>';
    return;
  }
  const stats = plan.stats || {};
  const durationSec = Number(plan.durationUs) > 0 ? plan.durationUs / 1e6 : (Number(stats.totalUs) || 0) / 1e6;
  const shots = Number(stats.shots) || 0;
  const segments = Number(stats.segments) || 0;
  const timing = plan.timing || {};
  const timingBase =
    { srt: '按剪映字幕时间', fit: '按口播音频时长推算', rate: '按语速估算' }[timing.source] || '按现有时间轴';
  const timingExtra = [];
  const counts = timing.counts || {};
  if (timing.mixed) timingExtra.push('部分字幕时间');
  if (counts.low) timingExtra.push(`${counts.low} 句低置信`);
  if (counts.est) timingExtra.push(`${counts.est} 句估算`);
  if (counts.gap) timingExtra.push(`${counts.gap} 句推算`);
  const hasVoice = (plan.tracks?.audio || []).length > 0;
  const issueCounts = { block: 0, confirm: 0, info: 0 };
  for (const issue of configIssues) issueCounts[levelOf(issue)]++;
  const issueText = configIssues.length
    ? [
        issueCounts.block ? `${issueCounts.block} 项阻塞` : '',
        issueCounts.confirm ? `${issueCounts.confirm} 项需确认` : '',
        issueCounts.info ? `${issueCounts.info} 项提醒` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '没有需要处理的问题';
  host.innerHTML = [
    `<div class="jy-sum-row"><b>画面</b><span>${shots} 个镜头 · ${segments} 个片段${stats.freezeCount ? ` · 含 ${stats.freezeCount} 段定格` : ''}</span></div>`,
    `<div class="jy-sum-row"><b>总时长</b><span>${durationSec > 0 ? fmtTc(durationSec) : '—'}${stats.gapUs ? `（留白 ${fmtLen(stats.gapUs / 1e6)}）` : ''}</span></div>`,
    `<div class="jy-sum-row"><b>口播</b><span>${hasVoice ? '加入独立音轨，与画面一起进剪映' : '项目没有口播音频，不含口播'}</span></div>`,
    `<div class="jy-sum-row"><b>时间来源</b><span>${timingBase}${timingExtra.length ? ' · ' + timingExtra.join(' · ') : ''}</span></div>`,
    `<div class="jy-sum-row" data-issues="${issueCounts.block ? 'block' : issueCounts.confirm ? 'confirm' : ''}"><b>问题</b><span>${issueText}</span></div>`,
  ].join('');
}

function hideIssues(host) {
  host.hidden = true;
  host.innerHTML = '';
}

function issueWhere(issue, row) {
  if (row) return `第 ${row.no} 句`;
  if (issue.lineNo != null) return `第 ${issue.lineNo} 句`;
  return '';
}

function renderIssues(host, issues, scope) {
  const list = issues || [];
  if (!list.length) return hideIssues(host);
  doneIssues = scope === 'done' ? list : doneIssues;
  const counts = { block: 0, confirm: 0, info: 0 };
  for (const issue of list) counts[levelOf(issue)]++;
  const head = [
    counts.block ? `${counts.block} 项阻塞` : '',
    counts.confirm ? `${counts.confirm} 项需确认` : '',
    counts.info ? `${counts.info} 项提醒` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  host.hidden = false;
  host.innerHTML =
    `<div class="jy-issues-head">${esc(head)}</div>` +
    list
      .map((issue, index) => {
        const level = levelOf(issue);
        const row = issueRow(issue);
        const where = issueWhere(issue, row);
        const text = esc(issue.message || issue.code || '待处理');
        if (!row)
          return `<div class="jy-issue" data-level="${level}"><span class="jy-issue-level">${LEVEL_LABEL[level]}</span><span class="jy-issue-text">${text}</span>${where ? `<span class="jy-issue-where">${esc(where)}</span>` : ''}</div>`;
        return `<button class="jy-issue" type="button" data-level="${level}" data-jy-issue="${index}" data-jy-scope="${scope}"><span class="jy-issue-level">${LEVEL_LABEL[level]}</span><span class="jy-issue-text">${text}</span><span class="jy-issue-where">${esc(where || '定位')} ›</span></button>`;
      })
      .join('');
}

function renderConfirmRow() {
  const need = configIssues.some(isConfirm);
  $('#jyConfirmRow').hidden = !need;
  if (!need) $('#jyConfirm').checked = false;
  return need;
}

function updateGoState() {
  const reason = goBlocker();
  $('#jyGo').disabled = !!reason;
  $('#jyGo').title = reason || '';
  $('#jyGo').textContent = preparing ? '正在检查…' : '生成剪映草稿';
}

function goBlocker() {
  if (starting) return '正在准备导出';
  if (preparing) return '正在检查项目和素材';
  if (!detection) return '正在检测剪映';
  if (detection.unavailable) return detection.error || '这个版本还不支持导出到剪映';
  const appFound = detection.ok || !!detection.version || !!detection.appPath;
  if (!appFound) return '没找到 Mac 版剪映专业版';
  if (!detection.supported) return '当前剪映版本未验证';
  if (currentMode() === 'library' && !detection.ok) return '剪映草稿库暂时不可用，改用「保存草稿文件夹」';
  if (!prepared?.ok) return prepared?.error || configError || '导出计划还没准备好';
  if (configIssues.some(isBlocking)) return '有阻塞问题，先处理后再导出';
  if (!formName()) return '草稿名称不能为空';
  if (currentMode() === 'folder' && !prefs?.destDir) return '先选择草稿保存位置';
  if (configIssues.some(isConfirm) && !$('#jyConfirm').checked) return '先勾选确认上面的待确认项';
  return '';
}

async function refreshConfig(token) {
  const seq = ++prepareSeq;
  preparing = true;
  renderSummary();
  renderAssetsLine();
  updateGoState();
  if (!snapshot) {
    const captured = editExport.captureExportSnapshot();
    if (!captured.ok) {
      preparing = false;
      configError = captured.error;
      renderSummary();
      renderAssetsLine();
      updateGoState();
      return;
    }
    snapshot = captured.snapshot;
  }
  const det = detection || (await editExport.detectJianying());
  const prep = await editExport.prepareJianyingExport(snapshot, formOptions());
  if (token !== viewToken || seq !== prepareSeq) return;
  preparing = false;
  detection = det;
  prepared = prep.ok ? prep : null;
  configError = prep.ok ? '' : prep.error;
  configIssues = prep.ok ? prep.issues : [];
  renderTarget();
  renderAssetsLine();
  renderSummary();
  renderIssues($('#jyIssues'), configIssues, 'config');
  renderConfirmRow();
  renderDestRow();
  updateGoState();
}

function schedulePrepare() {
  clearTimeout(prepareTimer);
  prepareTimer = setTimeout(() => {
    if (pane !== 'config') return;
    void refreshConfig(viewToken);
  }, 180);
}

function onOptionChange() {
  prefs = { ...prefs, options: formOptions() };
  editExport.saveJianyingSettings({ mode: currentMode(), options: prefs.options });
  renderDestRow();
  schedulePrepare();
}

function onModeChange() {
  prefs = { ...prefs, mode: currentMode() };
  editExport.saveJianyingSettings({ mode: prefs.mode, options: formOptions() });
  renderDestRow();
  updateGoState();
}

async function pickDest() {
  const picked = await editExport.pickJianyingFolder(prefs?.destDir || '');
  if (!picked) return;
  prefs = { ...prefs, destDir: picked };
  editExport.saveJianyingSettings({ destDir: picked });
  renderDestRow();
  updateGoState();
}

/* ── 开始生成 ── */
async function startFromForm() {
  if (starting || running) return;
  if (goBlocker()) return;
  starting = true;
  updateGoState();
  try {
    const options = formOptions();
    const mode = currentMode();
    prefs = { ...prefs, mode, options };
    editExport.saveJianyingSettings({ mode, options });
    const captured = editExport.captureExportSnapshot();
    if (!captured.ok) return toast(captured.error, null, 'error');
    snapshot = captured.snapshot;
    const prep = await editExport.prepareJianyingExport(snapshot, options);
    if (!prep.ok) {
      configError = prep.error;
      prepared = null;
      renderSummary();
      updateGoState();
      return toast(prep.error, null, 'error');
    }
    prepared = prep;
    configIssues = prep.issues;
    renderAssetsLine();
    renderSummary();
    renderIssues($('#jyIssues'), configIssues, 'config');
    renderConfirmRow();
    if (prep.issues.some(isBlocking)) {
      updateGoState();
      return toast('还有阻塞问题，先处理后再导出', null, 'warn');
    }
    if (prep.issues.some(isConfirm) && !$('#jyConfirm').checked) {
      updateGoState();
      return toast('先勾选确认上面的待确认项', null, 'warn');
    }
    launchJob({ mode, destDir: prefs.destDir, draftName: formName(), options, prepared: prep, quick: false });
  } finally {
    starting = false;
    if (pane === 'config') updateGoState();
  }
}

function launchJob({ mode, destDir, draftName, options, prepared: prep, quick }) {
  if (running) return false;
  const job = {
    jobId: '',
    cancelRequested: false,
    mode,
    destDir,
    options,
    draftName,
    progress: null,
    quick: !!quick,
  };
  running = job;
  setPane('run');
  $('#jyRunHead').textContent = quick ? '正在按上次的设置生成草稿' : '正在生成剪映草稿';
  $('#jyProgressTxt').textContent = '正在检查项目与素材…';
  renderRun();
  editExport
    .startPreparedJianyingExport(prep, {
      mode,
      destDir,
      draftName,
      onProgress: progress => {
        if (running !== job) return;
        job.progress = progress;
        renderRun();
      },
      onJob: info => {
        if (running !== job) return;
        job.jobId = info.jobId;
        if (job.cancelRequested) void editExport.cancelJianyingExport(info.jobId);
      },
    })
    .then(result => {
      if (running !== job) return;
      running = null;
      finishInto(result || { ok: false, error: '没有收到导出结果' }, job);
    })
    .catch(error => {
      if (running !== job) return;
      running = null;
      finishInto({ ok: false, error: '导出失败：' + (error?.message || error) }, job);
    });
  return true;
}

async function requestCancel() {
  if (!running || running.cancelRequested) return;
  running.cancelRequested = true;
  $('#jyCancelRun').disabled = true;
  $('#jyCancelRun').textContent = '正在取消…';
  $('#jyRunHead').textContent = '正在取消…';
  if (!running.jobId) {
    $('#jyProgressTxt').textContent = '任务刚开始，取消请求会在创建后立刻发出…';
    return;
  }
  const canceled = await editExport.cancelJianyingExport(running.jobId);
  if (!running) return;
  if (!canceled) {
    running.cancelRequested = false;
    $('#jyCancelRun').disabled = false;
    $('#jyCancelRun').textContent = '取消生成';
    $('#jyRunHead').textContent = '正在生成剪映草稿';
    toast('没能取消，任务可能已经完成', null, 'warn');
  }
}

/* ── 进度 ── */
function stageDetail(key, progress) {
  if (!progress) return '准备中…';
  if (key === 'copy' && Number(progress.total) > 0) return `${fmtBytes(progress.done)} / ${fmtBytes(progress.total)}`;
  if (key === 'freeze' && Number(progress.total) > 0) return `${progress.done} / ${progress.total} 张`;
  return progress.message || '处理中…';
}

function renderStages() {
  const job = running;
  const phase = job?.progress?.phase || '';
  const stageIndex = PHASE_STAGE[phase] ?? (job ? 0 : -1);
  $('#jyStages').innerHTML = STAGES.map((stage, index) => {
    let state = 'pending';
    if (!job) state = index === 0 ? 'active' : 'pending';
    else if (index < stageIndex) state = 'done';
    else if (index === stageIndex) state = 'active';
    if (job?.mode === 'folder' && stage.key === 'register') state = 'skip';
    const detail =
      state === 'active'
        ? job
          ? stageDetail(stage.key, job.progress)
          : '准备中…'
        : state === 'skip'
          ? '保存到文件夹，不需要'
          : '';
    const dot = state === 'done' ? '✓' : state === 'skip' ? '–' : '';
    return `<li class="jy-stage" data-state="${state}"><span class="jy-stage-dot">${dot}</span><span class="jy-stage-name">${stage.label}</span>${detail ? `<span class="jy-stage-detail">${esc(detail)}</span>` : ''}</li>`;
  }).join('');
}

function renderRun() {
  const job = running;
  renderStages();
  const progress = job?.progress;
  const phase = progress?.phase || '';
  const canceling = !!job?.cancelRequested;
  $('#jyRunHead').textContent = canceling ? '正在取消…' : job?.quick ? '正在按上次的设置生成草稿' : '正在生成剪映草稿';
  const known = job && (phase === 'copy' || phase === 'freeze') && Number(progress.total) > 0;
  const wrap = $('#jyProgress');
  if (known) {
    const pct = Math.max(0, Math.min(100, (Number(progress.done) / Number(progress.total)) * 100));
    wrap.dataset.known = '1';
    $('#jyBar').style.width = pct.toFixed(1) + '%';
    $('#jyProgressTxt').textContent =
      phase === 'copy'
        ? `${fmtBytes(progress.done)} / ${fmtBytes(progress.total)} · ${Math.floor(pct)}%`
        : `${progress.done} / ${progress.total} 张 · ${Math.floor(pct)}%`;
  } else {
    wrap.dataset.known = '0';
    $('#jyBar').style.width = '0';
    $('#jyProgressTxt').textContent = canceling ? '正在停止这次导出…' : progress?.message || '处理中…';
  }
  $('#jyCancelRun').disabled = canceling;
  $('#jyCancelRun').textContent = canceling ? '正在取消…' : '取消生成';
}

/* ── 完成 ── */
function joinText(entry) {
  const result = entry.result;
  if (entry.mode === 'folder') return '已保存到文件夹，没有加入剪映；放进剪映草稿目录后才能打开';
  if (result.registered) return '已加入剪映草稿列表，打开剪映就能看到';
  if (result.needsQuit) return '剪映正在运行，暂时没有加入列表；退出剪映后可再点「加入剪映草稿」';
  return '没有加入剪映草稿列表';
}

function finishInto(result, job) {
  const entry = { result, mode: job.mode, destDir: job.destDir, options: job.options, draftName: job.draftName };
  lastDone = entry;
  if (result?.ok && !result.canceled) {
    quickSuppressed = false;
    editExport.saveJianyingSettings({
      mode: job.mode,
      destDir: job.destDir,
      options: job.options,
      configured: true,
    });
    prefs = editExport.loadJianyingSettings();
  } else {
    quickSuppressed = true;
  }
  if (isShown()) renderDone(entry);
  else notifyHidden(entry);
}

function resultRows(entry) {
  const { result } = entry;
  const failed = !result.ok && !result.canceled;
  const canceled = !!result.canceled;
  const rows = [];
  rows.push(
    `<div class="jy-res-row"><b>草稿</b><span>${esc(result.draftName || entry.draftName || '未命名草稿')}</span></div>`,
  );
  if (result.draftDir)
    rows.push(
      `<div class="jy-res-row"><b>位置</b><code title="${esc(result.draftDir)}">${esc(shortPath(result.draftDir))}</code></div>`,
    );
  if (!failed && !canceled) {
    const segments = Number(result.segmentCount) || Number(result.planStats?.segments) || 0;
    rows.push(
      `<div class="jy-res-row"><b>片段</b><span>${segments} 个片段 · ${Number(result.assetCount) || 0} 个素材${Number(result.freezeCount) ? ` · ${result.freezeCount} 张定格图` : ''}</span></div>`,
    );
    rows.push(`<div class="jy-res-row"><b>加入剪映</b><span>${joinText(entry)}</span></div>`);
  }
  if (result.projectChanged)
    rows.push(
      `<div class="jy-res-row"><b>基于</b><span>开始导出时「${esc(result.projectTitle || '原项目')}」的内容，之后的改动没有进入这份草稿</span></div>`,
    );
  if (result.reportPath)
    rows.push(
      `<div class="jy-res-row"><b>导出说明</b><code title="${esc(result.reportPath)}">${esc(shortPath(result.reportPath))}</code></div>`,
    );
  if (result.notes?.length)
    rows.push(`<div class="jy-res-row"><b>说明</b><span>${esc(result.notes.join('；'))}</span></div>`);
  if (result.error && !(canceled && /取消/.test(result.error)))
    rows.push(`<div class="jy-res-row"><b>原因</b><span class="jy-error">${esc(result.error)}</span></div>`);
  return rows.join('');
}

function renderDone(entry) {
  const { result } = entry;
  const canceled = !!result.canceled;
  const failed = !result.ok && !canceled;
  const issues = mergeIssues(result.planIssues, result.issues);
  const pending = issues.filter(issue => levelOf(issue) !== 'info').length;
  setPane('done');
  const head = $('#jyDoneHead');
  head.textContent = canceled
    ? '已取消，没有留下草稿'
    : failed
      ? '这次没有生成草稿'
      : pending
        ? `草稿已生成，含 ${pending} 项待处理`
        : '剪映草稿已生成';
  head.dataset.level = canceled || failed ? 'warn' : pending ? 'warn' : 'ok';
  $('#jyResult').innerHTML = resultRows(entry);
  renderIssues($('#jyDoneIssues'), issues, 'done');
  const hint = $('#jyDoneHint');
  if (canceled) hint.textContent = '取消只清理这次任务自己的临时文件，已有草稿和项目不受影响。';
  else if (failed) hint.textContent = '项目没有被修改。调整设置或处理问题后可以再生成一次。';
  else if (entry.mode === 'folder')
    hint.textContent = '这是独立草稿文件夹：交付或手动放进剪映草稿目录后即可打开；移动位置后素材可能需要重新定位。';
  else if (result.needsQuit)
    hint.textContent = '剪映运行期间不会改动草稿列表。退出剪映后点「加入剪映草稿」，再打开剪映就能看到。';
  else hint.textContent = '这是新草稿，不会覆盖你已经在剪映里改过的其他草稿。';
  $('#jyReveal').hidden = !result.draftDir;
  $('#jyOpenApp').hidden = false;
  $('#jyRegister').hidden = !(entry.mode !== 'folder' && result.draftDir && !result.registered && !canceled && !failed);
  $('#jyAdjust').hidden = false;
}

function notifyHidden(entry) {
  const { result } = entry;
  const openResult = () => {
    showMask();
    viewToken++;
    renderDone(entry);
  };
  if (result.canceled) {
    toast('已取消生成剪映草稿', null, 'info');
    return;
  }
  if (!result.ok) {
    toast('剪映草稿生成失败：' + (result.error || '未知原因'), { label: '查看详情', cb: openResult }, 'error');
    return;
  }
  const pending = mergeIssues(result.planIssues, result.issues).filter(issue => levelOf(issue) !== 'info').length;
  const where = result.projectChanged ? `（基于「${result.projectTitle}」开始导出时的内容）` : '';
  toast(
    `剪映草稿已生成「${result.draftName || entry.draftName}」${where}${pending ? `，${pending} 项待处理` : ''}`,
    { label: '查看结果', cb: openResult },
    pending ? 'warn' : 'ok',
  );
}

/* ── 结果页动作 ── */
async function revealDraft() {
  const draftDir = lastDone?.result?.draftDir;
  const shown = await editExport.revealJianyingDraft(draftDir);
  if (!shown) toast('没能在访达中显示，草稿位置在 ' + shortPath(draftDir || ''), null, 'warn');
}

async function openApp() {
  const opened = await editExport.openJianyingApp();
  if (!opened) toast('打不开剪映，请从程序坞或启动台打开', null, 'warn');
}

async function registerDraft() {
  const entry = lastDone;
  const draftDir = entry?.result?.draftDir;
  if (!draftDir) return;
  $('#jyRegister').disabled = true;
  const result = await editExport.registerJianyingDraft(draftDir);
  $('#jyRegister').disabled = false;
  if (!result?.ok) {
    toast(
      result?.needsQuit
        ? '剪映还在运行，退出剪映后再点「加入剪映草稿」'
        : '没能加入剪映草稿列表：' + (result?.error || '请退出剪映后再试'),
      null,
      'warn',
    );
    return;
  }
  if (result.registered) {
    entry.result.registered = true;
    toast('已加入剪映草稿列表', null, 'ok');
    renderDone(entry);
  } else {
    toast('剪映还在运行，退出后再试一次', null, 'warn');
  }
}

async function backToConfig() {
  viewToken++;
  const token = viewToken;
  prefs = editExport.loadJianyingSettings();
  detection = null;
  snapshot = null;
  prepared = null;
  configIssues = [];
  configError = '';
  preparing = false;
  setPane('config');
  applyPrefsToForm();
  renderTarget();
  hideIssues($('#jyIssues'));
  renderSummary();
  renderAssetsLine();
  updateGoState();
  await refreshConfig(token);
}

/* ── 问题定位 ── */
function onIssueClick(event) {
  const button = event.target.closest('[data-jy-issue]');
  if (!button) return;
  const scope = button.dataset.jyScope;
  const list = scope === 'done' ? doneIssues : configIssues;
  const issue = list[Number(button.dataset.jyIssue)];
  if (!issue) return;
  const row = issueRow(issue);
  if (!row) return toast('这一项对应的内容已经不在当前项目里', null, 'info');
  hideMask();
  runCommand('nav:jump', row.id);
  if (issue.assetId) runCommand('inspector:open', row.id);
}

function onEnter() {
  if (pane === 'run') return;
  if (pane === 'done') return hideMask();
  if ($('#jyGo').disabled) return;
  void startFromForm();
}

export function initJianyingExport() {
  document.body.insertAdjacentHTML('beforeend', modalHtml());
  $('#jianyingMask').addEventListener('click', event => {
    if (event.target.id === 'jianyingMask') closeModal();
  });
  $('#jyClose').addEventListener('click', () => hideMask());
  $('#jyGo').addEventListener('click', () => void startFromForm());
  $('#jyAdjust').addEventListener('click', () => void backToConfig());
  $('#jyReveal').addEventListener('click', () => void revealDraft());
  $('#jyOpenApp').addEventListener('click', () => void openApp());
  $('#jyRegister').addEventListener('click', () => void registerDraft());
  $('#jyBackground').addEventListener('click', dismissRunning);
  $('#jyCancelRun').addEventListener('click', () => void requestCancel());
  $('#jyPickDest').addEventListener('click', () => void pickDest());
  document.querySelectorAll('input[name="jyMode"]').forEach(input => input.addEventListener('change', onModeChange));
  for (const id of ['jyCanvas', 'jyFps', 'jySubs', 'jyAlt']) $(`#${id}`).addEventListener('change', onOptionChange);
  $('#jyName').addEventListener('input', () => {
    renderDestRow();
    updateGoState();
  });
  $('#jyConfirm').addEventListener('change', updateGoState);
  $('#jyIssues').addEventListener('click', onIssueClick);
  $('#jyDoneIssues').addEventListener('click', onIssueClick);
  registerModal('jianyingMask', { close: closeModal, enter: onEnter });
  registerCommand('jianying:export', openJianyingExport);
}
