/* 导出到剪映弹窗的视图：弹窗结构、摘要、问题列表、进度和结果呈现都在这里。
   只按传入的状态渲染，不启动导出、不保存配置、也不另存任务状态；
   问题能否定位由接线层通过回调 context.locateIssue 提供（定位本身仍留在接线层）。
   依赖方向：view 只接收 controller 的状态与回调，不反过来调用 controller。 */
import { esc, toast } from '../ui/base/dom.js';
import { fmtTc, fmtLen, safeFileName } from '../core/text.js';
import { targetStatusOf } from '../core/jianying-target.js';
import { levelOf } from './jianying-export-controller.js';

const $ = s => document.querySelector(s);

export const CANVAS_OPTIONS = Object.freeze([
  { value: '1920x1080', width: 1920, height: 1080, label: '1920 × 1080 · 横屏' },
  { value: '1080x1920', width: 1080, height: 1920, label: '1080 × 1920 · 竖屏' },
  { value: '1080x1080', width: 1080, height: 1080, label: '1080 × 1080 · 方形' },
]);
export const FPS_OPTIONS = Object.freeze([30, 25, 24, 60]);
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

let appliedFormSeq = -1;

function fmtBytes(n) {
  if (!(n > 0)) return '0 MB';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1) + ' GB';
  return Math.max(0.1, n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1) + ' MB';
}
const shortPath = p => String(p || '').replace(/^\/Users\/[^/]+/, '~');
const isConfirm = issue => levelOf(issue) === 'confirm';

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

export function mountJianyingExportView() {
  if ($('#jianyingMask')) return true;
  document.body.insertAdjacentHTML('beforeend', modalHtml());
  return !!$('#jianyingMask');
}

export function isJianyingExportViewShown() {
  return $('#jianyingMask')?.classList.contains('show') || false;
}

export function showJianyingExportView() {
  $('#jianyingMask')?.classList.add('show');
}

export function hideJianyingExportView() {
  $('#jianyingMask')?.classList.remove('show');
}

/* ── 面板切换 ── */
function setPane(name) {
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

/* ── 表单回填：只在表单代次变化时做，避免每次重绘都抢用户正在敲的字 ── */
function applyForm(state) {
  appliedFormSeq = state.formSeq;
  const { form } = state;
  $('#jyName').value = form.name || '';
  document.querySelectorAll('input[name="jyMode"]').forEach(input => (input.checked = input.value === form.mode));
  $('#jyCanvas').value = canvasValue(form.options);
  $('#jyFps').value = String(form.options.fps);
  $('#jySubs').checked = !!form.options.subtitles;
  $('#jyAlt').checked = !!form.options.altAssets;
  $('#jyConfirm').checked = !!form.confirm;
}

function canvasValue(options) {
  const hit = CANVAS_OPTIONS.find(item => item.width === options.width && item.height === options.height);
  return hit ? hit.value : CANVAS_OPTIONS[0].value;
}

/* ── 首屏 ── */
function renderTarget(detection) {
  const el = $('#jyTarget');
  const status = targetStatusOf(detection);
  el.dataset.level = status.level;
  /* 版本不能导出的原因已由标题和说明讲清，不再把主进程的同义提示重复一遍 */
  const issues = (detection?.issues || [])
    .filter(issue => issue?.message && issue.code !== 'version-unsupported')
    .map(issue => esc(issue.message));
  const tail = issues.length ? `<small>${issues.join('；')}</small>` : '';
  el.innerHTML = `<b>${esc(status.title)}</b>${status.text ? `<span>${esc(status.text)}</span>` : ''}${tail}`;
}

function renderDestRow(state) {
  const folder = state.form.mode === 'folder';
  $('#jyDestRow').hidden = !folder;
  if (!folder) return;
  const base = state.prefs?.destDir || '';
  const name = safeFileName(state.form.name);
  $('#jyDest').textContent = base ? `${shortPath(base)}/${name}` : '还没有选择位置';
  $('#jyDest').title = base || '';
  $('#jyPickDest').textContent = base ? '更换位置…' : '选择位置…';
}

function renderAssetsLine(prepared) {
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

function renderSummary(state) {
  const host = $('#jySummary');
  if (state.configError) {
    host.innerHTML = `<p class="jy-error">${esc(state.configError)}</p>`;
    return;
  }
  const plan = state.prepared?.plan;
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
  for (const issue of state.configIssues) issueCounts[levelOf(issue)]++;
  const issueText = state.configIssues.length
    ? [
        issueCounts.block ? `${issueCounts.block} 项阻塞` : '',
        issueCounts.confirm ? `${issueCounts.confirm} 项需确认` : '',
        issueCounts.info ? `${issueCounts.info} 项提醒` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '没有需要处理的问题';
  host.innerHTML = [
    `<div class="jy-sum-row"><b>画面</b><span>${shots} 个画面 · ${segments} 个片段${stats.freezeCount ? ` · 含 ${stats.freezeCount} 段定格` : ''}</span></div>`,
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

function renderIssues(host, issues, scope, context) {
  const list = issues || [];
  if (!list.length) return hideIssues(host);
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
        const row = typeof context.locateIssue === 'function' ? context.locateIssue(issue) : null;
        const where = issueWhere(issue, row);
        const text = esc(issue.message || issue.code || '待处理');
        if (!row)
          return `<div class="jy-issue" data-level="${level}"><span class="jy-issue-level">${LEVEL_LABEL[level]}</span><span class="jy-issue-text">${text}</span>${where ? `<span class="jy-issue-where">${esc(where)}</span>` : ''}</div>`;
        return `<button class="jy-issue" type="button" data-level="${level}" data-jy-issue="${index}" data-jy-scope="${scope}"><span class="jy-issue-level">${LEVEL_LABEL[level]}</span><span class="jy-issue-text">${text}</span><span class="jy-issue-where">${esc(where || '定位')} ›</span></button>`;
      })
      .join('');
}

function renderConfirmRow(state) {
  const need = state.configIssues.some(isConfirm);
  $('#jyConfirmRow').hidden = !need;
  if (!need) $('#jyConfirm').checked = false;
}

function updateGoState(state) {
  const reason = state.blockReason;
  $('#jyGo').disabled = !!reason;
  $('#jyGo').title = reason || '';
  $('#jyGo').textContent = state.preparing ? '正在检查…' : '生成剪映草稿';
}

/* ── 进度 ── */
function stageDetail(key, progress) {
  if (!progress) return '准备中…';
  if (key === 'copy' && Number(progress.total) > 0) return `${fmtBytes(progress.done)} / ${fmtBytes(progress.total)}`;
  if (key === 'freeze' && Number(progress.total) > 0) return `${progress.done} / ${progress.total} 张`;
  return progress.message || '处理中…';
}

function renderStages(running) {
  const phase = running?.progress?.phase || '';
  const stageIndex = PHASE_STAGE[phase] ?? (running ? 0 : -1);
  $('#jyStages').innerHTML = STAGES.map((stage, index) => {
    let stageState = 'pending';
    if (!running) stageState = index === 0 ? 'active' : 'pending';
    else if (index < stageIndex) stageState = 'done';
    else if (index === stageIndex) stageState = 'active';
    if (running?.mode === 'folder' && stage.key === 'register') stageState = 'skip';
    const detail =
      stageState === 'active'
        ? running
          ? stageDetail(stage.key, running.progress)
          : '准备中…'
        : stageState === 'skip'
          ? '保存到文件夹，不需要'
          : '';
    const dot = stageState === 'done' ? '✓' : stageState === 'skip' ? '–' : '';
    return `<li class="jy-stage" data-state="${stageState}"><span class="jy-stage-dot">${dot}</span><span class="jy-stage-name">${stage.label}</span>${detail ? `<span class="jy-stage-detail">${esc(detail)}</span>` : ''}</li>`;
  }).join('');
}

function renderRun(state) {
  const running = state.running;
  renderStages(running);
  const progress = running?.progress;
  const phase = progress?.phase || '';
  const canceling = !!running?.cancelRequested;
  $('#jyRunHead').textContent = canceling ? '正在取消…' : '正在生成剪映草稿';
  const known = running && (phase === 'copy' || phase === 'freeze') && Number(progress.total) > 0;
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
  if (result.runningUnknown) return '无法确认剪映是否在运行，暂时没有加入列表；退出剪映后可再点「加入剪映草稿」';
  if (result.needsQuit) return '剪映正在运行，暂时没有加入列表；退出剪映后可再点「加入剪映草稿」';
  return '没有加入剪映草稿列表';
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

function renderDone(state, context) {
  const entry = state.lastDone;
  if (!entry) return;
  const { result } = entry;
  const canceled = !!result.canceled;
  const failed = !result.ok && !canceled;
  const issues = state.doneIssues;
  const pending = state.donePending;
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
  renderIssues($('#jyDoneIssues'), issues, 'done', context);
  const hint = $('#jyDoneHint');
  if (canceled) hint.textContent = '取消只清理这次任务自己的临时文件，已有草稿和项目不受影响。';
  else if (failed) hint.textContent = '项目没有被修改。调整设置或处理问题后可以再生成一次。';
  else if (entry.mode === 'folder')
    hint.textContent = '这是独立草稿文件夹：交付或手动放进剪映草稿目录后即可打开；移动位置后素材可能需要重新定位。';
  else if (result.runningUnknown)
    hint.textContent = '这次没能确认剪映是否在运行，为安全起见没有改动草稿列表。退出剪映后点「加入剪映草稿」。';
  else if (result.needsQuit)
    hint.textContent = '剪映运行期间不会改动草稿列表。退出剪映后点「加入剪映草稿」，再打开剪映就能看到。';
  else hint.textContent = '这是新草稿，不会覆盖你已经在剪映里改过的其他草稿。';
  $('#jyReveal').hidden = !result.draftDir;
  $('#jyOpenApp').hidden = false;
  $('#jyRegister').hidden = !(entry.mode !== 'folder' && result.draftDir && !result.registered && !canceled && !failed);
  $('#jyRegister').disabled = !!state.registering;
  $('#jyAdjust').hidden = false;
}

/* ── 整屏渲染 ── */
export function renderJianyingExportView(state, context = {}) {
  if (!document.getElementById('jianyingMask')) return;
  if (state.formSeq !== appliedFormSeq) applyForm(state);
  setPane(state.pane);
  renderTarget(state.detection);
  if (state.pane === 'run') renderRun(state);
  else if (state.pane === 'done') renderDone(state, context);
  else {
    renderDestRow(state);
    renderAssetsLine(state.prepared);
    renderSummary(state);
    renderIssues($('#jyIssues'), state.configIssues, 'config', context);
    renderConfirmRow(state);
    updateGoState(state);
  }
}

/* ── 后台完成 / 关闭时的提示（结果呈现的一部分，由接线层在弹窗藏着时调用） ── */
export function notifyJianyingExportFinished(state, { onOpenResult } = {}) {
  const entry = state.lastDone;
  if (!entry) return;
  const { result } = entry;
  const openResult = () => onOpenResult?.();
  if (result.canceled) {
    toast('已取消生成剪映草稿', null, 'info');
    return;
  }
  if (!result.ok) {
    toast('剪映草稿生成失败：' + (result.error || '未知原因'), { label: '查看详情', cb: openResult }, 'error');
    return;
  }
  const pending = state.donePending;
  const where = result.projectChanged ? `（基于「${result.projectTitle}」开始导出时的内容）` : '';
  toast(
    `剪映草稿已生成「${result.draftName || entry.draftName}」${where}${pending ? `，${pending} 项待处理` : ''}`,
    { label: '查看结果', cb: openResult },
    pending ? 'warn' : 'ok',
  );
}

export function notifyJianyingExportBackground() {
  toast('导出还在后台继续，完成后会提示', null, 'info');
}

export function notifyJianyingExportRevealFailed(draftDir) {
  toast('没能在访达中显示，草稿位置在 ' + shortPath(draftDir || ''), null, 'warn');
}

export function notifyJianyingExportOpenAppFailed() {
  toast('打不开剪映，请从程序坞或启动台打开', null, 'warn');
}
