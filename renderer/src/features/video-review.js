/* 视频审核：Claude 找好的视频候选在这里过目，通过的自动挂成主画面。
   流程：导入候选清单（JSON，type = fenjingtai-candidates）→ 每个候选截 6 张图 + 只播建议的那几秒
   → 通过 / 不要 / 换一个 + 意见 → 通过的挂到画面上（角色主画面、片段入出点、画面描述追加来源一行）
   → 审核结果自动写回候选清单文件，Claude 读得到 → 「保存这几秒」只截那一段存到本地；完整原片要单独点。
   不下载任何文件，直到你点「保存这几秒」或「下载完整原片」。

   1.9 起窗口是一个「收件箱」：
   · 批次：每次导入算一批，默认只看最新一批，顶部写「还剩 N 个待审 / 共 M 个」；旧批次在下拉里。
   · 左边按章节列出这一批的画面（带待审数 / 已审完），右边只显示选中画面的候选；截图只给右边这几个候选截。
   · 审完就走：审过的候选收成一行（能撤回），不再有「已通过」页——通过的结果在表格的画面上看；
     「不要」的关窗口时自动清掉（结果已写回清单，再导入同一份清单也不会回来）。
   · 键盘：1 通过 · 2 不要 · 3 换一个 · ↑↓ 换候选 · ←→ 换画面 · 空格 播放这段；一个画面审完自动跳到下一个。 */
import { state, update, rowById, renumber, on } from '../app/state.js';
import { persist, markProjectDirty } from '../app/storage.js';
import { snapshot } from '../app/undo.js';
import { invalidateProbe } from '../app/asset-actions.js';
import { shotMembers } from '../core/shots.js';
import { assetName, syncMirror } from '../core/asset-model.js';
import { fmtTime } from '../core/text.js';
import {
  CANDIDATE_TYPE,
  DECISION,
  planImport,
  attachCandidate,
  detachCandidate,
  swapToLocal,
  reviewPayload,
  lineTag,
  fileTitle,
  hasLineTag,
} from '../core/candidates.js';
import * as nat from '../platform/native.js';
import { toast, confirmModal, esc } from '../ui/dom.js';
import { registerCommand, runCommand } from '../ui/commands.js';

export { CANDIDATE_TYPE };
const $ = s => document.querySelector(s);
/* 原生能力统一走 platform/native.js（自测可通过 window.fjtHooks 注入替身） */
const native = name => nat[name];

/* ── 状态操作（一次 = 一步撤销） ── */
let writeTimer = null;
function writeBack() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    for (const [file, results] of reviewPayload(state.candidates)) {
      try {
        const r = await native('writeCandidateReview')(file, results);
        if (r && r.ok === false) console.warn('候选清单回写失败', file, r.error);
      } catch (e) {
        console.warn('候选清单回写失败', e);
      }
    }
  }, 500);
}
export const flushWriteBack = () => {
  clearTimeout(writeTimer);
  return Promise.all(
    [...reviewPayload(state.candidates)].map(([f, r]) => native('writeCandidateReview')(f, r).catch(() => null)),
  );
};

export function importCandidates(doc, srcFile) {
  renumber();
  const plan = planImport(doc, srcFile, state.rows, state.candidates);
  if (plan.error) {
    toast(plan.error);
    return null;
  }
  if (!plan.added.length && !plan.updated.length) {
    toast(plan.skipped.length ? `清单里的 ${plan.skipped.length} 个候选都对不上句子` : '清单里没有候选');
    return plan;
  }
  snapshot('导入视频候选');
  // 每次导入算一批：新加的候选、以及链接 / 时间改了重新回到待审的，都归进这一批
  const batch = {
    batchId: 'vb-' + Date.now().toString(36),
    batchAt: Date.now(),
    batchName: batchNameOf(doc, srcFile, plan),
  };
  for (const { old, next } of plan.updated) {
    Object.assign(old, next);
    if (!old.decision) Object.assign(old, batch);
  }
  for (const c of plan.added) Object.assign(c, batch);
  state.candidates = [...state.candidates, ...plan.added];
  persist();
  update('rows');
  curBatch = batch.batchId;
  curShot = null;
  openVideoReview();
  toast(
    `已导入 ${plan.added.length} 个视频候选${plan.updated.length ? `，更新 ${plan.updated.length} 个` : ''}${plan.skipped.length ? ` · ${plan.skipped.length} 个对不上句子，已跳过` : ''}`,
  );
  return plan;
}

/* 批次名：清单里写了 batch / title 就用它，否则用涉及的章节名，再不行用文件名 */
function batchNameOf(doc, srcFile, plan) {
  const given = String(doc.batch || doc.title || '').trim();
  if (given) return given.slice(0, 40);
  const secs = [];
  for (const c of [...plan.added, ...plan.updated.map(x => x.next)]) {
    const name = sectionOf(c.rowId);
    if (name && !secs.includes(name)) secs.push(name);
  }
  if (secs.length === 1) return secs[0];
  if (secs.length > 1) return `${secs[0]} 等 ${secs.length} 章`;
  return assetName(srcFile || '') || '视频候选';
}

export function setDecision(id, d) {
  const c = state.candidates.find(x => x.id === id);
  if (!c) return;
  const next = c.decision === d ? '' : d;
  snapshot(next ? `视频候选：${DECISION[next]}` : '撤回审核');
  let msg = '';
  if (c.decision === 'ok' && next !== 'ok') {
    detachCandidate(c, state.rows, state.assets);
    msg = '已从画面上撤下这个视频 · ⌘Z 可撤销';
  }
  if (next === 'ok') {
    const r = attachCandidate(c, state.rows, state.assets);
    if (r.error) {
      toast(r.error);
      return;
    }
    c.assetId = r.assetId;
    const names = r.demoted.map(x => state.assets[x]?.name || '素材');
    msg =
      r.role === 'main'
        ? `已挂成主画面（${fmtTime(c.in)}–${fmtTime(c.out)}）${names.length ? `，「${names.join('」「')}」让位成备选` : ''}`
        : '这个画面已经有通过的主画面视频，新通过的先放备选，可在「画面与素材」里调整';
  }
  c.decision = next;
  if (next) c.decidedAt = Date.now();
  else delete c.decidedAt;
  touched.add(c.id);
  persist();
  update('rows');
  writeBack();
  if (next) advanceAfterDecision(c);
  renderVideoReview();
  if (msg) toast(msg);
}
let noteTimer = null;
export function setNote(id, text) {
  const c = state.candidates.find(x => x.id === id);
  if (!c) return;
  c.note = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    persist();
    writeBack();
  }, 400);
}

async function ensureMediaDir(force = false) {
  if (state.mediaDir && !force) return state.mediaDir;
  const dir = await native('pickFolder')(state.mediaDir || '');
  if (!dir) return null;
  state.mediaDir = dir;
  persist();
  renderVideoReview();
  return dir;
}
const busy = new Set();
export async function saveSegment(id, { quiet = false } = {}) {
  const c = state.candidates.find(x => x.id === id);
  if (!c || c.decision !== 'ok' || busy.has(id)) return null;
  const dir = await ensureMediaDir();
  if (!dir) return null;
  busy.add(id);
  renderVideoReview();
  let r;
  try {
    renumber();
    r = await native('saveVideoSegment')({ url: c.url, start: c.in, end: c.out, dir, name: fileTitle(c, state.rows) });
  } finally {
    busy.delete(id);
  }
  if (!r || !r.ok) {
    renderVideoReview();
    if (r?.needFfmpeg)
      confirmModal('需要先装 ffmpeg', r.error, '知道了', () => {}, { cancelText: '关闭', danger: false });
    else if (!quiet) toast('保存失败：' + (r?.error || '未知原因'));
    return r;
  }
  snapshot('保存视频片段');
  c.savedPath = r.path;
  swapToLocal(c, r.path, state.rows, state.assets);
  invalidateProbe();
  persist();
  update('rows');
  writeBack();
  renderVideoReview();
  if (!quiet) toast(`已保存：${assetName(r.path)}`, { label: '在访达中显示', cb: () => native('revealAsset')(r.path) });
  return r;
}
/* 旧版本保存的片段文件名只有视频标题：载入项目时在原文件夹里补上句号（第125-127句_…），
   素材库路径、候选记录、候选清单一起改。找不到文件的跳过，不进撤销（改的是磁盘上的文件名） */
let tagging = false,
  tagAgain = false;
export async function tagOldSavedClips() {
  if (tagging) {
    tagAgain = true; // 正在改上一个项目的：改完再看一遍当前项目
    return 0;
  }
  const pid = state.projectId;
  const todo = state.candidates.filter(c => c.savedPath && !hasLineTag(c.savedPath));
  if (!todo.length) return 0;
  tagging = true;
  const { rows, assets, candidates } = state;
  const moved = new Map(); // 旧路径 → 新路径
  try {
    renumber();
    for (const c of todo) {
      const old = c.savedPath;
      if (!moved.has(old)) {
        const tag = lineTag(c, rows);
        if (!tag) continue;
        const r = await native('tagSavedClip')(old, tag);
        if (!r?.ok || !r.path || r.path === old) continue;
        moved.set(old, r.path);
      }
    }
  } finally {
    tagging = false;
    if (tagAgain) {
      tagAgain = false;
      setTimeout(tagOldSavedClips, 0);
    }
  }
  if (!moved.size) return 0;
  for (const c of candidates) if (moved.has(c.savedPath)) c.savedPath = moved.get(c.savedPath);
  for (const a of Object.values(assets || {}))
    if (moved.has(a.path)) {
      a.path = moved.get(a.path);
      a.name = assetName(a.path);
    }
  if (state.projectId !== pid) {
    markProjectDirty(pid); // 中途切了项目：改的是原项目的数据，单独标记写盘
    return moved.size;
  }
  syncMirror(rows, assets);
  invalidateProbe();
  persist();
  update('rows');
  writeBack();
  const first = [...moved.values()][0];
  toast(`已给 ${moved.size} 个保存过的视频片段补上句号，例如「${assetName(first)}」`, {
    label: '在访达中显示',
    cb: () => native('revealAsset')(first),
  });
  return moved.size;
}

export async function saveAllApproved() {
  const list = state.candidates.filter(c => c.decision === 'ok' && !c.savedPath);
  if (!list.length) {
    toast('没有待保存的已通过片段');
    return;
  }
  if (!(await ensureMediaDir())) return;
  let ok = 0,
    fail = 0;
  for (const c of list) {
    toast(`正在保存 ${ok + fail + 1}/${list.length}：${c.title}`);
    const r = await saveSegment(c.id, { quiet: true });
    if (r?.ok) ok++;
    else {
      fail++;
      if (r?.needFfmpeg) return;
    }
  }
  toast(`已保存 ${ok} 段${fail ? `，${fail} 段失败（可以单独重试）` : ''}`);
}
export function downloadOriginal(id) {
  const c = state.candidates.find(x => x.id === id);
  if (!c) return;
  confirmModal(
    '下载完整原片？',
    `会把整部视频下载到保存位置，可能有几百 MB，需要一段时间。\n\n${c.title}\n${c.url}`,
    '下载',
    async () => {
      const dir = await ensureMediaDir();
      if (!dir) return;
      toast('开始下载完整原片…');
      renumber();
      const r = await native('downloadOriginalVideo')({ url: c.url, dir, name: fileTitle(c, state.rows) });
      if (r?.ok)
        toast(`原片已下载：${assetName(r.path)}`, { label: '在访达中显示', cb: () => native('revealAsset')(r.path) });
      else toast('下载失败：' + (r?.error || '未知原因'));
    },
    { danger: false },
  );
}

/* ── 界面 ── */
let curBatch = null; // 正在看的批次
let curShot = null; // 右边显示的画面（画面第一句的 id）
let curCand = null; // 键盘焦点所在的候选
/* 刚审过的候选先展开留在原处（来得及点「保存这几秒」、写意见、撤回），换画面后收成一行 */
const touched = new Set();
const frames = new Map(); // 候选 id → 已截好的帧（重绘时直接搬过去，不重复请求）
const pendingCount = () => state.candidates.filter(c => !c.decision).length;
const isPending = c => !c.decision;
export const candidatesForRow = row =>
  row ? state.candidates.filter(c => shotMembers(state.rows, row).some(m => m.id === c.rowId)) : [];

export function refreshVideoReviewButton() {
  const b = $('#btnVideoReview');
  if (!b) return;
  const n = state.candidates.length;
  b.hidden = !n;
  const p = pendingCount();
  b.textContent = p ? `视频审核 · ${p} 待审` : '视频审核';
}

/* 句子所在章节名 */
function sectionOf(rowId) {
  let name = '';
  for (const r of state.rows) {
    if (r.kind === 'section') name = r.text;
    if (r.id === rowId) return name;
  }
  return '';
}
const leadOf = c => {
  const row = rowById(c.rowId);
  return row ? shotMembers(state.rows, row)[0] : null;
};

/* 批次：按导入时间新的在前；1.8 以前导入的没有批次，归成「之前导入的」 */
function batches() {
  const map = new Map();
  for (const c of state.candidates) {
    const id = c.batchId || 'legacy';
    if (!map.has(id))
      map.set(id, { id, name: c.batchId ? c.batchName || '视频候选' : '之前导入的', at: c.batchAt || 0, cands: [] });
    map.get(id).cands.push(c);
  }
  return [...map.values()].sort((a, b) => b.at - a.at);
}
/* 一批里的画面：按稿子顺序，带章节名和待审数 */
function shotsOf(batch) {
  const order = new Map(state.rows.map((r, i) => [r.id, i]));
  const map = new Map();
  for (const c of batch?.cands || []) {
    const lead = leadOf(c);
    const key = lead ? lead.id : 'missing';
    if (!map.has(key)) map.set(key, { key, lead, cands: [] });
    map.get(key).cands.push(c);
  }
  return [...map.values()]
    .sort((a, b) => (order.get(a.lead?.id) ?? 1e9) - (order.get(b.lead?.id) ?? 1e9))
    .map(g => ({
      ...g,
      section: g.lead ? sectionOf(g.lead.id) : '',
      pending: g.cands.filter(isPending).length,
      ok: g.cands.filter(c => c.decision === 'ok').length,
      re: g.cands.filter(c => c.decision === 're').length,
    }));
}
const curBatchObj = () => batches().find(b => b.id === curBatch) || null;
const curShots = () => shotsOf(curBatchObj());
const curGroup = () => curShots().find(g => g.key === curShot) || null;

/* 打开时选哪一批、哪个画面：指定了画面就去它那一批；否则最新一批里第一个还有待审的画面 */
function pickDefaults(rowId) {
  const all = batches();
  if (rowId != null) {
    const row = rowById(rowId);
    const lead = row ? shotMembers(state.rows, row)[0] : null;
    const hits = state.candidates.filter(c => lead && leadOf(c)?.id === lead.id);
    const hit = hits.find(isPending) || hits[hits.length - 1];
    if (hit) {
      curBatch = hit.batchId || 'legacy';
      curShot = lead.id;
      return;
    }
  }
  if (!all.some(b => b.id === curBatch)) curBatch = (all.find(b => b.cands.some(isPending)) || all[0])?.id ?? null;
  const shots = curShots();
  if (!shots.some(g => g.key === curShot)) curShot = (shots.find(g => g.pending) || shots[0])?.key ?? null;
}
function selectShot(key) {
  if (key === curShot) return;
  curShot = key;
  curCand = null;
  touched.clear();
  stopAll();
  renderVideoReview();
  $('#vrList')?.scrollTo?.({ top: 0 });
}
/* 审完一个：焦点移到这个画面的下一个待审候选；这个画面都审完了，稍等一下跳到下一个还有待审的画面 */
let advanceTimer = null;
function advanceAfterDecision(c) {
  const g = curGroup();
  if (!g || !g.cands.includes(c)) return;
  const next = g.cands.find(x => x !== c && isPending(x));
  if (next) {
    curCand = next.id;
    return;
  }
  clearTimeout(advanceTimer);
  const from = curShot;
  advanceTimer = setTimeout(() => {
    if (curShot !== from || !$('#vrMask').classList.contains('show')) return;
    const shots = curShots();
    if (shots.find(x => x.key === from)?.pending) return renderVideoReview(); // 中途撤销了：留在这个画面
    const i = shots.findIndex(x => x.key === from);
    const after = [...shots.slice(i + 1), ...shots.slice(0, i)].find(x => x.pending);
    if (after) selectShot(after.key);
    else renderVideoReview();
  }, 600);
}

export function openVideoReview(rowId = null) {
  touched.clear();
  curCand = null;
  pickDefaults(rowId);
  $('#vrMask').classList.add('show');
  renderVideoReview();
}
export const closeVideoReview = () => {
  $('#vrMask').classList.remove('show');
  stopAll();
  clearTimeout(advanceTimer);
  purgeRejected();
};
const stopAll = () => document.querySelectorAll('#vrList video').forEach(v => v.pause());
/* 「不要」的候选关窗口时清掉：结果已经写回清单（Claude 读得到），留着只会越堆越多 */
async function purgeRejected() {
  if (!state.candidates.some(c => c.decision === 'no')) return;
  await flushWriteBack();
  const pid = state.projectId;
  if (pid !== state.projectId) return;
  state.candidates = state.candidates.filter(c => c.decision !== 'no');
  for (const id of [...frames.keys()]) if (!state.candidates.some(c => c.id === id)) frames.delete(id);
  persist();
  refreshVideoReviewButton();
}

const fmtDay = t => {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const rangeText = lead => {
  if (!lead) return '找不到对应句子';
  const members = shotMembers(state.rows, lead);
  return members.length > 1 ? `第 ${members[0].no}–${members[members.length - 1].no} 句` : `第 ${members[0].no} 句`;
};

export function renderVideoReview() {
  refreshVideoReviewButton();
  const host = $('#vrList');
  if (!host || !$('#vrMask').classList.contains('show')) return;
  pickDefaults(null);
  const all = batches();
  const batch = curBatchObj();
  const shots = shotsOf(batch);
  // 顶部：批次 + 进度
  $('#vrBatch').innerHTML = all
    .map((b, i) => {
      const p = b.cands.filter(isPending).length;
      return `<option value="${esc(b.id)}"${b.id === curBatch ? ' selected' : ''}>${b.id === 'legacy' ? '' : `第 ${all.length - i} 批 · `}${esc(b.name)}${b.at ? ` · ${fmtDay(b.at)}` : ''}${p ? ` · ${p} 待审` : ' · 已审完'}</option>`;
    })
    .join('');
  $('#vrBatch').hidden = all.length < 1;
  const bc = batch?.cands || [];
  const left = bc.filter(isPending).length;
  const ok = bc.filter(c => c.decision === 'ok');
  const unsaved = state.candidates.filter(c => c.decision === 'ok' && !c.savedPath).length;
  $('#vrSummary').innerHTML = batch
    ? `${left ? `还剩 <b>${left}</b> 个待审` : '<b>这一批审完了</b>'} / 共 ${bc.length} 个${ok.length ? ` · 已通过 ${ok.length} 个 · <button class="vr-link" id="vrSeeOk">在表格里看</button>` : ''}`
    : '';
  const saveAll = $('#vrSaveAll');
  saveAll.hidden = !unsaved;
  saveAll.textContent = `保存已通过的片段（${unsaved}）`;
  $('#vrDir').textContent = state.mediaDir ? `保存到：${state.mediaDir}` : '还没选保存位置（第一次保存时会问）';

  // 左边：按章节列画面
  let sec = null;
  $('#vrNav').innerHTML = shots
    .map(g => {
      const head = g.section !== sec ? `<div class="vr-nav-sec">${esc(g.section || '（没有章节）')}</div>` : '';
      sec = g.section;
      const status = g.pending
        ? `<span class="vr-nav-n">${g.pending} 待审</span>`
        : g.ok
          ? '<span class="vr-nav-done ok">✓ 已通过</span>'
          : g.re
            ? '<span class="vr-nav-done re">等新候选</span>'
            : '<span class="vr-nav-done">已审完</span>';
      const label = g.cands[0]?.label ? `<small>${esc(g.cands[0].label)}</small>` : '';
      return `${head}<button class="vr-nav-shot${g.key === curShot ? ' on' : ''}${g.pending ? '' : ' done'}" data-vr-goto="${esc(String(g.key))}"><span>${rangeText(g.lead)}${label}</span>${status}</button>`;
    })
    .join('');
  $('#vrNav').querySelector('.vr-nav-shot.on')?.scrollIntoView({ block: 'nearest' });

  // 右边：选中画面的候选
  const g = shots.find(x => x.key === curShot);
  if (!state.candidates.length) {
    host.innerHTML =
      '<p class="vr-empty">还没有视频候选。让 Claude 找好后，把候选清单（.json）拖进窗口或点「导入候选清单」。</p>';
    return;
  }
  if (!g) {
    host.innerHTML = '<p class="vr-empty">这一批没有候选。</p>';
    return;
  }
  const open = g.cands.filter(c => isPending(c) || touched.has(c.id));
  const done = g.cands.filter(c => !isPending(c) && !touched.has(c.id));
  if (!open.some(c => c.id === curCand)) curCand = open.find(isPending)?.id || open[0]?.id || null;
  const vo = g.lead
    ? shotMembers(state.rows, g.lead)
        .map(m => m.text)
        .join('')
    : '';
  const allDone = !left;
  host.innerHTML = `<section class="vr-shot" data-vr-shot="${esc(String(g.key))}">
      <h4>${rangeText(g.lead)}${g.cands[0]?.label ? ` · ${esc(g.cands[0].label)}` : ''}</h4>
      ${vo ? `<p class="vr-vo">${esc(vo)}</p>` : ''}
      ${open.map(cardHTML).join('')}
      ${done.length ? `<div class="vr-done-list">${done.map(doneHTML).join('')}</div>` : ''}
      ${!open.length && allDone ? `<p class="vr-empty small">这一批都审完了。通过的已经挂在表格的画面上；要换的已经写回清单，Claude 读得到。</p>` : ''}
    </section>`;
  for (const c of open) {
    const strip = host.querySelector(`[data-vr-id="${c.id}"] .vr-strip`);
    if (!strip) continue;
    const got = frames.get(c.id);
    if (got && got.length) strip.replaceChildren(...got.map(x => x.cell));
    else queueFrames(c);
  }
  // 截图只给右边这几个候选：换了画面，没轮到的截图任务取消
  for (let i = queue.length - 1; i >= 0; i--) if (!open.some(c => c.id === queue[i].c.id)) queue.splice(i, 1);
}
function cardHTML(c) {
  const d = c.decision || '';
  const saving = busy.has(c.id);
  const actions =
    d === 'ok'
      ? c.savedPath
        ? `<span class="vr-saved">已保存：${esc(assetName(c.savedPath))}</span><button class="vr-mini" data-vr-reveal="${c.id}">在访达中显示</button>`
        : `<button class="vr-mini primary" data-vr-save="${c.id}" ${saving ? 'disabled' : ''}>${saving ? '正在截取…' : '保存这几秒'}</button>`
      : '';
  return `<article class="vr-cand ${d ? 'd-' + d : ''}${c.id === curCand ? ' focus' : ''}" data-vr-id="${c.id}">
    <div class="vr-head"><b>${esc(c.key || '·')}</b><strong>${esc(c.title)}</strong>${d ? `<span class="vr-tag d-${d}">${DECISION[d]}</span>` : ''}</div>
    <div class="vr-meta">建议 ${fmtTime(c.in)}–${fmtTime(c.out)}（${Math.round(c.out - c.in)} 秒）· ${esc(c.license || '版权未注明')} · <button class="vr-link" data-vr-page="${c.id}">原片页面</button></div>
    ${c.why ? `<p class="vr-why">${esc(c.why)}</p>` : ''}
    <div class="vr-strip">${'<div class="vr-cell ld">载入中…</div>'.repeat(6)}</div>
    <video class="vr-player" controls playsinline muted preload="none" hidden></video>
    <div class="vr-row">
      <button class="vr-btn play" data-vr-play="${c.id}">▶ 播放这段</button>
      <button class="vr-btn ok${d === 'ok' ? ' on' : ''}" data-vr-d="ok" data-vr-for="${c.id}">通过 <kbd>1</kbd></button>
      <button class="vr-btn no${d === 'no' ? ' on' : ''}" data-vr-d="no" data-vr-for="${c.id}">不要 <kbd>2</kbd></button>
      <button class="vr-btn re${d === 're' ? ' on' : ''}" data-vr-d="re" data-vr-for="${c.id}">换一个 <kbd>3</kbd></button>
      <input class="vr-note" data-vr-note="${c.id}" placeholder="意见（可选）：比如要更近景的、换成冷藏车外景…" value="${esc(c.note || '')}">
    </div>
    <div class="vr-row vr-after">${actions}<button class="vr-mini ghost" data-vr-orig="${c.id}">下载完整原片</button></div>
  </article>`;
}
/* 审过的候选收成一行：结果、意见、撤回（再点同一个结果 = 撤回） */
function doneHTML(c) {
  const d = c.decision;
  const save =
    d === 'ok'
      ? c.savedPath
        ? `<span class="vr-saved">已保存</span>`
        : `<button class="vr-mini primary" data-vr-save="${c.id}" ${busy.has(c.id) ? 'disabled' : ''}>${busy.has(c.id) ? '正在截取…' : '保存这几秒'}</button>`
      : '';
  return `<div class="vr-done d-${d}" data-vr-id="${c.id}"><span class="vr-tag d-${d}">${DECISION[d]}</span><b>${esc(c.key || '·')}</b><span class="vr-done-title">${esc(c.title)}</span>${c.note ? `<span class="vr-done-note">「${esc(c.note)}」</span>` : ''}<span class="vr-spacer"></span>${save}<button class="vr-mini" data-vr-d="${d}" data-vr-for="${c.id}" title="撤回这个审核结果，回到待审">撤回</button></div>`;
}

/* 截图：同时最多 2 个视频在截，每个候选在建议片段里均匀取 6 帧 */
const queue = [];
let running = 0;
function queueFrames(c) {
  if (queue.some(q => q.c.id === c.id) || frames.has(c.id)) return;
  queue.push({ c });
  pump();
}
function pump() {
  while (running < 2 && queue.length) {
    const { c } = queue.shift();
    running++;
    grab(c).finally(() => {
      running--;
      pump();
    });
  }
}
async function grab(c) {
  const cells = [];
  frames.set(c.id, cells);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = c.url.split('#')[0];
  const place = () => {
    const strip = document.querySelector(`[data-vr-id="${c.id}"] .vr-strip`);
    if (strip)
      strip.replaceChildren(
        ...cells.map(x => x.cell),
        ...Array.from({ length: 6 - cells.length }, () => loadingCell()),
      );
  };
  try {
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = rej;
      setTimeout(rej, 30000);
    });
  } catch {
    frames.delete(c.id);
    const strip = document.querySelector(`[data-vr-id="${c.id}"] .vr-strip`);
    if (strip)
      strip.innerHTML = '<div class="vr-cell fail">截图失败（网站不让读或网络不通），点「播放这段」直接看</div>';
    return;
  }
  for (let i = 0; i < 6; i++) {
    const t = c.in + 0.5 + ((c.out - c.in - 1) * i) / 5;
    v.currentTime = Math.max(0, t);
    await new Promise(r => {
      let done = false;
      const fin = () => {
        if (!done) {
          done = true;
          r();
        }
      };
      const f = () => {
        v.removeEventListener('seeked', f);
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => setTimeout(fin, 60));
        setTimeout(fin, 1500);
      };
      v.addEventListener('seeked', f);
      setTimeout(fin, 15000);
    });
    const cv = document.createElement('canvas');
    cv.width = 320;
    cv.height = Math.round((320 * v.videoHeight) / v.videoWidth) || 240;
    try {
      cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
    } catch {}
    const cell = document.createElement('div');
    cell.className = 'vr-cell';
    const tag = document.createElement('i');
    tag.textContent = fmtTime(t);
    cell.append(cv, tag);
    cells.push({ cell });
    place();
  }
  v.removeAttribute('src');
  v.load();
}
function loadingCell() {
  const d = document.createElement('div');
  d.className = 'vr-cell ld';
  d.textContent = '载入中…';
  return d;
}
function play(id) {
  const c = state.candidates.find(x => x.id === id);
  const card = document.querySelector(`[data-vr-id="${id}"]`);
  if (!c || !card) return;
  const v = card.querySelector('.vr-player');
  stopAll();
  v.hidden = false;
  if (!v.getAttribute('src')) v.src = c.url.split('#')[0];
  v.ontimeupdate = () => {
    if (v.currentTime >= c.out) {
      v.pause();
      v.currentTime = c.in;
    }
  };
  const go = () => {
    v.currentTime = c.in;
    v.play().catch(() => {});
  };
  if (v.readyState >= 1) go();
  else v.addEventListener('loadedmetadata', go, { once: true });
  card.querySelector('[data-vr-play]').textContent = '↻ 重播这段';
}

/* 键盘：1 通过 · 2 不要 · 3 换一个 · ↑↓ 换候选 · ←→ 换画面 · 空格 播放 / 暂停这段。在意见框里打字时不抢键 */
export function videoReviewKey(e) {
  if (e.target?.closest?.('.vr-note, select')) {
    if (e.key === 'Enter' || (e.key === 'Escape' && e.target.matches('.vr-note'))) {
      e.preventDefault();
      e.target.blur();
      return true;
    }
    return e.key !== 'Escape' && !e.metaKey;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const g = curGroup();
  const open = g ? g.cands.filter(c => isPending(c) || touched.has(c.id)) : [];
  const k = open.findIndex(c => c.id === curCand);
  const move = d => {
    if (!open.length) return;
    curCand = open[Math.max(0, Math.min(open.length - 1, (k < 0 ? 0 : k) + d))].id;
    renderVideoReview();
    $(`#vrList [data-vr-id="${curCand}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const DKEYS = { 1: 'ok', 2: 'no', 3: 're' };
  if (DKEYS[e.key]) {
    e.preventDefault();
    if (curCand) setDecision(curCand, DKEYS[e.key]);
    return true;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    move(e.key === 'ArrowDown' ? 1 : -1);
    return true;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const shots = curShots();
    const i = shots.findIndex(x => x.key === curShot);
    const j = Math.max(0, Math.min(shots.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
    if (shots[j]) selectShot(shots[j].key);
    return true;
  }
  if (e.key === ' ') {
    e.preventDefault();
    if (!curCand) return true;
    const v = $(`#vrList [data-vr-id="${curCand}"] .vr-player`);
    if (v && !v.hidden && !v.paused) v.pause();
    else play(curCand);
    return true;
  }
  return false;
}

export function initVideoReview() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="vrMask"><div class="modal vr-modal" role="dialog" aria-labelledby="vrTitle">
      <div class="vr-top">
        <h3 id="vrTitle">视频审核</h3>
        <select id="vrBatch" class="vr-batch" aria-label="批次" title="每次导入的候选清单算一批"></select>
        <span id="vrSummary" class="vr-summary"></span>
        <span class="vr-spacer"></span>
        <button class="btn" id="vrSaveAll" hidden title="把已通过、还没保存的片段都截下来存到本地">保存已通过的片段</button>
        <button class="btn" id="vrImport">导入候选清单…</button>
        <button class="text-button" id="vrClose" aria-label="关闭视频审核">✕</button>
      </div>
      <div class="vr-dirline"><span id="vrDir"></span><button class="vr-link" id="vrPickDir">更换保存位置</button><span class="vr-spacer"></span><span class="vr-keys"><kbd>1</kbd> 通过 · <kbd>2</kbd> 不要 · <kbd>3</kbd> 换一个 · <kbd>↑</kbd><kbd>↓</kbd> 换候选 · <kbd>←</kbd><kbd>→</kbd> 换画面 · <kbd>空格</kbd> 播放这段</span></div>
      <div class="vr-body">
        <nav id="vrNav" class="vr-nav" aria-label="这一批的画面"></nav>
        <div id="vrList"></div>
      </div>
    </div></div>`,
  );
  $('#vrClose').onclick = closeVideoReview;
  $('#vrMask').addEventListener('click', e => {
    if (e.target.id === 'vrMask') closeVideoReview();
  });
  $('#btnVideoReview').onclick = () => openVideoReview();
  $('#vrImport').onclick = () => runCommand('import:file');
  $('#vrSaveAll').onclick = () => saveAllApproved();
  $('#vrPickDir').onclick = () => ensureMediaDir(true);
  $('#vrBatch').addEventListener('change', e => {
    curBatch = e.target.value;
    curShot = null;
    curCand = null;
    touched.clear();
    renderVideoReview();
    e.target.blur();
  });
  $('#vrNav').addEventListener('click', e => {
    const b = e.target.closest('[data-vr-goto]');
    if (!b) return;
    const key = curShots().find(g => String(g.key) === b.dataset.vrGoto)?.key;
    if (key != null) selectShot(key);
  });
  $('#vrSummary').addEventListener('click', e => {
    if (!e.target.closest('#vrSeeOk')) return;
    // 通过的结果在表格的画面上：关掉窗口，跳到这一批第一个通过的画面
    const c = (curBatchObj()?.cands || []).find(x => x.decision === 'ok');
    closeVideoReview();
    if (c) runCommand('nav:jump', c.rowId);
  });
  $('#vrList').addEventListener('click', e => {
    const t = e.target;
    const card = t.closest('.vr-cand');
    if (card && card.dataset.vrId !== curCand) {
      curCand = card.dataset.vrId;
      document.querySelectorAll('#vrList .vr-cand').forEach(el => el.classList.toggle('focus', el === card));
    }
    const d = t.closest('[data-vr-d]');
    if (d) return setDecision(d.dataset.vrFor, d.dataset.vrD);
    const p = t.closest('[data-vr-play]');
    if (p) return play(p.dataset.vrPlay);
    const s = t.closest('[data-vr-save]');
    if (s) return void saveSegment(s.dataset.vrSave);
    const o = t.closest('[data-vr-orig]');
    if (o) return downloadOriginal(o.dataset.vrOrig);
    const pg = t.closest('[data-vr-page]');
    if (pg) {
      const c = state.candidates.find(x => x.id === pg.dataset.vrPage);
      if (c) native('openAsset')(c.page || c.url);
      return;
    }
    const rv = t.closest('[data-vr-reveal]');
    if (rv) {
      const c = state.candidates.find(x => x.id === rv.dataset.vrReveal);
      if (c?.savedPath) native('revealAsset')(c.savedPath);
    }
  });
  $('#vrList').addEventListener('input', e => {
    const n = e.target.closest('[data-vr-note]');
    if (n) setNote(n.dataset.vrNote, n.value);
  });
  // 下载完整原片的进度：提示条里显示百分比
  nat.onDownloadProgress(({ got, total }) => {
    if (total) toast(`正在下载完整原片… ${Math.floor((got / total) * 100)}%`);
  });
  on('rows', renderVideoReview); // 撤销 / 重做 / 切项目后按钮和列表跟着刷新
  on('project-loaded', () => {
    curBatch = curShot = curCand = null;
    touched.clear();
    setTimeout(tagOldSavedClips, 0);
  });
  setTimeout(tagOldSavedClips, 0); // 启动时的项目在这之前就载入了
  registerCommand('video:open', openVideoReview);
  registerCommand('video:import', (doc, path) => importCandidates(doc, path));
  refreshVideoReviewButton();
}
