/* 应用内更新：启动后（以及每隔 1 小时）查一次 GitHub 上有没有新版本；点开更新窗口、开始下载前都会再查一次，
   保证直接装最新的一版（隔了好几版也是一步到位，更新说明里列出中间每一版）；下好了旧一版、又发了新版时，改下新版。
   有新版本时顶栏出现蓝色下载图标「更新」按钮，点开看更新说明 → 下载并校验 → 「重启并更新」：
   分镜台先存盘退出，换上新版后自动重新打开。项目数据不在应用里，更新不会动它。 */
import * as native from '../platform/native.js';
import { toast } from '../ui/dom.js';
import { registerCommand } from '../ui/commands.js';

const $ = s => document.querySelector(s);
let info = null; // 最近一次检查到的新版本
let phase = 'idle'; // idle | downloading | ready | installing
let checking = false;
const mb = n => (n > 0 ? `${(n / 1048576).toFixed(n > 104857600 ? 0 : 1)} MB` : '');

export async function checkUpdate({ manual = false, open = manual } = {}) {
  if (checking || phase === 'downloading' || phase === 'installing') return;
  checking = true;
  let r;
  try {
    r = await native.checkUpdate({ auto: !manual });
  } finally {
    checking = false;
  }
  if (!r) return;
  if (!r.ok) {
    if (manual) toast('检查更新失败：' + r.error, null, 'error');
    return;
  }
  if (!r.available) {
    if (manual) toast(`已经是最新版本（${r.current}）`, null, 'ok');
    return;
  }
  // 下好的是旧一版、现在有更新的：回到「下载并更新」，下最新的
  phase = r.ready || (phase === 'ready' && info?.version === r.version) ? 'ready' : 'idle';
  info = r;
  paintButton();
  if (open) showUpdate();
}

function paintButton() {
  const b = $('#btnUpdate');
  if (!b) return;
  b.hidden = !info;
  if (!info) return;
  $('#updButtonLabel').textContent = phase === 'ready' ? '重启更新' : '更新';
  b.setAttribute('aria-label', `查看分镜台 ${info.version} 的更新详情`);
  b.title =
    phase === 'ready'
      ? `新版本 ${info.version} 已下载好，点开查看并确认重启更新`
      : `分镜台 ${info.version} 已发布，点开看更新内容`;
}

function renderUpdate(progress = null) {
  if (!info) return;
  $('#updTitle').textContent = `分镜台 ${info.version} 可以更新了`;
  const n = info.versions?.length || 1;
  $('#updMeta').textContent =
    `现在用的是 ${info.current}${n > 1 ? ` · 一次更新到最新，包含 ${n} 个版本的改动` : ''}${info.size ? ` · 更新包 ${mb(info.size)}` : ''}`;
  $('#updNotes').textContent = info.notes || '这一版没有写更新说明。';
  const reason = $('#updReason');
  reason.hidden = info.canInstall;
  reason.textContent = info.reason || '';
  const bar = $('#updBar');
  const status = $('#updStatus');
  bar.hidden = phase !== 'downloading';
  if (phase === 'downloading') {
    const pct = progress?.total ? Math.floor((progress.got / progress.total) * 100) : null;
    bar.style.setProperty('--p', `${pct ?? 0}%`);
    status.textContent =
      progress?.phase === 'verify'
        ? '下载完成，正在校验和解压…'
        : pct != null
          ? `正在下载… ${pct}%（${mb(progress.got)} / ${mb(progress.total)}）`
          : '正在下载…';
  } else if (phase === 'ready')
    status.textContent = '新版本已经下载并校验好。点「重启并更新」：分镜台会先保存、关闭，换上新版后自动重新打开。';
  else status.textContent = info.canInstall ? '更新只换应用本身，项目数据和自动备份都不动。' : '';
  const go = $('#updGo');
  go.hidden = !info.canInstall;
  go.disabled = phase === 'downloading' || phase === 'installing';
  go.textContent = phase === 'ready' ? '重启并更新' : phase === 'downloading' ? '下载中…' : '下载并更新';
  $('#updCancel').textContent = phase === 'downloading' ? '取消下载' : '以后再说';
  $('#updPage').hidden = info.canInstall && phase !== 'idle'; // 不能自动更新时，给一个手动下载的入口
}

/* 点「更新」：先再查一次，确保显示和下载的是现在最新的一版（应用开着期间可能又发了新版） */
export async function openUpdate() {
  if (phase === 'idle' || phase === 'ready') {
    const had = !!info;
    await checkUpdate({ manual: !had, open: false });
    if (!info) return;
  }
  showUpdate();
}
function showUpdate() {
  renderUpdate();
  $('#updateMask').classList.add('show');
}
const closeUpdate = () => $('#updateMask').classList.remove('show');

async function go() {
  if (phase === 'ready') {
    phase = 'installing';
    renderUpdate();
    const r = await native.installUpdate();
    if (!r?.ok) {
      phase = 'idle';
      renderUpdate();
      toast('更新失败：' + (r?.error || '未知原因'), null, 'error');
    }
    return;
  }
  await checkUpdate(); // 下载前再确认一次是不是最新的一版（窗口可能开了很久）
  if (phase === 'ready') return renderUpdate(); // 最新的一版其实已经下好了
  phase = 'downloading';
  renderUpdate();
  paintButton();
  const r = await native.downloadUpdate();
  if (r?.ok) {
    phase = 'ready';
    toast(`分镜台 ${r.version} 已下载好，点「重启并更新」换上`, null, 'ok');
  } else {
    phase = 'idle';
    if (r?.canceled) toast('已取消下载更新', null, 'info');
    else toast('下载更新失败：' + (r?.error || '未知原因'), null, 'error');
  }
  renderUpdate();
  paintButton();
}

export function initUpdate() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="updateMask"><div class="modal update-modal" role="dialog" aria-modal="true" aria-labelledby="updTitle">
      <h3 id="updTitle">有新版本</h3>
      <p class="upd-meta" id="updMeta"></p>
      <div class="upd-notes" id="updNotes"></div>
      <p class="upd-reason" id="updReason" hidden></p>
      <div class="upd-bar" id="updBar" hidden><span></span></div>
      <p class="upd-status" id="updStatus" role="status"></p>
      <div class="m-btns"><button class="text-button" id="updPage">打开下载页面</button><span class="spacer"></span><button class="btn" id="updCancel">以后再说</button><button class="btn primary" id="updGo">下载并更新</button></div>
    </div></div>`,
  );
  $('#btnUpdate').onclick = openUpdate;
  $('#updGo').onclick = go;
  $('#updCancel').onclick = () => {
    if (phase === 'downloading') native.cancelUpdate();
    else closeUpdate();
  };
  $('#updPage').onclick = () => info && native.openAsset(info.page);
  $('#updateMask').addEventListener('click', e => {
    if (e.target.id === 'updateMask' && phase !== 'downloading') closeUpdate();
  });
  native.onUpdateProgress(p => {
    if (phase === 'downloading') renderUpdate(p);
  });
  registerCommand('update:check', () => checkUpdate({ manual: true }));
  // 启动 4 秒后安静地查一次（没网、被限流都不打扰），之后每小时查一次（读 latest.json 不占 GitHub API 次数）；
  // 已经下好旧一版的也照查，有更新的就改成下最新的
  setTimeout(() => checkUpdate(), 4000);
  setInterval(() => checkUpdate(), 3600 * 1000);
}

export const updateKey = e => {
  if (e.key === 'Escape') {
    if (phase !== 'downloading') closeUpdate();
    e.preventDefault();
    return true;
  }
};
