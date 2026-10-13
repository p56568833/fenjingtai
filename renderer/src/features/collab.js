/* 局域网协作（2.0）的界面：顶栏「协作」按钮、共享 / 加入弹窗、表格里标出对方停在哪句。
   数据和连接都在 app/collab.js；这里只管显示和收集输入。 */
import { state, on, emit, update } from '../app/state.js';
import * as collab from '../app/collab.js';
import { setMediaDirectory } from '../app/candidate-media.js';
import * as native from '../platform/native.js';
import { toast, confirmModal, esc } from '../ui/base/dom.js';
import { registerModal } from '../ui/base/modal.js';
import { registerCommand } from '../ui/base/commands.js';

const $ = s => document.querySelector(s);
let open = false;
let joining = null; // 正在输配对码的 { hostId, shareId }
let busy = false;
let manualOpen = false;
let missing = []; // 当前项目在这台电脑上缺的文件（对方电脑上可能有）
let lastStatus = '';

const PEOPLE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.9-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9" r="2.6"/><path d="M15.8 14.2c2.4.1 4.1 1.7 4.7 4.8"/></svg>';

const STATUS_TEXT = {
  online: who => `${who} 在线`,
  waiting: who => (who ? `${who} 不在线，连上后自动同步` : '等同事加入'),
  offline: who => `${who || '主机'} 不在线，正在找…`,
  connecting: who => `正在连接 ${who || '主机'}…`,
  'needs-code': () => '需要重新输入配对码',
};

/* ── 顶栏按钮 ── */
function renderButton() {
  const btn = $('#btnCollab');
  if (!btn) return;
  const cur = collab.collabSession();
  const label = btn.querySelector('.cl-label');
  btn.classList.toggle('on', !!cur);
  btn.dataset.status = cur?.status || '';
  if (!cur) {
    label.textContent = '协作';
    btn.title = '和同一局域网里的同事一起改这个项目';
    return;
  }
  const who = cur.peer || (cur.role === 'host' ? '' : cur.hostName);
  btn.querySelector('.cl-av').textContent = [...(who || '?').trim()][0]?.toUpperCase() || '?';
  // 顶栏只写状态（对方的名字常是很长的电脑名，放进悬停提示，不挤顶栏）
  label.textContent =
    cur.status === 'online'
      ? '协作中'
      : cur.status === 'needs-code'
        ? '需配对码'
        : cur.role === 'host'
          ? '共享中'
          : '未连接';
  btn.title = STATUS_TEXT[cur.status]?.(who) || '';
}

/* ── 弹窗 ── */
/* 重画弹窗时保住正在输入的框：内容、光标、焦点原样接回去 */
function render() {
  if (!open) return;
  const ae = document.activeElement;
  const keep =
    ae?.id && ae.closest?.('#collabBody') && ae.tagName === 'INPUT'
      ? { id: ae.id, value: ae.value, start: ae.selectionStart, end: ae.selectionEnd }
      : null;
  paint();
  if (!keep) return;
  const el = document.getElementById(keep.id);
  if (!el) return;
  el.value = keep.value;
  el.focus({ preventScroll: true });
  try {
    el.setSelectionRange(keep.start, keep.end);
  } catch {
    /* 有的输入框不支持选区 */
  }
}
/* 「对方电脑上的文件」一栏：缺几个、正在取第几个 */
function filesSection(cur) {
  const job = collab.fileProgress();
  const find = collab.findProgress();
  const who = esc(cur.peer || cur.hostName || '对方');
  if (find) {
    const text =
      find.phase === 'info'
        ? `正在向 ${who} 要文件信息…`
        : `正在本机文件夹里找内容一样的文件${find.scanned ? `，已看过 ${find.scanned} 个` : '…'}`;
    return `<section class="cl-files"><div class="cl-files-text">${text}</div><button class="btn" data-cl="cancelfind">取消</button></section>`;
  }
  if (job) {
    const pct = job.size ? Math.min(100, Math.floor((job.done / job.size) * 100)) : 0;
    return `<section class="cl-files"><div class="cl-files-text">正在从 ${who} 那里取第 ${job.index} / ${job.total} 个：${esc(job.name)}${job.size ? ` · ${pct}%` : ''}<div class="pack-bar"><div style="width:${pct}%"></div></div></div><button class="btn" data-cl="cancelfetch">取消</button></section>`;
  }
  if (!missing.length) return '';
  const names =
    missing
      .slice(0, 3)
      .map(m => esc(m.name))
      .join('、') + (missing.length > 3 ? ' 等' : '');
  const online = cur.status === 'online';
  return `<section class="cl-files"><div class="cl-files-text"><b>你这边缺 ${missing.length} 个文件</b><small>${names}${online ? `，可以从 ${who} 的电脑拷一份过来` : '，对方在线时可以从他的电脑拷过来'}</small></div><div class="cl-files-acts"><button class="btn" data-cl="findin" ${online ? '' : 'disabled'} title="选一个文件夹，按内容认出你电脑上已经有的文件，认出来的就不用再传">在文件夹里找</button><button class="btn primary" data-cl="fetchall" ${online ? '' : 'disabled'}>全部取过来</button></div></section>`;
}
function paint() {
  const st = collab.collabState();
  const cur = st.current;
  const box = $('#collabBody');
  const title = esc(state.title || '未命名');
  const nameRow = `<label class="cl-name"><span>我的名字</span><input id="collabName" maxlength="40" value="${esc(st.me.name)}" placeholder="对方看到的名字" autocomplete="off"></label>`;
  if (cur?.role === 'host') {
    const who = cur.peer;
    const addr = st.hostInfo?.addresses?.length
      ? st.hostInfo.addresses
          .map(a => (st.hostInfo.port && st.hostInfo.port !== 47391 ? `${a}:${st.hostInfo.port}` : a))
          .join('、')
      : '';
    box.innerHTML = `
      <h3>正在共享「${title}」</h3>
      <div class="cl-code-card">
        <div class="cl-code-label">配对码</div>
        <div class="cl-code" aria-label="配对码 ${esc(cur.code.split('').join(' '))}">${cur.code
          .split('')
          .map(d => `<span>${esc(d)}</span>`)
          .join('')}</div>
        <button class="text-button" data-cl="newcode">换一个</button>
      </div>
      <p class="cl-help">让同事在他的分镜台点顶栏「协作」，在「加入同事的项目」里选「${title}」，输入这 4 位数。配对码用过一次就会换新的。</p>
      <div class="cl-status" data-status="${cur.status}"><i></i>${esc(STATUS_TEXT[cur.status]?.(who) || '')}</div>
      ${addr ? `<p class="cl-addr">同事那边找不到这个项目时，让他点「输入地址」，填：<code>${esc(addr)}</code></p>` : ''}
      ${filesSection(cur)}
      ${nameRow}
      <div class="m-btns"><button class="btn ghost danger-text" data-cl="stop">停止共享</button><span class="cl-grow"></span><button class="btn primary" data-cl="close" data-autofocus>完成</button></div>`;
    return;
  }
  if (cur?.role === 'guest') {
    const who = cur.peer || cur.hostName;
    box.innerHTML = `
      <h3>正在协作「${title}」</h3>
      <div class="cl-status" data-status="${cur.status}"><i></i>${esc(STATUS_TEXT[cur.status]?.(who) || '')}</div>
      ${
        cur.status === 'needs-code'
          ? `<div class="cl-join-row"><input id="collabCode" inputmode="numeric" maxlength="4" placeholder="4 位配对码" autocomplete="off"><button class="btn primary" data-cl="repair">重新加入</button></div>
             <p class="cl-help">主机那边重新配对过，原来的连接失效了。请对方在「协作」里看一下新的配对码。</p>`
          : `<p class="cl-help">你和 ${esc(who || '主机')} 的改动会实时合并。断线期间的改动先存在你电脑上，连上后自动同步。</p>`
      }
      <p class="cl-help">保存视频片段时存到你自己的电脑上，不会传给对方；对方存的片段在你这边显示为在线视频。点「保存已通过的片段」时，对方存过的会直接从他电脑上拷，没存过的才从网站下载。</p>
      ${filesSection(cur)}
      ${nameRow}
      <div class="m-btns"><button class="btn ghost danger-text" data-cl="leave">退出协作</button><span class="cl-grow"></span><button class="btn primary" data-cl="close" data-autofocus>完成</button></div>`;
    return;
  }
  const shares = st.hosts.flatMap(h => h.shares.map(s => ({ host: h, share: s })));
  const list = shares.length
    ? shares
        .map(({ host, share }) => {
          const active = joining?.hostId === host.hostId && joining?.shareId === share.id;
          return `<div class="cl-share${active ? ' active' : ''}">
            <div class="cl-share-main"><b>${esc(share.title || '未命名')}</b><small>${esc(host.name || '同事')}${share.joined ? ' · 你加入过，会接着同步' : ''}</small></div>
            ${
              active
                ? `<input id="collabCode" inputmode="numeric" maxlength="4" placeholder="配对码" autocomplete="off"><button class="btn primary" data-cl="join" ${busy ? 'disabled' : ''}>${busy ? '加入中…' : '加入'}</button>`
                : `<button class="btn" data-cl="pick" data-host="${esc(host.hostId)}" data-share="${esc(share.id)}">加入</button>`
            }
          </div>`;
        })
        .join('')
    : `<div class="cl-empty">${st.discovering ? '<span class="cl-spin"></span>正在局域网里找…同事那边要先点「协作 → 开始共享」' : '没有找到正在共享的项目'}</div>`;
  box.innerHTML = `
    <h3>局域网协作</h3>
    <p class="cl-help">和同一个局域网（同一个 Wi-Fi 或公司网络）里的同事一起改同一个项目，改动实时同步。目前一个项目最多两个人。</p>
    <section class="cl-card">
      <div class="cl-card-head"><b>共享这个项目</b><small>「${title}」 · 开始后会显示 4 位配对码，告诉同事</small></div>
      <button class="btn primary" data-cl="share">开始共享</button>
    </section>
    <section class="cl-card cl-join">
      <div class="cl-card-head"><b>加入同事的项目</b><small>加入后会在你这里新建这个项目；视频片段各存各的电脑</small></div>
      <div class="cl-shares">${list}</div>
      ${
        manualOpen
          ? `<div class="cl-join-row"><input id="collabAddr" placeholder="对方地址，如 192.168.1.23" autocomplete="off"><button class="btn" data-cl="query">查找</button></div>`
          : `<button class="text-button" data-cl="manual">找不到？输入对方地址</button>`
      }
    </section>
    ${nameRow}
    <div class="m-btns"><button class="btn primary" data-cl="close" data-autofocus>完成</button></div>`;
}

function openDialog() {
  open = true;
  joining = null;
  manualOpen = false;
  collab.watchHosts(true);
  render();
  refreshMissing();
  $('#collabMask').classList.add('show');
}
function closeDialog() {
  if (!open) return;
  open = false;
  joining = null;
  collab.watchHosts(false);
  $('#collabMask').classList.remove('show');
}

async function doJoin() {
  const st = collab.collabState();
  const host = st.hosts.find(h => h.hostId === joining?.hostId);
  const share = host?.shares.find(s => s.id === joining?.shareId);
  const code = $('#collabCode')?.value.trim() || '';
  if (!host || !share) return;
  if (!/^\d{4}$/.test(code)) return toast('配对码是 4 位数字', null, 'warn');
  busy = true;
  render();
  const r = await collab.joinShare(host, share, code);
  busy = false;
  if (r.error) {
    render();
    $('#collabCode')?.focus();
    return toast(r.error, null, 'error');
  }
  closeDialog();
  update('rows');
  toast(`已加入「${state.title}」，你们的改动会实时同步`, null, 'ok');
}

/* ── 从对方电脑取文件 ── */
async function refreshMissing() {
  const pid = state.projectId;
  const list = collab.collabSession() ? await collab.missingFiles(pid) : [];
  if (pid !== state.projectId) return [];
  missing = list;
  if (open) render();
  return list;
}
/* 连上时：缺的文件先在素材文件夹里认一遍，认出来的直接用上，剩下的才提醒去取 */
async function autoFind() {
  const pid = state.projectId;
  const list = await refreshMissing();
  if (!list.length || !state.mediaDir || pid !== state.projectId) return list;
  const r = await collab.findLocal(list, [state.mediaDir], pid);
  if (pid !== state.projectId) return [];
  if (r.got?.length) toast(`素材文件夹里已有 ${r.got.length} 个缺的文件，已直接用上`, null, 'ok');
  return refreshMissing();
}
async function fetchItems(items) {
  const cur = collab.collabSession();
  if (!cur || cur.status !== 'online') return toast('对方现在不在线，连上后再取', null, 'warn');
  if (!items.length) return toast('没有要取的文件', null, 'info');
  if (collab.findProgress()) return toast('正在本机找已有的文件，找完再取', null, 'info');
  // 存到这个项目的素材文件夹（和「保存已通过的片段」同一个）；第一次问一下放哪
  let dir = state.mediaDir;
  if (!dir) {
    dir = await native.pickFolder('');
    if (!dir) return;
    setMediaDirectory(state.projectId, dir);
  }
  const who = cur.peer || '对方';
  // 先在素材文件夹里认：内容一样的文件已经在了就直接用，不再传；认不了（对方没回文件信息等）也不耽误，照常全部取
  const found = await collab.findLocal(items, [dir]);
  if (found.canceled) return refreshMissing();
  const known = found.got?.length || 0;
  if (!found.error) items = found.rest;
  if (!items.length) {
    refreshMissing();
    return toast(`素材文件夹里已经有这 ${known} 个文件，直接用上了，不用再传`, null, 'ok');
  }
  toast(
    `${known ? `素材文件夹里已有 ${known} 个，` : ''}正在从 ${who} 那里取 ${items.length} 个文件…`,
    { label: '取消', cb: collab.cancelFetch },
    'info',
  );
  const r = await collab.fetchFiles(items, dir);
  if (r.error) return toast(r.error, null, 'error');
  const first = r.got[0]?.local;
  if (r.failed.length)
    toast(
      `取到 ${r.got.length} 个，${r.failed.length} 个没取到：${r.failed[0].error}`,
      null,
      r.got.length ? 'warn' : 'error',
    );
  else
    toast(
      `已从 ${who} 那里取到 ${r.got.length} 个文件`,
      first ? { label: '在访达中显示', cb: () => native.revealAsset(first) } : null,
      'ok',
    );
  refreshMissing();
}
/* 自己指一个文件夹：按内容认出里面已有的文件（含所有子文件夹，不看文件名） */
async function findInFolder() {
  const items = await refreshMissing();
  if (!items.length) return toast('没有缺的文件', null, 'info');
  const dir = await native.pickFolder(state.mediaDir || '');
  if (!dir) return;
  const r = await collab.findLocal(items, [dir]);
  if (r.error) return toast(r.error, null, 'error');
  const list = await refreshMissing();
  if (r.canceled) return toast(`已取消${r.got.length ? `，已认出 ${r.got.length} 个` : ''}`, null, 'info');
  if (!r.got.length) return toast('这个文件夹里没有内容一样的文件，可以换个文件夹，或者从对方那里取', null, 'warn');
  toast(
    list.length
      ? `认出 ${r.got.length} 个，已直接用上；还缺 ${list.length} 个`
      : `认出 ${r.got.length} 个，已直接用上，不缺文件了`,
    { label: '在访达中显示', cb: () => native.revealAsset(r.got[0].local) },
    'ok',
  );
}
function fetchAsset(assetId) {
  const a = state.assets?.[assetId];
  if (!a?.path) return;
  fetchItems([{ kind: 'asset', id: a.id, path: a.path, name: a.path.split('/').pop() }]);
}
function fetchVoice() {
  if (!state.voice?.path) return;
  fetchItems([{ kind: 'voice', path: state.voice.path, name: state.voice.path.split('/').pop() }]);
}

async function onAction(act, el) {
  if (act === 'close') return closeDialog();
  if (act === 'share') {
    collab.startSharing();
    return render();
  }
  if (act === 'newcode') {
    collab.newPairingCode();
    return render();
  }
  if (act === 'stop')
    return confirmModal(
      '停止共享？',
      '对方会断开，他那边的项目变成普通项目、内容保留。你这边的项目不受影响。',
      '停止共享',
      () => {
        collab.stopSharing();
        closeDialog();
        toast('已停止共享', null, 'ok');
      },
    );
  if (act === 'leave')
    return confirmModal('退出协作？', '这个项目会变成你的普通项目，内容都保留，之后不再同步。', '退出协作', () => {
      collab.leaveShare();
      closeDialog();
      toast('已退出协作，项目内容都在', null, 'ok');
    });
  if (act === 'pick') {
    joining = { hostId: el.dataset.host, shareId: el.dataset.share };
    render();
    return $('#collabCode')?.focus();
  }
  if (act === 'join') return doJoin();
  if (act === 'fetchall') return fetchItems(await refreshMissing());
  if (act === 'cancelfetch') return collab.cancelFetch();
  if (act === 'findin') return findInFolder();
  if (act === 'cancelfind') return collab.cancelFind();
  if (act === 'repair') {
    const code = $('#collabCode')?.value.trim() || '';
    if (!/^\d{4}$/.test(code)) return toast('配对码是 4 位数字', null, 'warn');
    const r = await collab.repair(code);
    if (r.error) return toast(r.error, null, 'error');
    render();
    return toast('已重新连上', null, 'ok');
  }
  if (act === 'manual') {
    manualOpen = true;
    render();
    return $('#collabAddr')?.focus();
  }
  if (act === 'query') {
    const r = await collab.queryHost($('#collabAddr')?.value);
    if (r.error) return toast(r.error, null, 'error');
    if (!r.host.shares.length) return toast('对方开着分镜台，但没有在共享项目', null, 'warn');
    manualOpen = false;
    joining = { hostId: r.host.hostId, shareId: r.host.shares[0].id };
    render();
    return $('#collabCode')?.focus();
  }
}

/* ── 对方停在哪句：表格那一行左边一条彩色竖线 + 名字 ── */
function paintPresence() {
  for (const el of document.querySelectorAll('.peer-here')) {
    el.classList.remove('peer-here');
    delete el.dataset.peer;
  }
  const p = collab.peerHere();
  if (!p) return;
  for (const el of document.querySelectorAll(`.row[data-id="${CSS.escape(String(p.sel))}"]`)) {
    el.classList.add('peer-here');
    el.dataset.peer = p.name;
  }
}

export function initCollab() {
  const anchor = $('#btnUpdate');
  anchor?.insertAdjacentHTML(
    'beforebegin',
    `<button class="btn collab-btn" id="btnCollab" title="和同一局域网里的同事一起改这个项目">${PEOPLE}<span class="cl-av" aria-hidden="true"></span><span class="cl-label">协作</span></button>`,
  );
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="collabMask"><div class="modal collab-modal" id="collabBody"></div></div>`,
  );
  $('#btnCollab').onclick = openDialog;
  $('#collabMask').addEventListener('click', e => {
    if (e.target.id === 'collabMask') return closeDialog();
    const b = e.target.closest('[data-cl]');
    if (b && !b.disabled) onAction(b.dataset.cl, b);
  });
  $('#collabMask').addEventListener('change', e => {
    if (e.target.id === 'collabName') collab.setMyName(e.target.value);
  });
  registerModal('collabMask', {
    close: closeDialog,
    enter: () => {
      const id = document.activeElement?.id;
      if (id === 'collabCode') return joining ? doJoin() : onAction('repair');
      if (id === 'collabAddr') return onAction('query');
      if (id === 'collabName') return document.activeElement.blur();
      closeDialog();
    },
  });
  registerCommand('collab:open', openDialog);
  registerCommand('collab:fetch-asset', fetchAsset);
  registerCommand('collab:fetch-voice', fetchVoice);
  on('collab-changed', () => {
    renderButton();
    render();
    paintPresence();
    // 连上了：看看有没有只在对方电脑上的文件，提醒一句
    const cur = collab.collabSession();
    const status = cur ? `${cur.projectId}|${cur.status}` : '';
    if (status === lastStatus) return;
    lastStatus = status;
    emit('collab-status'); // 面板里的「从对方电脑取」按钮跟着出现 / 消失
    if (cur?.status !== 'online') return;
    autoFind().then(list => {
      if (!list.length || open || collab.collabSession()?.status !== 'online') return;
      toast(
        `有 ${list.length} 个素材文件你这边没有，${cur.peer || '对方'} 的电脑上可能有`,
        { label: '取过来', cb: () => fetchItems(list) },
        'info',
      );
    });
  });
  on('collab-files', () => open && render());
  on('assets-changed', () => open && refreshMissing());
  on('collab-presence', paintPresence);
  on('workspace', paintPresence);
  on('project-loaded', () => {
    missing = [];
    renderButton();
    if (open) refreshMissing();
  });
  collab.initCollab().then(() => {
    renderButton();
    paintPresence();
  });
}
