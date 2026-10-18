import { shotTrackHTML, clipLen, shortName } from './shot-track-html.js';

/* 画面时间轨组件：每个实例独立保存选中、拖动、冲突提示和轨道缓存。
   播放位置、暂停、定位和裁剪预览由宿主提供；组件不管理窗口或审核页。 */
import { state } from '../app/state.js';
import { timeline, rowById, types } from '../app/project-queries.js';
import { shotMembers } from '../core/shots.js';

import { itemAt, circled, MIN_LEN } from '../core/shot-layout.js';
import { movePicture, trimPicture, rollPictures } from '../core/shot-edit.js';
import { moveAlt, mainSlotAt, swapIntoMain, insertIntoMain, dropToAlt } from '../core/shot-tracks.js';
import { setShotTimes, arrangeShot, clearShotTimes, setFitDone, setFreeze, removeUsage } from '../app/asset-actions.js';
import { decideCandidate } from '../app/candidate-actions.js';
import { usageList } from '../core/asset-model.js';
import { esc, toast } from '../ui/base/dom.js';
import { openMenu, closePop, popEl } from '../ui/base/popover.js';

import { reduced, EASE_OUT } from '../ui/base/motion.js';

import { paintFilm } from './filmstrip.js';

export function createShotTrack({
  root,
  markup,
  currentTime,
  seek,
  stop,
  isPlaying,
  previewTrim,
  scrub,
  refreshSoon,
  refreshNow,
}) {
  const $ = s => root.querySelector(s);
  let unit = null;
  let refreshAfterDrag = false;
  let knownSig = '';
  let pick = null; // 镜头轨上选中的画面（assetId）
  let drag = null; // 正在拖的色块
  let dragCleanup = null;
  function clearDrag() {
    const cleanup = dragCleanup;
    dragCleanup = null;
    drag = null;
    cleanup?.();
  }
  let editMsg = ''; // 填的秒数被前后画面挡住时的提示（只显示一次）
  /* 协作对方改了这个画面的提示：对方的改动会让审核页重画、镜头轨跟着重画好几次，只显示一次的话转眼就没了。
   留到换了画面或者自己再拖一下为止 */
  let remoteMsg = null; // { row, text }

  const sec = x => (Math.round(x * 10) / 10).toFixed(1);
  const unitRow = () => unit?.members[0] || null;
  let trackAlts = []; // 当前镜头备选轨上的画面（altItems 的结果）

  /* 画面的颜色跟着素材走（蓝 / 绿交替），换了先后顺序颜色也不变。
   第一次画到它时定下来：和左边那段不同色 */
  const tones = new Map(); // `${镜头首句 id}|${assetId}` → 0 蓝 / 1 绿
  function toneOf(owner, items, k) {
    const key = `${owner}|${items[k].assetId}`;
    if (!tones.has(key)) {
      const left = k ? tones.get(`${owner}|${items[k - 1].assetId}`) : 1;
      tones.set(key, left === 0 ? 1 : 0);
    }
    return tones.get(key);
  }
  let trackHtml = ''; // 镜头轨上次写进页面的内容：一样就不重写（松手后的落位动画不被紧跟着的刷新打断）
  let trackDirty = false; // 拖动时直接改过色块位置 / 样式：下次必须整个重写

  /* 轨道宽度变了（拉窗口、审核页换布局）：胶片按新宽度重铺，格子数跟着变 */
  let sizeObs = null;
  let sizeRaf = 0;
  function watchTrackSize(box) {
    if (sizeObs || typeof ResizeObserver === 'undefined') return;
    sizeObs = new ResizeObserver(() => {
      cancelAnimationFrame(sizeRaf);
      sizeRaf = requestAnimationFrame(() => !drag && paintFilm(box));
    });
    sizeObs.observe(box);
  }

  function renderTrack(u) {
    // 正在拖色块：先不重画（重画会把正在拖的色块换掉，拖动就断了），松手后再画
    if (drag) {
      refreshAfterDrag = true;
      return;
    }
    unit = u;
    const box = $('[data-pt="ptTrack"]');
    $('.pt-progress').hidden = false;
    if (!u) return (box.hidden = true);
    const next = shotTrackHTML({ unit: u, assets: state.assets || {}, tl: timeline(), ti: types(), pick, toneOf });
    trackAlts = next.alts;
    pick = next.pick;
    box.hidden = next.hidden;
    if (next.hidden) return;
    const html = next.html;
    if (html !== trackHtml || trackDirty || !box.querySelector('[data-pt="pttLanes"]')) {
      box.innerHTML = markup(html);
      trackHtml = html;
      trackDirty = false;
    }
    paintFilm(box);
    watchTrackSize(box);
    knownSig = shotSig();
    renderEdit();
    movePlayhead(currentTime());
    // 有镜头轨时上面那条总进度条就多余了（刻度尺本身可以点、可以拖）
    $('.pt-progress').hidden = true;
  }

  /* 选中画面的提醒（被前后画面挡住 / 超出口播 / 片段不够长），写在「画面时间」那一行，不另占一行 */
  function renderEdit() {
    const el = $('[data-pt="pttWarn"]');
    const u = unit;
    if (!el || !u) return;
    const it = u.layout?.items.find(x => x.assetId === pick);
    const notes = [];
    if (remoteMsg && remoteMsg.row !== u.members[0]?.id) remoteMsg = null;
    if (remoteMsg) notes.push(remoteMsg.text);
    if (editMsg) notes.push(editMsg);
    editMsg = '';
    let action = '';
    if (it) {
      const dur = u.end - u.start;
      const len = clipLen(it);
      const end = Math.min(it.end, dur);
      const slot = Math.min(it.slotEnd ?? it.end, dur);
      if (it.over) notes.push(`${circled(it.n)} 超出口播 ${sec(it.end - dur)} 秒，超出的部分不放`);
      const lack = len != null ? end - it.start - len : 0;
      if (it.usage.freeze && len != null) {
        notes.push(
          lack > 0.05
            ? `${circled(it.n)} 片段 ${sec(len)} 秒，后 ${sec(lack)} 秒定格补满（导出到剪映也是定格）`
            : `${circled(it.n)} 已标定格补满：结尾可以拉过片段末尾`,
        );
        action =
          '<button class="ptt-fitbtn" data-ptt-fit="unfreeze" title="不再定格：画面截回片段本身的长度">取消定格</button>';
      } else if (it.usage.fitDone && len != null) {
        notes.push(
          lack > 0.05
            ? `${circled(it.n)} 片段 ${sec(len)} 秒，后 ${sec(lack)} 秒标了剪辑里补足（导出到剪映这段留空）`
            : `${circled(it.n)} 已标剪辑里补足：结尾可以拉过片段末尾`,
        );
        action =
          '<button class="ptt-fitbtn" data-ptt-fit="freeze" title="放完停在最后一帧，导出到剪映也用定格补上">改成定格补满</button>' +
          '<button class="ptt-fitbtn" data-ptt-fit="off" title="画面截回片段本身的长度，重新提示不够长">取消补足</button>';
      } else if (it.kind === 'video' && slot > end + 0.05) {
        notes.push(`${circled(it.n)} 片段只有 ${sec(end - it.start)} 秒，后面 ${sec(slot - end)} 秒没有画面`);
        action =
          '<button class="ptt-fitbtn" data-ptt-fit="freeze" title="放完停在最后一帧，补到排给它的时间；导出到剪映也用定格补上">定格补满</button>' +
          '<button class="ptt-fitbtn" data-ptt-fit="on" title="不再提示不够长；导出到剪映时这段留空，你在剪辑里自己补（放慢等）">剪辑里补足</button>';
      }
    }
    el.innerHTML = esc(notes.join(' · ')) + action;
  }

  /* ── 双击画面的菜单：定格补满 / 删除 ──
   定格补满：片段放完停在最后一帧，一直补到下一个画面（或这个画面的结尾）；已经补过的可以取消。
   删除：审核通过的视频 = 撤回通过（回到待审）；其余素材 = 从这个画面移除关联，本地文件保留。都可以 ⌘Z */
  function freezePlan(it) {
    const u = unit;
    if (!u || !it || it.kind !== 'video') return { ok: false, why: '图片本来就是静止画面，不用定格' };
    if (it.usage.freeze) return { ok: true, off: true };
    // 标了剪辑里补足的：已经排到给它的时间，改成定格补满只换补法
    const len = clipLen(it);
    if (it.usage.fitDone && len != null) {
      const lack = Math.min(it.end, u.end - u.start) - it.start - len;
      return lack > 0.05 ? { ok: true, end: null, gain: lack } : { ok: false, why: '片段已经够长，不用定格' };
    }
    const items = u.layout.items;
    const k = items.findIndex(x => x.assetId === it.assetId);
    const dur = u.end - u.start;
    const end = Math.min(it.end, dur);
    // 手动排的：补到下一个画面开始（没有就到画面结尾）；按句子排的：补到排给它的时间
    const to = u.layout.timed ? Math.min(items[k + 1]?.start ?? dur, dur) : Math.min(it.slotEnd ?? it.end, dur);
    if (to <= end + 0.05) return { ok: false, why: '后面紧接着别的画面，没有空出来的时间要补' };
    return { ok: true, end: u.layout.timed ? to : null, gain: to - end };
  }
  function openBlockMenu(block) {
    const u = unit;
    const row = unitRow();
    if (!u || !row) return;
    const id = block.dataset.ptt;
    const isAlt = !!block.dataset.alt;
    const it = isAlt ? trackAlts.find(x => x.assetId === id) : u.layout?.items.find(x => x.assetId === id);
    if (!it) return;
    pick = id;
    for (const el of root.querySelectorAll('[data-pt="pttLanes"] .ptt-block')) el.classList.toggle('on', el === block);
    renderEdit();
    const item = (act, label, desc, { disabled = false, danger = false } = {}) =>
      `<div class="pop-item${danger ? ' danger' : ''}${disabled ? ' disabled' : ''}" data-ptt-act="${act}"><span class="main"><span>${label}</span>${desc ? `<span class="desc">${esc(desc)}</span>` : ''}</span></div>`;
    let html = `<div class="p-title">${isAlt ? '备选' : circled(it.n)} ${esc(shortName(it.asset.name))}</div>`;
    if (!isAlt) {
      const f = freezePlan(it);
      html += f.off
        ? item('unfreeze', '取消定格', '画面截回片段本身的长度')
        : item('freeze', '定格补满', f.ok ? `放完停在最后一帧，补足 ${sec(f.gain)} 秒` : f.why, { disabled: !f.ok });
      html += '<div class="pop-sep"></div>';
    }
    const cand = approvedCand(id);
    html += item(
      'remove',
      '删除',
      cand ? '撤回通过，视频回到待审 · ⌘Z 可撤销' : '从这个画面移除，本地文件保留 · ⌘Z 可撤销',
      {
        danger: true,
      },
    );
    openMenu(block, html);
    popEl.classList.add('ptt-menu');
    popEl.addEventListener('click', e => {
      const act = e.target.closest('.pop-item:not(.disabled)')?.dataset.pttAct;
      if (!act) return;
      closePop();
      if (act === 'freeze') {
        const f = freezePlan(it);
        if (f.ok) setFreeze(row, id, true, f.end);
      } else if (act === 'unfreeze') setFreeze(row, id, false);
      else if (act === 'remove') removePicture(row, id);
    });
  }
  const approvedCand = assetId => {
    const cid = state.assets?.[assetId]?.source?.candidate;
    return cid ? state.candidates?.find(c => c.id === cid && c.decision === 'ok' && c.assetId === assetId) : null;
  };
  function removePicture(row, assetId) {
    if (pick === assetId) pick = null;
    const cand = approvedCand(assetId);
    if (cand) {
      const r = decideCandidate(cand.id, 'ok'); // 再点一次「通过」= 撤回
      if (r?.error) toast(r.error, null, 'error');
      else toast('已从画面上删除，视频回到待审 · ⌘Z 可撤销', null, 'ok');
      return;
    }
    const index = usageList(row).findIndex(x => x.assetId === assetId);
    if (index >= 0) removeUsage(row, index);
  }

  function movePlayhead(t) {
    const u = unit;
    const head = $('[data-pt="pttHead"]');
    if (!u || !head) return;
    const rel = Math.max(0, Math.min(u.end - u.start, t - u.start));
    head.style.left = `${(rel / (u.end - u.start)) * 100}%`;
    const rh = $('[data-pt="pttRHead"]');
    if (rh) rh.style.left = head.style.left;
  }

  /* 时间与片段一次提交，一次撤销；拖动不会改变播放头。 */
  function commitEdit(draft, label) {
    const row = unitRow();
    if (row && draft?.changed) setShotTimes(row, draft.entries, label);
  }
  /* 两条轨一起改：mains / alts 两组 entries */
  function commitTracks(draft, label) {
    const row = unitRow();
    if (row && draft) arrangeShot(row, { mains: draft.mains || [], alts: draft.alts || [] }, label);
  }

  function setEdge(which, v, id = pick) {
    const u = unit;
    const items = u?.layout?.items || [];
    const alt = trackAlts.find(x => x.assetId === id);
    const k = items.findIndex(x => x.assetId === id);
    if ((k < 0 && !alt) || !Number.isFinite(v)) return;
    const draft = alt
      ? trimPicture([alt], 0, which, v, u.end - u.start)
      : trimPicture(items, k, which, v, u.end - u.start);
    if (!draft) return;
    const got = which === 'start' ? draft.start : draft.end;
    if (Math.abs(v - got) > 0.05) editMsg = '已到相邻画面、口播或素材的边界';
    const label = which === 'start' ? '裁剪画面开头' : '裁剪画面结尾';
    if (alt) draft.changed && commitTracks({ alts: draft.entries }, label);
    else commitEdit(draft, label);
    renderEdit();
  }

  /* 只展示正在裁的首 / 尾帧，不定位口播，也不写入项目。 */
  function showTrimFrame(it, entry, edge) {
    previewTrim(it, entry, edge);
  }

  /* 取消选中：白框和两头把手收起，看得清相邻画面接没接上（点轨上空白处、点刻度尺时） */
  function clearPick() {
    if (!pick) return;
    pick = null;
    // 只摘掉白框：镜头轨下次重画时按 pick 比内容，自然会重写，这里不用整块重画
    for (const el of root.querySelectorAll('[data-pt="pttLanes"] .ptt-block.on')) el.classList.remove('on');
    renderEdit();
  }

  /* 松手后浮着的色块从鼠标下滑到落点（虚线框处），不是瞬移 */
  function settle(assetId, from) {
    if (!from || reduced()) return;
    const el = root.querySelector(`[data-pt="pttLanes"] .ptt-block[data-ptt="${CSS.escape(assetId)}"]`);
    if (!el?.animate) return;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left,
      dy = from.top - to.top;
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: 180,
      easing: EASE_OUT,
    });
  }

  /* 拖中间移动 / 插入换序，拖边裁剪；Shift 拖相接边调整两段切换点；上下拖在正片和备选之间换。
   没有磁吸，鼠标落点只受时间线、相邻画面和实际素材长度约束。 */
  function onLaneDown(e) {
    const lanes = $('[data-pt="pttLanes"]');
    const lane = $('[data-pt="pttLane"]');
    const altLane = $('[data-pt="pttAlt"]');
    const u = unit;
    if (!lanes || !lane || !u || e.button !== 0 || drag) return;
    const rect = lane.getBoundingClientRect();
    const dur = u.end - u.start;
    const toSec = x => ((x - rect.left) / rect.width) * dur;
    const block = e.target.closest('.ptt-block');
    if (!block) {
      // 点轨上空白处：取消选中（白框和把手收起），播放头跳到这里
      clearPick();
      seek(u.start + Math.max(0, Math.min(dur, toSec(e.clientX))));
      return;
    }
    e.preventDefault();
    // 页面上留着的选中文字会让浏览器把这次按住当成「拖文字」，中途取消指针，色块弹回
    window.getSelection()?.removeAllRanges();
    const items = u.layout.items;
    const isAlt = !!block.dataset.alt;
    const k = isAlt ? -1 : items.findIndex(x => x.assetId === block.dataset.ptt);
    const it = isAlt ? trackAlts.find(x => x.assetId === block.dataset.ptt) : items[k];
    if (!it) return;
    if (isPlaying()) stop();
    remoteMsg = null;
    // 显式命中把手；窄素材的中间仍然可以用于排序。
    const grip = e.target.closest('.ptt-grip');
    const mode = grip ? (grip.classList.contains('l') ? 'start' : 'end') : 'move';
    const cutIndex = mode === 'start' ? k - 1 : k;
    const roll =
      !isAlt &&
      !!e.shiftKey &&
      mode !== 'move' &&
      cutIndex >= 0 &&
      items[cutIndex + 1] &&
      Math.abs(items[cutIndex].end - items[cutIndex + 1].start) <= 0.05;
    pick = it.assetId;
    for (const el of lanes.querySelectorAll('.ptt-block')) el.classList.toggle('on', el === block);
    const insert = $('[data-pt="pttInsert"]');
    const altInsert = $('[data-pt="pttAltInsert"]');
    const ghost = $('[data-pt="pttGhost"]');
    const feedback = $('[data-pt="pttWarn"]');
    const oldFeedback = feedback.innerHTML;
    drag = {
      plan: shotPlan(),
      k,
      it,
      mode,
      x0: e.clientX,
      y0: e.clientY,
      s0: it.start,
      e0: Math.min(it.end, dur),
      moved: false,
      cur: null,
      kind: '',
    };
    const swapTarget = el => {
      for (const b of lane.querySelectorAll('.ptt-block')) b.classList.toggle('swap', b === el);
    };
    dragCleanup = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      block.classList.remove('dragging');
      lane.classList.remove('sorting');
      lanes.classList.remove('dragging');
      block.style.transform = '';
      if (ghost) ghost.hidden = true;
      swapTarget(null);
      if (insert) insert.hidden = true;
      if (altInsert) altInsert.hidden = true;
      feedback.innerHTML = oldFeedback;
      try {
        if (lanes.hasPointerCapture(e.pointerId)) lanes.releasePointerCapture(e.pointerId);
      } catch {}
    };
    try {
      lanes.setPointerCapture(e.pointerId);
    } catch {}
    // 正片轨的色块按草稿摆（没给的回到原位）
    const placeMains = entries => {
      for (const el of lane.querySelectorAll('.ptt-block')) {
        if (el === block) continue;
        const entry = entries?.find(x => x.assetId === el.dataset.ptt);
        const orig = items.find(x => x.assetId === el.dataset.ptt);
        const src = entry || orig;
        if (!src) continue;
        el.style.left = `${(src.start / dur) * 100}%`;
        el.style.width = `${(Math.max(0, Math.min(src.end, dur) - src.start) / dur) * 100}%`;
      }
    };
    function onMove(ev) {
      if (!drag || ev.pointerId !== e.pointerId) return;
      // 松手那一下没传过来（指针移出窗口时松开等）：键已经抬起就按这里松手
      if (ev.type === 'pointermove' && ev.buttons === 0 && ev.isTrusted) return onUp(ev);
      const delta = toSec(ev.clientX) - toSec(drag.x0);
      if ((Math.abs(ev.clientX - drag.x0) > 3 || Math.abs(ev.clientY - drag.y0) > 6) && !drag.moved) {
        drag.moved = true;
        trackDirty = true;
        // 真正开始拖动才隐藏悬浮说明，单击保留节点以接收后续双击。
        for (const el of lanes.querySelectorAll('[title]')) el.removeAttribute('title');
        if (isPlaying()) stop();
        block.classList.add('dragging');
        lane.classList.add('sorting');
        lanes.classList.add('dragging'); // 空着的备选轨收成一条细线，拖动时展开好放 // 其余色块让位时滑过去，不是瞬移
      }
      if (!drag.moved) return;
      const len = drag.e0 - drag.s0;
      const start = drag.s0 + delta;
      swapTarget(null);
      insert.hidden = true;
      altInsert.hidden = true;
      if (ghost) ghost.hidden = true;
      // 落点：拖着的色块浮在鼠标下，松手后它落到这个虚线框的位置
      const showGhost = (s, e) => {
        if (!ghost) return;
        ghost.hidden = false;
        ghost.style.left = `${(s / dur) * 100}%`;
        ghost.style.width = `${(Math.max(0, Math.min(e, dur) - s) / dur) * 100}%`;
      };
      if (mode === 'move') {
        const mainBox = lane.getBoundingClientRect();
        const altBox = altLane.getBoundingClientRect();
        const toAlt = !isAlt && ev.clientY > (mainBox.bottom + altBox.top) / 2;
        const toMain = isAlt && ev.clientY < (mainBox.bottom + altBox.top) / 2;
        // 色块浮起来跟着鼠标走（上下换轨时也跟着），其余色块展示松手后的排布，虚线框是它松手后的落点
        block.style.left = `${(Math.max(0, Math.min(dur - len, start)) / dur) * 100}%`;
        block.style.transform = toAlt || toMain ? `translateY(${ev.clientY - drag.y0}px)` : '';
        if (toAlt) {
          drag.kind = 'toAlt';
          drag.cur = dropToAlt(items, k, start, dur);
          placeMains(drag.cur?.mains);
          altInsert.hidden = false;
          altInsert.style.left = `${(drag.cur.alts[0].start / dur) * 100}%`;
          feedback.textContent = '松手放到备选轨：先撤下来，原来的位置留空';
        } else if (toMain) {
          const slot = mainSlotAt(items, Math.max(0, toSec(ev.clientX)), dur);
          if (slot.kind === 'on') {
            drag.kind = 'swap';
            drag.cur = swapIntoMain(items, slot.index, it, dur);
            placeMains(null);
            swapTarget(lane.querySelector(`.ptt-block[data-ptt="${CSS.escape(items[slot.index].assetId)}"]`));
            feedback.textContent = `松手和 ${circled(items[slot.index].n)} 互换`;
          } else {
            drag.kind = 'insert';
            const at = Math.max(slot.start, Math.min(start, Math.max(slot.start, slot.end - MIN_LEN)));
            drag.cur = insertIntoMain(items, it, at, dur);
            placeMains(drag.cur.mains);
            insert.hidden = false;
            insert.style.left = `${(drag.cur.mains[drag.cur.index].start / dur) * 100}%`;
            showGhost(drag.cur.mains[drag.cur.index].start, drag.cur.mains[drag.cur.index].end);
            feedback.textContent = `松手放上正片轨（${sec(drag.cur.mains[drag.cur.index].start)} 秒起）`;
          }
        } else if (isAlt) {
          drag.kind = 'alt';
          const entry = moveAlt(it, start, dur);
          drag.cur = { alts: [entry], changed: Math.abs(entry.start - it.start) > 0.05 };
          placeMains(null);
          feedback.textContent = `备选 ${sec(entry.start)}–${sec(entry.end)} 秒`;
        } else {
          drag.kind = 'main';
          drag.cur = movePicture(items, k, start, dur);
          if (!drag.cur) return;
          placeMains(drag.cur.entries);
          // 落点用虚线框标出来：被前后画面挡住时框停在挡住处，前沿越过相邻画面一半时框跳到它另一边、紧挨着它
          showGhost(drag.cur.start, drag.cur.end);
          const wanted = Math.max(0, Math.min(dur - len, start));
          const blocked = !drag.cur.reordered && Math.abs(drag.cur.start - wanted) > 0.05;
          const by = blocked ? items[wanted > drag.cur.start ? k + 1 : k - 1] : null;
          drag.blocked = blocked
            ? by
              ? `被 ${circled(by.n)} 挡住 · 拖过它的一半就换位置`
              : `已到${wanted > drag.cur.start ? '结尾' : '开头'}`
            : '';
          feedback.textContent = drag.cur.reordered
            ? `松手放到 ${circled(items[drag.cur.index].n)} ${drag.cur.index > k ? '后面' : '前面'}`
            : `${sec(drag.cur.start)}–${sec(drag.cur.end)} 秒${drag.blocked ? ` · ${drag.blocked}` : ''}`;
        }
        return;
      }
      const value = (mode === 'start' ? drag.s0 : drag.e0) + delta;
      drag.kind = isAlt ? 'alt' : 'main';
      drag.cur = isAlt
        ? trimPicture([it], 0, mode, value, dur)
        : roll
          ? rollPictures(items, cutIndex, value, dur)
          : trimPicture(items, k, mode, value, dur);
      const draft = drag.cur;
      if (!draft) return;
      if (isAlt) {
        const entry = draft.entries[0];
        block.style.left = `${(entry.start / dur) * 100}%`;
        block.style.width = `${(Math.max(0, entry.end - entry.start) / dur) * 100}%`;
        draft.alts = draft.entries;
      } else {
        placeMains(draft.entries);
        const own = draft.entries.find(x => x.assetId === it.assetId);
        block.style.left = `${(own.start / dur) * 100}%`;
        block.style.width = `${(Math.max(0, Math.min(own.end, dur) - own.start) / dur) * 100}%`;
      }
      feedback.textContent = roll ? `切换点 ${sec(draft.cut)} 秒` : `${sec(draft.start)}–${sec(draft.end)} 秒`;
      const entry = draft.entries.find(x => x.assetId === it.assetId);
      showTrimFrame(it, entry, mode);
    }
    function onUp(ev) {
      if (ev && ev.pointerId !== e.pointerId) return;
      // 拖得快时，按下到松手之间浏览器可能一次移动都没报（或者最后一段没报）：按松手的位置再算一遍，
      // 不然草稿停在按下的地方，松手什么都不存，色块弹回原位
      if (ev && Number.isFinite(ev.clientX)) onMove(ev);
      const d = drag;
      const from = d?.moved && mode === 'move' ? block.getBoundingClientRect() : null;
      clearDrag();
      if (!d) return;
      if (!d.moved) {
        renderEdit();
        if (refreshAfterDrag) refreshSoon();
        return;
      }
      if (d.moved && d.kind === 'main' && d.cur && !d.cur.changed && d.blocked) editMsg = `没有移动：${d.blocked}`;
      if (!d.cur) {
        renderTrack(unit);
        settle(it.assetId, from);
        if (refreshAfterDrag) refreshSoon();
        return;
      }
      // 拖的这几秒里要写的画面被别处挪过（协作对方动了它）：草稿是按旧排布算的，不提交，免得盖掉对方的改动。
      // 改备注、审核、后台保存这类不动排布的变化照常保存——以前整镜头一比就放弃，拖快了色块总弹回原位
      if (draftConflict(d.plan, d.cur)) {
        remoteMsg = {
          row: unit?.members[0]?.id,
          text: '拖动期间协作对方改了这个画面，这次没有保存，已换成对方的版本',
        };
        refreshSoon();
        return;
      }
      if (d.kind === 'toAlt') commitTracks(d.cur, '画面移到备选轨');
      else if (d.kind === 'swap') commitTracks(d.cur, '备选换上正片轨');
      else if (d.kind === 'insert') commitTracks({ mains: d.cur.mains }, '备选放上正片轨');
      else if (d.kind === 'alt') {
        if (d.cur.changed) commitTracks(d.cur, mode === 'move' ? '移动备选' : '裁剪备选');
      } else
        commitEdit(
          d.cur,
          roll
            ? '调整画面切换点'
            : mode === 'move'
              ? d.cur.reordered
                ? '调换画面顺序'
                : '移动画面时间'
              : mode === 'start'
                ? '裁剪画面开头'
                : '裁剪画面结尾',
        );
      // 马上按提交后的排布重画（先画一遍旧排布的话，正片色块会在原位置闪一下再跳过去）；
      // 被边界挡住也要恢复草稿画面，播放头保持原来的秒数。
      refreshNow();
      settle(it.assetId, from);
    }
    function onCancel(ev) {
      if (ev && ev.pointerId !== e.pointerId) return;
      clearDrag();
      if (root.isConnected) {
        renderTrack(unit);
        refreshSoon();
      }
    }
    /* 移动 / 松手挂在整个窗口上，不靠轨道上的指针捕获：系统或浏览器中途收回捕获（lostpointercapture）时
     拖动照样继续，松手照样保存。以前一收回就当取消处理，色块当场弹回原位、也没有任何提示 */
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
  }

  function shotPlan() {
    const lead = rowById(unit?.members[0]?.id);
    const plan = new Map();
    if (!lead) return plan;
    for (const m of shotMembers(state.rows, lead))
      for (const u of m.assetUsages || []) {
        const p = plan.get(u.assetId) || { role: u.role, at: u.at, clip: u.clip, off: [] };
        p.off.push(!!u.off);
        plan.set(u.assetId, p);
      }
    return plan;
  }
  const planKey = p => (p ? JSON.stringify([p.role ?? null, p.at ?? null, p.off]) : '');
  const clipKey = p => JSON.stringify(p?.clip ?? null);
  /* 整个镜头的排布摘要：协作对方动了这个画面的排布才认得出来 */
  function shotSig() {
    return JSON.stringify([...shotPlan()].map(([id, p]) => [id, planKey(p), clipKey(p)]));
  }
  /* 松手要写进去的那几个画面，按下以后排布有没有被别处改过（只有这种才会盖掉对方的改动）。
   片段入出点只在这次要写入点出点（裁剪）时才比：后台保存到本地会把在线入出点换成本地的，挪位置不受影响 */
  function draftConflict(before, draft) {
    const now = shotPlan();
    const written = [...(draft.entries || []), ...(draft.mains || []), ...(draft.alts || [])];
    return written.some(
      e =>
        planKey(before.get(e.assetId)) !== planKey(now.get(e.assetId)) ||
        (e.clip && clipKey(before.get(e.assetId)) !== clipKey(now.get(e.assetId))),
    );
  }

  function onRemote() {
    if (unit && knownSig && !drag)
      remoteMsg =
        shotSig() !== knownSig ? { row: unit?.members[0]?.id, text: '协作对方刚改了这个画面，已换成对方的版本' } : null; // 对方这次改的是别处：上一条提示就不留了
  }

  function key(e) {
    if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'i' || e.key === 'I' || e.key === 'o' || e.key === 'O')) {
      const u = unit;
      if (!u) return true;
      e.preventDefault();
      // 选中了就裁选中的；谁都没选，就裁播放头底下的那段（和剪映一样）
      const rel = currentTime() - u.start;
      const id = pick ?? itemAt(u.layout, rel)?.assetId;
      if (!id) {
        editMsg = '播放头底下没有画面：先点一下要裁的画面，再按 I / O';
        renderEdit();
        return true;
      }
      setEdge(e.key.toLowerCase() === 'i' ? 'start' : 'end', rel, id);
      return true;
    }
    return false;
  }

  const track = $('[data-pt="ptTrack"]');
  track.addEventListener('pointerdown', e => {
    const ruler = e.target.closest('[data-pt="pttRuler"]');
    if (ruler) {
      const u = unit;
      clearPick();
      if (u) scrub(e, ruler, f => u.start + f * (u.end - u.start));
      return;
    }
    if (e.target.closest('[data-pt="pttLane"], [data-pt="pttAlt"]')) onLaneDown(e);
  });
  // 双击（或右键）画面：定格补满 / 删除
  const blockMenu = e => {
    const block =
      e.target.closest?.('.ptt-block') || document.elementFromPoint(e.clientX, e.clientY)?.closest('.ptt-block');
    if (!block || !track.contains(block) || drag) return;
    e.preventDefault();
    openBlockMenu(block);
  };
  track.addEventListener('dblclick', blockMenu);
  track.addEventListener('contextmenu', blockMenu);
  // 镜头轨上不做浏览器自带的拖放（拖文字 / 拖图），免得它接管鼠标、打断色块拖动
  track.addEventListener('dragstart', e => e.preventDefault());
  track.addEventListener('click', e => {
    if (e.target.closest('[data-pt="pttReset"]')) {
      const row = unitRow();
      if (row) clearShotTimes(row);
    }
    const fit = e.target.closest('[data-ptt-fit]');
    if (fit && pick) {
      const row = unitRow();
      const act = fit.dataset.pttFit;
      const it = unit?.layout?.items.find(x => x.assetId === pick);
      if (!row) return;
      if (act === 'freeze') {
        const f = freezePlan(it);
        if (f.ok) setFreeze(row, pick, true, f.end);
      } else if (act === 'unfreeze') setFreeze(row, pick, false);
      else setFitDone(row, pick, act === 'on');
    }
  });

  return {
    render: renderTrack,
    movePlayhead,
    key,
    remote: onRemote,
    isDragging: () => !!drag,
    deferRefresh() {
      refreshAfterDrag = !!drag;
      return !!drag;
    },
    reset() {
      clearDrag();
      pick = null;
      remoteMsg = null;
      tones.clear();
    },
    destroy() {
      clearDrag();
      sizeObs?.disconnect();
      cancelAnimationFrame(sizeRaf);
    },
    alts: () => trackAlts.map(a => ({ assetId: a.assetId, start: a.start, end: a.end, row: a.row })),
  };
}
